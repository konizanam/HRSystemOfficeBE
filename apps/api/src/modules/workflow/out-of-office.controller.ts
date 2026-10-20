import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  NomineeOptionsResponseSchema,
  OutOfOfficeResponseSchema,
  UpdateOutOfOfficeRequestSchema,
  UserOptionsQuerySchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { OutOfOfficeService } from './out-of-office.service';

class OutOfOfficeResponseDto extends createZodDto(OutOfOfficeResponseSchema) {}
class UpdateOutOfOfficeRequestDto extends createZodDto(UpdateOutOfOfficeRequestSchema) {}
class NomineeOptionsQueryDto extends createZodDto(UserOptionsQuerySchema) {}
class NomineeOptionsResponseDto extends createZodDto(NomineeOptionsResponseSchema) {}

/**
 * Section 12.8: Profile settings → Out of office (section 5.11). Blocked while working as someone
 * else (restricted feature OUT_OF_OFFICE).
 */
@ApiTags('profile')
@Controller('profile/out-of-office')
export class OutOfOfficeController {
  constructor(private readonly outOfOffice: OutOfOfficeService) {}

  @Get()
  @ApiOkResponse({ type: OutOfOfficeResponseDto })
  get(@Ctx() ctx: SecurityContext): Promise<OutOfOfficeResponseDto> {
    return this.outOfOffice.get(ctx);
  }

  @Put()
  @ApiOkResponse({ type: OutOfOfficeResponseDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Body() body: UpdateOutOfOfficeRequestDto,
  ): Promise<OutOfOfficeResponseDto> {
    return this.outOfOffice.update(ctx, body);
  }

  @Get('nominees')
  @ApiOkResponse({ type: NomineeOptionsResponseDto })
  nominees(
    @Ctx() ctx: SecurityContext,
    @Query() query: NomineeOptionsQueryDto,
  ): Promise<NomineeOptionsResponseDto> {
    return this.outOfOffice.nominees(ctx, query.search);
  }
}
