import { Prisma } from '@prisma/client';
import {
  addDays,
  ageOn,
  dateFromBusiness,
  birthdayFallsBetween,
  birthdayLabel,
  businessFromDate,
  daysUntilBirthday,
  maskedNumber,
  nextBirthday,
  payRunLabel,
  type ReportRow,
} from '@peoplehub/shared';
import { defineReport } from '../report-definition';
import {
  batches,
  dateRange,
  day,
  dec4,
  employeeCells,
  fullName,
  money,
  statusLabel,
  thisYear,
  ts,
} from '../report-helpers';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** Employee Pay Period Basic: one row per employee and pay period of their company rule. */
export const employeePayPeriodBasic = defineReport('EMPLOYEE_PAY_PERIOD_BASIC', async function* (rc, params) {
  const year = thisYear(rc.today);
  const range = { from: params.from ?? year.from, to: params.to ?? year.to };
  for await (const batch of batches(
    (page) =>
      rc.prisma.employee.findMany({
        where: rc.employees,
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          jobTitle: true,
          department: true,
          status: true,
          dateEngaged: true,
          terminationDate: true,
          companyRuleId: true,
          companyRule: { select: { description: true } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const periods = await rc.prisma.payPeriod.findMany({
      where: {
        companyRuleId: { in: [...new Set(batch.map((e) => e.companyRuleId))] },
        endDate: dateRange(range.from, range.to),
      },
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
    });
    const payslips = await rc.prisma.payslip.findMany({
      where: {
        employeeId: { in: batch.map((e) => e.id) },
        payPeriodId: { in: periods.map((p) => p.id) },
        supersededAt: null,
      },
      select: {
        employeeId: true,
        payPeriodId: true,
        payRun: true,
        grossPay: true,
        totalDeductions: true,
        netPay: true,
      },
      orderBy: { payRun: 'asc' },
    });
    for (const e of batch) {
      for (const p of periods) {
        if (p.companyRuleId !== e.companyRuleId) continue;
        if (e.dateEngaged && e.dateEngaged > p.endDate) continue;
        if (e.terminationDate && e.terminationDate < p.startDate) continue;
        const own = payslips.filter((s) => s.employeeId === e.id && s.payPeriodId === p.id);
        const sum = (pick: (s: (typeof own)[number]) => Prisma.Decimal) =>
          own.length === 0 ? null : money(own.reduce((t, s) => t.plus(pick(s)), new Prisma.Decimal(0)));
        yield {
          payPeriod: p.description,
          periodStart: day(p.startDate),
          periodEnd: day(p.endDate),
          ...employeeCells(e),
          companyRule: e.companyRule.description,
          jobTitle: e.jobTitle,
          department: e.department,
          status: titleCase(e.status),
          dateEngaged: day(e.dateEngaged),
          payslips: own.length,
          payRuns: own.map((s) => payRunLabel(s.payRun)).join(', ') || null,
          grossPay: sum((s) => s.grossPay),
          totalDeductions: sum((s) => s.totalDeductions),
          netPay: sum((s) => s.netPay),
        };
      }
    }
  }
});

const BASIC_SELECT = {
  id: true,
  employeeCode: true,
  title: true,
  initials: true,
  firstName: true,
  lastName: true,
  knownAs: true,
  jobTitle: true,
  jobGrade: true,
  department: true,
  status: true,
  dateEngaged: true,
  terminationDate: true,
  company: { select: { name: true } },
  companyRule: { select: { description: true } },
  reportsTo: { select: { firstName: true, lastName: true } },
} satisfies Prisma.EmployeeSelect;

/** Employee Basic. */
export const employeeBasic = defineReport('EMPLOYEE_BASIC', async function* (rc, params) {
  const engaged = dateRange(params.from, params.to);
  for await (const batch of batches(
    (page) =>
      rc.prisma.employee.findMany({
        where: { AND: [rc.employees, engaged ? { dateEngaged: engaged } : {}] },
        select: BASIC_SELECT,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const e of batch) {
      yield {
        employeeCode: e.employeeCode,
        title: e.title,
        initials: e.initials,
        firstName: e.firstName,
        lastName: e.lastName,
        knownAs: e.knownAs,
        company: e.company.name,
        companyRule: e.companyRule.description,
        jobTitle: e.jobTitle,
        department: e.department,
        status: titleCase(e.status),
        dateEngaged: day(e.dateEngaged),
        terminationDate: day(e.terminationDate),
        reportsTo: e.reportsTo ? fullName(e.reportsTo) : null,
      };
    }
  }
});

/** Employee Detail: identity and tax numbers are only ever shown masked. */
export const employeeDetail = defineReport('EMPLOYEE_DETAIL', async function* (rc, params) {
  const engaged = dateRange(params.from, params.to);
  for await (const batch of batches(
    (page) =>
      rc.prisma.employee.findMany({
        where: { AND: [rc.employees, engaged ? { dateEngaged: engaged } : {}] },
        select: {
          ...BASIC_SELECT,
          gender: true,
          dateOfBirth: true,
          nationality: true,
          homeLanguage: true,
          maritalStatus: true,
          identityType: true,
          identityNumberLast4: true,
          taxNumberLast4: true,
          contacts: {
            where: { type: { in: ['CELL', 'EMAIL'] } },
            select: { type: true, value: true, isPrimary: true },
            orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const e of batch) {
      const dob = day(e.dateOfBirth);
      yield {
        employeeCode: e.employeeCode,
        firstName: e.firstName,
        lastName: e.lastName,
        knownAs: e.knownAs,
        gender: e.gender,
        dateOfBirth: dob,
        age: dob ? ageOn(dob, rc.today) : null,
        nationality: e.nationality,
        homeLanguage: e.homeLanguage,
        maritalStatus: e.maritalStatus,
        identityType: e.identityType,
        identityNumber: maskedNumber(e.identityNumberLast4),
        taxNumber: maskedNumber(e.taxNumberLast4),
        cellNumber: e.contacts.find((c) => c.type === 'CELL')?.value ?? null,
        email: e.contacts.find((c) => c.type === 'EMAIL')?.value ?? null,
        jobTitle: e.jobTitle,
        jobGrade: e.jobGrade,
        department: e.department,
        companyRule: e.companyRule.description,
        dateEngaged: day(e.dateEngaged),
        status: titleCase(e.status),
      };
    }
  }
});

interface BirthdayRow {
  id: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  knownAs: string | null;
  department: string | null;
  companyRule: string;
  dateOfBirth: Date;
  m: number;
  d: number;
}

/**
 * Birthday List: calendar order (January to December) by day and month, never the year.
 * Employees who opted out are left out. Keyset pagination on (month, day, id) over the in-scope
 * employee ids.
 */
export const birthdayList = defineReport('BIRTHDAY_LIST', async function* (rc, params) {
  const ids: number[] = [];
  for await (const batch of batches(
    (page) =>
      rc.prisma.employee.findMany({
        where: { AND: [rc.employees, { birthdayVisible: true, dateOfBirth: { not: null } }] },
        select: { id: true },
        orderBy: { id: 'asc' },
        ...page,
      }),
    5000,
  )) {
    ids.push(...batch.map((e) => e.id));
  }
  if (ids.length === 0) return;
  // A range with one end open runs a year from (or up to) the given end.
  const window =
    params.from || params.to
      ? {
          from: params.from ?? addDays(params.to ?? rc.today, -365),
          to: params.to ?? addDays(params.from ?? rc.today, 365),
        }
      : null;
  let after = { m: 0, d: 0, id: 0 };
  for (;;) {
    const rows = await rc.prisma.$queryRaw<BirthdayRow[]>`
      SELECT e.id, e."employeeCode", e."firstName", e."lastName", e."knownAs", e.department,
             cr.description AS "companyRule", e."dateOfBirth",
             EXTRACT(MONTH FROM e."dateOfBirth")::int AS m, EXTRACT(DAY FROM e."dateOfBirth")::int AS d
      FROM "Employee" e JOIN "CompanyRule" cr ON cr.id = e."companyRuleId"
      WHERE e.id = ANY(${ids}::int[])
        AND (EXTRACT(MONTH FROM e."dateOfBirth")::int, EXTRACT(DAY FROM e."dateOfBirth")::int, e.id)
            > (${after.m}::int, ${after.d}::int, ${after.id}::int)
      ORDER BY m, d, e.id
      LIMIT ${rc.batchSize}`;
    for (const r of rows) {
      const dob = businessFromDate(r.dateOfBirth);
      if (window && !birthdayFallsBetween(dob, window.from, window.to)) continue;
      yield {
        employeeCode: r.employeeCode,
        employeeName: `${r.knownAs ?? r.firstName} ${r.lastName}`,
        companyRule: r.companyRule,
        department: r.department,
        birthday: birthdayLabel(dob),
        nextBirthday: nextBirthday(dob, rc.today),
        daysUntil: daysUntilBirthday(dob, rc.today),
      } satisfies ReportRow;
    }
    if (rows.length < rc.batchSize) return;
    const last = rows[rows.length - 1] as BirthdayRow;
    after = { m: last.m, d: last.d, id: last.id };
  }
});

/** EmployeeTransaction. */
export const employeeTransaction = defineReport('EMPLOYEE_TRANSACTION', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.employeeTransaction.findMany({
        where: {
          employee: rc.employees,
          ...(params.statuses ? { status: { in: params.statuses } } : {}),
          ...(params.from || params.to ? { createdAt: dateRange(params.from, params.to) } : {}),
        },
        include: {
          employee: {
            select: {
              employeeCode: true,
              firstName: true,
              lastName: true,
              companyRule: { select: { description: true } },
            },
          },
          payPeriod: { select: { description: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const t of batch) {
      yield {
        employeeCode: t.employee.employeeCode,
        employeeName: fullName(t.employee),
        companyRule: t.employee.companyRule.description,
        code: t.code,
        description: t.description,
        amount: money(t.amount),
        quantity: dec4(t.quantity),
        payPeriod: t.payPeriod?.description ?? null,
        recurring: t.isRecurring,
        status: statusLabel(t.status),
        createdAt: ts(t.createdAt),
      };
    }
  }
});

/** Development Plan Report: competencies and objectives of contracts with the latest rating. */
export const developmentPlan = defineReport('DEVELOPMENT_PLAN', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.performanceContractItem.findMany({
        where: {
          kind: { in: ['COMPETENCY', 'OBJECTIVE'] },
          deletedAt: null,
          contract: {
            employee: rc.employees,
            ...(params.statuses ? { status: { in: params.statuses } } : {}),
            ...(params.to ? { startDate: { lte: dateFromBusiness(params.to) } } : {}),
            ...(params.from ? { endDate: { gte: dateFromBusiness(params.from) } } : {}),
          },
        },
        include: {
          contract: {
            select: {
              name: true,
              startDate: true,
              endDate: true,
              status: true,
              employee: { select: { employeeCode: true, firstName: true, lastName: true } },
            },
          },
          scores: {
            where: { submittedAt: { not: null } },
            orderBy: { submittedAt: 'desc' },
            take: 1,
            select: { rating: true, comment: true, submittedAt: true },
          },
        },
        orderBy: [{ contractId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const item of batch) {
      const latest = item.scores[0];
      yield {
        employeeCode: item.contract.employee.employeeCode,
        employeeName: fullName(item.contract.employee),
        contractName: item.contract.name,
        contractStart: day(item.contract.startDate),
        contractEnd: day(item.contract.endDate),
        contractStatus: titleCase(item.contract.status),
        itemKind: titleCase(item.kind),
        developmentArea: item.title,
        target: item.target,
        weight: dec4(item.weight),
        latestRating: dec4(latest?.rating ?? null),
        latestComment: latest?.comment ?? null,
        lastReviewed: ts(latest?.submittedAt),
      };
    }
  }
});
