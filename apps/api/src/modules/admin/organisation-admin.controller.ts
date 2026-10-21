import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminCompaniesQuerySchema,
  AdminCompaniesResponseSchema,
  AdminCompanyRuleSchema,
  AdminCompanyRulesQuerySchema,
  AdminCompanyRulesResponseSchema,
  AdminCompanySchema,
  AdminHolidayRuleSchema,
  AdminHolidayRulesResponseSchema,
  AdminPublicHolidaySchema,
  AdminPublicHolidaysQuerySchema,
  AdminPublicHolidaysResponseSchema,
  AdminVersionRequestSchema,
  CreateCompanyRequestSchema,
  CreateCompanyRuleRequestSchema,
  CreateHolidayRuleRequestSchema,
  CreatePublicHolidayRequestSchema,
  IdParamSchema,
  UpdateCompanyRequestSchema,
  UpdateCompanyRuleRequestSchema,
  UpdateHolidayRuleRequestSchema,
  UpdatePublicHolidayRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { HolidayAdminService } from './holiday-admin.service';
import { OrganisationAdminService } from './organisation-admin.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class VersionDto extends createZodDto(AdminVersionRequestSchema) {}
class AdminCompanyDto extends createZodDto(AdminCompanySchema) {}
class AdminCompaniesQueryDto extends createZodDto(AdminCompaniesQuerySchema) {}
class AdminCompaniesResponseDto extends createZodDto(AdminCompaniesResponseSchema) {}
class CreateCompanyDto extends createZodDto(CreateCompanyRequestSchema) {}
class UpdateCompanyDto extends createZodDto(UpdateCompanyRequestSchema) {}
class AdminCompanyRuleDto extends createZodDto(AdminCompanyRuleSchema) {}
class AdminCompanyRulesQueryDto extends createZodDto(AdminCompanyRulesQuerySchema) {}
class AdminCompanyRulesResponseDto extends createZodDto(AdminCompanyRulesResponseSchema) {}
class CreateCompanyRuleDto extends createZodDto(CreateCompanyRuleRequestSchema) {}
class UpdateCompanyRuleDto extends createZodDto(UpdateCompanyRuleRequestSchema) {}
class AdminPublicHolidayDto extends createZodDto(AdminPublicHolidaySchema) {}
class AdminPublicHolidaysQueryDto extends createZodDto(AdminPublicHolidaysQuerySchema) {}
class AdminPublicHolidaysResponseDto extends createZodDto(AdminPublicHolidaysResponseSchema) {}
class CreatePublicHolidayDto extends createZodDto(CreatePublicHolidayRequestSchema) {}
class UpdatePublicHolidayDto extends createZodDto(UpdatePublicHolidayRequestSchema) {}
class AdminHolidayRuleDto extends createZodDto(AdminHolidayRuleSchema) {}
class AdminHolidayRulesResponseDto extends createZodDto(AdminHolidayRulesResponseSchema) {}
class HolidayRulesQueryDto extends createZodDto(
  z.object({ companyId: z.coerce.number().int().positive().optional() }),
) {}
class CreateHolidayRuleDto extends createZodDto(CreateHolidayRuleRequestSchema) {}
class UpdateHolidayRuleDto extends createZodDto(UpdateHolidayRuleRequestSchema) {}

/**
 * Section 12.10: companies and company rules. HR admins manage them within their companies; payroll
 * admins (their companies) and system admins (all) read them. DELETE deactivates.
 */
@ApiTags('admin: organisation')
@Controller('admin')
export class OrganisationAdminController {
  constructor(private readonly org: OrganisationAdminService) {}

