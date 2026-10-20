import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminFreeTextTypeSchema,
  AdminFreeTextTypesResponseSchema,
  AdminVersionRequestSchema,
  CreateFreeTextTypeRequestSchema,
  FreeTextAboutOptionsQuerySchema,
  FreeTextAboutOptionsResponseSchema,
  FreeTextListQuerySchema,
  FreeTextListResponseSchema,
  FreeTextRequestDtoSchema,
  FreeTextTypesResponseSchema,
  IdParamSchema,
  SubmitFreeTextRequestSchema,
  UpdateFreeTextTypeRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { FreeTextService } from './free-text.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class VersionDto extends createZodDto(AdminVersionRequestSchema) {}
class TypesQueryDto extends createZodDto(
  z.object({ employeeId: z.coerce.number().int().positive().optional() }),
) {}
class FreeTextTypesResponseDto extends createZodDto(FreeTextTypesResponseSchema) {}
class SubmitFreeTextDto extends createZodDto(SubmitFreeTextRequestSchema) {}
class FreeTextRequestDto extends createZodDto(FreeTextRequestDtoSchema) {}
class FreeTextListQueryDto extends createZodDto(FreeTextListQuerySchema) {}
class FreeTextListResponseDto extends createZodDto(FreeTextListResponseSchema) {}
class AboutOptionsQueryDto extends createZodDto(FreeTextAboutOptionsQuerySchema) {}
class AboutOptionsResponseDto extends createZodDto(FreeTextAboutOptionsResponseSchema) {}
class AdminFreeTextTypeDto extends createZodDto(AdminFreeTextTypeSchema) {}
class AdminFreeTextTypesResponseDto extends createZodDto(AdminFreeTextTypesResponseSchema) {}
class CreateFreeTextTypeDto extends createZodDto(CreateFreeTextTypeRequestSchema) {}
class UpdateFreeTextTypeDto extends createZodDto(UpdateFreeTextTypeRequestSchema) {}

/** Section 12.8: the Free Text Workflow (section 5.8). */
@ApiTags('free text')
@Controller('free-text')
export class FreeTextController {
  constructor(private readonly freeText: FreeTextService) {}

  @Get('types')
  @ApiOkResponse({ type: FreeTextTypesResponseDto })
  types(@Ctx() ctx: SecurityContext, @Query() query: TypesQueryDto): Promise<FreeTextTypesResponseDto> {
    return this.freeText.types(ctx, query.employeeId);
  }

  @Get('about-options')
  @ApiOkResponse({ type: AboutOptionsResponseDto })
  aboutOptions(
    @Ctx() ctx: SecurityContext,
    @Query() query: AboutOptionsQueryDto,
  ): Promise<AboutOptionsResponseDto> {
    return this.freeText.aboutOptions(ctx, query);
  }

  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: FreeTextRequestDto })
  submit(@Ctx() ctx: SecurityContext, @Body() body: SubmitFreeTextDto): Promise<FreeTextRequestDto> {
    return this.freeText.submit(ctx, body);
  }

  @Get()
  @ApiOkResponse({ type: FreeTextListResponseDto })
  list(@Ctx() ctx: SecurityContext, @Query() query: FreeTextListQueryDto): Promise<FreeTextListResponseDto> {
    return this.freeText.list(ctx, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: FreeTextRequestDto })
  get(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<FreeTextRequestDto> {
    return this.freeText.get(ctx, params.id);
  }
}

/** Section 12.10 (HR_ADMIN): free text types. DELETE deactivates. */
@ApiTags('admin: free text')
@Controller('admin/free-text-types')
@Roles('HR_ADMIN')
export class FreeTextAdminController {
  constructor(private readonly freeText: FreeTextService) {}

  @Get()
  @ApiOkResponse({ type: AdminFreeTextTypesResponseDto })
  list(): Promise<AdminFreeTextTypesResponseDto> {
    return this.freeText.adminTypes();
  }

  @Post()
  @ApiCreatedResponse({ type: AdminFreeTextTypeDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreateFreeTextTypeDto): Promise<AdminFreeTextTypeDto> {
    return this.freeText.createType(ctx, body);
  }

  @Put(':id')
  @ApiOkResponse({ type: AdminFreeTextTypeDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateFreeTextTypeDto,
  ): Promise<AdminFreeTextTypeDto> {
    return this.freeText.updateType(ctx, params.id, body);
  }

  @Delete(':id')
  @ApiOkResponse({ type: AdminFreeTextTypeDto })
  deactivate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminFreeTextTypeDto> {
    return this.freeText.deactivateType(ctx, params.id, body.version);
  }
}
