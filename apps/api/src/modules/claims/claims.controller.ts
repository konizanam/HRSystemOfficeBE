import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  CancelClaimRequestSchema,
  ClaimBalancesQuerySchema,
  ClaimBalancesResponseSchema,
  ClaimDetailSchema,
  ClaimEmployeeQuerySchema,
  ClaimGroupSetupResponseSchema,
  ClaimGroupsResponseSchema,
  ClaimsExportQuerySchema,
  ClaimsQuerySchema,
  ClaimsResponseSchema,
  CreateClaimRequestSchema,
  IdParamSchema,
  SavedClaimsQuerySchema,
  SavedClaimsResponseSchema,
  SubmitClaimRequestSchema,
  UpdateClaimRequestSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { ClaimBalanceService } from './claim-balance.service';
import { ClaimSetupService } from './claim-setup.service';
import { ClaimService } from './claim.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class ClaimEmployeeQueryDto extends createZodDto(ClaimEmployeeQuerySchema) {}
class ClaimGroupsResponseDto extends createZodDto(ClaimGroupsResponseSchema) {}
class ClaimGroupSetupResponseDto extends createZodDto(ClaimGroupSetupResponseSchema) {}
class SavedClaimsQueryDto extends createZodDto(SavedClaimsQuerySchema) {}
class SavedClaimsResponseDto extends createZodDto(SavedClaimsResponseSchema) {}
class CreateClaimRequestDto extends createZodDto(CreateClaimRequestSchema) {}
class UpdateClaimRequestDto extends createZodDto(UpdateClaimRequestSchema) {}
class SubmitClaimRequestDto extends createZodDto(SubmitClaimRequestSchema) {}
class CancelClaimRequestDto extends createZodDto(CancelClaimRequestSchema) {}
class ClaimDetailDto extends createZodDto(ClaimDetailSchema) {}
class ClaimsQueryDto extends createZodDto(ClaimsQuerySchema) {}
class ClaimsResponseDto extends createZodDto(ClaimsResponseSchema) {}
class ClaimsExportQueryDto extends createZodDto(ClaimsExportQuerySchema) {}
class ClaimBalancesQueryDto extends createZodDto(ClaimBalancesQuerySchema) {}
class ClaimBalancesResponseDto extends createZodDto(ClaimBalancesResponseSchema) {}

/**
 * Section 12.4: the Submit tiles and a group's setup, drafts, submit, cancel, My Expense Claims
 * (and its audited export), the claim detail and the balances grid. Writes take the `version`
 * read (409 when stale); submit and cancel accept an `Idempotency-Key`.
 */
@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claims: ClaimService,
    private readonly setup: ClaimSetupService,
    private readonly balances: ClaimBalanceService,
  ) {}

  @Get('groups')
  @ApiOkResponse({ type: ClaimGroupsResponseDto })
  groups(
    @Ctx() ctx: SecurityContext,
    @Query() query: ClaimEmployeeQueryDto,
  ): Promise<ClaimGroupsResponseDto> {
    return this.setup.groups(ctx, query.employeeId);
  }

  @Get('groups/:id/setup')
  @ApiOkResponse({ type: ClaimGroupSetupResponseDto })
  groupSetup(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Query() query: ClaimEmployeeQueryDto,
  ): Promise<ClaimGroupSetupResponseDto> {
    return this.setup.setup(ctx, params.id, query.employeeId);
  }

  @Get('saved')
  @ApiOkResponse({ type: SavedClaimsResponseDto })
  saved(@Ctx() ctx: SecurityContext, @Query() query: SavedClaimsQueryDto): Promise<SavedClaimsResponseDto> {
    return this.claims.saved(ctx, query);
  }

  @Get('balances')
  @ApiOkResponse({ type: ClaimBalancesResponseDto })
  balanceGrid(
    @Ctx() ctx: SecurityContext,
    @Query() query: ClaimBalancesQueryDto,
  ): Promise<ClaimBalancesResponseDto> {
    return this.balances.balances(ctx, query);
  }

  @Get('export')
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @Ctx() ctx: SecurityContext,
    @Query() query: ClaimsExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.claims.export(ctx, query);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'private, no-store')
      .send(file.body);
  }

  @Get()
  @ApiOkResponse({ type: ClaimsResponseDto })
  list(@Ctx() ctx: SecurityContext, @Query() query: ClaimsQueryDto): Promise<ClaimsResponseDto> {
    return this.claims.list(ctx, query);
  }

  /** Saves a new draft ("Saved"). */
  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: ClaimDetailDto })
  create(@Ctx() ctx: SecurityContext, @Body() body: CreateClaimRequestDto): Promise<ClaimDetailDto> {
    return this.claims.create(ctx, body);
  }

  @Get(':id')
  @ApiOkResponse({ type: ClaimDetailDto })
  detail(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<ClaimDetailDto> {
    return this.claims.detail(ctx, params.id);
  }

  @Put(':id')
  @ApiOkResponse({ type: ClaimDetailDto })
  update(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateClaimRequestDto,
  ): Promise<ClaimDetailDto> {
    return this.claims.update(ctx, params.id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: ClaimDetailDto })
  submit(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: SubmitClaimRequestDto,
  ): Promise<ClaimDetailDto> {
    return this.claims.submit(ctx, params.id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: ClaimDetailDto })
  cancel(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CancelClaimRequestDto,
  ): Promise<ClaimDetailDto> {
    return this.claims.cancel(ctx, params.id, body);
  }
}
