import { AUTH_POLICY } from '@peoplehub/shared';
import { describe, expect, it } from 'vitest';
import { isActingForOther } from '../../src/common/context/security-context';
import {
  hashToken,
  isLocked,
  lockMinutesRemaining,
  newPasswordIssues,
  randomToken,
  registerFailure,
  registerSuccess,
  safeEqual,
  sessionDeadline,
} from '../../src/modules/auth/auth-policy';

const NOW = new Date('2026-10-20T08:00:00Z');
const MIN = 60_000;

describe('lockout (section 4.3)', () => {
  it('locks for 15 minutes on the fifth consecutive failure', () => {
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 1; i <= 4; i++) {
      const next = registerFailure(state, NOW);
      expect(next).toEqual({ failedLoginCount: i, lockedUntil: null, lockedNow: false });
      state = next;
    }
    const fifth = registerFailure(state, NOW);
    expect(fifth.lockedNow).toBe(true);
    expect(fifth.failedLoginCount).toBe(0);
    expect(fifth.lockedUntil?.getTime()).toBe(NOW.getTime() + AUTH_POLICY.lockoutMinutes * MIN);
    expect(isLocked(fifth, NOW)).toBe(true);
    expect(isLocked(fifth, new Date(NOW.getTime() + 15 * MIN))).toBe(false);
  });

  it('starts counting again after the lock expires', () => {
    const expired = { failedLoginCount: 0, lockedUntil: new Date(NOW.getTime() - 1) };
    expect(registerFailure(expired, NOW)).toEqual({
      failedLoginCount: 1,
      lockedUntil: null,
      lockedNow: false,
    });
    // A stale counter from before the lock does not carry over.
    expect(
      registerFailure({ failedLoginCount: 4, lockedUntil: new Date(NOW.getTime() - 1) }, NOW).lockedNow,
    ).toBe(false);
  });

  it('resets on success', () => {
    expect(registerSuccess()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });

  it('reports the minutes left, rounded up', () => {
    expect(lockMinutesRemaining({ lockedUntil: new Date(NOW.getTime() + 14 * MIN + 1) }, NOW)).toBe(15);
    expect(lockMinutesRemaining({ lockedUntil: new Date(NOW.getTime() + 30_000) }, NOW)).toBe(1);
    expect(lockMinutesRemaining({ lockedUntil: null }, NOW)).toBe(0);
    expect(lockMinutesRemaining({ lockedUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(0);
  });
});

describe('new password rules', () => {
  // A fake "hash" is the password itself, so the history check needs no argon2 here.
  const verify = async (hash: string, password: string) => hash === password;

  it('applies the shared policy first', async () => {
    const issues = await newPasswordIssues({
      newPassword: 'short',
      username: 'jdoe',
      previousHashes: [],
      verify,
    });
    expect(issues).toContain('Use at least 10 characters');
  });

  it('refuses the username inside the password', async () => {
    const issues = await newPasswordIssues({
      newPassword: 'My-JDoe-Pass-1',
      username: 'jdoe',
      previousHashes: [],
      verify,
    });
    expect(issues).toEqual(['Do not use your username in your password']);
    // Very short usernames are not checked (they would block too much).
    expect(
      await newPasswordIssues({ newPassword: 'Abcdefgh-12', username: 'ab', previousHashes: [], verify }),
    ).toEqual([]);
  });

  it('refuses any of the last 5 passwords but allows the sixth', async () => {
    const history = [
      'Pass-word-05',
      'Pass-word-04',
      'Pass-word-03',
      'Pass-word-02',
      'Pass-word-01',
      'Pass-word-00',
    ];
    for (const old of history.slice(0, 5)) {
      const issues = await newPasswordIssues({
        newPassword: old,
        username: 'jdoe',
        previousHashes: history,
        verify,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('last 5');
    }
    expect(
      await newPasswordIssues({
        newPassword: 'Pass-word-00',
        username: 'jdoe',
        previousHashes: history,
        verify,
      }),
    ).toEqual([]);
  });
});

describe('tokens and sessions', () => {
  it('creates random URL-safe tokens and stores only a sha256', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares CSRF tokens in constant time and rejects empty values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(undefined, 'a')).toBe(false);
  });

  it('ends a session at the idle deadline or the absolute lifetime, whichever is first', () => {
    const lastActivityAt = NOW;
    expect(
      sessionDeadline({ lastActivityAt, expiresAt: new Date(NOW.getTime() + 12 * 60 * MIN) }, 20),
    ).toEqual({
      at: new Date(NOW.getTime() + 20 * MIN),
      reason: 'IDLE',
    });
    const soon = new Date(NOW.getTime() + 5 * MIN);
    expect(sessionDeadline({ lastActivityAt, expiresAt: soon }, 20)).toEqual({
      at: soon,
      reason: 'ABSOLUTE',
    });
  });

  it('knows when a user is working as someone else', () => {
    expect(isActingForOther({ selfEmployeeId: 5, actingAsEmployeeId: 5 })).toBe(false);
    expect(isActingForOther({ selfEmployeeId: 5, actingAsEmployeeId: 7 })).toBe(true);
    expect(isActingForOther({ selfEmployeeId: null, actingAsEmployeeId: 0 })).toBe(false);
    expect(isActingForOther({ selfEmployeeId: null, actingAsEmployeeId: 7 })).toBe(true);
  });
});
