import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeaveModule } from '../leave/leave.module';
import { PayslipsModule } from '../payslips/payslips.module';
import { BirthdayService } from './birthday.service';
import { BirthdaysController, DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** The dashboard (section 5.1): layout, summary and upcoming birthdays. */
@Module({
  imports: [AuthModule, LeaveModule, PayslipsModule],
  controllers: [DashboardController, BirthdaysController],
  providers: [DashboardService, BirthdayService],
  exports: [DashboardService, BirthdayService],
})
export class DashboardModule {}
