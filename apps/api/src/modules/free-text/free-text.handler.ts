import type { Tx } from '../../prisma/prisma-client';
import type {
  FinalApprovalResult,
  SubjectDescription,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
  WorkflowSubjectHandler,
} from '../workflow/workflow-subject';
import type { FreeTextService } from './free-text.service';

/**
 * The FREETEXT subject handler: free text requests whose type needs no "About employee". (Those
 * that do run on FREETEXTMANEMP, whose handler in the details module has a FreeTextRequest branch
 * that calls the same FreeTextService hooks.) FREETEXT completes on the last approval, so
 * `onProcess` is never called.
 */
export class FreeTextHandler implements WorkflowSubjectHandler {
  readonly type = 'FREETEXT' as const;

  constructor(private readonly freeText: FreeTextService) {}

  describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    return this.freeText.describe(client, process);
  }

  onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    return this.freeText.onFinalApproval(hook);
  }

  async onProcess(_hook: WorkflowProcessHookContext): Promise<void> {}

  onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    return this.freeText.onDeclined(hook);
  }

  onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    return this.freeText.onCancelled(hook);
  }

  onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    return this.freeText.onSentBack(hook);
  }

  onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    return this.freeText.onResubmitted(hook);
  }
}
