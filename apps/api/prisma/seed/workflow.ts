import type { Role } from '@prisma/client';
import {
  dateFromBusiness,
  endOfMonth,
  todayBusinessDate,
  WORKFLOW_TYPES,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import type { SeedDeps, SeedSummary } from './index';

/** Name of the type-wide default definition the seed owns (section 14). */
export const DEFAULT_DEFINITION_NAME = 'Default approval';

/** Section 14: step 2 is ROLE PAYROLL_ADMIN for these types, ROLE HR_ADMIN for the rest. */
const PAYROLL_SECOND_STEP: readonly WorkflowTypeCode[] = ['BASICINF', 'BANKDET'];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * A default two-step definition for each of the 16 workflow types (company rule null, so it
 * applies to every company rule until HR adds a more specific one): step 1 REPORTS_TO, step 2
 * ROLE HR_ADMIN (PAYROLL_ADMIN for BASICINF and BANKDET), both mandatory. A type that already
 * has its default is left alone, so HR edits survive a re-seed.
 */
export async function seedWorkflowDefinitions({ db, ctx }: SeedDeps): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    let created = 0;
    for (const code of Object.keys(WORKFLOW_TYPES) as WorkflowTypeCode[]) {
      const type = await tx.workflowType.findUniqueOrThrow({ where: { code } });
      const existing = await tx.workflowDefinition.findFirst({
        where: {
          workflowTypeId: type.id,
          companyRuleId: null,
          discriminator: null,
          name: DEFAULT_DEFINITION_NAME,
        },
        select: { id: true },
      });
      if (existing) continue;
      const role: Role = PAYROLL_SECOND_STEP.includes(code) ? 'PAYROLL_ADMIN' : 'HR_ADMIN';
      await tx.workflowDefinition.create({
        data: {
          workflowTypeId: type.id,
          name: DEFAULT_DEFINITION_NAME,
          steps: {
            create: [
              {
                stepNo: 1,
                name: 'Manager approval',
                resolution: 'REPORTS_TO',
                isMandatory: true,
                skipIfSameApprover: true,
              },
              {
                stepNo: 2,
                name: role === 'PAYROLL_ADMIN' ? 'Payroll approval' : 'HR approval',
                resolution: 'ROLE',
                approverRole: role,
                isMandatory: true,
                skipIfSameApprover: true,
              },
            ],
          },
        },
      });
      created += 1;
    }
    return { workflowDefinitionsCreated: created };
  });
}

/**
 * One open monthly pay period per month of the current year for company rule STAFF of the demo
 * company, so approved items can be processed (section 7.2). Existing periods are left alone.
 */
export async function seedPayPeriods({ db, ctx }: SeedDeps): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    const company = await tx.company.findUniqueOrThrow({ where: { code: 'DEMO' } });
    const rule = await tx.companyRule.findUniqueOrThrow({
      where: { companyId_code: { companyId: company.id, code: 'STAFF' } },
    });
    const year = Number(todayBusinessDate().slice(0, 4));
    let created = 0;
    for (let month = 1; month <= 12; month++) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = endOfMonth(start);
      const exists = await tx.payPeriod.findUnique({
        where: { companyRuleId_startDate: { companyRuleId: rule.id, startDate: dateFromBusiness(start) } },
        select: { id: true },
      });
      if (exists) continue;
      await tx.payPeriod.create({
        data: {
          companyRuleId: rule.id,
          description: `${MONTHS[month - 1]} ${year}`,
          startDate: dateFromBusiness(start),
          endDate: dateFromBusiness(end),
          payDate: dateFromBusiness(end),
        },
      });
      created += 1;
    }
    return { payPeriodsCreated: created };
  });
}
