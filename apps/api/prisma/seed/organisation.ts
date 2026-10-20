import { WORKFLOW_TYPES } from '@peoplehub/shared';
import type { SeedDeps, SeedSummary } from './index';

/** Company DEMO, company rule STAFF and the 16 observed workflow types (section 14). */
export async function seedOrganisation({ db, ctx }: SeedDeps): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    const company = await tx.company.upsert({
      where: { code: 'DEMO' },
      update: {},
      create: { code: 'DEMO', name: 'Demo Company (Pty) Ltd', currency: 'NAD', country: 'NA' },
    });
    await tx.companyRule.upsert({
      where: { companyId_code: { companyId: company.id, code: 'STAFF' } },
      update: {},
      create: { companyId: company.id, code: 'STAFF', description: 'Staff' },
    });
    for (const [code, description] of Object.entries(WORKFLOW_TYPES)) {
      await tx.workflowType.upsert({ where: { code }, update: {}, create: { code, description } });
    }
    return { companies: 1, companyRules: 1, workflowTypes: Object.keys(WORKFLOW_TYPES).length };
  });
}
