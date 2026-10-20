import { dateFromBusiness, last4Of, LOOKUP_TABLES, startOfMonth, todayBusinessDate } from '@peoplehub/shared';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { BanksService } from '../../src/modules/details/banks.service';
import { LookupService } from '../../src/modules/details/lookup.service';
import type { SeedDeps, SeedSummary } from './index';
import { SEED_PEOPLE } from './people';

/** Two retirement funds (section 5.4.5); every seeded employee is a member of the pension fund. */
export const SEED_FUNDS = [
  { code: 'DEMO_PF', name: 'Demo Staff Pension Fund' },
  { code: 'DEMO_PROV', name: 'Demo Provident Fund' },
] as const;

/** Payroll transaction codes (ASSUMPTION A17); two are open for employee inputs. */
export const SEED_TRANSACTION_CODES = [
  { code: 'HOUSING', description: 'Housing Allowance', allowEmployeeInput: false, inputMode: 'AMOUNT' },
  { code: 'MEDAID', description: 'Medical Aid Contribution', allowEmployeeInput: false, inputMode: 'AMOUNT' },
  {
    code: 'PENSION',
    description: 'Pension Fund Contribution',
    allowEmployeeInput: false,
    inputMode: 'AMOUNT',
  },
  { code: 'UNION', description: 'Union Dues', allowEmployeeInput: false, inputMode: 'AMOUNT' },
  {
    code: 'CELLPHONE',
    description: 'Cellphone Allowance Claim',
    allowEmployeeInput: true,
    inputMode: 'AMOUNT',
  },
  {
    code: 'SAVINGS',
    description: 'Voluntary Savings Deduction',
    allowEmployeeInput: true,
    inputMode: 'AMOUNT',
  },
] as const;

/** Recurring transactions of the demo employees (code, amount). */
const SEED_RECURRING: Record<string, [code: string, amount: string][]> = {
  employee1: [
    ['HOUSING', '2500.00'],
    ['MEDAID', '1850.00'],
    ['PENSION', '1420.50'],
  ],
  employee2: [
    ['MEDAID', '1850.00'],
    ['PENSION', '1210.00'],
    ['UNION', '95.00'],
  ],
  employee3: [
    ['HOUSING', '2500.00'],
    ['PENSION', '1305.75'],
  ],
};

/**
 * My Details reference and demo data (section 14): the lookup lists, the 40 banks with the
 * observed branch lists, two retirement funds with memberships, the transaction codes, recurring
 * transactions and one salary account per seeded employee. Rows are only created when missing.
 */
