import type { AccrualMethod } from '@prisma/client';
import {
  addDays,
  addMonths,
  type BusinessDate,
  businessFromDate,
  isoWeekday,
  startOfMonth,
  todayBusinessDate,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../src/common/context/security-context';
import { AttachmentService } from '../../src/modules/attachments/attachment.service';
import { HolidayService } from '../../src/modules/holidays/holiday.service';
import { EntitlementService } from '../../src/modules/leave/entitlement.service';
import { CARRY_FORWARD_DEFINITION, LEAVE_EMPLOYEE_SELECT } from '../../src/modules/leave/leave-constants';
import { LeaveJobs } from '../../src/modules/leave/leave-jobs.service';
import { LeavePolicyService } from '../../src/modules/leave/leave-policy.service';
import { calculateUnits } from '../../src/modules/leave/leave-rules';
import { LeaveService } from '../../src/modules/leave/leave.service';
import type { SeedDeps, SeedSummary } from './index';
import { SEED_PEOPLE } from './people';

interface SeedLeaveType {
  id: number;
  code: string;
  description: string;
  colour: string | null;
  isPaid?: boolean;
  mandatoryReason?: boolean;
  requiresAttachmentAfterDays?: string | null;
  allowNegative?: boolean;
  isCreditLeave?: boolean;
  reasons: [code: string, description: string][];
  policy: {
    entitlementPerCycle: string;
    accrualMethod: AccrualMethod;
    cycleMonths?: number;
    maxCarryForward?: string | null;
    carryForwardExpiryMonths?: number | null;
    maxNegative?: string;
    creditExpiryDays?: number | null;
  };
}

/**
 * Section 14: the 12 observed leave types with their exact ids, codes and colours, plus the
 * leave-in-lieu credit type (ASSUMPTION), with reasons (ASSUMPTION) and policies (ASSUMPTION; HR
 * edits them). Policies apply to every company rule (`companyRuleId = null`).
 */
export const SEED_LEAVE_TYPES: SeedLeaveType[] = [
  {
    id: 1,
    code: 'ANN_LVE',
    description: 'Annual Leave',
    colour: '#C0FFC0',
    reasons: [
      ['VACATION', 'Vacation'],
      ['PERSONAL', 'Personal matters'],
    ],
    policy: {
      entitlementPerCycle: '20',
      accrualMethod: 'MONTHLY_PRO_RATA',
      maxCarryForward: '5',
      carryForwardExpiryMonths: 6,
    },
  },
  {
    id: 2,
    code: 'SICK_LVE',
    description: 'Sick Leave',
    colour: '#FFFFC0',
    mandatoryReason: true,
    requiresAttachmentAfterDays: '2',
    reasons: [
      ['ILLNESS', 'Illness'],
      ['FAMILY_ILLNESS', 'Family Illness'],
      ['MEDICAL_APPOINTMENT', 'Medical appointment'],
    ],
    policy: { entitlementPerCycle: '34', accrualMethod: 'UPFRONT', cycleMonths: 36, maxCarryForward: '0' },
  },
  {
    id: 3,
    code: 'DC_LVE',
    description: 'Discretionary Leave',
    colour: '#80FF80',
    reasons: [['MANAGEMENT', 'Granted by management']],
    policy: { entitlementPerCycle: '0', accrualMethod: 'NONE', maxCarryForward: '0' },
  },
  {
    id: 4,
    code: 'COMP_LVE',
    description: 'Compassionate Leave',
    colour: '#C0C0FF',
    mandatoryReason: true,
    reasons: [
      ['DEATH_FAMILY', 'Death of family member'],
      ['SERIOUS_ILLNESS_FAMILY', 'Serious illness of family member'],
    ],
    policy: { entitlementPerCycle: '10', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 5,
    code: 'MAT_LVE',
    description: 'Maternity Leave',
    colour: '#FFC0FF',
    reasons: [
      ['BIRTH', 'Birth of child'],
      ['ADOPTION', 'Adoption of a child'],
    ],
    policy: { entitlementPerCycle: '84', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 6,
    code: 'STUDY',
    description: 'Study Leave',
    colour: '#FFE0C0',
    mandatoryReason: true,
    requiresAttachmentAfterDays: '0',
    reasons: [
      ['EXAMINATION', 'Examination'],
      ['EXAM_PREPARATION', 'Examination preparation'],
    ],
    policy: { entitlementPerCycle: '12', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 7,
    code: 'PAT_LVE',
    description: 'Paternity Leave',
    colour: '#C0FFFF',
    reasons: [['BIRTH', 'Birth of child']],
    policy: { entitlementPerCycle: '3', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 8,
    code: 'SPORT_LVE',
    description: 'Sports Leave',
    colour: '#FFC080',
    reasons: [
      ['REPRESENTATION', 'National representation'],
      ['COMPETITION', 'Sports competition'],
    ],
    policy: { entitlementPerCycle: '10', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 9,
    code: 'UNPD_LVE',
    description: 'Unpaid Leave',
    colour: null,
    isPaid: false,
    mandatoryReason: true,
    allowNegative: true,
    reasons: [
      ['PERSONAL', 'Personal reasons'],
      ['EXTENDED', 'Extended leave'],
    ],
    policy: { entitlementPerCycle: '0', accrualMethod: 'NONE', maxCarryForward: '0', maxNegative: '365' },
  },
  {
    id: 10,
    code: 'RESET_LVE',
    description: 'Resettlement Leave',
    colour: null,
    reasons: [['RELOCATION', 'Relocation']],
    policy: { entitlementPerCycle: '4', accrualMethod: 'UPFRONT', maxCarryForward: '0' },
  },
  {
    id: 11,
    code: 'LOST_LVE',
    description: 'Lost Leave',
    colour: '#FFC0C0',
    reasons: [['FORFEITED', 'Forfeited leave']],
    policy: { entitlementPerCycle: '0', accrualMethod: 'NONE', maxCarryForward: '0' },
  },
  {
    id: 12,
    code: 'UN_SICK',
    description: 'Unpaid Sick Leave',
    colour: '#8080FF',
    isPaid: false,
    mandatoryReason: true,
    requiresAttachmentAfterDays: '2',
    allowNegative: true,
    reasons: [['ILLNESS', 'Illness']],
    policy: { entitlementPerCycle: '0', accrualMethod: 'NONE', maxCarryForward: '0', maxNegative: '365' },
  },
  {
    id: 13,
    code: 'LIEU_LVE',
    description: 'Leave in Lieu',
    colour: '#E0C0FF',
    isCreditLeave: true,
    reasons: [['TIME_OFF', 'Time off in lieu']],
    policy: { entitlementPerCycle: '0', accrualMethod: 'NONE', maxCarryForward: '0', creditExpiryDays: 90 },
  },
];

/** Leave types, reasons and policies. Existing rows are never changed, so HR edits survive. */
export async function seedLeaveReferenceData({
  db,
  ctx,
}: Pick<SeedDeps, 'db' | 'ctx'>): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    let types = 0;
    let reasons = 0;
    let policies = 0;
    for (const t of SEED_LEAVE_TYPES) {
      const existing = await tx.leaveType.findUnique({ where: { id: t.id } });
      if (!existing) {
        await tx.leaveType.create({
          data: {
            id: t.id,
            code: t.code,
            description: t.description,
            colour: t.colour,
            isPaid: t.isPaid ?? true,
            mandatoryReason: t.mandatoryReason ?? false,
            requiresAttachmentAfterDays: t.requiresAttachmentAfterDays ?? null,
            allowNegative: t.allowNegative ?? false,
            isCreditLeave: t.isCreditLeave ?? false,
          },
        });
        types += 1;
      }
      for (const [code, description] of t.reasons) {
        const reason = await tx.leaveReason.findUnique({
          where: { leaveTypeId_code: { leaveTypeId: t.id, code } },
        });
        if (reason) continue;
        await tx.leaveReason.create({ data: { leaveTypeId: t.id, code, description } });
        reasons += 1;
      }
      const policy = await tx.leavePolicy.findFirst({ where: { leaveTypeId: t.id, companyRuleId: null } });
      if (!policy) {
        await tx.leavePolicy.create({
          data: {
            leaveTypeId: t.id,
            companyRuleId: null,
            definitionName: t.description,
            entitlementPerCycle: t.policy.entitlementPerCycle,
            accrualMethod: t.policy.accrualMethod,
            cycleMonths: t.policy.cycleMonths ?? 12,
            maxCarryForward: t.policy.maxCarryForward ?? null,
            carryForwardExpiryMonths: t.policy.carryForwardExpiryMonths ?? null,
            maxNegative: t.policy.maxNegative ?? '0',
            creditExpiryDays: t.policy.creditExpiryDays ?? null,
          },
        });
        policies += 1;
      }
    }
    return { leaveTypesCreated: types, leaveReasonsCreated: reasons, leavePoliciesCreated: policies };
  });
}

/** A one-page PDF used as the seeded study leave supporting document. */
const STUDY_LETTER_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** The context employee1's own session would have (they submit their own study leave). */
async function employeeContext(deps: SeedDeps, username: string): Promise<SecurityContext> {
  const user = await deps.db.prisma.user.findUniqueOrThrow({ where: { username } });
  if (user.employeeId === null) throw new Error(`${username} has no employee record`);
  return {
    userId: user.id,
    username: user.username,
    roles: user.roles,
    selfEmployeeId: user.employeeId,
    actingAsEmployeeId: user.employeeId,
    companyIds: [],
    sessionId: 'seed',
    requestId: 'seed-leave',
    ip: '127.0.0.1',
    userAgent: 'seed',
  };
}

/** The first range from `start` (a weekday) with exactly `units` working days. */
async function rangeWithUnits(
  deps: SeedDeps,
  companyId: number,
  start: BusinessDate,
  units: number,
): Promise<{ from: BusinessDate; to: BusinessDate }> {
  const holidays = await deps.app.get(HolidayService).calendar(companyId, start, addDays(start, 60));
  for (let to = start; to <= addDays(start, 60); to = addDays(to, 1)) {
    try {
      const calc = calculateUnits({
        fromDate: start,
        toDate: to,
        startPortion: 'FULL',
        endPortion: 'FULL',
        excludeWeekends: true,
        excludePublicHolidays: true,
        allowHalfDay: true,
        holidays,
      });
      if (calc.units.eq(units)) return { from: start, to };
    } catch {
      // No working day yet (a weekend or holiday start); extend the range.
    }
  }
  throw new Error(`No ${units}-day range found from ${start}`);
}

/** The first Monday on or after `date` that is not a public holiday. */
async function nextWorkingMonday(
  deps: SeedDeps,
  companyId: number,
  date: BusinessDate,
): Promise<BusinessDate> {
  let day = addDays(date, (8 - isoWeekday(date)) % 7);
  const holidays = await deps.app.get(HolidayService).calendar(companyId, day, addDays(day, 70));
  while (holidays.has(day)) day = addDays(day, 7);
  return day;
}

/**
 * Opening balances that reproduce the section 1.7 fixtures for employee1 (E000077), relative to
 * the month the seed first runs in (the current pay period is that month):
 * - Annual Leave: a "Carry Forward Leave" bucket (0.5024 carried in, expiring after 6 months) and
 *   an "Annual Leave" bucket whose cycle started last month (accrued 1.6667 last month and
 *   1.6667 this month): BF 2.1691 + accrued 1.6667 − taken 0 = CF 3.8358.
 * - Study Leave: entitlement 12 with two pending applications of 4 and 5 days (actual available
 *   3); the 5-day request showed "Days available 8".
 */
async function seedEmployee1Fixture(deps: SeedDeps): Promise<SeedSummary> {
  const { db, ctx, app } = deps;
  const entitlements = app.get(EntitlementService);
  const policies = app.get(LeavePolicyService);
  const employee = await db.prisma.employee.findUniqueOrThrow({
    where: { entityCode: '000077' },
    select: LEAVE_EMPLOYEE_SELECT,
  });
  const summary: SeedSummary = { employee1AnnualFixture: 0, employee1StudyApplications: 0 };

  const hasAnnual = await db.prisma.employeeLeaveEntitlement.count({
    where: { employeeId: employee.id, leaveTypeId: 1 },
  });
  if (hasAnnual === 0) {
    const thisMonth = startOfMonth(todayBusinessDate());
    const cycleStart = addMonths(thisMonth, -1);
    await db.tx(ctx, async (tx) => {
      await entitlements.lockEmployee(tx, employee.id);
      const policy = await policies.requirePolicy(employee.companyRuleId, 1, tx);
      const carryEnd = addDays(addMonths(cycleStart, policy.carryForwardExpiryMonths ?? 6), -1);
      const carry = await entitlements.openBucket(
        tx,
        ctx,
        {
          employeeId: employee.id,
          leaveTypeId: 1,
          policyId: policy.id,
          kind: 'CARRY_FORWARD',
          definitionName: CARRY_FORWARD_DEFINITION,
          entitlement: '0.5024',
          cycleStartDate: cycleStart,
          cycleEndDate: carryEnd,
          expiresOn: carryEnd,
        },
        { seed: 'section 1.7 fixture' },
      );
      const annual = await entitlements.openCycleBucket(tx, ctx, employee.id, policy, {
        start: cycleStart,
        end: addDays(addMonths(cycleStart, 12), -1),
      });
      const base = { employeeId: employee.id, leaveTypeId: 1 };
      await entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: carry.id,
          entryType: 'CARRY_FORWARD_IN',
          units: '0.5024',
          effectiveDate: cycleStart,
          note: 'Opening balance (take-on)',
        },
        { action: 'LEAVE.OPENING_BALANCE_POSTED', metadata: { seed: 'section 1.7 fixture' } },
      );
      for (const month of [cycleStart, thisMonth]) {
        await entitlements.post(
          tx,
          ctx,
          {
            ...base,
            entitlementId: annual.id,
            entryType: 'ACCRUAL',
            units: '1.6667',
            effectiveDate: month,
            note: 'Annual Leave accrual',
          },
          { action: 'LEAVE.ACCRUED', metadata: { seed: 'section 1.7 fixture' } },
        );
      }
    });
    summary.employee1AnnualFixture = 1;
  }

  // Buckets and accruals for every seeded employee (UPFRONT types post their entitlement).
  const people = await db.prisma.employee.findMany({
    where: { entityCode: { in: SEED_PEOPLE.map((p) => p.entityCode) } },
    select: { id: true },
  });
  const accrual = await app.get(LeaveJobs).accrue({ employeeIds: people.map((p) => p.id) });
  summary.leaveBucketsOpened = Number(accrual.bucketsOpened);
  summary.leaveAccrualsPosted = Number(accrual.accrualsPosted);

  const hasStudy = await db.prisma.leaveApplication.count({
    where: { employeeId: employee.id, leaveTypeId: 6 },
  });
  if (hasStudy === 0) {
    const employeeCtx = await employeeContext(deps, 'employee1');
    const reason = await db.prisma.leaveReason.findUniqueOrThrow({
      where: { leaveTypeId_code: { leaveTypeId: 6, code: 'EXAMINATION' } },
    });
    const first = await rangeWithUnits(
      deps,
      employee.companyId,
      await nextWorkingMonday(deps, employee.companyId, addDays(todayBusinessDate(), 21)),
      4,
    );
    const secondStart = await nextWorkingMonday(deps, employee.companyId, addDays(first.to, 7));
    const second = await rangeWithUnits(deps, employee.companyId, secondStart, 5);
    for (const [range, comment] of [
      [first, 'Semester examinations'],
      [second, 'Final examinations'],
    ] as const) {
      const [letter] = await app
        .get(AttachmentService)
        .upload(employeeCtx, [
          { fileName: 'study-confirmation.pdf', mimeType: 'application/pdf', bytes: STUDY_LETTER_PDF },
        ]);
      await app.get(LeaveService).submit(employeeCtx, {
        leaveTypeId: 6,
        fromDate: range.from,
        toDate: range.to,
        startPortion: 'FULL',
        endPortion: 'FULL',
        leaveReasonId: reason.id,
        comment,
        noteSubmitted: false,
        attachmentIds: letter ? [letter.id] : [],
        overrideUnits: false,
      });
      summary.employee1StudyApplications = Number(summary.employee1StudyApplications) + 1;
    }
  }
  summary.employee1StudyEntitlementCycleEnd = businessFromDate(
    (
      await db.prisma.employeeLeaveEntitlement.findFirstOrThrow({
        where: { employeeId: employee.id, leaveTypeId: 6, kind: 'CYCLE' },
        orderBy: { cycleEndDate: 'desc' },
      })
    ).cycleEndDate,
  );
  return summary;
}

/** Section 14 leave data: reference data, then buckets, accruals and the employee1 fixture. */
export async function seedLeave(deps: SeedDeps): Promise<SeedSummary> {
  return { ...(await seedLeaveReferenceData(deps)), ...(await seedEmployee1Fixture(deps)) };
}
