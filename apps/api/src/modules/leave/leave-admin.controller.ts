import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminLeavePoliciesQuerySchema,
  AdminLeavePoliciesResponseSchema,
  AdminLeavePolicySchema,
  AdminLeaveReasonSchema,
  AdminLeaveReasonsQuerySchema,
  AdminLeaveReasonsResponseSchema,
  AdminLeaveTypeSchema,
  AdminLeaveTypesResponseSchema,
  CreateLeavePolicyRequestSchema,
  CreateLeaveReasonRequestSchema,
  CreateLeaveTypeRequestSchema,
  DeactivateRequestSchema,
  IdParamSchema,
  LeaveAdjustmentRequestSchema,
  LeaveAdjustmentResponseSchema,
  OpeningBalanceImportRequestSchema,
  OpeningBalanceImportResponseSchema,
  UpdateLeavePolicyRequestSchema,
  UpdateLeaveReasonRequestSchema,
  UpdateLeaveTypeRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { LeaveAdminService } from './leave-admin.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class DeactivateRequestDto extends createZodDto(DeactivateRequestSchema) {}
class LeaveAdjustmentRequestDto extends createZodDto(LeaveAdjustmentRequestSchema) {}
class LeaveAdjustmentResponseDto extends createZodDto(LeaveAdjustmentResponseSchema) {}
class OpeningBalanceImportRequestDto extends createZodDto(OpeningBalanceImportRequestSchema) {}
class OpeningBalanceImportResponseDto extends createZodDto(OpeningBalanceImportResponseSchema) {}
class AdminLeaveTypeDto extends createZodDto(AdminLeaveTypeSchema) {}
class AdminLeaveTypesResponseDto extends createZodDto(AdminLeaveTypesResponseSchema) {}
class CreateLeaveTypeRequestDto extends createZodDto(CreateLeaveTypeRequestSchema) {}
class UpdateLeaveTypeRequestDto extends createZodDto(UpdateLeaveTypeRequestSchema) {}
class AdminLeaveReasonDto extends createZodDto(AdminLeaveReasonSchema) {}
class AdminLeaveReasonsQueryDto extends createZodDto(AdminLeaveReasonsQuerySchema) {}
class AdminLeaveReasonsResponseDto extends createZodDto(AdminLeaveReasonsResponseSchema) {}
class CreateLeaveReasonRequestDto extends createZodDto(CreateLeaveReasonRequestSchema) {}
class UpdateLeaveReasonRequestDto extends createZodDto(UpdateLeaveReasonRequestSchema) {}
class AdminLeavePolicyDto extends createZodDto(AdminLeavePolicySchema) {}
class AdminLeavePoliciesQueryDto extends createZodDto(AdminLeavePoliciesQuerySchema) {}
class AdminLeavePoliciesResponseDto extends createZodDto(AdminLeavePoliciesResponseSchema) {}
class CreateLeavePolicyRequestDto extends createZodDto(CreateLeavePolicyRequestSchema) {}
class UpdateLeavePolicyRequestDto extends createZodDto(UpdateLeavePolicyRequestSchema) {}

/**
 * Section 12.10 (HR_ADMIN): leave adjustments, the opening balances import and the leave types,
 * reasons and policies API. Deleting deactivates (no hard deletes); updates send the `version`.
 */
@ApiTags('admin: leave')
@Controller('admin')
@Roles('HR_ADMIN')
export class LeaveAdminController {
  constructor(private readonly admin: LeaveAdminService) {}

  @Post('leave/adjustments')
  @Idempotent()
  @ApiCreatedResponse({ type: LeaveAdjustmentResponseDto })
  adjust(
    @Ctx() ctx: SecurityContext,
    @Body() body: LeaveAdjustmentRequestDto,
  ): Promise<LeaveAdjustmentResponseDto> {
    return this.admin.adjust(ctx, body);
  }

