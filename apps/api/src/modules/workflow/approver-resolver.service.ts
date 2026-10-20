import { Injectable } from '@nestjs/common';
import type { WorkflowStep } from '@prisma/client';
import { SYSTEM_USER_ID } from '../../common/context/security-context';
import type { Tx } from '../../prisma/prisma-client';
import { planStep, type StepFacts, type StepPlan } from './engine-rules';
import { isAvailable, PERSON_USER_SELECT, WorkflowPeopleService } from './people.service';

/** The parts of a process that approver resolution depends on. */
export interface ResolutionSubject {
  processId: number;
  round: number;
  subjectEmployeeId: number;
  companyId: number;
  reportsToId: number | null;
  submittedByUserId: string;
}

/**
 * Gathers the facts for `planStep` from the database (section 7.1): who the rule resolves to,
 * who may never approve (the applicant's user and the submitter), who approved the previous step
 * and the company's HR admins as the fallback for a mandatory step.
 */
@Injectable()
export class ApproverResolver {
  constructor(private readonly people: WorkflowPeopleService) {}

  /** The applicant's user (whatever its state) and the submitter. SYSTEM is never an applicant. */
  async applicantUserIds(client: Tx, subject: ResolutionSubject): Promise<Set<string>> {
    const ids = new Set<string>();
    const user = await client.user.findFirst({
      where: { employeeId: subject.subjectEmployeeId },
      select: { id: true },
    });
    if (user) ids.add(user.id);
    if (subject.submittedByUserId !== SYSTEM_USER_ID) ids.add(subject.submittedByUserId);
    return ids;
  }

  /** The user who approved the latest earlier step of the round, if any. */
  async previousApprover(
    client: Tx,
    subject: ResolutionSubject,
    beforeStepNo: number,
  ): Promise<string | null> {
    const last = await client.workflowStepInstance.findFirst({
      where: {
        processId: subject.processId,
        round: subject.round,
        stepNo: { lt: beforeStepNo },
        status: 'APPROVED',
      },
      orderBy: [{ stepNo: 'desc' }, { actedAt: 'desc' }],
      select: { actedByUserId: true },
    });
    return last?.actedByUserId ?? null;
  }

  /** Users the step's rule resolves to; only users who can be given work. */
  async resolve(client: Tx, step: WorkflowStep, subject: ResolutionSubject): Promise<string[]> {
    switch (step.resolution) {
      case 'REPORTS_TO': {
        const id = await this.people.userOfEmployee(client, subject.reportsToId);
        return id ? [id] : [];
      }
      case 'REPORTS_TO_LEVEL_2': {
        const id = await this.levelTwoManager(client, subject);
        return id ? [id] : [];
      }
      case 'SPECIFIC_USER': {
        if (!step.approverUserId) return [];
        const user = await client.user.findUnique({
          where: { id: step.approverUserId },
          select: PERSON_USER_SELECT,
        });
        return user && isAvailable(user) ? [user.id] : [];
      }
      case 'ROLE':
        return step.approverRole ? this.people.withRole(client, step.approverRole, subject.companyId) : [];
    }
  }

  /** The applicant's manager's manager (REPORTS_TO_LEVEL_2), when that user can be given work. */
  async levelTwoManager(client: Tx, subject: ResolutionSubject): Promise<string | null> {
    if (subject.reportsToId === null) return null;
    const manager = await client.employee.findUnique({
      where: { id: subject.reportsToId },
      select: { reportsToId: true },
    });
    return this.people.userOfEmployee(client, manager?.reportsToId ?? null);
  }

  async facts(
    client: Tx,
    step: WorkflowStep,
    subject: ResolutionSubject,
    known: { applicantUserIds?: Set<string>; previousApproverUserId?: string | null } = {},
  ): Promise<StepFacts> {
    const [applicantUserIds, previousApproverUserId, resolved, fallback] = await Promise.all([
      known.applicantUserIds ?? this.applicantUserIds(client, subject),
      known.previousApproverUserId !== undefined
        ? known.previousApproverUserId
        : this.previousApprover(client, subject, step.stepNo),
      this.resolve(client, step, subject),
      step.isMandatory ? this.people.withRole(client, 'HR_ADMIN', subject.companyId) : [],
    ]);
    return { applicantUserIds, previousApproverUserId, resolved, fallback };
  }

  async plan(
    client: Tx,
    step: WorkflowStep,
    subject: ResolutionSubject,
    known: { applicantUserIds?: Set<string>; previousApproverUserId?: string | null } = {},
  ): Promise<StepPlan> {
    return planStep(step, await this.facts(client, step, subject, known));
  }
}
