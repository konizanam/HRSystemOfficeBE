import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { DbService } from '../../src/prisma/db.service';

export interface TestApp {
  app: NestFastifyApplication;
  db: DbService;
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
    server: app.getHttpServer(),
    close: () => app.close(),
  };
}
