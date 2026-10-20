import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  InboxCategoriesResponseSchema,
  InboxItemDetailSchema,
  InboxItemsQuerySchema,
  InboxItemsResponseSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { InboxService } from './inbox.service';

class InboxCategoriesResponseDto extends createZodDto(InboxCategoriesResponseSchema) {}
class InboxItemsQueryDto extends createZodDto(InboxItemsQuerySchema) {}
class InboxItemsResponseDto extends createZodDto(InboxItemsResponseSchema) {}
class InboxItemDetailDto extends createZodDto(InboxItemDetailSchema) {}
class ProcessIdParamDto extends createZodDto(z.object({ processId: z.coerce.number().int().positive() })) {}

/** Section 12.7: the inbox category panel, the item tabs and the detail panel. */
@ApiTags('inbox')
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('categories')
  @ApiOkResponse({ type: InboxCategoriesResponseDto })
  categories(@Ctx() ctx: SecurityContext): Promise<InboxCategoriesResponseDto> {
    return this.inbox.categories(ctx);
  }

  @Get('items')
  @ApiOkResponse({ type: InboxItemsResponseDto })
  items(@Ctx() ctx: SecurityContext, @Query() query: InboxItemsQueryDto): Promise<InboxItemsResponseDto> {
    return this.inbox.items(ctx, query);
  }

  @Get('items/:processId')
  @ApiOkResponse({ type: InboxItemDetailDto })
  detail(@Ctx() ctx: SecurityContext, @Param() params: ProcessIdParamDto): Promise<InboxItemDetailDto> {
    return this.inbox.detail(ctx, params.processId);
  }
}
