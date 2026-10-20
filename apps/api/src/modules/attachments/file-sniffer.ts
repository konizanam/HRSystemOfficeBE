import { ATTACHMENT_TYPES, type AttachmentMimeType } from '@peoplehub/shared';

// A small magic-byte sniffer for the four accepted upload types (section 10.4). The declared MIME
// type and the file extension are client input; only the leading bytes decide what a file is.

const PDF = Buffer.from('%PDF-', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Every OOXML package has this part; a Word document also has parts under `word/`. */
const OOXML_CONTENT_TYPES = Buffer.from('[Content_Types].xml', 'latin1');
const WORD_DOCUMENT = Buffer.from('word/document.xml', 'latin1');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

/**
 * The type the bytes say the file is, or null when they match none of the accepted types. A DOCX
 * is a ZIP archive whose (uncompressed) entry names include `[Content_Types].xml` and
 * `word/document.xml`; a plain ZIP or another Office format is not accepted.
 */
export function sniffMimeType(buffer: Buffer): AttachmentMimeType | null {
  if (startsWith(buffer, PDF)) return 'application/pdf';
  if (startsWith(buffer, PNG)) return 'image/png';
  if (startsWith(buffer, JPEG)) return 'image/jpeg';
  if (
    startsWith(buffer, ZIP_LOCAL_HEADER) &&
    buffer.includes(OOXML_CONTENT_TYPES) &&
    buffer.includes(WORD_DOCUMENT)
  ) {
    return DOCX;
  }
  return null;
}

/** Lower-case extension without the dot, or '' when the name has none. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The accepted MIME type an extension stands for, or null. */
export function mimeTypeForExtension(extension: string): AttachmentMimeType | null {
  for (const [mime, extensions] of Object.entries(ATTACHMENT_TYPES) as [
    AttachmentMimeType,
    readonly string[],
  ][]) {
    if (extensions.includes(extension)) return mime;
  }
  return null;
}

/** Normalises what browsers send ("image/jpg", "image/pjpeg", parameters, case). */
export function normaliseMimeType(declared: string | undefined): string {
  const base = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg';
  if (base === 'application/x-pdf') return 'application/pdf';
  return base;
}

/** Declared types that say nothing about the content; the extension decides the expected type. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export type FileCheck = { ok: true; mimeType: AttachmentMimeType } | { ok: false; reason: string };

/**
 * Checks an upload: the extension must be accepted, the declared MIME type must agree with it
 * (a generic declaration is replaced by the extension's type), and the magic bytes must match.
 */
export function checkFile(fileName: string, declaredMimeType: string | undefined, bytes: Buffer): FileCheck {
  const byExtension = mimeTypeForExtension(extensionOf(fileName));
  if (!byExtension) return { ok: false, reason: 'Only PDF, PNG, JPG and DOCX files can be attached' };
  const declared = normaliseMimeType(declaredMimeType);
  const expected = GENERIC_TYPES.has(declared) ? byExtension : declared;
  if (expected !== byExtension) {
    return { ok: false, reason: 'The file type does not match the file name' };
  }
  const sniffed = sniffMimeType(bytes);
  if (sniffed !== expected) {
    return { ok: false, reason: 'The file content does not match its type' };
  }
  return { ok: true, mimeType: sniffed };
}

/** A file name safe to store and to put in a Content-Disposition header. */
export function safeFileName(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? 'file')
    // Control characters and characters that break headers or paths.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_')
    .trim();
  return (base || 'file').slice(0, 200);
}
