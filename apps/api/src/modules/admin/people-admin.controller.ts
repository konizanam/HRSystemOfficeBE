import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminEmployeeSchema,
  AdminEmployeesQuerySchema,
  AdminEmployeesResponseSchema,
  AdminUserSchema,
  AdminUsersQuerySchema,
  AdminUsersResponseSchema,
  CreateEmployeeRequestSchema,
  CreateUserRequestSchema,
  DeactivateUserResponseSchema,
  EmployeeImportRequestSchema,
  EmployeeImportResponseSchema,
  IdParamSchema,
  SetEmployeePhotoRequestSchema,
  TerminateEmployeeRequestSchema,
  TerminateEmployeeResponseSchema,
  UpdateEmployeeRequestSchema,
  UpdateUserRequestSchema,
  UpdateUserRolesRequestSchema,
  UserActionRequestSchema,
  UserEmployeeOptionsQuerySchema,
  UserEmployeeOptionsResponseSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { EmployeeAdminService } from './employee-admin.service';
import { EmployeeImportService } from './employee-import.service';
import { UserAdminService } from './user-admin.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class UserIdParamDto extends createZodDto(z.object({ id: z.string().uuid('Expected a user id') })) {}
class AdminEmployeeDto extends createZodDto(AdminEmployeeSchema) {}
class AdminEmployeesQueryDto extends createZodDto(AdminEmployeesQuerySchema) {}
class AdminEmployeesResponseDto extends createZodDto(AdminEmployeesResponseSchema) {}
class CreateEmployeeDto extends createZodDto(CreateEmployeeRequestSchema) {}
class UpdateEmployeeDto extends createZodDto(UpdateEmployeeRequestSchema) {}
class TerminateEmployeeDto extends createZodDto(TerminateEmployeeRequestSchema) {}
class TerminateEmployeeResponseDto extends createZodDto(TerminateEmployeeResponseSchema) {}
class SetEmployeePhotoDto extends createZodDto(SetEmployeePhotoRequestSchema) {}
class EmployeeImportDto extends createZodDto(EmployeeImportRequestSchema) {}
class EmployeeImportResponseDto extends createZodDto(EmployeeImportResponseSchema) {}
class AdminUserDto extends createZodDto(AdminUserSchema) {}
class AdminUsersQueryDto extends createZodDto(AdminUsersQuerySchema) {}
class AdminUsersResponseDto extends createZodDto(AdminUsersResponseSchema) {}
class CreateUserDto extends createZodDto(CreateUserRequestSchema) {}
class UpdateUserDto extends createZodDto(UpdateUserRequestSchema) {}
class UpdateUserRolesDto extends createZodDto(UpdateUserRolesRequestSchema) {}
class UserActionDto extends createZodDto(UserActionRequestSchema) {}
class DeactivateUserResponseDto extends createZodDto(DeactivateUserResponseSchema) {}
class UserEmployeeOptionsQueryDto extends createZodDto(UserEmployeeOptionsQuerySchema) {}
class UserEmployeeOptionsResponseDto extends createZodDto(UserEmployeeOptionsResponseSchema) {}

/**
 * Section 12.10: employees (HR fields, terminate, photo) and the employee CSV import. HR_ADMIN
 * writes; HR_ADMIN and PAYROLL_ADMIN read, within their companies.
 */
@ApiTags('admin: employees')
@Controller('admin')
export class EmployeeAdminController {
  constructor(
    private readonly employees: EmployeeAdminService,
    private readonly importer: EmployeeImportService,
  ) {}

