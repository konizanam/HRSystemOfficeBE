import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AUTH_POLICY } from '@peoplehub/shared';
import { ValidationError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
import { newPasswordIssues } from './auth-policy';

/** argon2id with the library defaults (64 MiB, 3 passes, parallelism 4). */
const HASH_OPTIONS = { type: argon2.argon2id } as const;

/** Password hashing, verification and the reuse rule (section 4.3). */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, HASH_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** True when the hash uses weaker parameters than today's; re-hash on the next sign-in. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash);
    } catch {
      return true;
    }
  }

  /**
   * Burns the same time as a real verification, so an unknown username cannot be told apart
   * from a wrong password by timing.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash('not-a-real-password-0', HASH_OPTIONS);
    await this.verify(await this.dummyHash, password);
  }

  /**
   * Throws 422 on `field` when the new password breaks the policy or matches the current password
   * or one of the last AUTH_POLICY.passwordHistoryDepth passwords.
   */
  async assertAcceptable(
    reader: Pick<Tx, 'passwordHistory'>,
    user: { id: string; username: string; passwordHash: string | null },
    newPassword: string,
    field = 'newPassword',
  ): Promise<void> {
    const history = await reader.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUTH_POLICY.passwordHistoryDepth,
      select: { hash: true },
    });
    const hashes = [...new Set([user.passwordHash, ...history.map((h) => h.hash)].filter((h) => !!h))];
    const issues = await newPasswordIssues({
      newPassword,
      username: user.username,
      previousHashes: hashes as string[],
      verify: (hash, password) => this.verify(hash, password),
    });
    if (issues.length) throw new ValidationError(issues.map((message) => ({ path: field, message })));
  }
}
