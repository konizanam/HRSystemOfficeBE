import { Module, type OnModuleInit } from '@nestjs/common';
import { AttachmentOwnerRegistry } from '../attachments/attachment-owners';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { WorkflowSubjectRegistry } from '../workflow/subject-registry';
import { WorkflowModule } from '../workflow/workflow.module';
import { CalendarController } from './calendar.controller';
import { CreditLeaveHandler, CreditLeaveService } from './credit-leave.service';
import { EntitlementService } from './entitlement.service';
import { LeaveAdminController } from './leave-admin.controller';
import { LeaveAdminService } from './leave-admin.service';
import { LeaveApplicationWriter } from './leave-application.writer';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveCalendarService } from './leave-calendar.service';
import { CREDIT_LEAVE_ENTITY, LEAVE_APPLICATION_ENTITY } from './leave-constants';
import { LeaveJobs } from './leave-jobs.service';
import { LeavePolicyService } from './leave-policy.service';
import { LeaveRequestValidator } from './leave-request.validator';
import { CancelLeaveHandler, LeaveSubjectHandler } from './leave-subject.handlers';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';

/**
 * Leave (section 5.2): types, policies, entitlement buckets and the ledger, the unit
 * calculation, applications with their LEAVE and CANCELLEAVE workflows, balances, leave in lieu
 * (CREDITLVEREQ / CREDITLVEALLOC), the accrual, rollover and expiry jobs, the leave calendar and
 * the HR admin endpoints.
 */
@Module({
  imports: [AuthModule, WorkflowModule, AttachmentsModule, HolidaysModule],
  controllers: [LeaveController, CalendarController, LeaveAdminController],
  providers: [
    LeavePolicyService,
    EntitlementService,
    LeaveRequestValidator,
    LeaveApplicationWriter,
    LeaveService,
    LeaveBalanceService,
    LeaveCalendarService,
    CreditLeaveService,
    LeaveAdminService,
    LeaveJobs,
    LeaveSubjectHandler,
    CancelLeaveHandler,
  ],
  exports: [LeaveService, LeaveBalanceService, LeaveCalendarService, EntitlementService, LeaveJobs],
})
export class LeaveModule implements OnModuleInit {
  constructor(
    private readonly registry: WorkflowSubjectRegistry,
    private readonly owners: AttachmentOwnerRegistry,
    private readonly leaveHandler: LeaveSubjectHandler,
    private readonly cancelHandler: CancelLeaveHandler,
    private readonly credit: CreditLeaveService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.leaveHandler);
    this.registry.register(this.cancelHandler);
    this.registry.register(new CreditLeaveHandler('CREDITLVEREQ', this.credit));
    this.registry.register(new CreditLeaveHandler('CREDITLVEALLOC', this.credit));

    this.owners.register(LEAVE_APPLICATION_ENTITY, async (client, id) => {
      const app = await client.leaveApplication.findUnique({
        where: { id: Number(id) },
        select: { employeeId: true, processId: true },
      });
      return app ? { employeeId: app.employeeId, processId: app.processId } : null;
    });
    this.owners.register(CREDIT_LEAVE_ENTITY, async (client, id) => {
      const request = await client.creditLeaveRequest.findUnique({
        where: { id: Number(id) },
        select: { employeeId: true, processId: true },
      });
      return request ? { employeeId: request.employeeId, processId: request.processId } : null;
    });
  }
}
