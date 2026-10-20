import type { WorkflowTypeCode } from '@peoplehub/shared';
import type { Tx } from '../../prisma/prisma-client';
import type {
  FinalApprovalResult,
  SubjectDescription,
  SubjectViewer,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
  WorkflowSubjectHandler,
} from '../workflow/workflow-subject';
import type { ChangeRequestService } from './change-request.service';

/** The workflow types whose subject is a ChangeRequest (section 7.6). */
export const CHANGE_REQUEST_WORKFLOW_TYPES = [
  'BASICINF',
  'BANKDET',
  'DRIVERSLICENSE',
  'BENEFICIARY',
] as const;

/**
 * `ChangeRequestHandler` (section 7.3), one instance per change-request workflow type. None of
 * these types needs payroll processing: the final approval applies the change and the process goes
 * straight to PROCESSED in the same transaction, or ends in CONFLICT when the record changed.
 */
export class ChangeRequestHandler implements WorkflowSubjectHandler {
  constructor(
    readonly type: WorkflowTypeCode,
    private readonly changes: ChangeRequestService,
  ) {}

  describe(
    client: Tx,
    process: WorkflowProcessSnapshot,
    viewer?: SubjectViewer,
  ): Promise<SubjectDescription> {
    return this.changes.describe(client, process, viewer);
  }

  onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    return this.changes.onFinalApproval(hook);
  }

  /** Never called: these types complete on the final approval. */
  async onProcess(): Promise<void> {}

  onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    return this.changes.onDeclined(hook);
  }

  onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    return this.changes.onCancelled(hook);
  }

  onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    return this.changes.onSentBack(hook);
  }

  onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    return this.changes.onResubmitted(hook);
  }
}
