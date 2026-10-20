import { Module, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../../jobs/jobs.service';
import { AuthModule } from '../auth/auth.module';
import { DetailsModule } from '../details/details.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ContractService } from './contract.service';
import { InitiationService } from './initiation.service';
import { PerformanceAccess } from './performance-access';
import { PERFORMANCE_INITIATE_JOB, PERFORMANCE_REVIEW_NOTIFY_JOB } from './performance-common';
import { PerformanceParameterService } from './performance-parameter.service';
import {
  PerformanceLookupsController,
  PerformanceParametersAdminController,
} from './performance-parameters.controller';
import { PerformanceSeedService } from './performance-seed.service';
import { PerformanceController } from './performance.controller';
import { ReviewNotifier } from './review-notifier.service';
import { ReviewService } from './review.service';
import { TemplateService } from './template.service';

/**
 * Performance (section 5.9): parameter lookups, rating scales, templates, contract initiation (a
 * pg-boss job), contracts and archive, the review wizard and status flow, scoring, results and the
 * contract reviews grid.
 */
@Module({
  imports: [AuthModule, DetailsModule, NotificationsModule],
  controllers: [PerformanceLookupsController, PerformanceParametersAdminController, PerformanceController],
  providers: [
    PerformanceAccess,
    PerformanceParameterService,
    TemplateService,
    ContractService,
    InitiationService,
    ReviewNotifier,
    ReviewService,
    PerformanceSeedService,
  ],
  exports: [PerformanceSeedService, ReviewService, ContractService],
})
export class PerformanceModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly initiations: InitiationService,
    private readonly notifier: ReviewNotifier,
  ) {}

  onModuleInit(): void {
    this.jobs.register<{ initiationId?: number }>(PERFORMANCE_INITIATE_JOB, (data) =>
      this.initiations.run(data),
    );
    // Daily at 06:00 (Africa/Windhoek): reviews whose "Specific Date" notification is due.
    this.jobs.register<{ asOf?: string }>(
      PERFORMANCE_REVIEW_NOTIFY_JOB,
      (data) => this.notifier.notifyDue(data),
      {
        cron: '0 6 * * *',
      },
    );
  }
}
