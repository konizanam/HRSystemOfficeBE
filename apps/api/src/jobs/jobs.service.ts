import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { BUSINESS_TIMEZONE } from '@peoplehub/shared';
import { AuditService } from '../audit/audit.service';
import { systemContext } from '../common/context/security-context';
import { env } from '../config/env';
import { jobDuration } from '../metrics/registry';

/** Counts reported by a job run; written to the SYSTEM.JOB_RUN audit row. */
export type JobCounts = Record<string, number | string>;

export type JobHandler<T = Record<string, unknown>> = (data: T) => Promise<JobCounts>;

interface Registration {
  handler: JobHandler<Record<string, unknown>>;
  cron?: string;
  audit: boolean;
}

/**
 * pg-boss wrapper (section 2). Modules register handlers in `onModuleInit`; queues, workers and
 * cron schedules are created on bootstrap when JOBS_ENABLED is true. `runNow` executes a handler
 * in-process (tests, admin re-runs).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly registrations = new Map<string, Registration>();
  private boss: PgBoss | null = null;
  private healthy = true;

  constructor(private readonly audit: AuditService) {}

  register<T extends Record<string, unknown>>(
    name: string,
    handler: JobHandler<T>,
    options: { cron?: string; audit?: boolean } = {},
  ): void {
    this.registrations.set(name, {
      handler: handler as JobHandler<Record<string, unknown>>,
      cron: options.cron,
      audit: options.audit ?? true,
    });
  }

  registeredJobs(): { name: string; cron: string | null }[] {
    return [...this.registrations.entries()].map(([name, r]) => ({ name, cron: r.cron ?? null }));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!env().JOBS_ENABLED) return;
    const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: 'pgboss' });
    boss.on('error', (err: unknown) => {
      this.healthy = false;
      this.logger.error({ err }, 'pg-boss error');
    });
    await boss.start();
    this.boss = boss;
    for (const [name, reg] of this.registrations) {
      await boss.createQueue(name);
      await boss.work<Record<string, unknown>>(name, async (jobs) => {
        for (const job of jobs) await this.execute(name, reg, job.data ?? {});
      });
      if (reg.cron) await boss.schedule(name, reg.cron, {}, { tz: BUSINESS_TIMEZONE });
    }
    this.logger.log(`Started ${this.registrations.size} job queues`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
  }

  isHealthy(): boolean {
    return !env().JOBS_ENABLED || (this.boss !== null && this.healthy);
  }

  /** Queues a job; without a running queue (tests, JOBS_ENABLED=false) it runs in-process. */
  async send(
    name: string,
    data: Record<string, unknown> = {},
    options: PgBoss.SendOptions = {},
  ): Promise<void> {
    if (this.boss) {
      await this.boss.send(name, data, options);
      return;
    }
    await this.runNow(name, data);
  }

  async runNow(name: string, data: Record<string, unknown> = {}): Promise<JobCounts> {
    const reg = this.registrations.get(name);
    if (!reg) throw new Error(`Unknown job ${name}`);
    return this.execute(name, reg, data);
  }

  private async execute(name: string, reg: Registration, data: Record<string, unknown>): Promise<JobCounts> {
    const started = performance.now();
    const ctx = systemContext(`job-${name}-${Date.now()}`);
    try {
      const counts = await reg.handler(data);
      const seconds = (performance.now() - started) / 1000;
      jobDuration.observe({ job: name, outcome: 'success' }, seconds);
      if (reg.audit) {
        await this.audit.recordStandalone(ctx, {
          category: 'SYSTEM',
          action: 'SYSTEM.JOB_RUN',
          entityType: 'Job',
          entityId: name,
          metadata: { job: name, data, counts: counts ?? {}, durationMs: Math.round(seconds * 1000) },
        });
      }
      return counts ?? {};
    } catch (err) {
      const seconds = (performance.now() - started) / 1000;
      jobDuration.observe({ job: name, outcome: 'failure' }, seconds);
      this.logger.error({ err, job: name }, 'Job failed');
      await this.audit
        .recordStandalone(ctx, {
          category: 'SYSTEM',
          action: 'SYSTEM.JOB_RUN',
          entityType: 'Job',
          entityId: name,
          outcome: 'FAILURE',
          reason: err instanceof Error ? err.message : String(err),
          metadata: { job: name, data, durationMs: Math.round(seconds * 1000) },
        })
        .catch(() => undefined);
      throw err;
    }
  }
}
