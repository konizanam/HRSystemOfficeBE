import { Injectable } from '@nestjs/common';
import {
  type SubjectDetail,
  WORKFLOW_REQUEST_LABELS,
  WORKFLOW_TYPES,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import type { Tx } from '../../prisma/prisma-client';
import type {
  FinalApprovalResult,
  SubjectDescription,
  WorkflowProcessSnapshot,
  WorkflowSubjectHandler,
} from './workflow-subject';

/**
 * The inbox detail's `subject` from a handler's description: the shared fields plus `kind`
 * (GENERIC when the handler did not set one) and the matching `data`.
 */
export function toSubjectDetail(description: SubjectDescription): SubjectDetail {
  const base = {
    title: description.title,
    requestLabel: description.requestLabel,
    headline: description.headline,
    fields: description.fields,
  };
  switch (description.kind) {
    case 'LEAVE':
      return { ...base, kind: description.kind, data: description.data };
    case 'CREDIT_LEAVE':
      return { ...base, kind: description.kind, data: description.data };
    case 'CLAIM':
      return { ...base, kind: description.kind, data: description.data };
    case 'CHANGE_REQUEST':
      return { ...base, kind: description.kind, data: description.data };
    case 'EMPLOYEE_TRANSACTION':
      return { ...base, kind: description.kind, data: description.data };
    case 'FREE_TEXT':
      return { ...base, kind: description.kind, data: description.data };
    default:
      return { ...base, kind: 'GENERIC', data: description.data };
  }
}

/**
 * Used for a type that has no handler yet (for example TRAINING, which has no screens in v1):
 * the subject is described by the process summary and the hooks do nothing.
 */
export class GenericSubjectHandler implements WorkflowSubjectHandler {
  constructor(readonly type: WorkflowTypeCode) {}

  async describe(_client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const label = WORKFLOW_REQUEST_LABELS[process.type];
    return {
      requestLabel: label,
      title: WORKFLOW_TYPES[process.type],
      fromDate: null,
      toDate: null,
      unitsLine: null,
      headline: [],
      fields: [{ label: 'Summary', value: process.summary }],
      kind: 'GENERIC',
      data: {},
      viewLabel: `View ${label.toLowerCase()} request`,
    };
  }

  async onFinalApproval(): Promise<FinalApprovalResult> {
    return { outcome: 'APPLIED' };
  }
  async onProcess(): Promise<void> {}
  async onDeclined(): Promise<void> {}
  async onCancelled(): Promise<void> {}
}

/**
 * Subject handlers by workflow type (section 7.3). Feature modules register theirs in
 * `onModuleInit`; a second registration for a type is a programming error unless `replace` is
 * passed (tests swap in a fake handler that way and restore the original afterwards).
 */
@Injectable()
export class WorkflowSubjectRegistry {
  private readonly handlers = new Map<WorkflowTypeCode, WorkflowSubjectHandler>();

  /** Registers a handler. Returns a function that restores the previous registration. */
  register(handler: WorkflowSubjectHandler, options: { replace?: boolean } = {}): () => void {
    const previous = this.handlers.get(handler.type);
    if (previous && !options.replace) {
      throw new Error(`A workflow subject handler for ${handler.type} is already registered`);
    }
    this.handlers.set(handler.type, handler);
    return () => {
      if (this.handlers.get(handler.type) !== handler) return;
      if (previous) this.handlers.set(handler.type, previous);
      else this.handlers.delete(handler.type);
    };
  }

  has(type: WorkflowTypeCode): boolean {
    return this.handlers.has(type);
  }

  /** The registered handler, or the generic one. */
  get(type: WorkflowTypeCode): WorkflowSubjectHandler {
    return this.handlers.get(type) ?? new GenericSubjectHandler(type);
  }
}
