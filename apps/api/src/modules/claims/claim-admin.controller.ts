import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminClaimCapSchema,
  AdminClaimCapsQuerySchema,
  AdminClaimCapsResponseSchema,
  AdminClaimGroupSchema,
  AdminClaimGroupsResponseSchema,
  AdminClaimTypeSchema,
  AdminClaimTypesQuerySchema,
  AdminClaimTypesResponseSchema,
  ClaimAdjustmentRequestSchema,
  ClaimAdjustmentSchema,
  CreateClaimCapRequestSchema,
  CreateClaimGroupRequestSchema,
  CreateClaimTypeRequestSchema,
  DeactivateRequestSchema,
  IdParamSchema,
  UpdateClaimCapRequestSchema,
  UpdateClaimGroupRequestSchema,
  UpdateClaimTypeRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { ClaimAdminService } from './claim-admin.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class DeactivateRequestDto extends createZodDto(DeactivateRequestSchema) {}
class AdminClaimGroupDto extends createZodDto(AdminClaimGroupSchema) {}
class AdminClaimGroupsResponseDto extends createZodDto(AdminClaimGroupsResponseSchema) {}
class CreateClaimGroupRequestDto extends createZodDto(CreateClaimGroupRequestSchema) {}
class UpdateClaimGroupRequestDto extends createZodDto(UpdateClaimGroupRequestSchema) {}
class AdminClaimTypeDto extends createZodDto(AdminClaimTypeSchema) {}
class AdminClaimTypesQueryDto extends createZodDto(AdminClaimTypesQuerySchema) {}
class AdminClaimTypesResponseDto extends createZodDto(AdminClaimTypesResponseSchema) {}
class CreateClaimTypeRequestDto extends createZodDto(CreateClaimTypeRequestSchema) {}
class UpdateClaimTypeRequestDto extends createZodDto(UpdateClaimTypeRequestSchema) {}
class AdminClaimCapDto extends createZodDto(AdminClaimCapSchema) {}
class AdminClaimCapsQueryDto extends createZodDto(AdminClaimCapsQuerySchema) {}
class AdminClaimCapsResponseDto extends createZodDto(AdminClaimCapsResponseSchema) {}
class CreateClaimCapRequestDto extends createZodDto(CreateClaimCapRequestSchema) {}
class UpdateClaimCapRequestDto extends createZodDto(UpdateClaimCapRequestSchema) {}
class ClaimAdjustmentRequestDto extends createZodDto(ClaimAdjustmentRequestSchema) {}
class ClaimAdjustmentDto extends createZodDto(ClaimAdjustmentSchema) {}

/**
 * Section 12.10 (HR_ADMIN and PAYROLL_ADMIN): claim groups, types and caps; balance adjustments
 * are PAYROLL_ADMIN only. Deleting deactivates (no hard deletes); updates send the `version`.
 */
@ApiTags('admin: claims')
@Controller('admin')
@Roles('HR_ADMIN', 'PAYROLL_ADMIN')
export class ClaimAdminController {
  constructor(private readonly admin: ClaimAdminService) {}

  @Post('claims/adjustments')
  @Roles('PAYROLL_ADMIN')
  @Idempotent()
  @ApiCreatedResponse({ type: ClaimAdjustmentDto })
  adjust(@Ctx() ctx: SecurityContext, @Body() body: ClaimAdjustmentRequestDto): Promise<ClaimAdjustmentDto> {
    return this.admin.adjust(ctx, body);
  }

  // ───────────── Claim groups ─────────────

  @Get('claim-groups')
  @ApiOkResponse({ type: AdminClaimGroupsResponseDto })
  listGroups(): Promise<AdminClaimGroupsResponseDto> {
    return this.admin.listGroups();
  }

  @Get('claim-groups/:id')
  @ApiOkResponse({ type: AdminClaimGroupDto })
  getGroup(@Param() params: IdParamDto): Promise<AdminClaimGroupDto> {
    return this.admin.getGroup(params.id);
  }

  @Post('claim-groups')
  @ApiCreatedResponse({ type: AdminClaimGroupDto })
  createGroup(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateClaimGroupRequestDto,
  ): Promise<AdminClaimGroupDto> {
    return this.admin.createGroup(ctx, body);
  }

  @Put('claim-groups/:id')
  @ApiOkResponse({ type: AdminClaimGroupDto })
  updateGroup(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateClaimGroupRequestDto,
  ): Promise<AdminClaimGroupDto> {
    return this.admin.updateGroup(ctx, params.id, body);
  }

  @Delete('claim-groups/:id')
  @ApiOkResponse({ type: AdminClaimGroupDto })
  deactivateGroup(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminClaimGroupDto> {
    return this.admin.deactivateGroup(ctx, params.id, body.version);
  }

  // ───────────── Claim types ─────────────

  @Get('claim-types')
  @ApiOkResponse({ type: AdminClaimTypesResponseDto })
  listTypes(@Query() query: AdminClaimTypesQueryDto): Promise<AdminClaimTypesResponseDto> {
    return this.admin.listTypes(query);
  }

  @Get('claim-types/:id')
  @ApiOkResponse({ type: AdminClaimTypeDto })
  getType(@Param() params: IdParamDto): Promise<AdminClaimTypeDto> {
    return this.admin.getType(params.id);
  }

  @Post('claim-types')
  @ApiCreatedResponse({ type: AdminClaimTypeDto })
  createType(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateClaimTypeRequestDto,
  ): Promise<AdminClaimTypeDto> {
    return this.admin.createType(ctx, body);
  }

  @Put('claim-types/:id')
  @ApiOkResponse({ type: AdminClaimTypeDto })
  updateType(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateClaimTypeRequestDto,
  ): Promise<AdminClaimTypeDto> {
    return this.admin.updateType(ctx, params.id, body);
  }

  @Delete('claim-types/:id')
  @ApiOkResponse({ type: AdminClaimTypeDto })
  deactivateType(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminClaimTypeDto> {
    return this.admin.deactivateType(ctx, params.id, body.version);
  }

  // ───────────── Claim caps ─────────────

  @Get('claim-caps')
  @ApiOkResponse({ type: AdminClaimCapsResponseDto })
  listCaps(@Query() query: AdminClaimCapsQueryDto): Promise<AdminClaimCapsResponseDto> {
    return this.admin.listCaps(query);
  }

  @Post('claim-caps')
  @ApiCreatedResponse({ type: AdminClaimCapDto })
  createCap(@Ctx() ctx: SecurityContext, @Body() body: CreateClaimCapRequestDto): Promise<AdminClaimCapDto> {
    return this.admin.createCap(ctx, body);
  }

  @Put('claim-caps/:id')
  @ApiOkResponse({ type: AdminClaimCapDto })
  updateCap(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateClaimCapRequestDto,
  ): Promise<AdminClaimCapDto> {
    return this.admin.updateCap(ctx, params.id, body);
  }

  @Delete('claim-caps/:id')
  @ApiOkResponse({ type: AdminClaimCapDto })
  deactivateCap(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminClaimCapDto> {
    return this.admin.deactivateCap(ctx, params.id, body.version);
  }
}
