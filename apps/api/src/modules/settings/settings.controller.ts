import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AdminSettingsResponseSchema, UpdateSettingsRequestSchema } from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { SettingsService } from './settings.service';

class AdminSettingsDto extends createZodDto(AdminSettingsResponseSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateSettingsRequestSchema) {}

/** `GET/PUT /admin/settings` (section 12.10), SYSTEM_ADMIN only. */
@ApiTags('admin')
@Controller('admin/settings')
@Roles('SYSTEM_ADMIN')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOkResponse({ type: AdminSettingsDto })
  get(): Promise<AdminSettingsDto> {
    return this.settings.adminView();
  }

  @Put()
  @ApiOkResponse({ type: AdminSettingsDto })
  update(@Ctx() ctx: SecurityContext, @Body() body: UpdateSettingsDto): Promise<AdminSettingsDto> {
    return this.settings.update(ctx, body.values);
  }
}
