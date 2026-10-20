import { Module } from '@nestjs/common';
import { PdfModule } from '../../pdf/pdf.service';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { LeaveModule } from '../leave/leave.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollDocumentsService } from './payroll-documents.service';
import {
  PayrollImportController,
  PayslipsController,
  TaxCertificatesController,
} from './payslips.controller';
import { PayslipImportService } from './payslip-import.service';
import { PayslipService } from './payslip.service';
import { TaxCertificateImportService } from './tax-certificate-import.service';
import { TaxCertificateService } from './tax-certificate.service';

/**
 * Payroll outputs (sections 5.5 and 5.6): payslips and tax certificates, their audited PDFs and
 * the PAYROLL_ADMIN imports that publish them. The PDFs are attachments owned by `Payslip` /
 * `TaxCertificate` with no download resolver, so they are only served here, never through
 * `GET /attachments/:id` (which would bypass the restricted-feature rule).
 */
@Module({
  imports: [AuthModule, AttachmentsModule, LeaveModule, NotificationsModule, PdfModule],
  controllers: [PayslipsController, TaxCertificatesController, PayrollImportController],
  providers: [
    PayrollDocumentsService,
    PayslipService,
    PayslipImportService,
    TaxCertificateService,
    TaxCertificateImportService,
  ],
  exports: [PayslipService, PayslipImportService, TaxCertificateService, TaxCertificateImportService],
})
export class PayslipsModule {}
