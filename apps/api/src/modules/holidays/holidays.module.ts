import { Module } from '@nestjs/common';
import { HolidayService } from './holiday.service';
import { HolidaysController } from './holidays.controller';

/** Public holidays and the holiday rules table (sections 12.2 and 14). */
@Module({
  controllers: [HolidaysController],
  providers: [HolidayService],
  exports: [HolidayService],
})
export class HolidaysModule {}
