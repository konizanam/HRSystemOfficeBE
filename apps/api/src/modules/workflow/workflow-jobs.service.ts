import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SYSTEM_USER_ID } from '../../common/context/security-context';
import { type JobCounts, JobsService } from '../../jobs/jobs.service';
import { workflowProcessesByStatus } from '../../metrics/registry';
import { DbService } from '../../prisma/db.service';
import { SettingsService } from '../settings/settings.service';
import { OPEN_STEP_STATUSES } from './process-shape';
import { WorkflowEngine } from './workflow-engine.service';

export const WORKFLOW_JOBS = {
  escalate: 'workflow.escalate',
  unpark: 'workflow.unpark',
  reresolve: 'workflow.reresolve',
} as const;

/** Most steps one job run handles; the next run picks up the rest. */
const BATCH = 500;

/**
 * The workflow's scheduled jobs (sections 7.4 and 7.5). Each item is handled in its own
 * transaction, so one bad item never blocks the rest; each handler returns its counts for the
 * SYSTEM.JOB_RUN audit row.
 */
@Injectable()
export class WorkflowJobs implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly engine: WorkflowEngine,
  ) {}

  onModuleInit(): void {
    this.jobs.register(WORKFLOW_JOBS.escalate, () => this.escalate(), { cron: '*/15 * * * *' });
    this.jobs.register(WORKFLOW_JOBS.unpark, () => this.unpark(), { cron: '*/15 * * * *' });
    this.jobs.register(WORKFLOW_JOBS.reresolve, () => this.reresolve(), { cron: '30 2 * * *' });
  }

  /** Overdue PENDING steps: notify, mark escalated, and auto-reassign after twice the time. */
  async escalate(now = new Date()): Promise<JobCounts> {
    const autoReassign = await this.settings.get('workflow.escalation.autoReassign');
    const due = await this.db.prisma.workflowStepInstance.findMany({
      where: {
        status: 'PENDING',
        dueAt: { lte: now },
        process: { status: 'IN_PROGRESS' },
        // Not yet notified, or (with auto-reassign on) possibly past twice the escalation time.
        ...(autoReassign ? {} : { escalatedAt: null }),
      },
      select: { id: true },
      orderBy: { dueAt: 'asc' },
      take: BATCH,
    });
    const counts = { checked: due.length, escalated: 0, reassigned: 0 };
    for (const { id } of due) {
      const outcome = await this.engine.escalateStep(id, autoReassign, now);
      if (outcome === 'escalated') counts.escalated += 1;
      if (outcome === 'reassigned') counts.reassigned += 1;
    }
    await this.refreshMetrics();
    return counts;
  }

  /** Parked steps whose date has come return to Action Required. */
  async unpark(now = new Date()): Promise<JobCounts> {
    const due = await this.db.prisma.workflowStepInstance.findMany({
      where: { status: 'PARKED', parkedUntil: { lte: now } },
      select: { id: true },
      orderBy: { parkedUntil: 'asc' },
      take: BATCH,
    });
    let unparked = 0;
    for (const { id } of due) if (await this.engine.unparkStep(id, now)) unparked += 1;
    return { checked: due.length, unparked };
  }

  /** Open steps assigned to users who can no longer be given work are re-resolved as SYSTEM. */
  async reresolve(): Promise<JobCounts> {
    const stale = await this.db.prisma.workflowStepInstance.findMany({
      where: {
        status: { in: [...OPEN_STEP_STATUSES] },
        assigneeUserId: { not: SYSTEM_USER_ID },
        OR: [
          { assignee: { isActive: false } },
          { assignee: { employee: { status: { not: 'ACTIVE' } } } },
          { assignee: { employee: { deletedAt: { not: null } } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    const counts = { checked: stale.length, reassigned: 0, removed: 0, skipped: 0, unresolved: 0 };
    for (const { id } of stale) {
      const outcome = await this.engine.reresolveStep(id);
      if (outcome !== 'unchanged') counts[outcome] += 1;
    }
    return counts;
  }

  /** Prometheus gauge of processes by type and status (section 15). */
  private async refreshMetrics(): Promise<void> {
    const [groups, types] = await Promise.all([
      this.db.prisma.workflowProcess.groupBy({ by: ['workflowTypeId', 'status'], _count: true }),
      this.db.prisma.workflowType.findMany({ select: { id: true, code: true } }),
    ]);
    const code = new Map(types.map((t) => [t.id, t.code]));
    workflowProcessesByStatus.reset();
    for (const g of groups) {
      workflowProcessesByStatus.set(
        { type: code.get(g.workflowTypeId) ?? String(g.workflowTypeId), status: g.status },
        g._count,
      );
    }
  }
}
