import {
  AuditFiltersSchema,
  AuditListQuerySchema,
  CreateHolidayRuleRequestSchema,
  CreateUserRequestSchema,
  freeTextWorkflowType,
  workflowStepIssues,
  type WorkflowStepInput,
} from '@peoplehub/shared';
import { describe, expect, it } from 'vitest';
import type { SecurityContext } from '../../src/common/context/security-context';
import {
  auditConditions,
  changesOf,
  hidesPayData,
  instantFrom,
  instantTo,
  PAY_DATA_HIDDEN,
  type RawAuditRow,
  toAuditDetail,
  toAuditRow,
  whereSql,
} from '../../src/modules/audit-api/audit-query';
import { freeTextDiscriminator } from '../../src/modules/free-text/free-text.service';
import { settingsRevision } from '../../src/modules/settings/settings.service';

function ctx(roles: SecurityContext['roles']): SecurityContext {
  return {
    userId: 'u',
    username: 'u',
    roles,
    selfEmployeeId: 1,
    actingAsEmployeeId: 1,
    companyIds: [],
    sessionId: 's',
    requestId: 'r',
    ip: '127.0.0.1',
    userAgent: 'test',
  };
}

function raw(overrides: Partial<RawAuditRow> = {}): RawAuditRow {
  return {
    id: 42n,
    occurredAt: new Date('2026-10-20T10:00:00Z'),
    requestId: 'req-1',
    sessionId: 'sess-1',
    actorUserId: 'u1',
    actorUsername: 'alice',
    actingAsEmployeeId: 7,
    subjectEmployeeId: 7,
    category: 'DATA_CHANGE',
    action: 'PAYSLIP.IMPORTED',
    entityType: 'Payslip',
    entityId: '9',
    outcome: 'SUCCESS',
    before: null,
    after: { payRun: 'MAIN', grossPay: '1000.00', lines: [{ amount: '5.00' }] },
    changes: [
      { path: 'grossPay', from: null, to: '1000.00' },
      { path: 'payRun', from: null, to: 'MAIN' },
    ],
    reason: null,
    ip: '10.0.0.1',
    userAgent: 'agent',
    metadata: { amount: '1.00', note: 'x' },
    prevHash: 'a',
    hash: 'b',
    ...overrides,
  };
}

const step = (s: Partial<WorkflowStepInput> & Pick<WorkflowStepInput, 'stepNo'>): WorkflowStepInput => ({
  name: 'Step',
  resolution: 'REPORTS_TO',
  approverRole: null,
  approverUserId: null,
  isMandatory: true,
  skipIfSameApprover: true,
  escalationHours: null,
  ...s,
});

describe('audit API helpers', () => {
  it('turns dates into Africa/Windhoek day bounds and keeps timestamps as given', () => {
    expect(instantFrom('2026-10-20').toISOString()).toBe('2026-10-19T22:00:00.000Z');
    expect(instantTo('2026-10-20')).toEqual({ at: new Date('2026-10-20T22:00:00.000Z'), inclusive: false });
    expect(instantTo('2026-10-20T12:00:00Z')).toEqual({
      at: new Date('2026-10-20T12:00:00Z'),
      inclusive: true,
    });
  });

  it('builds one SQL condition per filter, escaping LIKE wildcards', () => {
    const filters = AuditFiltersSchema.parse({
      from: '2026-10-01',
      to: '2026-10-20T12:00:00Z',
      actorUsername: 'al_ice',
      categories: 'AUTH,SECURITY',
      outcomes: 'DENIED',
      action: 'AUTH.',
      entityType: 'User',
      entityId: 'x',
      subjectEmployeeId: '7',
      actorUserId: 'u1',
      q: '50%',
    });
    const conditions = auditConditions(filters);
    expect(conditions).toHaveLength(11);
    const sql = whereSql(conditions);
    expect(sql.sql).toContain('metadata::text ILIKE');
    expect(sql.values).toContain('%al\\_ice%');
    expect(sql.values).toContain('%50\\%%');
    expect(sql.values).toContainEqual(['AUTH', 'SECURITY']);
    expect(whereSql([]).sql).toBe('');
    expect(() => AuditListQuerySchema.parse({ nope: 1 })).toThrow();
  });

  it('reads changes defensively', () => {
    expect(changesOf(null)).toEqual([]);
    expect(changesOf([{ path: 'a', from: 1 }, 'junk', { nope: true }])).toEqual([
      { path: 'a', from: 1, to: null },
    ]);
  });

  it('hides pay data from a system admin only, and plumbing from non-auditors', () => {
    expect(hidesPayData(ctx(['SYSTEM_ADMIN']))).toBe(true);
    expect(hidesPayData(ctx(['SYSTEM_ADMIN', 'PAYROLL_ADMIN']))).toBe(false);
    expect(hidesPayData(ctx(['AUDITOR']))).toBe(false);

    const sys = toAuditDetail(raw(), ctx(['SYSTEM_ADMIN']));
    expect(sys.payDataHidden).toBe(true);
    expect(sys.after).toEqual({ payRun: 'MAIN', grossPay: PAY_DATA_HIDDEN, lines: PAY_DATA_HIDDEN });
    expect(sys.changes).toEqual([
      { path: 'grossPay', from: PAY_DATA_HIDDEN, to: PAY_DATA_HIDDEN },
      { path: 'payRun', from: null, to: 'MAIN' },
    ]);
    expect(sys.metadata).toEqual({ amount: PAY_DATA_HIDDEN, note: 'x' });

    const auditor = toAuditDetail(raw(), ctx(['AUDITOR']));
    expect(auditor).toMatchObject({ payDataHidden: false, ip: '10.0.0.1', sessionId: 'sess-1' });
    expect(auditor.after).toEqual(raw().after);

    // A leave row keeps its amounts even for a system admin (only payroll entities are pay data).
    const leave = toAuditDetail(
      raw({ entityType: 'LeaveApplication', after: { amount: '2.0000' } }),
      ctx(['SYSTEM_ADMIN']),
    );
    expect(leave.after).toEqual({ amount: '2.0000' });

    const employee = toAuditRow(raw(), ctx(['EMPLOYEE']));
    expect(employee).toMatchObject({
      id: '42',
      ip: null,
      requestId: null,
      changedFields: ['grossPay', 'payRun'],
    });
  });
});

