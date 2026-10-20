import { Global, Module } from '@nestjs/common';
import { AuditAnchorJob } from './audit/audit-anchor.job';
import { AuditService } from './audit/audit.service';
import { AuditViewInterceptor } from './common/http/audit-view';
import { IdempotencyInterceptor } from './common/http/idempotency';
import { EncryptionService } from './crypto/encryption.service';
import { JobsService } from './jobs/jobs.service';
import { DbService } from './prisma/db.service';
import { StorageService } from './storage/storage.service';

/** Cross-cutting services every feature module uses (Phase 1). */
@Global()
@Module({
  providers: [
    DbService,
    AuditService,
    EncryptionService,
    StorageService,
    JobsService,
    AuditAnchorJob,
    AuditViewInterceptor,
    IdempotencyInterceptor,
  ],
  exports: [
    DbService,
    AuditService,
    EncryptionService,
    StorageService,
    JobsService,
    AuditViewInterceptor,
    IdempotencyInterceptor,
  ],
})
export class CoreModule {}
