import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

/** Email delivery and in-app notifications (section 6). */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [MailService, NotificationService],
  exports: [MailService, NotificationService],
})
export class NotificationsModule {}