describe('admin contract rules', () => {
  it('checks workflow steps: contiguous numbers and the approver of each resolution', () => {
    expect(workflowStepIssues([step({ stepNo: 1 }), step({ stepNo: 2 })])).toEqual([]);
    expect(workflowStepIssues([])).toEqual([{ path: 'steps', message: 'Add at least one step' }]);
    expect(workflowStepIssues([step({ stepNo: 1 }), step({ stepNo: 3 })]).map((i) => i.path)).toEqual([
      'steps.1.stepNo',
    ]);
    expect(workflowStepIssues([step({ stepNo: 1 }), step({ stepNo: 1 })]).map((i) => i.path)).toEqual([
      'steps.1.stepNo',
    ]);
    expect(workflowStepIssues([step({ stepNo: 1, resolution: 'ROLE' })]).map((i) => i.path)).toEqual([
      'steps.0.approverRole',
    ]);
    expect(
      workflowStepIssues([step({ stepNo: 1, resolution: 'SPECIFIC_USER', approverRole: 'HR_ADMIN' })]).map(
        (i) => i.path,
      ),
    ).toEqual(['steps.0.approverUserId', 'steps.0.approverRole']);
    expect(workflowStepIssues(Array.from({ length: 11 }, (_, i) => step({ stepNo: i + 1 })))[0]?.path).toBe(
      'steps',
    );
  });

  it('validates holiday rules and user creation', () => {
    expect(CreateHolidayRuleRequestSchema.safeParse({ name: 'x', kind: 'FIXED', month: 1 }).success).toBe(
      false,
    );
    expect(
      CreateHolidayRuleRequestSchema.safeParse({ name: 'x', kind: 'FIXED', month: 1, day: 1 }).success,
    ).toBe(true);
    expect(
      CreateHolidayRuleRequestSchema.safeParse({
        name: 'x',
        kind: 'EASTER_RELATIVE',
        easterOffsetDays: 1,
        validFromYear: 2030,
        validToYear: 2029,
      }).success,
    ).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ username: 'abc', roles: ['EMPLOYEE'] }).success).toBe(false);
    expect(
      CreateUserRequestSchema.safeParse({ username: 'abc', roles: ['EMPLOYEE'], email: 'a@b.test' }).success,
    ).toBe(true);
    expect(
      CreateUserRequestSchema.safeParse({ username: 'abc', roles: ['EMPLOYEE'], authProvider: 'OAUTH' })
        .success,
    ).toBe(false);
    expect(
      CreateUserRequestSchema.safeParse({
        username: 'abc',
        roles: ['EMPLOYEE', 'EMPLOYEE'],
        email: 'a@b.test',
      }).success,
    ).toBe(false);
  });

  it('maps free text types to their workflow and discriminator', () => {
    expect(freeTextWorkflowType({ requiresSubjectEmployee: false })).toBe('FREETEXT');
    expect(freeTextWorkflowType({ requiresSubjectEmployee: true })).toBe('FREETEXTMANEMP');
    expect(freeTextDiscriminator('ONBOARD_ARRIVAL')).toBe('FT:ONBOARD_ARRIVAL');
  });

  it('derives the settings revision from every stored key and change time', () => {
    const at = new Date('2026-10-20T10:00:00Z');
    const a = settingsRevision([
      { key: 'ui.helpUrl', updatedAt: at },
      { key: 'session.idleMinutes', updatedAt: at },
    ]);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    // Order does not matter, unknown keys are ignored, a newer change gives a new revision.
    expect(
      settingsRevision([
        { key: 'session.idleMinutes', updatedAt: at },
        { key: 'ui.helpUrl', updatedAt: at },
        { key: 'not.a.setting', updatedAt: new Date() },
      ]),
    ).toBe(a);
    expect(settingsRevision([{ key: 'ui.helpUrl', updatedAt: new Date('2026-10-21T00:00:00Z') }])).not.toBe(
      a,
    );
  });
});
