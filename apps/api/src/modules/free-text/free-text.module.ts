import { Module, type OnModuleInit } from '@nestjs/common';
import { AttachmentOwnerRegistry } from '../attachments/attachment-owners';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowSubjectRegistry } from '../workflow/subject-registry';
import { WorkflowModule } from '../workflow/workflow.module';
import { FreeTextAdminController, FreeTextController } from './free-text.controller';
import { FreeTextHandler } from './free-text.handler';
import { FREE_TEXT_ENTITY, FreeTextService } from './free-text.service';

/**
 * The Free Text Workflow (section 5.8): the employee API, HR's free text types, the FREETEXT
 * subject handler and the attachment owner of free text requests. FREETEXTMANEMP keeps its single
 * handler in the details module, which imports this module for its FreeTextRequest branch.
 */
@Module({
  imports: [AuthModule, WorkflowModule, AttachmentsModule],
  controllers: [FreeTextController, FreeTextAdminController],
  providers: [FreeTextService],
  exports: [FreeTextService],
})
export class FreeTextModule implements OnModuleInit {
  constructor(
    private readonly registry: WorkflowSubjectRegistry,
    private readonly owners: AttachmentOwnerRegistry,
    private readonly freeText: FreeTextService,
  ) {}

  onModuleInit(): void {
    this.registry.register(new FreeTextHandler(this.freeText));
    this.owners.register(FREE_TEXT_ENTITY, async (client, id) => {
      const row = await client.freeTextRequest.findUnique({
        where: { id: Number(id) },
        select: { applicantId: true, processId: true },
      });
      return row ? { employeeId: row.applicantId, processId: row.processId } : null;
    });
  }
}
