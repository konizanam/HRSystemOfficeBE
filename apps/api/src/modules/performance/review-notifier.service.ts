import { Injectable } from '@nestjs/common';
import {
  businessFromDate,
  formatCardDate,
  REVIEW_LIVE_STATUSES,
  todayBusinessDate,
  dateFromBusiness,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { type SecurityContext, systemContext } from '../../common/context/security-context';
import { env } from '../../config/env';
import type { JobCounts } from '../../jobs/jobs.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { MailService } from '../notifications/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { PERFORMANCE_REVIEW_NOTIFY_JOB, REVIEW_ENTITY } from './performance-common';

/**
 * Review notifications (section 5.9 "Notify: Immediately | Never | Specific Date"). IMMEDIATELY
 * notifies the participants when the review is opened; SPECIFIC_DATE notifies on that date (the
 * daily `performance.reviewNotify` job, or straight away when a review is opened on or after the
 * date); NEVER sends nothing. Each review is notified once (`Review.notifiedAt`). Participants get
 * an in-app notification and an email with their first name and a link only.
 */
@Injectable()
export class ReviewNotifier {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
  ) {}

  /** True when an open review with this notify setting should be notified on `today`. */
  isDue(
    review: { notifyMode: string; notifyDate: Date | null; notifiedAt: Date | null },
    today: string,
  ): boolean {
    if (review.notifiedAt) return false;
    if (review.notifyMode === 'IMMEDIATELY') return true;
    return (
      review.notifyMode === 'SPECIFIC_DATE' &&
      !!review.notifyDate &&
      businessFromDate(review.notifyDate) <= today
    );
  }

  /** Notifies every participant with an active user account and stamps `notifiedAt`. */
  async notify(tx: Tx, ctx: SecurityContext, reviewId: number): Promise<number> {
    const review = await tx.review.findUniqueOrThrow({
      where: { id: reviewId },
      include: {
        employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        participants: { where: { deletedAt: null } },
      },
    });
    const userIds = [...new Set(review.participants.map((p) => p.userId).filter((id): id is string => !!id))];
    const users = await tx.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, email: true, username: true, employee: { select: { firstName: true } } },
    });
    const reviewee = review.employee
      ? `${review.employee.firstName} ${review.employee.lastName} - ${review.employee.employeeCode}`
      : 'an employee';
    const period = `${formatCardDate(review.cycleStartDate)} to ${formatCardDate(review.cycleEndDate)}`;
    for (const user of users) {
      const roles = review.participants.filter((p) => p.userId === user.id).map((p) => p.role);
      const isReviewee = roles.includes('REVIEWEE');
      await this.notifications.create(tx, {
        userId: user.id,
        kind: 'PERFORMANCE_REVIEW',
        title: isReviewee ? 'Your performance review is open' : 'A performance review needs your input',
        body: isReviewee
          ? `The review "${review.name}" (${period}) is open.`
          : `You are a reviewer of ${reviewee} in "${review.name}" (${period}).`,
        link: `/performance/reviews/${review.id}`,
      });
      const email = user.email;
      if (email) {
        const firstName = user.employee?.firstName ?? user.username;
        this.db.afterCommit(() =>
          this.mail.sendInBackground({
            to: email,
            template: 'performance-review',
            data: { firstName, link: `${env().PUBLIC_URL}/performance/reviews/${review.id}` },
          }),
        );
      }
    }
    const after = await tx.review.update({ where: { id: reviewId }, data: { notifiedAt: new Date() } });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'REVIEW.NOTIFIED',
      entityType: REVIEW_ENTITY,
      entityId: reviewId,
      subjectEmployeeId: review.employeeId,
      before: { notifiedAt: null },
      after: { notifiedAt: after.notifiedAt },
      metadata: { notifyMode: review.notifyMode, recipients: users.length },
    });
    return users.length;
  }

  /** The daily job: open reviews whose "Specific Date" has come and that were not notified yet. */
  async notifyDue(data: { asOf?: string } = {}): Promise<JobCounts> {
    const today = data.asOf ?? todayBusinessDate();
    const ctx = systemContext(`job-${PERFORMANCE_REVIEW_NOTIFY_JOB}`);
    const due = await this.db.prisma.review.findMany({
      where: {
        notifyMode: 'SPECIFIC_DATE',
        notifiedAt: null,
        notifyDate: { lte: dateFromBusiness(today) },
        status: { in: REVIEW_LIVE_STATUSES.filter((s) => s !== 'COMPLETED') },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let reviews = 0;
    let recipients = 0;
    for (const { id } of due) {
      const sent = await this.db.tx(ctx, async (tx) => {
        await this.db.lockRow(tx, 'Review', id);
        const review = await tx.review.findUniqueOrThrow({ where: { id } });
        if (!this.isDue(review, today)) return null;
        return this.notify(tx, ctx, id);
      });
      if (sent !== null) {
        reviews += 1;
        recipients += sent;
      }
    }
    return { due: due.length, reviews, recipients };
  }
}