  @Post('leave/opening-balances/import')
  @HttpCode(200)
  @ApiOkResponse({ type: OpeningBalanceImportResponseDto })
  importOpeningBalances(
    @Ctx() ctx: SecurityContext,
    @Body() body: OpeningBalanceImportRequestDto,
  ): Promise<OpeningBalanceImportResponseDto> {
    return this.admin.importOpeningBalances(ctx, body);
  }

  // ───────────── Leave types ─────────────

  @Get('leave-types')
  @ApiOkResponse({ type: AdminLeaveTypesResponseDto })
  listTypes(): Promise<AdminLeaveTypesResponseDto> {
    return this.admin.listTypes();
  }

  @Get('leave-types/:id')
  @ApiOkResponse({ type: AdminLeaveTypeDto })
  getType(@Param() params: IdParamDto): Promise<AdminLeaveTypeDto> {
    return this.admin.getType(params.id);
  }

  @Post('leave-types')
  @ApiCreatedResponse({ type: AdminLeaveTypeDto })
  createType(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateLeaveTypeRequestDto,
  ): Promise<AdminLeaveTypeDto> {
    return this.admin.createType(ctx, body);
  }

  @Put('leave-types/:id')
  @ApiOkResponse({ type: AdminLeaveTypeDto })
  updateType(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateLeaveTypeRequestDto,
  ): Promise<AdminLeaveTypeDto> {
    return this.admin.updateType(ctx, params.id, body);
  }

  @Delete('leave-types/:id')
  @ApiOkResponse({ type: AdminLeaveTypeDto })
  deactivateType(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminLeaveTypeDto> {
    return this.admin.deactivateType(ctx, params.id, body.version);
  }

  // ───────────── Leave reasons ─────────────

  @Get('leave-reasons')
  @ApiOkResponse({ type: AdminLeaveReasonsResponseDto })
  listReasons(@Query() query: AdminLeaveReasonsQueryDto): Promise<AdminLeaveReasonsResponseDto> {
    return this.admin.listReasons(query);
  }

  @Post('leave-reasons')
  @ApiCreatedResponse({ type: AdminLeaveReasonDto })
  createReason(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateLeaveReasonRequestDto,
  ): Promise<AdminLeaveReasonDto> {
    return this.admin.createReason(ctx, body);
  }

  @Put('leave-reasons/:id')
  @ApiOkResponse({ type: AdminLeaveReasonDto })
  updateReason(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateLeaveReasonRequestDto,
  ): Promise<AdminLeaveReasonDto> {
    return this.admin.updateReason(ctx, params.id, body);
  }

  @Delete('leave-reasons/:id')
  @ApiOkResponse({ type: AdminLeaveReasonDto })
  deactivateReason(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminLeaveReasonDto> {
    return this.admin.deactivateReason(ctx, params.id, body.version);
  }

  // ───────────── Leave policies ─────────────

  @Get('leave-policies')
  @ApiOkResponse({ type: AdminLeavePoliciesResponseDto })
  listPolicies(@Query() query: AdminLeavePoliciesQueryDto): Promise<AdminLeavePoliciesResponseDto> {
    return this.admin.listPolicies(query);
  }

  @Post('leave-policies')
  @ApiCreatedResponse({ type: AdminLeavePolicyDto })
  createPolicy(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateLeavePolicyRequestDto,
  ): Promise<AdminLeavePolicyDto> {
    return this.admin.createPolicy(ctx, body);
  }

  @Put('leave-policies/:id')
  @ApiOkResponse({ type: AdminLeavePolicyDto })
  updatePolicy(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateLeavePolicyRequestDto,
  ): Promise<AdminLeavePolicyDto> {
    return this.admin.updatePolicy(ctx, params.id, body);
  }

  @Delete('leave-policies/:id')
  @ApiOkResponse({ type: AdminLeavePolicyDto })
  deactivatePolicy(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminLeavePolicyDto> {
    return this.admin.deactivatePolicy(ctx, params.id, body.version);
  }
}
