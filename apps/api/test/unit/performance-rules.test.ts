import { describe, expect, it } from 'vitest';
import type { SecurityContext } from '../../src/common/context/security-context';
import { renderMail } from '../../src/modules/notifications/mail-templates';
import { PerformanceAccess } from '../../src/modules/performance/performance-access';
import {
  scalePoints,
  sectionTotalsOf,
  toRatingScaleDto,
} from '../../src/modules/performance/performance-common';
import { ReviewNotifier } from '../../src/modules/performance/review-notifier.service';
import type { DbService } from '../../src/prisma/db.service';
import type { ScopeService } from '../../src/modules/auth/scope.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { NotificationService } from '../../src/modules/notifications/notification.service';
import type { MailService } from '../../src/modules/notifications/mail.service';

function ctx(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    userId: 'u-1',
    username: 'u1',
    roles: ['EMPLOYEE'],
    selfEmployeeId: 10,
    actingAsEmployeeId: 10,
    companyIds: [1],
    sessionId: 's',
    requestId: 'r',
    ip: '127.0.0.1',
    userAgent: 'test',
    ...overrides,
  };
}

const access = new PerformanceAccess({} as DbService, {} as ScopeService);
const notifier = new ReviewNotifier(
  {} as DbService,
  {} as AuditService,
  {} as NotificationService,
  {} as MailService,
);

describe('performance access rules', () => {
  it('lets HR in scope and auditors read every review, others only opened ones', () => {
    const hr = { actors: ['HR_ADMIN' as const], manager: false };
    const reviewee = { actors: ['REVIEWEE' as const], manager: false };
    const manager = { actors: [], manager: true };
    const nobody = { actors: [], manager: false };
    expect(access.canReadReview(ctx({ roles: ['HR_ADMIN'] }), 'DRAFT', hr)).toBe(true);
    expect(access.canReadReview(ctx({ roles: ['AUDITOR'] }), 'CANCELLED', nobody)).toBe(true);
    expect(access.canReadReview(ctx(), 'DRAFT', reviewee)).toBe(false);
    expect(access.canReadReview(ctx(), 'OPEN', reviewee)).toBe(true);
    expect(access.canReadReview(ctx(), 'COMPLETED', manager)).toBe(true);
    expect(access.canReadReview(ctx(), 'CANCELLED', reviewee)).toBe(false);
    expect(access.canReadReview(ctx(), 'OPEN', nobody)).toBe(false);
  });

  it('treats HR as HR only for employees in their companies', () => {
    expect(access.isHrFor(ctx({ roles: ['HR_ADMIN'] }), { id: 5, companyId: 1 })).toBe(true);
    expect(access.isHrFor(ctx({ roles: ['HR_ADMIN'] }), { id: 5, companyId: 2 })).toBe(false);
    expect(access.isHrFor(ctx(), { id: 5, companyId: 1 })).toBe(false);
    expect(access.isHrFor(ctx({ isSystem: true }), null)).toBe(true);
    expect(access.isSelf(ctx(), 10)).toBe(true);
    expect(access.isSelf(ctx({ selfEmployeeId: null }), 10)).toBe(false);
  });
});

describe('review notification timing', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  it('notifies Immediately once, Specific Date on or after the date, Never not at all', () => {
    expect(
      notifier.isDue({ notifyMode: 'IMMEDIATELY', notifyDate: null, notifiedAt: null }, '2026-05-01'),
    ).toBe(true);
    expect(
      notifier.isDue({ notifyMode: 'IMMEDIATELY', notifyDate: null, notifiedAt: new Date() }, '2026-05-01'),
    ).toBe(false);
    expect(
      notifier.isDue(
        { notifyMode: 'SPECIFIC_DATE', notifyDate: d('2026-05-02'), notifiedAt: null },
        '2026-05-01',
      ),
    ).toBe(false);
    expect(
      notifier.isDue(
        { notifyMode: 'SPECIFIC_DATE', notifyDate: d('2026-05-01'), notifiedAt: null },
        '2026-05-01',
      ),
    ).toBe(true);
    expect(notifier.isDue({ notifyMode: 'NEVER', notifyDate: null, notifiedAt: null }, '2026-05-01')).toBe(
      false,
    );
  });
});

describe('performance helpers', () => {
  it('reads stored rating scales and section totals', () => {
    const points = [
      { value: 1, label: 'Low' },
      { value: 3, label: 'High' },
    ];
    expect(scalePoints({ points })).toEqual(points);
    expect(scalePoints({ points: 'broken' })).toEqual([]);
    expect(toRatingScaleDto({ id: 1, name: 'S', points })).toEqual({
      id: 1,
      name: 'S',
      points,
      min: '1',
      max: '3',
    });
    expect(toRatingScaleDto({ id: 2, name: 'Empty', points: [] })).toMatchObject({ min: '0', max: '0' });
    expect(
      sectionTotalsOf([
        { kind: 'KPA', weight: '60' },
        { kind: 'KPA', weight: '30' },
        { kind: 'OBJECTIVE', weight: '100' },
      ]),
    ).toEqual([
      { section: 'KPA', total: '90.00', valid: false },
      { section: 'OBJECTIVE', total: '100.00', valid: true },
    ]);
  });

  it('renders the review email with the first name and a link only', () => {
    const mail = renderMail(
      'performance-review',
      { firstName: 'Ana', link: 'http://localhost:5173/performance/reviews/7' },
      { accentColour: '#0F766E' },
    );
    expect(mail.subject).toBe('A performance review is open');
    expect(mail.text).toContain('Hi Ana');
    expect(mail.text).toContain('http://localhost:5173/performance/reviews/7');
  });
});
