import { describe, expect, it } from 'vitest';
import {
  approvalStatusText,
  ApproveRequestSchema,
  BulkApproveRequestSchema,
  DeclineRequestSchema,
  formalName,
  type HistoryEventInput,
  historyEventLine,
  INBOX_CATEGORIES,
  InboxItemsQuerySchema,
  NotificationsQuerySchema,
  PROCESS_STATUSES,
  ParkRequestSchema,
  ProcessRequestSchema,
  renderApprovalHistory,
  type RemainingStep,
  UpdateOutOfOfficeRequestSchema,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_REQUEST_LABELS,
  WORKFLOW_TYPE_CATEGORY,
  WORKFLOW_TYPE_CODES,
  type WorkflowPerson,
  workflowTypesInCategory,
} from '../src';

const applicant = {
  employeeId: 77,
  employeeCode: 'E000077',
  firstName: 'Anna',
  lastName: 'Example',
  title: 'Ms',
  initials: 'A',
};

function person(name: string, userId = name): WorkflowPerson {
  return { userId, employeeId: 1, employeeCode: 'E000001', name, displayName: name };
}

function event(partial: Partial<HistoryEventInput> & Pick<HistoryEventInput, 'action'>): HistoryEventInput {
  return {
    id: 1,
    at: '2026-09-24T08:00:00.000Z',
    round: 1,
    stepNo: null,
    actor: null,
    from: null,
    to: null,
    comment: null,
    parkedUntil: null,
    fromStatus: null,
    toStatus: null,
    ...partial,
  };
}

