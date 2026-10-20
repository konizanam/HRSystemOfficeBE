import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PickerService } from './picker.service';
import { PickersController } from './pickers.controller';

/** Scoped pickers: employees, companies, company rules and positions (GET /lookups/…). */
@Module({
  imports: [AuthModule],
  controllers: [PickersController],
  providers: [PickerService],
  exports: [PickerService],
})
export class LookupsModule {}
