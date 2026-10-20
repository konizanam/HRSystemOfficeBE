import {
  addMonths,
  businessFromDate,
  dateFromBusiness,
  DEFAULT_DASHBOARD_LAYOUT,
  DEFAULT_TAX_CERTIFICATE_TYPE,
  endOfMonth,
  formatCardDate,
  type PayslipImportRowInput,
  round2,
  startOfMonth,
  type TaxCertificateImportRowInput,
  taxYearOf,
  todayBusinessDate,
} from '@peoplehub/shared';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service';
import { PayslipImportService } from '../../src/modules/payslips/payslip-import.service';
import { TaxCertificateImportService } from '../../src/modules/payslips/tax-certificate-import.service';
import type { SeedDeps, SeedSummary } from './index';
import { SEED_PEOPLE } from './people';

/** Months of pay periods with demo payslips (the last three completed months). */
const PAYSLIP_MONTHS = 3;
/** Employees with a demo tax certificate for the previous tax year. */
const CERTIFICATE_USERS = ['employee1', 'employee2', 'employee3'];

const money = (n: number) => round2(n).toFixed(2);

/** Month number within the Namibian tax year (March = 1 … February = 12), for the YTD figures. */
function taxMonth(periodEnd: string): number {
  const month = Number(periodEnd.slice(5, 7));
  return month >= 3 ? month - 2 : month + 10;
}

/**
 * Demo payslip lines (ASSUMPTION: illustrative figures, not a tax calculation): basic salary by
 * position in the seed list, two allowances, PAYE at a flat 22%, social security at 0.9% capped at
 * N$99, pension at 7% (employer 10%), medical aid, a cellphone fringe benefit and normal hours.
 */
export function demoPayslipLines(index: number, periodEnd: string): PayslipImportRowInput['lines'] {
  const basic = 18_000 + 1_500 * index;
  const housing = 2_500;
  const transport = 1_200;
  const gross = basic + housing + transport;
  const ssc = Math.min(basic * 0.009, 99);
  const ytd = taxMonth(periodEnd);
  const line = (category: string, code: string, description: string, amount: number, extra = {}) => ({
    category: category as PayslipImportRowInput['lines'][number]['category'],
    code,
    description,
    amount: money(amount),
    ytdAmount: money(amount * ytd),
    ...extra,
  });
  return [
    line('EARNING', 'BASIC', 'Basic Salary', basic),
    line('EARNING', 'HOUSING', 'Housing Allowance', housing),
    line('EARNING', 'TRANSPORT', 'Transport Allowance', transport),
    line('DEDUCTION', 'PAYE', 'PAYE', gross * 0.22),
    line('DEDUCTION', 'SSC', 'Social Security', ssc),
    line('DEDUCTION', 'PENSION', 'Pension Fund', basic * 0.07),
    line('DEDUCTION', 'MEDICAL', 'Medical Aid', 1_450),
    line('COMPANY_CONTRIBUTION', 'PENSION_ER', 'Pension Fund (Employer)', basic * 0.1),
    line('COMPANY_CONTRIBUTION', 'SSC_ER', 'Social Security (Employer)', ssc),
    line('FRINGE_BENEFIT', 'CELLPHONE', 'Cellphone Benefit', 300),
    { category: 'INFO', code: 'HOURS', description: 'Normal Hours', amount: '173.33', ytdAmount: null },
  ];
}

/**
 * Section 7 seed: payslips for the last three completed pay periods of every seeded employee,
 * one tax certificate for the previous tax year for a few employees, and the default dashboard
 * layout for every seeded user. Payslips and certificates go through the import services (dry
 * run, then commit) so their PDFs are generated and stored like real ones. Only what is missing
 * is imported, so a second run writes nothing.
 */
