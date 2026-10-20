import { Module, type OnModuleInit } from '@nestjs/common';
import { AttachmentOwnerRegistry } from '../attachments/attachment-owners';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowSubjectRegistry } from '../workflow/subject-registry';
import { WorkflowModule } from '../workflow/workflow.module';
import { ClaimAdminController } from './claim-admin.controller';
import { ClaimAdminService } from './claim-admin.service';
import { ClaimBalanceService } from './claim-balance.service';
import { CLAIM_ENTITY, CLAIM_LINE_ENTITY, CLAIM_WORKFLOW_TYPES } from './claim-constants';
import { ClaimSetupService } from './claim-setup.service';
import { ClaimSubjectHandler, ClaimWorkflowService } from './claim-workflow';
import { ClaimService } from './claim.service';
import { ClaimWriter } from './claim.writer';
import { ClaimsController } from './claims.controller';

/**
 * Claims (section 5.3): groups, types and caps, drafts and their lines, submit with caps and
 * mandatory attachments, the GROUPEDCLAIM and CLAIMS workflows, My Expense Claims with its
 * export, the balances grid and the HR/Payroll admin API.
 */
@Module({
  imports: [AuthModule, WorkflowModule, AttachmentsModule],
  controllers: [ClaimsController, ClaimAdminController],
  providers: [
    ClaimSetupService,
    ClaimBalanceService,
    ClaimWriter,
    ClaimService,
    ClaimWorkflowService,
    ClaimAdminService,
  ],
  exports: [ClaimService, ClaimSetupService, ClaimBalanceService],
})
export class ClaimsModule implements OnModuleInit {
  constructor(
    private readonly registry: WorkflowSubjectRegistry,
    private readonly owners: AttachmentOwnerRegistry,
    private readonly workflow: ClaimWorkflowService,
  ) {}

  onModuleInit(): void {
    for (const type of CLAIM_WORKFLOW_TYPES) {
      this.registry.register(new ClaimSubjectHandler(type, this.workflow));
    }
    this.owners.register(CLAIM_ENTITY, async (client, id) => {
      const claim = await client.claim.findUnique({
        where: { id: Number(id) },
        select: { employeeId: true, processId: true },
      });
      return claim ? { employeeId: claim.employeeId, processId: claim.processId } : null;
    });
    this.owners.register(CLAIM_LINE_ENTITY, async (client, id) => {
      const line = await client.claimLine.findUnique({
        where: { id: Number(id) },
        select: { claim: { select: { employeeId: true, processId: true } } },
      });
      return line ? { employeeId: line.claim.employeeId, processId: line.claim.processId } : null;
    });
  }
}
