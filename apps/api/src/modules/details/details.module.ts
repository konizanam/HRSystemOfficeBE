import { Module, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../../jobs/jobs.service';
import { AttachmentOwnerRegistry } from '../attachments/attachment-owners';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { FreeTextModule } from '../free-text/free-text.module';
import { FreeTextService } from '../free-text/free-text.service';
import { WorkflowSubjectRegistry } from '../workflow/subject-registry';
import { WorkflowModule } from '../workflow/workflow.module';
import { BankAccountService } from './bank-account.service';
import { BanksService } from './banks.service';
import { BeneficiaryService } from './beneficiary.service';
import { CHANGE_REQUEST_WORKFLOW_TYPES, ChangeRequestHandler } from './change-request.handler';
import { CHANGE_REQUEST_ENTITY, ChangeRequestService } from './change-request.service';
import { DetailsAdminController } from './details-admin.controller';
import { DetailsNotifier } from './details-notifier.service';
import { DetailsAccess } from './details-records';
import { DetailsController } from './details.controller';
import { DriversLicenceService, LICENCE_EXPIRY_JOB } from './drivers-licence.service';
import {
  EMPLOYEE_TRANSACTION_ENTITY,
  EmployeeTransactionService,
  FreeTextManEmpHandler,
} from './employee-transaction.service';
import { FamilyService } from './family.service';
import { LookupService } from './lookup.service';
import { EMPLOYEE_ENTITY, PersonalDetailsService } from './personal-details.service';
import { ReferenceController } from './reference.controller';

/**
 * My Details (section 5.4): personal details, bank details, drivers licences, family,
 * beneficiaries and employee transactions. Employee changes go through the ChangeRequest pattern
 * (section 7.6) on the BASICINF, BANKDET, DRIVERSLICENSE and BENEFICIARY workflows; employee
 * payroll inputs through FREETEXTMANEMP. Also the lookups, banks and the HR admin endpoints.
 */
@Module({
  imports: [AuthModule, WorkflowModule, AttachmentsModule, FreeTextModule],
  controllers: [DetailsController, ReferenceController, DetailsAdminController],
  providers: [
    DetailsAccess,
    LookupService,
    BanksService,
    ChangeRequestService,
    PersonalDetailsService,
    BankAccountService,
    DriversLicenceService,
    FamilyService,
    BeneficiaryService,
    EmployeeTransactionService,
    DetailsNotifier,
  ],
  exports: [ChangeRequestService, PersonalDetailsService, LookupService, BanksService, DriversLicenceService],
})
export class DetailsModule implements OnModuleInit {
  constructor(
    private readonly registry: WorkflowSubjectRegistry,
    private readonly owners: AttachmentOwnerRegistry,
    private readonly jobs: JobsService,
    private readonly changes: ChangeRequestService,
    private readonly personal: PersonalDetailsService,
    private readonly bank: BankAccountService,
    private readonly licences: DriversLicenceService,
    private readonly family: FamilyService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly transactions: EmployeeTransactionService,
    private readonly freeText: FreeTextService,
  ) {}

  onModuleInit(): void {
    for (const applier of [this.personal, this.bank, this.licences, this.family, this.beneficiaries]) {
      this.changes.registerApplier(applier);
    }
    for (const type of CHANGE_REQUEST_WORKFLOW_TYPES) {
      this.registry.register(new ChangeRequestHandler(type, this.changes));
    }
    // One FREETEXTMANEMP handler: employee transaction inputs and "about employee" free text.
    this.registry.register(new FreeTextManEmpHandler(this.transactions, this.freeText));

    this.owners.register(CHANGE_REQUEST_ENTITY, async (client, id) => {
      const cr = await client.changeRequest.findUnique({
        where: { id: Number(id) },
        select: { employeeId: true, processId: true },
      });
      return cr ? { employeeId: cr.employeeId, processId: cr.processId } : null;
    });
    this.owners.register(EMPLOYEE_TRANSACTION_ENTITY, async (client, id) => {
      const row = await client.employeeTransaction.findUnique({
        where: { id: Number(id) },
        select: { employeeId: true, processId: true },
      });
      return row ? { employeeId: row.employeeId, processId: row.processId } : null;
    });
    this.owners.register(EMPLOYEE_ENTITY, async (client, id) => {
      const row = await client.employee.findUnique({ where: { id: Number(id) }, select: { id: true } });
      return row ? { employeeId: row.id, processId: null } : null;
    });

    // Nightly at 02:15 (Africa/Windhoek): licences expiring within 60 days.
    this.jobs.register<{ asOf?: string }>(LICENCE_EXPIRY_JOB, (data) => this.licences.notifyExpiring(data), {
      cron: '15 2 * * *',
    });
  }
}
