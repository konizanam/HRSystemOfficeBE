import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ApprovalHistorySchema,
  ApproveRequestSchema,
  BulkActionResponseSchema,
  BulkApproveRequestSchema,
  businessFromDate,
  CanStartQuerySchema,
  CanStartResponseSchema,
  CommentRequestSchema,
  DeclineRequestSchema,
  IdParamSchema,
  ParkRequestSchema,
  PayPeriodsQuerySchema,
  PayPeriodsResponseSchema,
  ProcessRequestSchema,
  ReassignRequestSchema,
  ResubmitRequestSchema,
  SendBackRequestSchema,
  UserOptionsQuerySchema,
  UserOptionsResponseSchema,
  WithdrawRequestSchema,
  WorkflowProcessSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { DbService } from '../../prisma/db.service';
import { Roles } from '../auth/decorators';
import { WorkflowPeopleService } from './people.service';
import { WorkflowEngine } from './workflow-engine.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class WorkflowProcessDto extends createZodDto(WorkflowProcessSchema) {}
class ApprovalHistoryDto extends createZodDto(ApprovalHistorySchema) {}
class ApproveRequestDto extends createZodDto(ApproveRequestSchema) {}
class DeclineRequestDto extends createZodDto(DeclineRequestSchema) {}
class ReassignRequestDto extends createZodDto(ReassignRequestSchema) {}
class ParkRequestDto extends createZodDto(ParkRequestSchema) {}
class SendBackRequestDto extends createZodDto(SendBackRequestSchema) {}
class ResubmitRequestDto extends createZodDto(ResubmitRequestSchema) {}
class WithdrawRequestDto extends createZodDto(WithdrawRequestSchema) {}
class CommentRequestDto extends createZodDto(CommentRequestSchema) {}
class BulkApproveRequestDto extends createZodDto(BulkApproveRequestSchema) {}
class ProcessRequestDto extends createZodDto(ProcessRequestSchema) {}
class BulkActionResponseDto extends createZodDto(BulkActionResponseSchema) {}
class CanStartQueryDto extends createZodDto(CanStartQuerySchema) {}
class CanStartResponseDto extends createZodDto(CanStartResponseSchema) {}
class PayPeriodsQueryDto extends createZodDto(PayPeriodsQuerySchema) {}
class PayPeriodsResponseDto extends createZodDto(PayPeriodsResponseSchema) {}
class UserOptionsQueryDto extends createZodDto(UserOptionsQuerySchema) {}
class UserOptionsResponseDto extends createZodDto(UserOptionsResponseSchema) {}

/**
 * Section 12.7: approval history, approver and applicant actions, bulk approve and payroll
 * processing. Every action takes the `version` the client read (409 when it is stale) and
 * accepts an `Idempotency-Key`.
 */
@ApiTags('workflow')
@Controller('workflow')
export class WorkflowController {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly people: WorkflowPeopleService,
    private readonly db: DbService,
  ) {}

  @Get('processes/:id/history')
  @ApiOkResponse({ type: ApprovalHistoryDto })
  history(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<ApprovalHistoryDto> {
    return this.engine.history(ctx, params.id);
  }

  @Post('processes/bulk-approve')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: BulkActionResponseDto })
  bulkApprove(
    @Ctx() ctx: SecurityContext,
    @Body() body: BulkApproveRequestDto,
  ): Promise<BulkActionResponseDto> {
    return this.engine.bulkApprove(ctx, body.items, body.comment);
  }

  @Post('processes/process')
  @HttpCode(200)
  @Roles('PAYROLL_ADMIN')
  @Idempotent()
  @ApiOkResponse({ type: BulkActionResponseDto })
  process(@Ctx() ctx: SecurityContext, @Body() body: ProcessRequestDto): Promise<BulkActionResponseDto> {
    return this.engine.process(ctx, body.ids, body.payPeriodId);
  }

  @Post('processes/:id/approve')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  approve(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ApproveRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'APPROVE',
      expectedVersion: body.version,
      comment: body.comment,
    });
  }

  @Post('processes/:id/decline')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  decline(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeclineRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'DECLINE',
      expectedVersion: body.version,
      comment: body.comment,
    });
  }

  @Post('processes/:id/reassign')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  reassign(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ReassignRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'REASSIGN',
      expectedVersion: body.version,
      comment: body.comment,
      reassignToUserId: body.toUserId,
    });
  }

  @Post('processes/:id/park')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  park(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ParkRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'PARK',
      expectedVersion: body.version,
      comment: body.comment,
      parkUntil: body.until,
    });
  }

  @Post('processes/:id/send-back')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  sendBack(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: SendBackRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'SEND_BACK',
      expectedVersion: body.version,
      comment: body.comment,
    });
  }

  @Post('processes/:id/comment')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  comment(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CommentRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.act(ctx, params.id, {
      action: 'COMMENT',
      expectedVersion: body.version,
      comment: body.comment,
    });
  }

  @Post('processes/:id/resubmit')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  resubmit(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ResubmitRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.resubmit(ctx, params.id, body.version, {
      comment: body.comment,
      changes: body.changes,
    });
  }

  @Post('processes/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: WorkflowProcessDto })
  withdraw(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: WithdrawRequestDto,
  ): Promise<WorkflowProcessDto> {
    return this.engine.withdraw(ctx, params.id, body.version, body.comment);
  }

  @Get('can-start')
  @ApiOkResponse({ type: CanStartResponseDto })
  async canStart(
    @Ctx() ctx: SecurityContext,
    @Query() query: CanStartQueryDto,
  ): Promise<CanStartResponseDto> {
    return {
      type: query.type,
      employeeId: ctx.actingAsEmployeeId,
      canStart: await this.engine.canStart(ctx, query.type, query.discriminator),
    };
  }

  /**
   * Open pay periods in the payroll admin's companies, for the "Process" dialog; `companyRuleId`
   * (the applicant's, from the inbox card) narrows them to the ones the item can go into.
   */
  @Get('pay-periods')
  @Roles('PAYROLL_ADMIN')
  @ApiOkResponse({ type: PayPeriodsResponseDto })
  async payPeriods(
    @Ctx() ctx: SecurityContext,
    @Query() query: PayPeriodsQueryDto,
  ): Promise<PayPeriodsResponseDto> {
    const rows = await this.db.prisma.payPeriod.findMany({
      where: {
        isClosed: false,
        companyRule: { companyId: { in: ctx.companyIds } },
        ...(query.companyRuleId !== undefined ? { companyRuleId: query.companyRuleId } : {}),
      },
      include: { companyRule: { select: { description: true } } },
      orderBy: [{ companyRuleId: 'asc' }, { startDate: 'asc' }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        companyRuleId: r.companyRuleId,
        companyRule: r.companyRule.description,
        description: r.description,
        startDate: businessFromDate(r.startDate),
        endDate: businessFromDate(r.endDate),
        payDate: r.payDate ? businessFromDate(r.payDate) : null,
        isClosed: r.isClosed,
      })),
    };
  }

  /** People a step can be reassigned to (active, same company). */
  @Get('user-options')
  @ApiOkResponse({ type: UserOptionsResponseDto })
  userOptions(
    @Ctx() ctx: SecurityContext,
    @Query() query: UserOptionsQueryDto,
  ): Promise<UserOptionsResponseDto> {
    return this.people.userOptions(ctx, query.search);
  }
}
