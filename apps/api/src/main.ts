import 'reflect-metadata';
import { createApp } from './app.factory';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen({ port: env().PORT, host: '0.0.0.0' });
}

void bootstrap();
