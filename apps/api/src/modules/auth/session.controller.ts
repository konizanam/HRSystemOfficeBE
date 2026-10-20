import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ActingAsOptionsQuerySchema,
  ActingAsOptionsResponseSchema,
  ActivityResponseSchema,
  SessionSchema,
  SetActingAsRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { ActingAsService } from './acting-as.service';
import { AllowPendingPasswordChange } from './decorators';
import { SessionService } from './session.service';

class SessionDto extends createZodDto(SessionSchema) {}
class ActivityResponseDto extends createZodDto(ActivityResponseSchema) {}
class ActingAsOptionsQueryDto extends createZodDto(ActingAsOptionsQuerySchema) {}
class ActingAsOptionsResponseDto extends createZodDto(ActingAsOptionsResponseSchema) {}
class SetActingAsDto extends createZodDto(SetActingAsRequestSchema) {}

/** Section 12.1: the current session, the idle heartbeat and the "Working as" picker. */
@ApiTags('session')
@Controller('session')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly actingAs: ActingAsService,
  ) {}

  @Get()
  @AllowPendingPasswordChange()
  @ApiOkResponse({ type: SessionDto })
  get(@Ctx() ctx: SecurityContext): Promise<SessionDto> {
    return this.sessions.describe(ctx);
  }

  /** Heartbeat. The guard has already recorded the activity (it is a POST). */
  @Post('activity')
  @AllowPendingPasswordChange()
  @HttpCode(200)
  @ApiOkResponse({ type: ActivityResponseDto })
  activity(@Ctx() ctx: SecurityContext): Promise<ActivityResponseDto> {
    return this.sessions.activity(ctx);
  }

  @Get('acting-as/options')
  @ApiOkResponse({ type: ActingAsOptionsResponseDto })
  options(
    @Ctx() ctx: SecurityContext,
    @Query() query: ActingAsOptionsQueryDto,
  ): Promise<ActingAsOptionsResponseDto> {
    return this.actingAs.options(ctx, query.search);
  }

  @Put('acting-as')
  @ApiOkResponse({ type: SessionDto })
  set(@Ctx() ctx: SecurityContext, @Body() body: SetActingAsDto): Promise<SessionDto> {
    return this.actingAs.set(ctx, body.employeeId);
  }
}
