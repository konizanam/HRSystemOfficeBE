import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  ArchiveContractRequestSchema,
  ContractInitiationSchema,
  ContractReviewsExportQuerySchema,
  ContractReviewsQuerySchema,
  ContractReviewsResponseSchema,
  ContractsExportQuerySchema,
  ContractsQuerySchema,
  ContractsResponseSchema,
  CopyReviewRequestSchema,
  CopyTemplateRequestSchema,
  CreateInitiationRequestSchema,
  CreateReviewRequestSchema,
  CreateReviewResponseSchema,
  CreateTemplateRequestSchema,
  IdParamSchema,
  InitiationsExportQuerySchema,
  InitiationsQuerySchema,
  InitiationsResponseSchema,
  PerformanceContractSchema,
  PerformanceTemplateSchema,
  RatingScalesResponseSchema,
  ResultsQuerySchema,
  ResultsResponseSchema,
  ReviewDetailSchema,
  ReviewsQuerySchema,
  ReviewsResponseSchema,
  ReviewStatusRequestSchema,
  SubmitScoresRequestSchema,
  TemplatesExportQuerySchema,
  TemplatesQuerySchema,
  TemplatesResponseSchema,
  UpdateContractRequestSchema,
  UpdateReviewRequestSchema,
  UpdateTemplateRequestSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { ContractService } from './contract.service';
import type { ExportFile } from './performance-export';
import { InitiationService } from './initiation.service';
import { ReviewService } from './review.service';
import { TemplateService } from './template.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class RatingScalesResponseDto extends createZodDto(RatingScalesResponseSchema) {}
class TemplatesQueryDto extends createZodDto(TemplatesQuerySchema) {}
class TemplatesResponseDto extends createZodDto(TemplatesResponseSchema) {}
class PerformanceTemplateDto extends createZodDto(PerformanceTemplateSchema) {}
class CreateTemplateRequestDto extends createZodDto(CreateTemplateRequestSchema) {}
class UpdateTemplateRequestDto extends createZodDto(UpdateTemplateRequestSchema) {}
class CopyTemplateRequestDto extends createZodDto(CopyTemplateRequestSchema) {}
class InitiationsQueryDto extends createZodDto(InitiationsQuerySchema) {}
class InitiationsResponseDto extends createZodDto(InitiationsResponseSchema) {}
class ContractInitiationDto extends createZodDto(ContractInitiationSchema) {}
class CreateInitiationRequestDto extends createZodDto(CreateInitiationRequestSchema) {}
class ContractsQueryDto extends createZodDto(ContractsQuerySchema) {}
class ContractsResponseDto extends createZodDto(ContractsResponseSchema) {}
class PerformanceContractDto extends createZodDto(PerformanceContractSchema) {}
class UpdateContractRequestDto extends createZodDto(UpdateContractRequestSchema) {}
class ArchiveContractRequestDto extends createZodDto(ArchiveContractRequestSchema) {}
class ReviewsQueryDto extends createZodDto(ReviewsQuerySchema) {}
class ReviewsResponseDto extends createZodDto(ReviewsResponseSchema) {}
class ReviewDetailDto extends createZodDto(ReviewDetailSchema) {}
class CreateReviewRequestDto extends createZodDto(CreateReviewRequestSchema) {}
class CreateReviewResponseDto extends createZodDto(CreateReviewResponseSchema) {}
class UpdateReviewRequestDto extends createZodDto(UpdateReviewRequestSchema) {}
class CopyReviewRequestDto extends createZodDto(CopyReviewRequestSchema) {}
class ReviewStatusRequestDto extends createZodDto(ReviewStatusRequestSchema) {}
class SubmitScoresRequestDto extends createZodDto(SubmitScoresRequestSchema) {}
class ResultsQueryDto extends createZodDto(ResultsQuerySchema) {}
class ResultsResponseDto extends createZodDto(ResultsResponseSchema) {}
class ContractReviewsQueryDto extends createZodDto(ContractReviewsQuerySchema) {}
class ContractReviewsResponseDto extends createZodDto(ContractReviewsResponseSchema) {}
class TemplatesExportQueryDto extends createZodDto(TemplatesExportQuerySchema) {}
class InitiationsExportQueryDto extends createZodDto(InitiationsExportQuerySchema) {}
class ContractsExportQueryDto extends createZodDto(ContractsExportQuerySchema) {}
class ContractReviewsExportQueryDto extends createZodDto(ContractReviewsExportQuerySchema) {}

