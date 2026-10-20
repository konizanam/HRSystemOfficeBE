import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { AuditApiController } from './audit-api.controller';
import { AuditApiService } from './audit-api.service';
import { EntityHistoryAccess } from './entity-history-access';

/** The audit explorer, record history, chain verification and export (sections 9.7, 12.11). */
@Module({
  imports: [AuthModule, WorkflowModule],
  controllers: [AuditApiController],
  providers: [AuditApiService, EntityHistoryAccess],
})
export class AuditApiModule {}
