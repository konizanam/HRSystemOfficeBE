import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SystemSetting } from '@prisma/client';
import {
  type AdminSettingsResponse,
  defaultSettings,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { sha256Hex } from '../../audit/canonical-json';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError, VersionConflictError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';

/** Advisory lock that serialises settings writes, so the revision check cannot race. */
const SETTINGS_WRITE_LOCK = 727275;

/** Other API instances pick up a change within this time; this instance sees it immediately. */
export const SETTINGS_CACHE_TTL_MS = 30_000;

interface Snapshot {
  values: Settings;
  rows: Map<string, SystemSetting>;
  loadedAt: number;
}

function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key);
}

/**
 * The optimistic concurrency token of the settings: a hash over every stored setting's key and
 * last change. Any saved change (on any API instance) gives a new revision.
 */
export function settingsRevision(rows: Iterable<Pick<SystemSetting, 'key' | 'updatedAt'>>): string {
  const parts = [...rows]
    .filter((r) => isSettingKey(r.key))
    .map((r) => `${r.key}@${r.updatedAt.toISOString()}`)
    .sort();
  return sha256Hex(parts.join('|')).slice(0, 32);
}

/**
 * Resolves a stored value against its definition. An invalid stored value (for example edited by
 * hand in the database) falls back to the default rather than breaking every request.
 */
export function resolveSetting<K extends SettingKey>(key: K, stored: unknown): Settings[K] | undefined {
  const parsed = SETTING_DEFINITIONS[key].schema.safeParse(stored);
  return parsed.success ? (parsed.data as Settings[K]) : undefined;
}

/**
 * Typed access to SystemSetting (section 10.5) with the defaults from the shared contract. Reads
 * are served from an in-process cache that is invalidated on every write; every change is audited
 * as SECURITY.SETTING_CHANGED with before and after.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    return (await this.load()).values[key];
  }

  async getAll(): Promise<Settings> {
    const values = (await this.load()).values;
    return structuredClone(values);
  }

  /** Forgets the cache; the next read reloads from the database. */
  invalidate(): void {
    this.snapshot = null;
    this.loading = null;
  }

  /** GET /admin/settings: always read fresh, so the revision is current. */
  async adminView(): Promise<AdminSettingsResponse> {
    this.invalidate();
    const snap = await this.load();
    return {
      revision: settingsRevision(snap.rows.values()),
      values: structuredClone(snap.values),
      items: SETTING_KEYS.map((key) => {
        const row = snap.rows.get(key);
        return {
          key,
          description: SETTING_DEFINITIONS[key].description,
          isDefault: !row,
          updatedAt: row ? row.updatedAt.toISOString() : null,
          updatedByUserId: row?.updatedByUserId ?? null,
        };
      }),
    };
  }

  /**
   * Writes the given keys. Values equal to the current ones are skipped, so a no-op PUT writes
   * nothing and audits nothing. Validation runs per key against the shared schema. With
   * `expectedRevision` (PUT /admin/settings always sends it) a stale revision answers 409.
   */
  async update(
    ctx: SecurityContext,
    values: Partial<Settings>,
    expectedRevision?: string,
  ): Promise<AdminSettingsResponse> {
    const errors: { path: string; message: string }[] = [];
    const changes: { key: SettingKey; value: unknown }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      if (!isSettingKey(key)) {
        errors.push({ path: `values.${key}`, message: 'Unknown setting' });
        continue;
      }
      const parsed = SETTING_DEFINITIONS[key].schema.safeParse(raw);
      if (!parsed.success) {
        errors.push({ path: `values.${key}`, message: parsed.error.issues[0]?.message ?? 'Invalid value' });
        continue;
      }
      changes.push({ key, value: parsed.data });
    }
    if (errors.length) throw new ValidationError(errors);

    try {
      await this.db.tx(ctx, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_WRITE_LOCK})`;
        if (expectedRevision !== undefined) {
          const stored = await tx.systemSetting.findMany({ select: { key: true, updatedAt: true } });
          const current = settingsRevision(stored);
          if (current !== expectedRevision) {
            throw new VersionConflictError('The settings were changed by someone else; reload', {
              revision: current,
            });
          }
        }
        for (const { key, value } of changes) {
          const row = await tx.systemSetting.findUnique({ where: { key } });
          const stored = row ? resolveSetting(key, row.value) : undefined;
          const current = stored === undefined ? defaultSettings()[key] : stored;
          if (JSON.stringify(current) === JSON.stringify(value)) continue;
          const json: Prisma.InputJsonValue | typeof Prisma.JsonNull =
            value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
          await tx.systemSetting.upsert({
            where: { key },
            create: { key, value: json, updatedByUserId: ctx.userId },
            update: { value: json, updatedByUserId: ctx.userId },
          });
          this.audit.record(tx, ctx, {
            category: 'SECURITY',
            action: 'SECURITY.SETTING_CHANGED',
            entityType: 'SystemSetting',
            entityId: key,
            before: { key, value: current, isDefault: !row },
            after: { key, value, isDefault: false },
          });
        }
      });
    } finally {
      this.invalidate();
    }
    return this.adminView();
  }

  private async load(): Promise<Snapshot> {
    const snap = this.snapshot;
    if (snap && Date.now() - snap.loadedAt < SETTINGS_CACHE_TTL_MS) return snap;
    if (!this.loading) {
      this.loading = this.fetch().then(
        (fresh) => {
          this.snapshot = fresh;
          this.loading = null;
          return fresh;
        },
        (err: unknown) => {
          this.loading = null;
          throw err;
        },
      );
    }
    return this.loading;
  }

  private async fetch(): Promise<Snapshot> {
    const rows = await this.db.prisma.systemSetting.findMany();
    const values = defaultSettings();
    const byKey = new Map<string, SystemSetting>();
    for (const row of rows) {
      if (!isSettingKey(row.key)) continue;
      byKey.set(row.key, row);
      const resolved = resolveSetting(row.key, row.value);
      if (resolved === undefined) {
        this.logger.warn({ key: row.key }, 'Stored setting is invalid; using the default');
        continue;
      }
      (values as Record<SettingKey, unknown>)[row.key] = resolved;
    }
    return { values, rows: byKey, loadedAt: Date.now() };
  }
}
