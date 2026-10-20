import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { MailService } from '../../src/modules/notifications/mail.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { DbService } from '../../src/prisma/db.service';

export interface TestApp {
  app: NestFastifyApplication;
  db: DbService;
  /** Memory-mode mail: read `mail.outbox`, await `mail.flush()` after background sends. */
  mail: MailService;
  settings: SettingsService;
  /** The Node HTTP server for supertest. */
  server: NestFastifyApplication['getHttpServer'] extends () => infer S ? S : never;
  close(): Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    db: app.get(DbService),
    mail: app.get(MailService),
    settings: app.get(SettingsService),
    server: app.getHttpServer(),
    close: () => app.close(),
  };
}
