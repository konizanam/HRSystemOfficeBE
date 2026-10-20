import { Injectable } from '@nestjs/common';
import type { Tx } from '../../prisma/prisma-client';

/** Who an owning entity belongs to, for the download authorisation check. */
export interface AttachmentOwner {
  /** The employee the entity is about (the applicant). */
  employeeId: number;
  /** The workflow process of the entity, when it has one: its approvers may download. */
  processId: number | null;
}

/** Looks up an owning entity by id; null when it does not exist. */
export type AttachmentOwnerResolver = (client: Tx, ownerEntityId: string) => Promise<AttachmentOwner | null>;

/**
 * Attachments are bound to an owner entity (a Prisma model name and id, e.g. `LeaveApplication`
 * and `42`) when the request they were uploaded for is submitted. Each feature module registers
 * a resolver for its owner entities in `onModuleInit`, so the download check can find the owning
 * employee and process without the attachments module knowing every feature.
 */
@Injectable()
export class AttachmentOwnerRegistry {
  private readonly resolvers = new Map<string, AttachmentOwnerResolver>();

  register(ownerEntity: string, resolver: AttachmentOwnerResolver): void {
    if (this.resolvers.has(ownerEntity)) {
      throw new Error(`An attachment owner resolver for ${ownerEntity} is already registered`);
    }
    this.resolvers.set(ownerEntity, resolver);
  }

  get(ownerEntity: string): AttachmentOwnerResolver | undefined {
    return this.resolvers.get(ownerEntity);
  }
}
