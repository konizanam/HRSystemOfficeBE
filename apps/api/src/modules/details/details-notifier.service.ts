import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatCardDate } from '@peoplehub/shared';
import { env } from '../../config/env';
import { type DomainEvent, type EventContext, EventBus } from '../../events/event-bus';
import { MailService } from '../notifications/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { BANK_DETAILS_CHANGED_EVENT } from './bank-account.service';

/** The bank details page the email and the notification link to. */
export const BANK_DETAILS_LINK = '/details/bank';

/**
 * "Your bank details were changed" (sections 5.4.2 and 6): when an approved bank change is
 * applied, the employee gets an in-app notification and an email, even when someone else (a
 * manager working as them) submitted it, so a fraudulent change cannot go unnoticed. The email
 * carries only the first name, the date the account is used from and a link.
 */
@Injectable()
export class DetailsNotifier implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(BANK_DETAILS_CHANGED_EVENT, (event, context) => this.bankChanged(event, context));
  }

  private async bankChanged(event: DomainEvent, { tx, afterCommit }: EventContext): Promise<void> {
    const employeeId = typeof event.payload.employeeId === 'number' ? event.payload.employeeId : null;
    const effectiveFrom =
      typeof event.payload.effectiveFrom === 'string' ? event.payload.effectiveFrom : null;
    if (employeeId === null) return;
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { firstName: true, user: { select: { id: true, email: true, isActive: true } } },
    });
    const user = employee?.user;
    if (!employee || !user || !user.isActive) return;
    const from = effectiveFrom ? formatCardDate(effectiveFrom) : 'the next pay period';
    await this.notifications.create(tx, {
      userId: user.id,
      kind: 'BANK_DETAILS_CHANGED',
      title: 'Your bank details were changed',
      body: `The bank account your pay goes into was changed and is used from ${from}. If you did not ask for this change, contact payroll straight away.`,
      link: BANK_DETAILS_LINK,
    });
    const email = user.email;
    if (!email) return;
    afterCommit(() =>
      this.mail.sendInBackground({
        to: email,
        template: 'bank-details-changed',
        data: {
          firstName: employee.firstName,
          effectiveFrom: from,
          link: `${env().PUBLIC_URL}${BANK_DETAILS_LINK}`,
        },
      }),
    );
  }
}
