import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SESSION_COOKIE } from '@peoplehub/shared';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { env } from './config/env';
import { httpRequestDuration } from './metrics/registry';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Builds the configured Nest/Fastify app. Used by main.ts and the integration tests. */
export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });

  // Section 10.2: strict CSP (no inline scripts), HSTS, nosniff, same-origin referrer.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    origin: env()
      .WEB_ORIGIN.split(',')
      .map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'content-disposition', 'idempotent-replay'],
  });
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });
  // Limits are opted into per route (auth endpoints: 10/min/IP, section 10.1).
  await app.register(fastifyRateLimit, { global: false });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', String(req.id));
  });
  fastify.addHook('onResponse', async (req, reply) => {
    httpRequestDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unknown', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PeopleHub ESS API')
      .setDescription(
        'Employee Self-Service API. Decimals are strings; business dates are YYYY-MM-DD (Africa/Windhoek).',
      )
      .setVersion('1.0')
      .setOpenAPIVersion('3.1.0')
      .addCookieAuth(SESSION_COOKIE)
      .build(),
  );
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document), {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });

  return app;
}
