import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CompaniesResponseSchema,
  CompanyRulesQuerySchema,
  CompanyRulesResponseSchema,
  EmployeePickerQuerySchema,
  EmployeePickerResponseSchema,
  PositionsQuerySchema,
  PositionsResponseSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { PickerService } from './picker.service';

class EmployeePickerQueryDto extends createZodDto(EmployeePickerQuerySchema) {}
class EmployeePickerResponseDto extends createZodDto(EmployeePickerResponseSchema) {}
class CompaniesResponseDto extends createZodDto(CompaniesResponseSchema) {}
class CompanyRulesQueryDto extends createZodDto(CompanyRulesQuerySchema) {}
class CompanyRulesResponseDto extends createZodDto(CompanyRulesResponseSchema) {}
class PositionsQueryDto extends createZodDto(PositionsQuerySchema) {}
class PositionsResponseDto extends createZodDto(PositionsResponseSchema) {}

/**
 * Scoped pickers (any signed-in user; the rows follow the caller's scope, see PickerService).
 * These static paths win over `GET /lookups/:table`.
 */
@ApiTags('lookups')
@Controller('lookups')
export class PickersController {
  constructor(private readonly pickers: PickerService) {}

  @Get('employees')
  @ApiOkResponse({ type: EmployeePickerResponseDto })
  employees(
    @Ctx() ctx: SecurityContext,
    @Query() query: EmployeePickerQueryDto,
  ): Promise<EmployeePickerResponseDto> {
    return this.pickers.employees(ctx, query);
  }

  @Get('companies')
  @ApiOkResponse({ type: CompaniesResponseDto })
  companies(@Ctx() ctx: SecurityContext): Promise<CompaniesResponseDto> {
    return this.pickers.companies(ctx);
  }

  @Get('company-rules')
  @ApiOkResponse({ type: CompanyRulesResponseDto })
  companyRules(
    @Ctx() ctx: SecurityContext,
    @Query() query: CompanyRulesQueryDto,
  ): Promise<CompanyRulesResponseDto> {
    return this.pickers.companyRules(ctx, query);
  }

  @Get('positions')
  @ApiOkResponse({ type: PositionsResponseDto })
  positions(@Ctx() ctx: SecurityContext, @Query() query: PositionsQueryDto): Promise<PositionsResponseDto> {
    return this.pickers.positions(ctx, query);
  }
}
