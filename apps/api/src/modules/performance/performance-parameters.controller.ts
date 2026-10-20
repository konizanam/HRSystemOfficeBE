import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminParameterValueSchema,
  AdminParameterValuesResponseSchema,
  CreateParameterValueRequestSchema,
  DeactivateRequestSchema,
  ParameterTableParamSchema,
  ParameterValueParamSchema,
  ParameterValuesQuerySchema,
  ParameterValuesResponseSchema,
  UpdateParameterValueRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { PerformanceParameterService } from './performance-parameter.service';

class ParameterTableParamDto extends createZodDto(ParameterTableParamSchema) {}
class ParameterValueParamDto extends createZodDto(ParameterValueParamSchema) {}
class ParameterValuesQueryDto extends createZodDto(ParameterValuesQuerySchema) {}
class ParameterValuesResponseDto extends createZodDto(ParameterValuesResponseSchema) {}
class AdminParameterValueDto extends createZodDto(AdminParameterValueSchema) {}
class AdminParameterValuesResponseDto extends createZodDto(AdminParameterValuesResponseSchema) {}
class CreateParameterValueRequestDto extends createZodDto(CreateParameterValueRequestSchema) {}
class UpdateParameterValueRequestDto extends createZodDto(UpdateParameterValueRequestSchema) {}
class DeactivateRequestDto extends createZodDto(DeactivateRequestSchema) {}

/** Section 12.9 `GET /lookups/parameters/:table`: the performance pick lists (any signed-in user). */
@ApiTags('performance')
@Controller('lookups/parameters')
export class PerformanceLookupsController {
  constructor(private readonly parameters: PerformanceParameterService) {}

  @Get(':table')
  @ApiOkResponse({ type: ParameterValuesResponseDto })
  list(
    @Param() params: ParameterTableParamDto,
    @Query() query: ParameterValuesQueryDto,
  ): Promise<ParameterValuesResponseDto> {
    return this.parameters.list(params.table, query);
  }
}

/**
 * Section 12.10 `CRUD /admin/parameters/:table` (HR_ADMIN): the performance parameter tables.
 * Deleting deactivates (no hard deletes); every change is audited.
 */
@ApiTags('admin: performance')
@Controller('admin/parameters')
@Roles('HR_ADMIN')
export class PerformanceParametersAdminController {
  constructor(private readonly parameters: PerformanceParameterService) {}

  @Get(':table')
  @ApiOkResponse({ type: AdminParameterValuesResponseDto })
  list(@Param() params: ParameterTableParamDto): Promise<AdminParameterValuesResponseDto> {
    return this.parameters.adminList(params.table);
  }

  @Post(':table')
  @ApiCreatedResponse({ type: AdminParameterValueDto })
  create(
    @Ctx() ctx: SecurityContext,
    @Param() params: ParameterTableParamDto,
    @Body() body: CreateParameterValueRequestDto,
  ): Promise<AdminParameterValueDto> {
    return this.parameters.create(ctx, params.table, body);
  }

  @Put(':table/:id')
  @ApiOkResponse({ type: AdminParameterValueDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: ParameterValueParamDto,
    @Body() body: UpdateParameterValueRequestDto,
  ): Promise<AdminParameterValueDto> {
    return this.parameters.update(ctx, params.table, params.id, body);
  }

  @Delete(':table/:id')
  @ApiOkResponse({ type: AdminParameterValueDto })
  deactivate(
    @Ctx() ctx: SecurityContext,
    @Param() params: ParameterValueParamDto,
    @Body() body: DeactivateRequestDto,
  ): Promise<AdminParameterValueDto> {
    return this.parameters.deactivate(ctx, params.table, params.id, body.version);
  }
}
