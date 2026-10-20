import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  LeaveCalendarExportQuerySchema,
  LeaveCalendarQuerySchema,
  LeaveCalendarResponseSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { LeaveCalendarService } from './leave-calendar.service';

class LeaveCalendarQueryDto extends createZodDto(LeaveCalendarQuerySchema) {}
class LeaveCalendarExportQueryDto extends createZodDto(LeaveCalendarExportQuerySchema) {}
class LeaveCalendarResponseDto extends createZodDto(LeaveCalendarResponseSchema) {}

/** Section 12.2: the dashboard leave calendar and its audited export. */
@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: LeaveCalendarService) {}

  @Get('leave')
  @ApiOkResponse({ type: LeaveCalendarResponseDto })
  leave(
    @Ctx() ctx: SecurityContext,
    @Query() query: LeaveCalendarQueryDto,
  ): Promise<LeaveCalendarResponseDto> {
    return this.calendar.calendar(ctx, query);
  }

  @Get('leave/export')
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @Ctx() ctx: SecurityContext,
    @Query() query: LeaveCalendarExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.calendar.export(ctx, query);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'private, no-store')
      .send(file.body);
  }
}
