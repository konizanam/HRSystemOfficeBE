import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  ReportCatalogueSchema,
  ReportEmployeesQuerySchema,
  ReportEmployeesResponseSchema,
  ReportPageSchema,
  RunReportRequestSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { ReportsService } from './reports.service';

class ReportCatalogueDto extends createZodDto(ReportCatalogueSchema) {}
class ReportCodeParamDto extends createZodDto(z.object({ code: z.string().regex(/^[A-Z_]{2,60}$/) })) {}
class ReportEmployeesQueryDto extends createZodDto(ReportEmployeesQuerySchema) {}
class ReportEmployeesResponseDto extends createZodDto(ReportEmployeesResponseSchema) {}
class RunReportRequestDto extends createZodDto(RunReportRequestSchema) {}
class ReportPageDto extends createZodDto(ReportPageSchema) {}

/**
 * Section 12.11: the report catalogue and runs. `format: 'json'` answers one page for the grid;
 * `csv`, `xlsx` and `pdf` stream a file (chunked). Every run is audited `EXPORT.REPORT`.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOkResponse({ type: ReportCatalogueDto })
  catalogue(@Ctx() ctx: SecurityContext): Promise<ReportCatalogueDto> {
    return this.reports.catalogue(ctx);
  }

  @Get(':code/employees')
  @ApiOkResponse({ type: ReportEmployeesResponseDto })
  employees(
    @Ctx() ctx: SecurityContext,
    @Param() params: ReportCodeParamDto,
    @Query() query: ReportEmployeesQueryDto,
  ): Promise<ReportEmployeesResponseDto> {
    return this.reports.employees(ctx, params.code, query);
  }

  @Post(':code/run')
  @ApiOkResponse({ type: ReportPageDto })
  @ApiProduces(
    'application/json',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
  )
  async run(
    @Ctx() ctx: SecurityContext,
    @Param() params: ReportCodeParamDto,
    @Body() body: RunReportRequestDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.reports.run(ctx, params.code, body);
    reply.status(200).header('cache-control', 'private, no-store');
    if (result.kind === 'json') {
      await reply.send(result.page);
      return;
    }
    await reply
      .header('content-type', result.contentType)
      .header('content-disposition', `attachment; filename="${result.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .send(result.stream);
  }
}
