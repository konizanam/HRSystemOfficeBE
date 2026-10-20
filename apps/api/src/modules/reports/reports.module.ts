import { Module } from '@nestjs/common';
import { PdfModule } from '../../pdf/pdf.service';
import { AuthModule } from '../auth/auth.module';
import { ReportRegistry } from './report-registry';
import { ReportScopeService } from './report-scope.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Reports (section 5.7): the registry of report definitions, scoping, streaming exports. */
@Module({
  imports: [AuthModule, PdfModule],
  controllers: [ReportsController],
  providers: [ReportRegistry, ReportScopeService, ReportsService],
  exports: [ReportRegistry, ReportsService],
})
export class ReportsModule {}
