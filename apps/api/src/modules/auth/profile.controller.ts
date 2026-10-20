import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { MobilePairingResponseSchema } from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { MobilePairingService } from './mobile-pairing.service';

class MobilePairingResponseDto extends createZodDto(MobilePairingResponseSchema) {}

/** Profile settings menu: "Setup mobile" (section 1.1, ASSUMPTION A3). */
@ApiTags('profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly pairing: MobilePairingService) {}

  @Post('mobile/pairing')
  @HttpCode(201)
  @ApiCreatedResponse({ type: MobilePairingResponseDto })
  create(@Ctx() ctx: SecurityContext): Promise<MobilePairingResponseDto> {
    return this.pairing.create(ctx);
  }
}
