import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus';
import { OutboxService } from './outbox.service';

/** Domain events: the transactional outbox and the in-process bus it publishes to (section 7.3). */
@Global()
@Module({
  providers: [EventBus, OutboxService],
  exports: [EventBus, OutboxService],
})
export class EventsModule {}
