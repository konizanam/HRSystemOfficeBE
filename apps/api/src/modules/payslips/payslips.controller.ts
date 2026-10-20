import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  IdParamSchema,
  PayslipDetailSchema,
  PayslipImportRequestSchema,
  PayslipImportResponseSchema,
  PayslipListQuerySchema,
  PayslipListResponseSchema,
  PdfQuerySchema,
  TaxCertificateImportRequestSchema,
  TaxCertificateImportResponseSchema,
  TaxCertificatesQuerySchema,
  TaxCertificatesResponseSchema,
} from '@peoplehub/shared';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { PayslipImportService } from './payslip-import.service';
import { PayslipService } from './payslip.service';
import { TaxCertificateImportService } from './tax-certificate-import.service';
import { TaxCertificateService } from './tax-certificate.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class PdfQueryDto extends createZodDto(PdfQuerySchema) {}
class PayslipListQueryDto extends createZodDto(PayslipListQuerySchema) {}
class PayslipListResponseDto extends createZodDto(PayslipListResponseSchema) {}
class PayslipDetailDto extends createZodDto(PayslipDetailSchema) {}
class PayslipImportRequestDto extends createZodDto(PayslipImportRequestSchema) {}
class PayslipImportResponseDto extends createZodDto(PayslipImportResponseSchema) {}
class TaxCertificatesQueryDto extends createZodDto(TaxCertificatesQuerySchema) {}
class TaxCertificatesResponseDto extends createZodDto(TaxCertificatesResponseSchema) {}
class TaxCertificateImportRequestDto extends createZodDto(TaxCertificateImportRequestSchema) {}
class TaxCertificateImportResponseDto extends createZodDto(TaxCertificateImportResponseSchema) {}

async function sendPdf(
  reply: FastifyReply,
  file: { fileName: string; bytes: Buffer; download: boolean },
): Promise<void> {
  await reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `${file.download ? 'attachment' : 'inline'}; filename="${file.fileName}"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

/** Section 12.6: payslips (cards, metadata, PDF). Views and downloads are audited. */
@ApiTags('payslips')
@Controller('payslips')
export class PayslipsController {
  constructor(private readonly payslips: PayslipService) {}

  @Get()
  @ApiOkResponse({ type: PayslipListResponseDto })
  list(@Ctx() ctx: SecurityContext, @Query() query: PayslipListQueryDto): Promise<PayslipListResponseDto> {
    return this.payslips.list(ctx, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: PayslipDetailDto })
  detail(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<PayslipDetailDto> {
    return this.payslips.detail(ctx, params.id);
  }

  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  async pdf(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Query() query: PdfQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendPdf(reply, await this.payslips.pdf(ctx, params.id, query.download));
  }
}

/** Section 12.6: My Tax Certificates (list by tax year, PDF). Views and downloads are audited. */
@ApiTags('tax-certificates')
@Controller('tax-certificates')
export class TaxCertificatesController {
  constructor(private readonly certificates: TaxCertificateService) {}

  @Get()
  @ApiOkResponse({ type: TaxCertificatesResponseDto })
  list(
    @Ctx() ctx: SecurityContext,
    @Query() query: TaxCertificatesQueryDto,
  ): Promise<TaxCertificatesResponseDto> {
    return this.certificates.list(ctx, query.employeeId);
  }

  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  async pdf(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Query() query: PdfQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendPdf(reply, await this.certificates.pdf(ctx, params.id, query.download));
  }
}

/** Section 12.10: payroll imports (PAYROLL_ADMIN). Dry run first, then commit with the token. */
@ApiTags('admin')
@Controller('admin')
@Roles('PAYROLL_ADMIN')
export class PayrollImportController {
  constructor(
    private readonly payslips: PayslipImportService,
    private readonly certificates: TaxCertificateImportService,
  ) {}

  @Post('payslips/import')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: PayslipImportResponseDto })
  importPayslips(
    @Ctx() ctx: SecurityContext,
    @Body() body: PayslipImportRequestDto,
  ): Promise<PayslipImportResponseDto> {
    return this.payslips.import(ctx, body);
  }

  @Post('tax-certificates/import')
  @HttpCode(200)
  @Idempotent()
  @ApiOkResponse({ type: TaxCertificateImportResponseDto })
  importTaxCertificates(
    @Ctx() ctx: SecurityContext,
    @Body() body: TaxCertificateImportRequestDto,
  ): Promise<TaxCertificateImportResponseDto> {
    return this.certificates.import(ctx, body);
  }
}