describe('approval history rendering (section 1.5)', () => {
  it('reproduces the observed format exactly', () => {
    const remaining: RemainingStep[] = [
      {
        stepNo: 2,
        name: 'HR approval',
        isMandatory: true,
        approvers: [person('Mrs B Sample')],
        roleLabel: null,
        isCurrent: true,
      },
    ];
    const text = renderApprovalHistory({
      processId: 821,
      requestLabel: 'Annual Leave',
      status: 'APPROVED_PENDING_PROCESS',
      applicant,
      events: [
        event({ id: 1, action: 'CREATE', actor: person('Ms A Example') }),
        event({ id: 2, action: 'SUBMIT', actor: person('Ms A Example') }),
        event({
          id: 3,
          action: 'APPROVE',
          stepNo: 1,
          at: '2026-09-25T09:30:00.000Z',
          actor: person('Mr C Manager'),
        }),
      ],
      remaining,
    });
    expect(text).toBe(
      [
        'Approval history - Anna Example - E000077',
        'Current Status Of Request',
        'This Annual Leave Request has been Approved and is waiting to be Processed.',
        'History Of Request',
        'CREATED: New Annual Leave Request on 24 Sep 2026 by Applicant E000077 - Ms A Example',
        'Step 1',
        'Approved by Mr C Manager on 25 Sep 2026',
        'Remaining Approvers',
        'Step 2',
        'Mrs B Sample (Mandatory)',
        'Workflow Process ID: 821',
      ].join('\n'),
    );
  });

  it('groups step events under headers, restarts them per round and adds comments', () => {
    const text = renderApprovalHistory({
      processId: 5,
      requestLabel: 'Free Text',
      status: 'IN_PROGRESS',
      applicant,
      events: [
        event({ id: 1, action: 'CREATE' }),
        event({ id: 2, action: 'DELEGATE', stepNo: 1, from: person('Mr X'), to: person('Ms Y') }),
        event({ id: 3, action: 'SEND_BACK', stepNo: 1, actor: person('Ms Y'), comment: 'Add the dates' }),
        event({ id: 4, action: 'RESUBMIT', round: 2, actor: person('Ms A Example') }),
        event({ id: 5, action: 'APPROVE', round: 2, stepNo: 1, actor: person('Ms Y') }),
        event({ id: 6, action: 'AUTO_SKIP', round: 2, stepNo: 2 }),
      ],
      remaining: [
        {
          stepNo: 3,
          name: 'HR',
          isMandatory: false,
          approvers: [],
          roleLabel: 'Any HR Administrator',
          isCurrent: true,
        },
      ],
    });
    expect(text.split('\n')).toEqual([
      'Approval history - Anna Example - E000077',
      'Current Status Of Request',
      'This Free Text Request is In Progress and is waiting to be Approved.',
      'History Of Request',
      'CREATED: New Free Text Request on 24 Sep 2026 by Applicant E000077 - Ms A Example',
      'Step 1',
      'Delegated from Mr X to Ms Y (out of office) on 24 Sep 2026',
      'Sent back for resubmission by Ms Y on 24 Sep 2026',
      'Comment: Add the dates',
      'RESUBMITTED: Free Text Request resubmitted on 24 Sep 2026 by Ms A Example',
      'Step 1',
      'Approved by Ms Y on 24 Sep 2026',
      'Step 2',
      'Skipped automatically on 24 Sep 2026',
      'Remaining Approvers',
      'Step 3',
      'Any HR Administrator (Optional)',
      'Workflow Process ID: 5',
    ]);
  });

  it('uses business dates in Africa/Windhoek', () => {
    const line = historyEventLine(
      event({ action: 'APPROVE', stepNo: 1, at: '2026-09-24T22:30:00.000Z', actor: person('Mr C') }),
      { requestLabel: 'Leave', applicant },
    );
    expect(line).toBe('Approved by Mr C on 25 Sep 2026');
  });

  it('has a line (or a deliberate gap) for every action type', () => {
    const ctx = { requestLabel: 'Claim', applicant };
    const lines = Object.fromEntries(
      WORKFLOW_ACTION_TYPES.map((action) => [
        action,
        historyEventLine(
          event({
            action,
            stepNo: 1,
            actor: person('Mr C'),
            from: person('Mr F'),
            to: person('Ms T'),
            parkedUntil: '2026-10-01T22:00:00.000Z',
          }),
          ctx,
        ),
      ]),
    );
    expect(lines).toMatchObject({
      SUBMIT: null,
      DECLINE: 'Declined by Mr C on 24 Sep 2026',
      REASSIGN: 'Reassigned from Mr F to Ms T by Mr C on 24 Sep 2026',
      PARK: 'Parked by Mr C until 02 Oct 2026 on 24 Sep 2026',
      UNPARK: 'Returned from parking on 24 Sep 2026',
      ESCALATE: 'Escalated to Ms T on 24 Sep 2026',
      WITHDRAW: 'WITHDRAWN: Claim Request withdrawn on 24 Sep 2026 by Mr C',
      CANCEL: 'CANCELLED: Claim Request cancelled on 24 Sep 2026 by Mr C',
      PROCESS: 'PROCESSED: Claim Request processed on 24 Sep 2026 by Mr C',
      APPLY: 'COMPLETED: Claim Request applied on 24 Sep 2026',
      CONFLICT: 'CONFLICT: Claim Request could not be applied on 24 Sep 2026 because the record had changed',
      COMMENT: 'Comment by Mr C on 24 Sep 2026',
    });
    expect(historyEventLine(event({ action: 'REASSIGN', stepNo: 1, from: person('Mr F') }), ctx)).toBe(
      'Reassigned from Mr F by System on 24 Sep 2026',
    );
    expect(historyEventLine(event({ action: 'ESCALATE', stepNo: 1 }), ctx)).toBe(
      'Escalated as overdue on 24 Sep 2026',
    );
    expect(historyEventLine(event({ action: 'APPROVE', stepNo: 1 }), ctx)).toBe(
      'Approved by System on 24 Sep 2026',
    );
    expect(historyEventLine(event({ action: 'PARK', stepNo: 1 }), ctx)).toBe(
      'Parked by System until  on 24 Sep 2026',
    );
  });

  it('has a status sentence for every status', () => {
    for (const status of PROCESS_STATUSES) {
      expect(approvalStatusText(status, 'Leave')).toMatch(/^This Leave Request (has|is) /);
    }
    expect(approvalStatusText('APPROVED_PENDING_PROCESS', 'Annual Leave')).toBe(
      'This Annual Leave Request has been Approved and is waiting to be Processed.',
    );
  });

  it('builds formal names without empty parts', () => {
    expect(formalName({ title: 'Dr', initials: 'K N', lastName: 'Sample' })).toBe('Dr K N Sample');
    expect(formalName({ title: null, initials: ' ', lastName: 'Sample' })).toBe('Sample');
  });

  it('keeps pre-rendered event text and leaves out an empty remaining section', () => {
    const text = renderApprovalHistory({
      processId: 9,
      requestLabel: 'Leave',
      status: 'PROCESSED',
      applicant,
      events: [{ ...event({ action: 'CREATE' }), text: 'CUSTOM LINE' }],
      remaining: [],
    });
    expect(text.split('\n').slice(3)).toEqual([
      'History Of Request',
      'CUSTOM LINE',
      'Workflow Process ID: 9',
    ]);
  });
});

