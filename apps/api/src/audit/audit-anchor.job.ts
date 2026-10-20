import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { addDays, BUSINESS_TIMEZONE, dateFromBusiness, todayBusinessDate } from '@peoplehub/shared';
import { fromZonedTime } from 'date-fns-tz';
import { env } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { DbService } from '../prisma/db.service';
import { s3ClientFromEnv } from '../storage/storage.service';

export const AUDIT_ANCHOR_JOB = 'audit.anchor';

/**
 * Nightly anchor (section 9.3): the last audit id and hash of each business day, stored in
 * AuditAnchor (append-only) and, when configured, in a write-once S3 bucket (Object Lock).
 */
@Injectable()
export class AuditAnchorJob implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register<{ day?: string }>(AUDIT_ANCHOR_JOB, (data) => this.anchor(data.day), {
      cron: '5 0 * * *',
    });
  }

  /** Anchors `day` (default: yesterday in Africa/Windhoek). Idempotent. */
  async anchor(
    day: string = addDays(todayBusinessDate(), -1),
  ): Promise<{ anchored: number; lastAuditId: string }> {
    const prisma = this.db.prisma;
    const existing = await prisma.auditAnchor.findUnique({ where: { day: dateFromBusiness(day) } });
    if (existing) return { anchored: 0, lastAuditId: existing.lastAuditId.toString() };

    const endOfDay = fromZonedTime(`${addDays(day, 1)}T00:00:00`, BUSINESS_TIMEZONE);
    const last = await prisma.auditLog.findFirst({
      where: { occurredAt: { lt: endOfDay } },
      orderBy: { id: 'desc' },
      select: { id: true, hash: true },
    });
    if (!last) return { anchored: 0, lastAuditId: '' };

    await prisma.auditAnchor.create({
      data: { day: dateFromBusiness(day), lastAuditId: last.id, lastHash: last.hash },
    });

    const bucket = env().AUDIT_ANCHOR_BUCKET;
    if (bucket) {
      const retainUntil = new Date(Date.now() + 10 * 365 * 86_400_000);
      await s3ClientFromEnv().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `audit-anchors/${day}.json`,
          Body: JSON.stringify({ day, lastAuditId: last.id.toString(), lastHash: last.hash }),
          ContentType: 'application/json',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
        }),
      );
    }
    return { anchored: 1, lastAuditId: last.id.toString() };
  }
}
