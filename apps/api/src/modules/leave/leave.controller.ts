import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AllocatableEmployeesQuerySchema,
  AllocatableEmployeesResponseSchema,
  CancelLeaveRequestSchema,
  CancelLeaveResponseSchema,
  CreateCreditLeaveRequestSchema,
  CreditLeaveListResponseSchema,
  CreditLeaveQuerySchema,
  CreditLeaveRowSchema,
  IdParamSchema,
  LeaveApplicationDetailSchema,
  LeaveApplicationsQuerySchema,
  LeaveApplicationsResponseSchema,
  LeaveBalanceDefinitionsResponseSchema,
  LeaveBalancesQuerySchema,
  LeaveBalancesResponseSchema,
  LeaveCalculateRequestSchema,
  LeaveCalculateResponseSchema,
  LeaveReasonsResponseSchema,
  LeaveTypeIdParamSchema,
  LeaveTypesQuerySchema,
  LeaveTypesResponseSchema,
  OnLeaveTodayResponseSchema,
  SubmitLeaveRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { CreditLeaveService } from './credit-leave.service';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveCalendarService } from './leave-calendar.service';
import { LeaveService } from './leave.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class LeaveTypeIdParamDto extends createZodDto(LeaveTypeIdParamSchema) {}
class LeaveTypesQueryDto extends createZodDto(LeaveTypesQuerySchema) {}
class LeaveTypesResponseDto extends createZodDto(LeaveTypesResponseSchema) {}
class LeaveReasonsResponseDto extends createZodDto(LeaveReasonsResponseSchema) {}
class LeaveCalculateRequestDto extends createZodDto(LeaveCalculateRequestSchema) {}
class LeaveCalculateResponseDto extends createZodDto(LeaveCalculateResponseSchema) {}
class SubmitLeaveRequestDto extends createZodDto(SubmitLeaveRequestSchema) {}
class LeaveApplicationDetailDto extends createZodDto(LeaveApplicationDetailSchema) {}
class LeaveApplicationsQueryDto extends createZodDto(LeaveApplicationsQuerySchema) {}
class LeaveApplicationsResponseDto extends createZodDto(LeaveApplicationsResponseSchema) {}
class CancelLeaveRequestDto extends createZodDto(CancelLeaveRequestSchema) {}
class CancelLeaveResponseDto extends createZodDto(CancelLeaveResponseSchema) {}
class LeaveBalancesQueryDto extends createZodDto(LeaveBalancesQuerySchema) {}
class LeaveBalancesResponseDto extends createZodDto(LeaveBalancesResponseSchema) {}
class LeaveBalanceDefinitionsResponseDto extends createZodDto(LeaveBalanceDefinitionsResponseSchema) {}
class CreateCreditLeaveRequestDto extends createZodDto(CreateCreditLeaveRequestSchema) {}
class CreditLeaveRowDto extends createZodDto(CreditLeaveRowSchema) {}
class CreditLeaveQueryDto extends createZodDto(CreditLeaveQuerySchema) {}
class CreditLeaveListResponseDto extends createZodDto(CreditLeaveListResponseSchema) {}
class OnLeaveTodayResponseDto extends createZodDto(OnLeaveTodayResponseSchema) {}
class AllocatableEmployeesQueryDto extends createZodDto(AllocatableEmployeesQuerySchema) {}
class AllocatableEmployeesResponseDto extends createZodDto(AllocatableEmployeesResponseSchema) {}

