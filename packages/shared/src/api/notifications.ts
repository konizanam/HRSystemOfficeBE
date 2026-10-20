import { z } from 'zod';
import { TimestampSchema } from './common';

// Contracts for in-app notifications (section 6): the bell count and the Notification Inbox.

/** Every notification kind (section 6). Phase 3 sends the WORKFLOW_* kinds. */
export const NOTIFICATION_KINDS = [
  'WORKFLOW_SUBMITTED',
  'WORKFLOW_APPROVAL_REQUIRED',
  'WORKFLOW_STEP_APPROVED',
  'WORKFLOW_APPROVED',
  'WORKFLOW_DECLINED',
  'WORKFLOW_SENT_BACK',
  'WORKFLOW_CANCELLED',
  'WORKFLOW_PROCESSED',
  'WORKFLOW_ESCALATED',
  'WORKFLOW_REASSIGNED',
  'WORKFLOW_DELEGATED',
  'WORKFLOW_PARKED_DUE',
  'WORKFLOW_DELEGATION_CYCLE',
  'WORKFLOW_CONFLICT',
  'BANK_DETAILS_CHANGED',
  'LICENCE_EXPIRING',
  'PASSWORD_CHANGED',
  'ACCOUNT_LOCKED',
  'PERFORMANCE_REVIEW',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  title: z.string(),
  body: z.string(),
  /** Path inside the web app, e.g. "/inbox/items/42". */
  link: z.string().nullable(),
  isRead: z.boolean(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

const BooleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** GET /notifications?page=&pageSize=&unreadOnly=true. Newest first. */
export const NotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: BooleanQuerySchema,
});
export type NotificationsQuery = z.infer<typeof NotificationsQuerySchema>;

export const NotificationsResponseSchema = z.object({
  items: z.array(NotificationSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** The bell count. */
  unreadCount: z.number().int(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;

/** POST /notifications/:id/read. */
export const NotificationReadResponseSchema = z.object({
  notification: NotificationSchema,
  unreadCount: z.number().int(),
});
export type NotificationReadResponse = z.infer<typeof NotificationReadResponseSchema>;

/** POST /notifications/read-all. */
export const NotificationReadAllResponseSchema = z.object({
  updated: z.number().int(),
  unreadCount: z.number().int(),
});
export type NotificationReadAllResponse = z.infer<typeof NotificationReadAllResponseSchema>;

export const NotificationIdParamSchema = z.object({ id: z.string().uuid() });
