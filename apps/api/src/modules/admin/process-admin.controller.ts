import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminPayPeriodSchema,
  AdminPayPeriodsQuerySchema,
  AdminPayPeriodsResponseSchema,
  AdminVersionRequestSchema,
  AdminWorkflowDefinitionSchema,
  AdminWorkflowDefinitionsQuerySchema,
  AdminWorkflowDefinitionsResponseSchema,
  ClosePayPeriodResponseSchema,
  CreatePayPeriodRequestSchema,
  CreateWorkflowDefinitionRequestSchema,
  IdParamSchema,
  UpdatePayPeriodRequestSchema,
  UpdateWorkflowDefinitionRequestSchema,
  UpdateWorkflowStepsRequestSchema,
  UserOptionsQuerySchema,
  UserOptionsResponseSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { WorkflowPeopleService } from '../workflow/people.service';
import { PayPeriodAdminService } from './pay-period-admin.service';
import { WorkflowDefinitionAdminService } from './workflow-definition-admin.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class VersionDto extends createZodDto(AdminVersionRequestSchema) {}
class AdminWorkflowDefinitionDto extends createZodDto(AdminWorkflowDefinitionSchema) {}
class AdminWorkflowDefinitionsQueryDto extends createZodDto(AdminWorkflowDefinitionsQuerySchema) {}
class AdminWorkflowDefinitionsResponseDto extends createZodDto(AdminWorkflowDefinitionsResponseSchema) {}
class CreateWorkflowDefinitionDto extends createZodDto(CreateWorkflowDefinitionRequestSchema) {}
class UpdateWorkflowDefinitionDto extends createZodDto(UpdateWorkflowDefinitionRequestSchema) {}
class UpdateWorkflowStepsDto extends createZodDto(UpdateWorkflowStepsRequestSchema) {}
class AdminPayPeriodDto extends createZodDto(AdminPayPeriodSchema) {}
class AdminPayPeriodsQueryDto extends createZodDto(AdminPayPeriodsQuerySchema) {}
class AdminPayPeriodsResponseDto extends createZodDto(AdminPayPeriodsResponseSchema) {}
class CreatePayPeriodDto extends createZodDto(CreatePayPeriodRequestSchema) {}
class UpdatePayPeriodDto extends createZodDto(UpdatePayPeriodRequestSchema) {}
class ClosePayPeriodResponseDto extends createZodDto(ClosePayPeriodResponseSchema) {}
class UserOptionsQueryDto extends createZodDto(UserOptionsQuerySchema) {}
class UserOptionsResponseDto extends createZodDto(UserOptionsResponseSchema) {}

/**
 * Section 12.10 (HR_ADMIN): workflow definitions and their steps. A PUT creates a new version
 * (running processes keep theirs); DELETE deactivates.
 */
@ApiTags('admin: workflow')
@Controller('admin/workflow-definitions')
@Roles('HR_ADMIN')
export class WorkflowDefinitionAdminController {
  constructor(
    private readonly definitions: WorkflowDefinitionAdminService,
    private readonly people: WorkflowPeopleService,
  ) {}

  @Get()
  @ApiOkResponse({ type: AdminWorkflowDefinitionsResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: AdminWorkflowDefinitionsQueryDto,
  ): Promise<AdminWorkflowDefinitionsResponseDto> {
    return this.definitions.list(ctx, query);
  }

  /**
   * Who a SPECIFIC_USER step may name: active users of the caller's companies plus active users
   * without an employee record (the system user never). Declared before `:id`.
   */
  @Get('user-options')
  @ApiOkResponse({ type: UserOptionsResponseDto })
  userOptions(
    @Ctx() ctx: SecurityContext,
    @Query() query: UserOptionsQueryDto,
  ): Promise<UserOptionsResponseDto> {
    return this.people.stepUserOptions(ctx, query.search);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminWorkflowDefinitionDto })
  get(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.get(ctx, params.id);
  }

  @Post()
  @ApiCreatedResponse({ type: AdminWorkflowDefinitionDto })
  create(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateWorkflowDefinitionDto,
  ): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.create(ctx, body);
  }

  @Put(':id')
  @ApiOkResponse({ type: AdminWorkflowDefinitionDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateWorkflowDefinitionDto,
  ): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.update(ctx, params.id, body);
  }

  @Put(':id/steps')
  @ApiOkResponse({ type: AdminWorkflowDefinitionDto })
  updateSteps(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateWorkflowStepsDto,
  ): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.updateSteps(ctx, params.id, body.steps, body.version);
  }

  @Delete(':id')
  @ApiOkResponse({ type: AdminWorkflowDefinitionDto })
  deactivate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.setActive(ctx, params.id, false, body.version);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminWorkflowDefinitionDto })
  activate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminWorkflowDefinitionDto> {
    return this.definitions.setActive(ctx, params.id, true, body.version);
  }
}

/** Section 12.10 (PAYROLL_ADMIN): pay periods; closing emits `payPeriod.closed` (leave accrual). */
@ApiTags('admin: payroll')
@Controller('admin/pay-periods')
@Roles('PAYROLL_ADMIN')
export class PayPeriodAdminController {
  constructor(private readonly periods: PayPeriodAdminService) {}

  @Get()
  @ApiOkResponse({ type: AdminPayPeriodsResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: AdminPayPeriodsQueryDto,
  ): Promise<AdminPayPeriodsResponseDto> {
    return this.periods.list(ctx, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminPayPeriodDto })
  get(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<AdminPayPeriodDto> {
    return this.periods.get(ctx, params.id);
  }

  @Post()
  @ApiCreatedResponse({ type: AdminPayPeriodDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreatePayPeriodDto): Promise<AdminPayPeriodDto> {
    return this.periods.create(ctx, body);
  }

  @Put(':id')
  @ApiOkResponse({ type: AdminPayPeriodDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdatePayPeriodDto,
  ): Promise<AdminPayPeriodDto> {
    return this.periods.update(ctx, params.id, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOkResponse({ type: ClosePayPeriodResponseDto })
  close(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<ClosePayPeriodResponseDto> {
    return this.periods.close(ctx, params.id, body.version);
  }
}