export async function seedDetails({ db, audit, ctx, app }: SeedDeps): Promise<SeedSummary> {
  const lookupRows = await app.get(LookupService).seed(ctx, LOOKUP_TABLES);
  const banks = await app.get(BanksService).seed(ctx);
  const crypto = app.get(EncryptionService);

  const counts = await db.tx(ctx, async (tx) => {
    let funds = 0;
    let memberships = 0;
    let codes = 0;
    let transactions = 0;
    let accounts = 0;
    const fundIds: number[] = [];
    for (const fund of SEED_FUNDS) {
      let row = await tx.retirementFund.findUnique({ where: { code: fund.code } });
      if (!row) {
        row = await tx.retirementFund.create({ data: fund });
        audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'RETIREMENT_FUND.SEEDED',
          entityType: 'RetirementFund',
          entityId: row.id,
          after: row,
        });
        funds += 1;
      }
      fundIds.push(row.id);
    }
    const codeIds = new Map<string, number>();
    for (const code of SEED_TRANSACTION_CODES) {
      let row = await tx.payrollTransactionCode.findUnique({ where: { code: code.code } });
      if (!row) {
        row = await tx.payrollTransactionCode.create({ data: code });
        audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'TRANSACTION_CODE.SEEDED',
          entityType: 'PayrollTransactionCode',
          entityId: row.id,
          after: row,
        });
        codes += 1;
      }
      codeIds.set(code.code, row.id);
    }
    const windhoek = await tx.bank.findUniqueOrThrow({ where: { name: 'Bank of Windhoek' } });
    const mainBranch = await tx.bankBranch.findUnique({
      where: { bankId_name: { bankId: windhoek.id, name: 'Main Branch' } },
    });
    const start = dateFromBusiness(startOfMonth(todayBusinessDate()));

    for (const person of SEED_PEOPLE) {
      const employee = await tx.employee.findUniqueOrThrow({ where: { entityCode: person.entityCode } });
      const isEmployee = person.username.startsWith('employee');
      const funded = isEmployee
        ? ['employee1', 'employee2', 'employee3'].includes(person.username)
          ? fundIds
          : fundIds.slice(0, 1)
        : [];
      for (const [index, fundId] of funded.entries()) {
        const existing = await tx.fundMembership.findUnique({
          where: { employeeId_fundId: { employeeId: employee.id, fundId } },
          select: { id: true },
        });
        if (existing) continue;
        const row = await tx.fundMembership.create({
          data: {
            employeeId: employee.id,
            fundId,
            memberNumber: `M${index + 1}-${person.entityCode}`,
            startDate: employee.dateEngaged,
          },
        });
        audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'FUND_MEMBERSHIP.SEEDED',
          entityType: 'FundMembership',
          entityId: row.id,
          subjectEmployeeId: employee.id,
          after: row,
        });
        memberships += 1;
      }

      for (const [code, amount] of SEED_RECURRING[person.username] ?? []) {
        const transactionCodeId = codeIds.get(code) ?? null;
        const existing = await tx.employeeTransaction.findFirst({
          where: { employeeId: employee.id, code, isRecurring: true },
          select: { id: true },
        });
        if (existing) continue;
        const definition = SEED_TRANSACTION_CODES.find((c) => c.code === code);
        const row = await tx.employeeTransaction.create({
          data: {
            employeeId: employee.id,
            transactionCodeId,
            code,
            description: definition?.description ?? code,
            amount,
            isRecurring: true,
            status: 'PROCESSED',
            startDate: employee.dateEngaged,
          },
        });
        audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'EMPLOYEE_TRANSACTION.SEEDED',
          entityType: 'EmployeeTransaction',
          entityId: row.id,
          subjectEmployeeId: employee.id,
          after: row,
        });
        transactions += 1;
      }

      if (isEmployee) {
        const hasAccount = await tx.bankAccount.findFirst({
          where: { employeeId: employee.id },
          select: { id: true },
        });
        if (!hasAccount) {
          // A fake demo account number per employee (never real data, section 14).
          const number = `8${person.entityCode}${person.entityCode.slice(-3)}`;
          const row = await tx.bankAccount.create({
            data: {
              employeeId: employee.id,
              accountType: 'SAVINGS',
              holderName: `${employee.firstName} ${employee.lastName}`,
              holderRelationship: 'OWN',
              bankId: windhoek.id,
              branchId: mainBranch?.id ?? null,
              accountNumberEnc: crypto.encrypt(number),
              accountNumberLast4: last4Of(number) ?? '',
              currency: 'NAD',
              effectiveFrom: employee.dateEngaged ?? start,
            },
          });
          audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'BANK_ACCOUNT.SEEDED',
            entityType: 'BankAccount',
            entityId: row.id,
            subjectEmployeeId: employee.id,
            after: row,
          });
          accounts += 1;
        }
      }
    }
    return { funds, memberships, codes, transactions, accounts };
  });

  return {
    lookupRowsCreated: lookupRows,
    banksCreated: banks.banksCreated,
    bankBranchesCreated: banks.branchesCreated,
    retirementFundsCreated: counts.funds,
    fundMembershipsCreated: counts.memberships,
    transactionCodesCreated: counts.codes,
    employeeTransactionsCreated: counts.transactions,
    bankAccountsCreated: counts.accounts,
  };
}
