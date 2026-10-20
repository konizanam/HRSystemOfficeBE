import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { AttachmentOwnerRegistry } from './attachment-owners';
import { AttachmentService } from './attachment.service';
import { AttachmentsController } from './attachments.controller';
import { VIRUS_SCANNER, virusScannerFromEnv } from './virus-scanner';

/**
 * File attachments (section 10.4). Feature modules import this module to bind uploads to their
 * requests (`AttachmentService.bind`) and register an owner resolver for the download check
 * (`AttachmentOwnerRegistry.register`).
 */
@Module({
  imports: [AuthModule, WorkflowModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentService,
    AttachmentOwnerRegistry,
    { provide: VIRUS_SCANNER, useFactory: virusScannerFromEnv },
  ],
  exports: [AttachmentService, AttachmentOwnerRegistry],
})
export class AttachmentsModule {}
