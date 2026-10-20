import { Module, type OnModuleInit } from '@nestjs/common';
import { AttachmentOwnerRegistry } from '../attachments/attachment-owners';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { EMPLOYEE_PHOTO_ENTITY, EmployeeAdminService } from './employee-admin.service';
import { EmployeeImportService } from './employee-import.service';
import { HolidayAdminService } from './holiday-admin.service';
import { HolidayAdminController, OrganisationAdminController } from './organisation-admin.controller';
import { OrganisationAdminService } from './organisation-admin.service';
import { PayPeriodAdminService } from './pay-period-admin.service';
import { EmployeeAdminController, UserAdminController } from './people-admin.controller';
import { PayPeriodAdminController, WorkflowDefinitionAdminController } from './process-admin.controller';
import { UserAdminService } from './user-admin.service';
import { WorkflowDefinitionAdminService } from './workflow-definition-admin.service';

/**
 * The Phase 9 admin API (section 12.10) that the feature modules do not own: companies and
 * company rules, public holidays and holiday rules, employees (HR fields, terminate, photo, CSV
 * import), users (SYSTEM_ADMIN), workflow definitions and pay periods. Leave, claims, banks,
 * funds, lookups, transaction codes, parameters, payroll imports and settings stay with their
 * modules.
 */
@Module({
  imports: [AuthModule, WorkflowModule, AttachmentsModule],
  controllers: [
    OrganisationAdminController,
    HolidayAdminController,
    EmployeeAdminController,
    UserAdminController,
    WorkflowDefinitionAdminController,
    PayPeriodAdminController,
  ],
  providers: [
    OrganisationAdminService,
    HolidayAdminService,
    EmployeeAdminService,
    EmployeeImportService,
    UserAdminService,
    WorkflowDefinitionAdminService,
    PayPeriodAdminService,
  ],
  exports: [EmployeeAdminService, UserAdminService],
})
export class AdminModule implements OnModuleInit {
  constructor(private readonly owners: AttachmentOwnerRegistry) {}

  onModuleInit(): void {
    // Employee photos (the dashboard welcome banner): readable like the employee's own record.
    this.owners.register(EMPLOYEE_PHOTO_ENTITY, async (client, id) => {
      const row = await client.employee.findFirst({
        where: { id: Number(id), deletedAt: null },
        select: { id: true },
      });
      return row ? { employeeId: row.id, processId: null } : null;
    });
  }
}
