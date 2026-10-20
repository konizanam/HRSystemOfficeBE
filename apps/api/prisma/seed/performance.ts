import { PerformanceSeedService } from '../../src/modules/performance/performance-seed.service';
import type { SeedDeps, SeedSummary } from './index';

/**
 * Performance reference data (section 14): the parameter tables (ReviewCategory, ReviewType and
 * samples for the others), the "1–5" rating scale and one active template owned by hr.admin.
 * Rows are only created when missing.
 */
export async function seedPerformance({ ctx, app }: SeedDeps): Promise<SeedSummary> {
  return app.get(PerformanceSeedService).seed(ctx);
}
