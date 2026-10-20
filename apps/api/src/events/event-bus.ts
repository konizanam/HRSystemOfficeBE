import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../prisma/prisma-client';

/** A domain event read back from the outbox. */
export interface DomainEvent<T = Record<string, unknown>> {
  id: bigint;
  type: string;
  payload: T;
  createdAt: Date;
}

/**
 * What a listener gets besides the event. Database writes go through `tx`, which also marks the
 * event as published, so they happen exactly once. Side effects outside the database (email) are
 * registered with `afterCommit` and run only once that transaction has committed.
 */
export interface EventContext {
  tx: Tx;
  afterCommit(effect: () => void): void;
}

export type EventListener = (event: DomainEvent, context: EventContext) => Promise<void>;

/** Listens to every event type. */
export const ALL_EVENTS = '*';

/**
 * In-process publish/subscribe for domain events (section 7.3). Events are never dispatched
 * directly by business code: they are written to the `OutboxEvent` table inside the business
 * transaction and dispatched here by the outbox publisher after commit.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly listeners = new Map<string, EventListener[]>();

  /** Subscribes to one event type (or `ALL_EVENTS`). Returns a function that unsubscribes. */
  subscribe(type: string, listener: EventListener): () => void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return () => {
      const current = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        current.filter((l) => l !== listener),
      );
    };
  }

  /** Runs every listener of the event in registration order. A failing listener fails the dispatch. */
  async dispatch(event: DomainEvent, context: EventContext): Promise<number> {
    const targets = [...(this.listeners.get(event.type) ?? []), ...(this.listeners.get(ALL_EVENTS) ?? [])];
    for (const listener of targets) await listener(event, context);
    if (targets.length === 0) this.logger.debug({ type: event.type }, 'No listener for event');
    return targets.length;
  }
}