const EXPORT_TYPES = [
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

async function sendExport(reply: FastifyReply, file: ExportFile): Promise<void> {
  await reply
    .header('content-type', file.contentType)
    .header('content-disposition', `attachment; filename="${file.fileName}"`)
    .header('cache-control', 'private, no-store')
    .send(file.body);
}

/**
 * Section 12.9: templates, contract initiation, contracts, reviews, scores, results and contract
 * reviews. HR_ADMIN manages templates, initiations and reviews; AUDITOR reads; employees,
 * reviewers and managers see their own, their reviews and their reports' (scoped in the services).
 */
@ApiTags('performance')
@Controller('performance')
export class PerformanceController {
  constructor(
    private readonly templates: TemplateService,
    private readonly initiations: InitiationService,
    private readonly contracts: ContractService,
    private readonly reviews: ReviewService,
  ) {}

  // ───────────── Rating scales ─────────────

  @Get('rating-scales')
  @ApiOkResponse({ type: RatingScalesResponseDto })
  ratingScales(): Promise<RatingScalesResponseDto> {
    return this.templates.ratingScales();
  }

  // ───────────── Templates ─────────────

  @Get('templates')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiOkResponse({ type: TemplatesResponseDto })
  listTemplates(@Query() query: TemplatesQueryDto): Promise<TemplatesResponseDto> {
    return this.templates.list(query);
  }

  /** The filtered templates grid as CSV or Excel (audited EXPORT.PERFORMANCE_TEMPLATES). */
  @Get('templates/export')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiProduces(...EXPORT_TYPES)
  async exportTemplates(
    @Ctx() ctx: SecurityContext,
    @Query() query: TemplatesExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(reply, await this.templates.export(ctx, query));
  }

  @Get('templates/:id')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiOkResponse({ type: PerformanceTemplateDto })
  getTemplate(@Param() params: IdParamDto): Promise<PerformanceTemplateDto> {
    return this.templates.get(params.id);
  }

  @Post('templates')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: PerformanceTemplateDto })
  createTemplate(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateTemplateRequestDto,
  ): Promise<PerformanceTemplateDto> {
    return this.templates.create(ctx, body);
  }

  @Put('templates/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: PerformanceTemplateDto })
  updateTemplate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateTemplateRequestDto,
  ): Promise<PerformanceTemplateDto> {
    return this.templates.update(ctx, params.id, body);
  }

  @Post('templates/:id/copy')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: PerformanceTemplateDto })
  copyTemplate(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CopyTemplateRequestDto,
  ): Promise<PerformanceTemplateDto> {
    return this.templates.copy(ctx, params.id, body);
  }

  // ───────────── Contract initiation ─────────────

  @Get('contract-initiations')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiOkResponse({ type: InitiationsResponseDto })
  listInitiations(@Query() query: InitiationsQueryDto): Promise<InitiationsResponseDto> {
    return this.initiations.list(query);
  }

  /** The filtered initiations grid as CSV or Excel (audited EXPORT.CONTRACT_INITIATIONS). */
  @Get('contract-initiations/export')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiProduces(...EXPORT_TYPES)
  async exportInitiations(
    @Ctx() ctx: SecurityContext,
    @Query() query: InitiationsExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(reply, await this.initiations.export(ctx, query));
  }

  @Get('contract-initiations/:id')
  @Roles('HR_ADMIN', 'AUDITOR')
  @ApiOkResponse({ type: ContractInitiationDto })
  getInitiation(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<ContractInitiationDto> {
    return this.initiations.get(ctx, params.id);
  }

  /** Stores the selection and queues the `performance.initiateContracts` job. */
  @Post('contract-initiations')
  @Roles('HR_ADMIN')
  @Idempotent()
  @ApiCreatedResponse({ type: ContractInitiationDto })
  createInitiation(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateInitiationRequestDto,
  ): Promise<ContractInitiationDto> {
    return this.initiations.create(ctx, body);
  }

  // ───────────── Contracts ─────────────

  @Get('contracts')
  @ApiOkResponse({ type: ContractsResponseDto })
  listContracts(
    @Ctx() ctx: SecurityContext,
    @Query() query: ContractsQueryDto,
  ): Promise<ContractsResponseDto> {
    return this.contracts.list(ctx, query);
  }

  /** The filtered contracts grid (the caller's scope) as CSV or Excel (audited EXPORT.PERFORMANCE_CONTRACTS). */
  @Get('contracts/export')
  @ApiProduces(...EXPORT_TYPES)
  async exportContracts(
    @Ctx() ctx: SecurityContext,
    @Query() query: ContractsExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(reply, await this.contracts.export(ctx, query));
  }

  @Get('contracts/:id')
  @ApiOkResponse({ type: PerformanceContractDto })
  getContract(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<PerformanceContractDto> {
    return this.contracts.get(ctx, params.id);
  }

  @Put('contracts/:id')
  @ApiOkResponse({ type: PerformanceContractDto })
  updateContract(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateContractRequestDto,
  ): Promise<PerformanceContractDto> {
    return this.contracts.update(ctx, params.id, body);
  }

  @Post('contracts/:id/archive')
  @HttpCode(200)
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: PerformanceContractDto })
  archiveContract(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ArchiveContractRequestDto,
  ): Promise<PerformanceContractDto> {
    return this.contracts.archive(ctx, params.id, body);
  }

  // ───────────── Reviews ─────────────

  /** Edit Review: the reviews the caller may see, with Filter and Sort by. */
  @Get('reviews')
  @ApiOkResponse({ type: ReviewsResponseDto })
  listReviews(@Ctx() ctx: SecurityContext, @Query() query: ReviewsQueryDto): Promise<ReviewsResponseDto> {
    return this.reviews.list(ctx, query);
  }

  @Get('reviews/:id')
  @ApiOkResponse({ type: ReviewDetailDto })
  getReview(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<ReviewDetailDto> {
    return this.reviews.detail(ctx, params.id);
  }

  /** Create Review wizard: one review per reviewee. */
  @Post('reviews')
  @Roles('HR_ADMIN')
  @Idempotent()
  @ApiCreatedResponse({ type: CreateReviewResponseDto })
  createReview(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateReviewRequestDto,
  ): Promise<CreateReviewResponseDto> {
    return this.reviews.create(ctx, body);
  }

  @Put('reviews/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: ReviewDetailDto })
  updateReview(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateReviewRequestDto,
  ): Promise<ReviewDetailDto> {
    return this.reviews.update(ctx, params.id, body);
  }

  @Post('reviews/:id/copy')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: ReviewDetailDto })
  copyReview(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CopyReviewRequestDto,
  ): Promise<ReviewDetailDto> {
    return this.reviews.copy(ctx, params.id, body);
  }

  @Post('reviews/:id/status')
  @HttpCode(200)
  @ApiOkResponse({ type: ReviewDetailDto })
  changeReviewStatus(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: ReviewStatusRequestDto,
  ): Promise<ReviewDetailDto> {
    return this.reviews.changeStatus(ctx, params.id, body);
  }

  @Post('reviews/:id/scores')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: ReviewDetailDto })
  submitScores(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: SubmitScoresRequestDto,
  ): Promise<ReviewDetailDto> {
    return this.reviews.submitScores(ctx, params.id, body);
  }

  /** Review Results: scored reviews (filter, sort; copy through POST /reviews/:id/copy). */
  @Get('results')
  @ApiOkResponse({ type: ResultsResponseDto })
  results(@Ctx() ctx: SecurityContext, @Query() query: ResultsQueryDto): Promise<ResultsResponseDto> {
    return this.reviews.list(ctx, query, true);
  }

  /** The filtered Reviews grid as CSV or Excel (audited EXPORT.CONTRACT_REVIEWS). */
  @Get('contract-reviews/export')
  @ApiProduces(...EXPORT_TYPES)
  async exportContractReviews(
    @Ctx() ctx: SecurityContext,
    @Query() query: ContractReviewsExportQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(reply, await this.reviews.exportContractReviews(ctx, query));
  }

  /** Reviews (contract reviews) with the Filter Selection modal. */
  @Get('contract-reviews')
  @ApiOkResponse({ type: ContractReviewsResponseDto })
  contractReviews(
    @Ctx() ctx: SecurityContext,
    @Query() query: ContractReviewsQueryDto,
  ): Promise<ContractReviewsResponseDto> {
    return this.reviews.contractReviews(ctx, query);
  }
}