/** Section 12.3: leave types, calculation, applications, cancel, balances and leave in lieu. */
@ApiTags('leave')
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly balances: LeaveBalanceService,
    private readonly credit: CreditLeaveService,
    private readonly calendar: LeaveCalendarService,
  ) {}

  @Get('types')
  @ApiOkResponse({ type: LeaveTypesResponseDto })
  types(@Ctx() ctx: SecurityContext, @Query() query: LeaveTypesQueryDto): Promise<LeaveTypesResponseDto> {
    return this.leave.types(ctx, query.employeeId);
  }

  @Get('types/:id/reasons')
  @ApiOkResponse({ type: LeaveReasonsResponseDto })
  reasons(@Param() params: IdParamDto): Promise<LeaveReasonsResponseDto> {
    return this.leave.reasons(params.id);
  }

  @Get('balances')
  @ApiOkResponse({ type: LeaveBalancesResponseDto })
  balanceCards(
    @Ctx() ctx: SecurityContext,
    @Query() query: LeaveBalancesQueryDto,
  ): Promise<LeaveBalancesResponseDto> {
    return this.balances.cards(ctx, query.employeeId);
  }

  @Get('balances/:leaveTypeId/definitions')
  @ApiOkResponse({ type: LeaveBalanceDefinitionsResponseDto })
  balanceDefinitions(
    @Ctx() ctx: SecurityContext,
    @Param() params: LeaveTypeIdParamDto,
    @Query() query: LeaveBalancesQueryDto,
  ): Promise<LeaveBalanceDefinitionsResponseDto> {
    return this.balances.definitions(ctx, params.leaveTypeId, query.employeeId);
  }

  /** Read-only: the units and balance panel for a prospective request. */
  @Post('calculate')
  @HttpCode(200)
  @ApiOkResponse({ type: LeaveCalculateResponseDto })
  calculate(
    @Ctx() ctx: SecurityContext,
    @Body() body: LeaveCalculateRequestDto,
  ): Promise<LeaveCalculateResponseDto> {
    return this.leave.calculate(ctx, body);
  }

  @Post('applications')
  @Idempotent()
  @ApiCreatedResponse({ type: LeaveApplicationDetailDto })
  submit(
    @Ctx() ctx: SecurityContext,
    @Body() body: SubmitLeaveRequestDto,
  ): Promise<LeaveApplicationDetailDto> {
    return this.leave.submit(ctx, body);
  }

  @Get('applications')
  @ApiOkResponse({ type: LeaveApplicationsResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: LeaveApplicationsQueryDto,
  ): Promise<LeaveApplicationsResponseDto> {
    return this.leave.list(ctx, query);
  }

  @Get('applications/:id')
  @ApiOkResponse({ type: LeaveApplicationDetailDto })
  detail(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<LeaveApplicationDetailDto> {
    return this.leave.detail(ctx, params.id);
  }

  @Post('applications/:id/cancel')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: CancelLeaveResponseDto })
  cancel(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CancelLeaveRequestDto,
  ): Promise<CancelLeaveResponseDto> {
    return this.leave.cancel(ctx, params.id, body);
  }

  @Post('in-lieu')
  @Idempotent()
  @ApiCreatedResponse({ type: CreditLeaveRowDto })
  createCredit(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateCreditLeaveRequestDto,
  ): Promise<CreditLeaveRowDto> {
    return this.credit.create(ctx, body);
  }

  @Get('in-lieu')
  @ApiOkResponse({ type: CreditLeaveListResponseDto })
  listCredit(
    @Ctx() ctx: SecurityContext,
    @Query() query: CreditLeaveQueryDto,
  ): Promise<CreditLeaveListResponseDto> {
    return this.credit.list(ctx, query);
  }

  /** Leave in lieu ALLOCATION picker: the employees the signed-in user may allocate credit to. */
  @Get('in-lieu/allocatable-employees')
  @Roles('MANAGER', 'HR_ADMIN')
  @ApiOkResponse({ type: AllocatableEmployeesResponseDto })
  allocatableEmployees(
    @Ctx() ctx: SecurityContext,
    @Query() query: AllocatableEmployeesQueryDto,
  ): Promise<AllocatableEmployeesResponseDto> {
    return this.credit.allocatableEmployees(ctx, query);
  }

  /** "Employees on Leave": the manager's reports on approved or processed leave today. */
  @Get('team/on-leave-today')
  @Roles('MANAGER')
  @ApiOkResponse({ type: OnLeaveTodayResponseDto })
  onLeaveToday(@Ctx() ctx: SecurityContext): Promise<OnLeaveTodayResponseDto> {
    return this.calendar.onLeaveToday(ctx);
  }
}