  @Get('companies')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AdminCompaniesResponseDto })
  listCompanies(
    @Ctx() ctx: SecurityContext,
    @Query() query: AdminCompaniesQueryDto,
  ): Promise<AdminCompaniesResponseDto> {
    return this.org.listCompanies(ctx, query);
  }

  @Get('companies/:id')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AdminCompanyDto })
  getCompany(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<AdminCompanyDto> {
    return this.org.getCompany(ctx, params.id);
  }

  @Post('companies')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminCompanyDto })
  createCompany(@Ctx() ctx: SecurityContext, @Body() body: CreateCompanyDto): Promise<AdminCompanyDto> {
    return this.org.createCompany(ctx, body);
  }

  @Put('companies/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminCompanyDto })
  updateCompany(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateCompanyDto,
  ): Promise<AdminCompanyDto> {
    return this.org.updateCompany(ctx, params.id, body);
  }

  @Delete('companies/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminCompanyDto })
  deactivateCompany(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminCompanyDto> {
    return this.org.setCompanyActive(ctx, params.id, false, body.version);
  }

  @Post('companies/:id/activate')
  @Roles('HR_ADMIN')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminCompanyDto })
  activateCompany(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminCompanyDto> {
    return this.org.setCompanyActive(ctx, params.id, true, body.version);
  }

  @Get('company-rules')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AdminCompanyRulesResponseDto })
  listRules(
    @Ctx() ctx: SecurityContext,
    @Query() query: AdminCompanyRulesQueryDto,
  ): Promise<AdminCompanyRulesResponseDto> {
    return this.org.listRules(ctx, query);
  }

  @Get('company-rules/:id')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AdminCompanyRuleDto })
  getRule(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<AdminCompanyRuleDto> {
    return this.org.getRule(ctx, params.id);
  }

  @Post('company-rules')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminCompanyRuleDto })
  createRule(@Ctx() ctx: SecurityContext, @Body() body: CreateCompanyRuleDto): Promise<AdminCompanyRuleDto> {
    return this.org.createRule(ctx, body);
  }

  @Put('company-rules/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminCompanyRuleDto })
  updateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateCompanyRuleDto,
  ): Promise<AdminCompanyRuleDto> {
    return this.org.updateRule(ctx, params.id, body);
  }

  @Delete('company-rules/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminCompanyRuleDto })
  deactivateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminCompanyRuleDto> {
    return this.org.setRuleActive(ctx, params.id, false, body.version);
  }

  @Post('company-rules/:id/activate')
  @Roles('HR_ADMIN')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminCompanyRuleDto })
  activateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminCompanyRuleDto> {
    return this.org.setRuleActive(ctx, params.id, true, body.version);
  }
}

/** Section 12.10 (HR_ADMIN): public holidays and the holiday rules that generate them. */
@ApiTags('admin: holidays')
@Controller('admin')
@Roles('HR_ADMIN')
export class HolidayAdminController {
  constructor(private readonly holidays: HolidayAdminService) {}

  @Get('public-holidays')
  @ApiOkResponse({ type: AdminPublicHolidaysResponseDto })
  list(@Query() query: AdminPublicHolidaysQueryDto): Promise<AdminPublicHolidaysResponseDto> {
    return this.holidays.listHolidays(query);
  }

  @Post('public-holidays')
  @ApiCreatedResponse({ type: AdminPublicHolidayDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreatePublicHolidayDto): Promise<AdminPublicHolidayDto> {
    return this.holidays.createHoliday(ctx, body);
  }

  @Put('public-holidays/:id')
  @ApiOkResponse({ type: AdminPublicHolidayDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdatePublicHolidayDto,
  ): Promise<AdminPublicHolidayDto> {
    return this.holidays.updateHoliday(ctx, params.id, body);
  }

  @Delete('public-holidays/:id')
  @ApiOkResponse({ type: AdminPublicHolidayDto })
  remove(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminPublicHolidayDto> {
    return this.holidays.deleteHoliday(ctx, params.id, body.version);
  }

  /** Brings a deleted holiday back (audited HOLIDAY.RESTORED). */
  @Post('public-holidays/:id/restore')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminPublicHolidayDto })
  restore(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminPublicHolidayDto> {
    return this.holidays.restoreHoliday(ctx, params.id, body.version);
  }

  @Get('holiday-rules')
  @ApiOkResponse({ type: AdminHolidayRulesResponseDto })
  listRules(@Query() query: HolidayRulesQueryDto): Promise<AdminHolidayRulesResponseDto> {
    return this.holidays.listRules(query.companyId);
  }

  @Post('holiday-rules')
  @ApiCreatedResponse({ type: AdminHolidayRuleDto })
  createRule(@Ctx() ctx: SecurityContext, @Body() body: CreateHolidayRuleDto): Promise<AdminHolidayRuleDto> {
    return this.holidays.createRule(ctx, body);
  }

  @Put('holiday-rules/:id')
  @ApiOkResponse({ type: AdminHolidayRuleDto })
  updateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateHolidayRuleDto,
  ): Promise<AdminHolidayRuleDto> {
    return this.holidays.updateRule(ctx, params.id, body);
  }

  @Delete('holiday-rules/:id')
  @ApiOkResponse({ type: AdminHolidayRuleDto })
  deactivateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminHolidayRuleDto> {
    return this.holidays.setRuleActive(ctx, params.id, false, body.version);
  }

  @Post('holiday-rules/:id/activate')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminHolidayRuleDto })
  activateRule(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminHolidayRuleDto> {
    return this.holidays.setRuleActive(ctx, params.id, true, body.version);
  }
}
