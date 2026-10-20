import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { ProblemFilter } from './common/errors/problem.filter';
import { env } from './config/env';
import { CoreModule } from './core.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env().NODE_ENV === 'test' ? 'silent' : env().LOG_LEVEL,
        // Never log PII or secrets (section 2): no bodies, and credentials are redacted.
        redact: {
          paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers["x-csrf-token"]',
            'req.headers["idempotency-key"]',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        customProps: (req) => ({ requestId: (req as { id?: unknown }).id }),
        serializers: {
          req: (req: { id: unknown; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url.split('?')[0],
          }),
        },
        transport:
          env().NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    CoreModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
