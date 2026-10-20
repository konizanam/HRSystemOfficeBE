import { ONBOARD_ARRIVAL_FREE_TEXT_TYPE } from '@peoplehub/shared';
import type { SeedDeps, SeedSummary } from './index';

/**
 * The observed free text type (section 14): `ONBOARD_ARRIVAL` "Onboarding Arrival Update". An
 * existing row is left alone, so HR edits survive a re-seed.
 */
export async function seedFreeText({ db, ctx, audit }: SeedDeps): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    const existing = await tx.freeTextType.findUnique({
      where: { code: ONBOARD_ARRIVAL_FREE_TEXT_TYPE.code },
    });
    if (existing) return { freeTextTypesCreated: 0 };
    const row = await tx.freeTextType.create({ data: { ...ONBOARD_ARRIVAL_FREE_TEXT_TYPE } });
    audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'FREE_TEXT_TYPE.SEEDED',
      entityType: 'FreeTextType',
      entityId: row.id,
      after: row,
    });
    return { freeTextTypesCreated: 1 };
  });
}
