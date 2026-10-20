import { Injectable } from '@nestjs/common';
import type { Notification as NotificationRow, Prisma } from '@prisma/client';
import type {
  Notification,
  NotificationKind,
  NotificationReadAllResponse,
  NotificationReadResponse,
  NotificationsQuery,
  NotificationsResponse,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Path inside the web app, e.g. `/inbox/items/42`. */
  link: string | null;
}

export function toNotificationDto(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    link: row.link,
    isRead: row.readAt !== null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * In-app notifications (section 6): the bell count and the Notification Inbox. Rows are created
 * by event listeners inside the outbox delivery transaction; a user only ever sees their own.
 * Notifications belong to the signed-in user, not to the "Working as" employee.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly db: DbService) {}

  async create(tx: Tx, input: NewNotification): Promise<void> {
    await tx.notification.create({ data: input });
  }

  unreadCount(userId: string): Promise<number> {
    return this.db.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async list(ctx: SecurityContext, query: NotificationsQuery): Promise<NotificationsResponse> {
    const where: Prisma.NotificationWhereInput = { userId: ctx.userId };
    if (query.unreadOnly) where.readAt = null;
    const [rows, total, unreadCount] = await Promise.all([
      this.db.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.notification.count({ where }),
      this.unreadCount(ctx.userId),
    ]);
    return {
      items: rows.map(toNotificationDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
      unreadCount,
    };
  }

  /** Marks one of the caller's notifications read. Someone else's notification is a 404. */
  async markRead(ctx: SecurityContext, id: string): Promise<NotificationReadResponse> {
    const row = await this.db.prisma.notification.findFirst({ where: { id, userId: ctx.userId } });
    if (!row) throw new NotFoundError('Notification');
    const updated = row.readAt
      ? row
      : await this.db.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return { notification: toNotificationDto(updated), unreadCount: await this.unreadCount(ctx.userId) };
  }

  async markAllRead(ctx: SecurityContext): Promise<NotificationReadAllResponse> {
    const result = await this.db.prisma.notification.updateMany({
      where: { userId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count, unreadCount: await this.unreadCount(ctx.userId) };
  }
}
