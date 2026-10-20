import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { type MailTemplateData, type MailTemplateName, renderMail } from './mail-templates';

export interface MailMessage<K extends MailTemplateName = MailTemplateName> {
  to: string;
  template: K;
  data: MailTemplateData[K];
}

/** A message as it was handed to the transport. In memory mode these are kept in `outbox`. */
export interface SentMail {
  messageId: string;
  from: string;
  to: string;
  template: MailTemplateName;
  subject: string;
  html: string;
  text: string;
  sentAt: Date;
}

/** Memory-mode outbox size; older messages are dropped first. */
const OUTBOX_LIMIT = 500;

/**
 * Sends templated email through nodemailer (SMTP_* settings). With MAIL_TRANSPORT=memory nothing
 * leaves the process: messages are rendered and kept in `outbox` for tests to read.
 *
 * Request handlers normally use `sendInBackground`, so a slow or failing mail server neither
 * delays the response nor reveals (through timing) whether an account exists.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly pending = new Set<Promise<unknown>>();
  readonly outbox: SentMail[] = [];

  constructor(private readonly settings: SettingsService) {
    const e = env();
    this.transporter =
      e.MAIL_TRANSPORT === 'memory'
        ? null
        : createTransport({
            host: e.SMTP_HOST,
            port: e.SMTP_PORT,
            secure: e.SMTP_SECURE,
            auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS ?? '' } : undefined,
          });
  }

  async send<K extends MailTemplateName>(message: MailMessage<K>): Promise<SentMail> {
    const [fromSetting, accentColour] = await Promise.all([
      this.settings.get('mail.from'),
      this.settings.get('ui.accentColour'),
    ]);
    const from = fromSetting ?? env().MAIL_FROM;
    const rendered = renderMail(message.template, message.data, { accentColour });
    let messageId = `<${randomUUID()}@peoplehub.local>`;
    if (this.transporter) {
      const info = (await this.transporter.sendMail({
        from,
        to: message.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      })) as { messageId?: string };
      messageId = info.messageId ?? messageId;
    }
    const sent: SentMail = {
      messageId,
      from,
      to: message.to,
      template: message.template,
      ...rendered,
      sentAt: new Date(),
    };
    if (!this.transporter) {
      this.outbox.push(sent);
      if (this.outbox.length > OUTBOX_LIMIT) this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT);
    }
    return sent;
  }

  /** Sends without awaiting; failures are logged (without the recipient) and never thrown. */
  sendInBackground<K extends MailTemplateName>(message: MailMessage<K>): void {
    const job = this.send(message).catch((err: unknown) => {
      this.logger.error({ err, template: message.template }, 'Failed to send email');
    });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Resolves once every background send has finished (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Memory mode: messages sent to an address, oldest first. */
  sentTo(address: string): SentMail[] {
    const target = address.toLowerCase();
    return this.outbox.filter((m) => m.to.toLowerCase() === target);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
    this.transporter?.close();
  }
}