export async function seedPayroll({ db, ctx, app }: SeedDeps): Promise<SeedSummary> {
  const company = await db.prisma.company.findUniqueOrThrow({ where: { code: 'DEMO' } });
  const rule = await db.prisma.companyRule.findUniqueOrThrow({
    where: { companyId_code: { companyId: company.id, code: 'STAFF' } },
  });
  const today = todayBusinessDate();
  const months = Array.from({ length: PAYSLIP_MONTHS }, (_, i) => startOfMonth(addMonths(today, -(i + 1))));

  // The periods may predate this year's periods (seeding in January–March).
  const periodsCreated = await db.tx(ctx, async (tx) => {
    let created = 0;
    for (const start of months) {
      const exists = await tx.payPeriod.findUnique({
        where: { companyRuleId_startDate: { companyRuleId: rule.id, startDate: dateFromBusiness(start) } },
        select: { id: true },
      });
      if (exists) continue;
      await tx.payPeriod.create({
        data: {
          companyRuleId: rule.id,
          description: formatCardDate(start).slice(3),
          startDate: dateFromBusiness(start),
          endDate: dateFromBusiness(endOfMonth(start)),
          payDate: dateFromBusiness(endOfMonth(start)),
        },
      });
      created += 1;
    }
    return created;
  });
  const periods = await db.prisma.payPeriod.findMany({
    where: { companyRuleId: rule.id, startDate: { in: months.map(dateFromBusiness) } },
  });

  const employees = await db.prisma.employee.findMany({
    where: { entityCode: { in: SEED_PEOPLE.map((p) => p.entityCode) } },
    select: { id: true, entityCode: true, employeeCode: true, user: { select: { username: true } } },
  });
  const rows: PayslipImportRowInput[] = [];
  for (const [index, person] of SEED_PEOPLE.entries()) {
    const employee = employees.find((e) => e.entityCode === person.entityCode);
    if (!employee) continue;
    for (const period of periods) {
      const existing = await db.prisma.payslip.findFirst({
        where: { employeeId: employee.id, payPeriodId: period.id, payRun: 'MAIN', supersededAt: null },
        select: { id: true },
      });
      if (existing) continue;
      const periodEnd = businessFromDate(period.endDate);
      rows.push({
        employeeCode: employee.employeeCode,
        periodEndDate: periodEnd,
        payRun: 'MAIN',
        runType: 'Normal',
        lines: demoPayslipLines(index, periodEnd),
      });
    }
  }
  const payslips = app.get(PayslipImportService);
  if (rows.length > 0) {
    const input = { format: 'json' as const, rows, replace: false };
    const dry = await payslips.import(ctx, { ...input, mode: 'DRY_RUN' });
    await payslips.import(ctx, { ...input, mode: 'COMMIT', confirmToken: dry.confirmToken });
  }

  const taxYear = taxYearOf(today) - 1;
  const certificates: TaxCertificateImportRowInput[] = [];
  for (const username of CERTIFICATE_USERS) {
    const index = SEED_PEOPLE.findIndex((p) => p.username === username);
    const employee = employees.find((e) => e.entityCode === SEED_PEOPLE[index]?.entityCode);
    if (!employee) continue;
    const existing = await db.prisma.taxCertificate.findFirst({
      where: {
        employeeId: employee.id,
        taxYear,
        certificateType: DEFAULT_TAX_CERTIFICATE_TYPE,
        supersededAt: null,
      },
      select: { id: true },
    });
    if (existing) continue;
    const annual = (18_000 + 1_500 * index + 3_700) * 12;
    certificates.push({
      employeeCode: employee.employeeCode,
      taxYear,
      certificateType: DEFAULT_TAX_CERTIFICATE_TYPE,
      figures: [
        { code: '3601', description: 'Gross remuneration', amount: money(annual) },
        { code: '3605', description: 'Taxable allowances', amount: money(3_700 * 12) },
        {
          code: '4001',
          description: 'Pension fund contributions',
          amount: money((18_000 + 1_500 * index) * 0.07 * 12),
        },
        { code: '4102', description: 'Employees tax (PAYE) deducted', amount: money(annual * 0.22) },
      ],
    });
  }
  const taxImport = app.get(TaxCertificateImportService);
  if (certificates.length > 0) {
    const input = { format: 'json' as const, rows: certificates, replace: false };
    const dry = await taxImport.import(ctx, { ...input, mode: 'DRY_RUN' });
    await taxImport.import(ctx, { ...input, mode: 'COMMIT', confirmToken: dry.confirmToken });
  }

  const dashboard = app.get(DashboardService);
  const users = await db.prisma.user.findMany({
    where: { username: { in: SEED_PEOPLE.map((p) => p.username) }, dashboardLayout: null },
    select: { id: true },
  });
  if (users.length > 0) {
    await db.tx(ctx, async (tx) => {
      for (const user of users) await dashboard.saveLayout(tx, ctx, user.id, DEFAULT_DASHBOARD_LAYOUT);
    });
  }

  return {
    payPeriodsCreatedForPayslips: periodsCreated,
    payslipsImported: rows.length,
    taxCertificatesImported: certificates.length,
    dashboardLayoutsCreated: users.length,
  };
}
