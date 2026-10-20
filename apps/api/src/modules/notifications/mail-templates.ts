import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Email templates (section 6): plain HTML in src/notifications/templates, copied to dist by the
// Nest CLI. They carry no PII beyond the first name, the request type and a link.

/** Variables each template needs. Add a template by adding its file and an entry here. */
export interface MailTemplateData {
  'password-reset': { firstName: string; link: string; expiresMinutes: number };
  'password-changed': { firstName: string; link: string };
  'account-locked': { firstName: string; minutes: number; link: string };
}

export type MailTemplateName = keyof MailTemplateData;

export const MAIL_SUBJECTS: { [K in MailTemplateName]: string } = {
  'password-reset': 'Reset your PeopleHub password',
  'password-changed': 'Your PeopleHub password was changed',
  'account-locked': 'Your PeopleHub account was locked',
};

export const TEMPLATE_DIR = resolve(__dirname, '../../notifications/templates');

const cache = new Map<string, string>();

function loadTemplate(name: string): string {
  let source = cache.get(name);
  if (source === undefined) {
    source = readFileSync(resolve(TEMPLATE_DIR, `${name}.html`), 'utf8');
    cache.set(name, source);
  }
  return source;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/**
 * Replaces `{{name}}` with the HTML-escaped value and `{{{name}}}` with the raw value (only the
 * layout uses that, for the rendered body). A variable the data does not supply is an error, so a
 * template typo never reaches a user as a literal placeholder.
 */
export function renderTemplate(source: string, data: Record<string, string | number>): string {
  return source.replace(/\{\{(\{?)\s*([A-Za-z0-9_]+)\s*\}?\}\}/g, (_match, raw: string, key: string) => {
    const value = data[key];
    if (value === undefined) throw new Error(`Mail template variable "${key}" is missing`);
    return raw ? String(value) : escapeHtml(String(value));
  });
}

/** A readable plain-text alternative: links become "label: url", tags are dropped. */
export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // Source formatting (line breaks inside tags and paragraphs) carries no meaning in HTML.
  return body
    .replace(/\s+/g, ' ')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, label: string) => {
      return `${label.replace(/<[^>]+>/g, '').trim()}: ${href}`;
    })
    .replace(/<\/(p|tr|h\d)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export function renderMail<K extends MailTemplateName>(
  template: K,
  data: MailTemplateData[K],
  layout: { accentColour: string },
): RenderedMail {
  const subject = MAIL_SUBJECTS[template];
  const vars = { ...data, ...layout, subject } as Record<string, string | number>;
  const content = renderTemplate(loadTemplate(template), vars);
  const html = renderTemplate(loadTemplate('layout'), { ...vars, content });
  return { subject, html, text: htmlToText(html) };
}
