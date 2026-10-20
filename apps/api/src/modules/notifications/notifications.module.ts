import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Email delivery. Phase 3 adds in-app notifications and workflow events here. */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class NotificationsModule {}
