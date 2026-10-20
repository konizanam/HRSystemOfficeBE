import { z } from 'zod';
import { API_PREFIX, TimestampSchema } from './common';

// Contracts for file attachments (section 10.4): `POST /attachments` (multipart upload),
// `GET /attachments/:id` (audited download) and `DELETE /attachments/:id` (an unsubmitted upload).

/** Largest accepted file (section 5.2.1: max 10 MB each). */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Most files in one upload request. */
export const ATTACHMENT_MAX_FILES_PER_UPLOAD = 10;

/** Most attachments one request (a leave application, a leave in lieu request, …) may carry. */
export const ATTACHMENT_MAX_PER_REQUEST = 20;

/** Accepted MIME types and the file extensions each may have (pdf/png/jpg/jpeg/docx). */
export const ATTACHMENT_TYPES = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
} as const satisfies Record<string, readonly string[]>;

export type AttachmentMimeType = keyof typeof ATTACHMENT_TYPES;
export const ATTACHMENT_MIME_TYPES = Object.keys(ATTACHMENT_TYPES) as AttachmentMimeType[];
export const AttachmentMimeTypeSchema = z.enum(
  ATTACHMENT_MIME_TYPES as [AttachmentMimeType, ...AttachmentMimeType[]],
);

/** Extensions accepted, lower case without the dot. */
export const ATTACHMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'docx'] as const;

/** Value for an `<input type="file" accept>` attribute. */
export const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx';

/** The multipart field name for files. */
export const ATTACHMENT_UPLOAD_FIELD = 'file';

/**
 * Owner of an upload that has not been attached to a request yet. Uploads start unowned (only
 * the uploader can see or delete them) and are bound to their owner entity when the request is
 * submitted.
 */
export const UNOWNED_ATTACHMENT_OWNER = 'Unowned';

/** The audited download path of an attachment. */
export function attachmentDownloadPath(id: string): string {
  return `${API_PREFIX}/attachments/${id}`;
}

export const AttachmentIdSchema = z.string().uuid('Invalid attachment id');

/** Attachment ids sent with a submit; unique, at most {@link ATTACHMENT_MAX_PER_REQUEST}. */
export const AttachmentIdsSchema = z
  .array(AttachmentIdSchema)
  .max(ATTACHMENT_MAX_PER_REQUEST, `Attach at most ${ATTACHMENT_MAX_PER_REQUEST} files`)
  .refine((ids) => new Set(ids).size === ids.length, 'The same file is attached twice');

export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** Hex sha256 of the stored bytes. */
  sha256: z.string(),
  uploadedAt: TimestampSchema,
  /** `Unowned` until the request it was uploaded for is submitted. */
  ownerEntity: z.string(),
  /** True once bound to a request. */
  isBound: z.boolean(),
  /** Download goes through the audited attachment endpoint. */
  downloadUrl: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** POST /attachments (multipart, field `file`, one or more files). */
export const UploadAttachmentsResponseSchema = z.object({ items: z.array(AttachmentSchema) });
export type UploadAttachmentsResponse = z.infer<typeof UploadAttachmentsResponseSchema>;

/** Problem `type` values of attachment errors the web app branches on. */
export const ATTACHMENT_PROBLEM_TYPES = {
  /** Extension or declared MIME type not allowed, or the bytes do not match the MIME type. */
  invalidType: 'urn:peoplehub:problem:attachment-invalid-type',
  tooLarge: 'urn:peoplehub:problem:attachment-too-large',
  empty: 'urn:peoplehub:problem:attachment-empty',
  infected: 'urn:peoplehub:problem:attachment-infected',
  scanUnavailable: 'urn:peoplehub:problem:attachment-scan-unavailable',
  /** An id sent with a submit is not an unsubmitted upload of the caller. */
  notAvailable: 'urn:peoplehub:problem:attachment-not-available',
} as const;