  @Get('employees')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminEmployeesResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: AdminEmployeesQueryDto,
  ): Promise<AdminEmployeesResponseDto> {
    return this.employees.list(ctx, query);
  }

  @Get('employees/:id')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminEmployeeDto })
  get(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<AdminEmployeeDto> {
    return this.employees.get(ctx, params.id);
  }

  @Post('employees')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminEmployeeDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreateEmployeeDto): Promise<AdminEmployeeDto> {
    return this.employees.create(ctx, body);
  }

  @Put('employees/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminEmployeeDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateEmployeeDto,
  ): Promise<AdminEmployeeDto> {
    return this.employees.update(ctx, params.id, body);
  }

  @Post('employees/:id/terminate')
  @Roles('HR_ADMIN')
  @HttpCode(200)
  @ApiOkResponse({ type: TerminateEmployeeResponseDto })
  terminate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: TerminateEmployeeDto,
  ): Promise<TerminateEmployeeResponseDto> {
    return this.employees.terminate(ctx, params.id, body);
  }

  @Put('employees/:id/photo')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminEmployeeDto })
  setPhoto(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: SetEmployeePhotoDto,
  ): Promise<AdminEmployeeDto> {
    return this.employees.setPhoto(ctx, params.id, body);
  }

  /** CSV import: `DRY_RUN` first, then `COMMIT` with the dry run's `confirmToken`. */
  @Post('import/employees')
  @Roles('HR_ADMIN')
  @HttpCode(200)
  @ApiOkResponse({ type: EmployeeImportResponseDto })
  importEmployees(
    @Ctx() ctx: SecurityContext,
    @Body() body: EmployeeImportDto,
  ): Promise<EmployeeImportResponseDto> {
    return this.importer.run(ctx, body);
  }
}

/** Section 12.10 (SYSTEM_ADMIN): users, roles, activation, unlock, password and MFA resets. */
@ApiTags('admin: users')
@Controller('admin/users')
@Roles('SYSTEM_ADMIN')
export class UserAdminController {
  constructor(private readonly users: UserAdminService) {}

  @Get()
  @ApiOkResponse({ type: AdminUsersResponseDto })
  list(@Query() query: AdminUsersQueryDto): Promise<AdminUsersResponseDto> {
    return this.users.list(query);
  }

  @Get('employee-options')
  @ApiOkResponse({ type: UserEmployeeOptionsResponseDto })
  employeeOptions(@Query() query: UserEmployeeOptionsQueryDto): Promise<UserEmployeeOptionsResponseDto> {
    return this.users.employeeOptions(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminUserDto })
  get(@Param() params: UserIdParamDto): Promise<AdminUserDto> {
    return this.users.get(params.id);
  }

  @Post()
  @ApiCreatedResponse({ type: AdminUserDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreateUserDto): Promise<AdminUserDto> {
    return this.users.create(ctx, body);
  }

  @Put(':id')
  @ApiOkResponse({ type: AdminUserDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UpdateUserDto,
  ): Promise<AdminUserDto> {
    return this.users.update(ctx, params.id, body);
  }

  @Put(':id/roles')
  @ApiOkResponse({ type: AdminUserDto })
  setRoles(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UpdateUserRolesDto,
  ): Promise<AdminUserDto> {
    return this.users.setRoles(ctx, params.id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminUserDto })
  activate(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UserActionDto,
  ): Promise<AdminUserDto> {
    return this.users.activate(ctx, params.id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOkResponse({ type: DeactivateUserResponseDto })
  deactivate(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UserActionDto,
  ): Promise<DeactivateUserResponseDto> {
    return this.users.deactivate(ctx, params.id, body);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminUserDto })
  unlock(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UserActionDto,
  ): Promise<AdminUserDto> {
    return this.users.unlock(ctx, params.id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminUserDto })
  resetPassword(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UserActionDto,
  ): Promise<AdminUserDto> {
    return this.users.resetPassword(ctx, params.id, body);
  }

  @Post(':id/reset-mfa')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminUserDto })
  resetMfa(
    @Ctx() ctx: SecurityContext,
    @Param() params: UserIdParamDto,
    @Body() body: UserActionDto,
  ): Promise<AdminUserDto> {
    return this.users.resetMfa(ctx, params.id, body);
  }
}
