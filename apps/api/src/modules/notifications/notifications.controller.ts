import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  NotificationIdParamSchema,
  NotificationReadAllResponseSchema,
  NotificationReadResponseSchema,
  NotificationsQuerySchema,
  NotificationsResponseSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { NotificationService } from './notification.service';

class NotificationsQueryDto extends createZodDto(NotificationsQuerySchema) {}
class NotificationsResponseDto extends createZodDto(NotificationsResponseSchema) {}
class NotificationIdParamDto extends createZodDto(NotificationIdParamSchema) {}
class NotificationReadResponseDto extends createZodDto(NotificationReadResponseSchema) {}
class NotificationReadAllResponseDto extends createZodDto(NotificationReadAllResponseSchema) {}

/** Section 12.7: the Notification Inbox and the bell count. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOkResponse({ type: NotificationsResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: NotificationsQueryDto,
  ): Promise<NotificationsResponseDto> {
    return this.notifications.list(ctx, query);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOkResponse({ type: NotificationReadAllResponseDto })
  readAll(@Ctx() ctx: SecurityContext): Promise<NotificationReadAllResponseDto> {
    return this.notifications.markAllRead(ctx);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOkResponse({ type: NotificationReadResponseDto })
  read(
    @Ctx() ctx: SecurityContext,
    @Param() params: NotificationIdParamDto,
  ): Promise<NotificationReadResponseDto> {
    return this.notifications.markRead(ctx, params.id);
  }
}
