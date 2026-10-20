import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  AuditEntityParamSchema,
  AuditExportRequestSchema,
  AuditIdParamSchema,
  AuditListQuerySchema,
  AuditListResponseSchema,
  AuditRowDetailSchema,
  AuditVerifyQuerySchema,
  AuditVerifyResponseSchema,
  EntityHistoryResponseSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { AuditApiService } from './audit-api.service';

class AuditListQueryDto extends createZodDto(AuditListQuerySchema) {}
class AuditListResponseDto extends createZodDto(AuditListResponseSchema) {}
class AuditIdParamDto extends createZodDto(AuditIdParamSchema) {}
class AuditRowDetailDto extends createZodDto(AuditRowDetailSchema) {}
class AuditEntityParamDto extends createZodDto(AuditEntityParamSchema) {}
class EntityHistoryResponseDto extends createZodDto(EntityHistoryResponseSchema) {}
class AuditVerifyQueryDto extends createZodDto(AuditVerifyQuerySchema) {}
class AuditVerifyResponseDto extends createZodDto(AuditVerifyResponseSchema) {}
class AuditExportRequestDto extends createZodDto(AuditExportRequestSchema) {}

/**
 * Section 12.11: the audit explorer, verification and export (AUDITOR and SYSTEM_ADMIN), and the
 * record history of an entity (any user allowed to see that entity, section 9.7).
 */
@ApiTags('audit')
@Controller('audit')
export class AuditApiController {
  constructor(private readonly audit: AuditApiService) {}

  @Get()
  @Roles('AUDITOR', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AuditListResponseDto })
  list(@Ctx() ctx: SecurityContext, @Query() query: AuditListQueryDto): Promise<AuditListResponseDto> {
    return this.audit.list(ctx, query);
  }

  @Get('verify')
  @Roles('AUDITOR', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AuditVerifyResponseDto })
  verify(@Query() query: AuditVerifyQueryDto): Promise<AuditVerifyResponseDto> {
    return this.audit.verify(query);
  }

  @Get('entity/:entityType/:entityId')
  @ApiOkResponse({ type: EntityHistoryResponseDto })
  entity(
    @Ctx() ctx: SecurityContext,
    @Param() params: AuditEntityParamDto,
  ): Promise<EntityHistoryResponseDto> {
    return this.audit.entityHistory(ctx, params.entityType, params.entityId);
  }

  @Get(':id')
  @Roles('AUDITOR', 'SYSTEM_ADMIN')
  @ApiOkResponse({ type: AuditRowDetailDto })
  get(@Ctx() ctx: SecurityContext, @Param() params: AuditIdParamDto): Promise<AuditRowDetailDto> {
    return this.audit.get(ctx, params.id);
  }

  /** Streams CSV or Excel; the export itself is audited `EXPORT.AUDIT`. */
  @Post('export')
  @Roles('AUDITOR', 'SYSTEM_ADMIN')
  @HttpCode(200)
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @Ctx() ctx: SecurityContext,
    @Body() body: AuditExportRequestDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.audit.export(ctx, body);
    await reply
      .status(200)
      .header('cache-control', 'private, no-store')
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .send(file.stream);
  }
}