describe('workflow contracts', () => {
  it('requires a comment to decline and accepts an optional one to approve', () => {
    expect(DeclineRequestSchema.safeParse({ version: 1, comment: '  ' }).success).toBe(false);
    expect(DeclineRequestSchema.safeParse({ version: 1, comment: 'No' }).success).toBe(true);
    expect(ApproveRequestSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(ApproveRequestSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(ParkRequestSchema.safeParse({ version: 2, until: '2026-02-30' }).success).toBe(false);
  });

  it('rejects duplicate ids in bulk requests', () => {
    expect(
      BulkApproveRequestSchema.safeParse({
        items: [
          { id: 1, version: 1 },
          { id: 1, version: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(BulkApproveRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ProcessRequestSchema.safeParse({ ids: [3, 3], payPeriodId: 1 }).success).toBe(false);
    expect(ProcessRequestSchema.safeParse({ ids: [3, 4], payPeriodId: 1 }).success).toBe(true);
  });

  it('maps every workflow type to an inbox category and a request label', () => {
    for (const type of WORKFLOW_TYPE_CODES) {
      expect(INBOX_CATEGORIES).toContain(WORKFLOW_TYPE_CATEGORY[type]);
      expect(WORKFLOW_REQUEST_LABELS[type]).toBeTruthy();
    }
    expect(workflowTypesInCategory('LEAVE')).toEqual([
      'LEAVE',
      'CANCELLEAVE',
      'CREDITLVEALLOC',
      'CREDITLVEREQ',
    ]);
    expect(workflowTypesInCategory('BANK_DETAILS')).toEqual(['BANKDET']);
  });

  it('defaults inbox queries and parses notification flags', () => {
    expect(InboxItemsQuerySchema.parse({})).toMatchObject({
      box: 'action',
      sort: 'submittedAt:desc',
      page: 1,
      pageSize: 25,
    });
    expect(InboxItemsQuerySchema.safeParse({ sort: 'summary:asc' }).success).toBe(false);
    expect(NotificationsQuerySchema.parse({ unreadOnly: 'false' }).unreadOnly).toBe(false);
    expect(NotificationsQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(NotificationsQuerySchema.parse({}).unreadOnly).toBeUndefined();
  });

  it('validates out-of-office settings', () => {
    const nominee = '5f7c2b8e-3c1a-4c55-9d7e-0a1b2c3d4e5f';
    expect(
      UpdateOutOfOfficeRequestSchema.safeParse({ mode: 'OFF', mainNomineeUserId: null, version: 0 }).success,
    ).toBe(true);
    const range = UpdateOutOfOfficeRequestSchema.safeParse({
      mode: 'DATE_RANGE',
      fromDate: '2026-10-10',
      toDate: '2026-10-01',
      mainNomineeUserId: nominee,
      version: 1,
    });
    expect(range.success).toBe(false);
    expect(range.error?.issues.map((i) => i.path.join('.'))).toEqual(['toDate']);
    const missing = UpdateOutOfOfficeRequestSchema.safeParse({
      mode: 'DATE_RANGE',
      mainNomineeUserId: null,
      rules: [
        { workflowType: 'LEAVE', nomineeUserId: nominee },
        { workflowType: 'LEAVE', nomineeUserId: nominee },
      ],
      version: 1,
    });
    expect(missing.error?.issues.map((i) => i.path.join('.'))).toEqual([
      'fromDate',
      'toDate',
      'mainNomineeUserId',
      'rules.1.workflowType',
    ]);
  });
});
