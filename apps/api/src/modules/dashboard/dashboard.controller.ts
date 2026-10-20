import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  DashboardLayoutResponseSchema,
  DashboardSummarySchema,
  UpcomingBirthdaysQuerySchema,
  UpcomingBirthdaysResponseSchema,
  UpdateDashboardLayoutRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { BirthdayService } from './birthday.service';
import { DashboardService } from './dashboard.service';

class DashboardLayoutResponseDto extends createZodDto(DashboardLayoutResponseSchema) {}
class UpdateDashboardLayoutRequestDto extends createZodDto(UpdateDashboardLayoutRequestSchema) {}
class DashboardSummaryDto extends createZodDto(DashboardSummarySchema) {}
class UpcomingBirthdaysQueryDto extends createZodDto(UpcomingBirthdaysQuerySchema) {}
class UpcomingBirthdaysResponseDto extends createZodDto(UpcomingBirthdaysResponseSchema) {}

/** Section 12.2: the dashboard layout and summary. */
@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('layout')
  @ApiOkResponse({ type: DashboardLayoutResponseDto })
  layout(@Ctx() ctx: SecurityContext): Promise<DashboardLayoutResponseDto> {
    return this.dashboard.layout(ctx);
  }

  @Put('layout')
  @ApiOkResponse({ type: DashboardLayoutResponseDto })
  updateLayout(
    @Ctx() ctx: SecurityContext,
    @Body() body: UpdateDashboardLayoutRequestDto,
  ): Promise<DashboardLayoutResponseDto> {
    return this.dashboard.updateLayout(ctx, body);
  }

  @Get('summary')
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@Ctx() ctx: SecurityContext): Promise<DashboardSummaryDto> {
    return this.dashboard.summary(ctx);
  }
}

/** Section 12.2: `GET /birthdays/upcoming?days=30` (name and day/month only). */
@ApiTags('dashboard')
@Controller('birthdays')
export class BirthdaysController {
  constructor(private readonly birthdays: BirthdayService) {}

  @Get('upcoming')
  @ApiOkResponse({ type: UpcomingBirthdaysResponseDto })
  upcoming(
    @Ctx() ctx: SecurityContext,
    @Query() query: UpcomingBirthdaysQueryDto,
  ): Promise<UpcomingBirthdaysResponseDto> {
    return this.birthdays.upcoming(ctx, query.days);
  }
}
