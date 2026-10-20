import { AUTH_POLICY, passwordPolicyIssues } from '@peoplehub/shared';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Pure account-security rules (section 4.3). No I/O, so they are unit tested directly.

const MINUTE_MS = 60_000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface FailureOutcome extends LockoutState {
  /** True when this failure is the one that locked the account. */
  lockedNow: boolean;
}

export function isLocked(state: Pick<LockoutState, 'lockedUntil'>, now: Date): boolean {
  return !!state.lockedUntil && state.lockedUntil.getTime() > now.getTime();
}

/** Whole minutes until the lock ends, rounded up (0 when not locked). */
export function lockMinutesRemaining(state: Pick<LockoutState, 'lockedUntil'>, now: Date): number {
  if (!isLocked(state, now) || !state.lockedUntil) return 0;
  return Math.ceil((state.lockedUntil.getTime() - now.getTime()) / MINUTE_MS);
}

/**
 * Counts one failed sign-in. The fifth consecutive failure locks the account for 15 minutes and
 * resets the counter, so after the lock ends the user again has five attempts. Failures while
 * locked do not extend the lock (the caller rejects those before checking the password).
 */
export function registerFailure(state: LockoutState, now: Date): FailureOutcome {
  const lockExpired = !!state.lockedUntil && !isLocked(state, now);
  const count = (lockExpired ? 0 : state.failedLoginCount) + 1;
  if (count >= AUTH_POLICY.lockoutThreshold) {
    return {
      failedLoginCount: 0,
      lockedUntil: new Date(now.getTime() + AUTH_POLICY.lockoutMinutes * MINUTE_MS),
      lockedNow: true,
    };
  }
  return { failedLoginCount: count, lockedUntil: lockExpired ? null : state.lockedUntil, lockedNow: false };
}

/** A successful sign-in clears the counter and any expired lock. */
export function registerSuccess(): LockoutState {
  return { failedLoginCount: 0, lockedUntil: null };
}

export interface PasswordCheckInput {
  newPassword: string;
  username: string;
  /** Hashes of the current password and earlier ones, newest first. */
  previousHashes: string[];
  verify: (hash: string, password: string) => Promise<boolean>;
}

/**
 * Field messages for a proposed password: the shared policy (10 characters, 3 of 4 classes), not
 * the username, and none of the last AUTH_POLICY.passwordHistoryDepth passwords.
 */
export async function newPasswordIssues(input: PasswordCheckInput): Promise<string[]> {
  const issues = passwordPolicyIssues(input.newPassword);
  if (input.username.length >= 3 && input.newPassword.toLowerCase().includes(input.username.toLowerCase())) {
    issues.push('Do not use your username in your password');
  }
  if (issues.length) return issues;
  for (const hash of input.previousHashes.slice(0, AUTH_POLICY.passwordHistoryDepth)) {
    if (await input.verify(hash, input.newPassword)) {
      issues.push(
        `Choose a password you have not used for your last ${AUTH_POLICY.passwordHistoryDepth} changes`,
      );
      break;
    }
  }
  return issues;
}

/** URL-safe random secret (session tokens, reset tokens, pairing tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as their sha256 (hex). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings (CSRF tokens). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The session ends at whichever comes first: idle timeout or the 12-hour absolute lifetime. */
export function sessionDeadline(
  session: { lastActivityAt: Date; expiresAt: Date },
  idleMinutes: number,
): { at: Date; reason: 'IDLE' | 'ABSOLUTE' } {
  const idle = session.lastActivityAt.getTime() + idleMinutes * MINUTE_MS;
  return idle < session.expiresAt.getTime()
    ? { at: new Date(idle), reason: 'IDLE' }
    : { at: session.expiresAt, reason: 'ABSOLUTE' };
}
