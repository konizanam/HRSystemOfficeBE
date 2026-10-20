import { API_PREFIX } from '@peoplehub/shared';
import request from 'supertest';
import { expect } from 'vitest';
import type { TestApp } from './app';
import {
  auditSince,
  lastAuditId,
  login,
  ROLE_KEYS,
  type RoleFixtures,
  type RoleKey,
  uniqueIp,
} from './fixtures';

// Building blocks for the authorisation matrix (section 16.2): every endpoint × role × target
// (self / report / non-report / other company) with its expected status. Later phases append
// their endpoints to a case list and reuse `runMatrixCell` / `runAnonymous`.

export type Method = 'get' | 'post' | 'put' | 'delete';

export interface MatrixCase {
  /** Shown in the test name, e.g. "PUT /session/acting-as (report)". */
  name: string;
  method: Method;
  /** Path below /api/v1; a function can use fixture ids. */
  path: string | ((f: RoleFixtures, role: RoleKey) => string);
  body?: (f: RoleFixtures, role: RoleKey) => unknown;
  /** Expected status per role; roles not listed expect `otherwise`. */
  expect: Partial<Record<RoleKey, number>> & { otherwise: number };
  /** Status without a session (default 401). Public endpoints set their own. */
  anonymous?: number;
}

export function expectedStatus(c: MatrixCase, role: RoleKey): number {
  return c.expect[role] ?? c.expect.otherwise;
}

/** Every role gets `status`. */
export function all(status: number): MatrixCase['expect'] {
  return { otherwise: status };
}

/** `status` for the listed roles, `otherwise` for the rest. */
export function only(roles: RoleKey[], status: number, otherwise = 403): MatrixCase['expect'] {
  return { otherwise, ...Object.fromEntries(roles.map((r) => [r, status])) };
}

function resolvePath(c: MatrixCase, f: RoleFixtures, role: RoleKey): string {
  return typeof c.path === 'function' ? c.path(f, role) : c.path;
}

/**
 * Signs in a fresh session for `role` (so cells never share state), calls the endpoint and checks
 * the status. Every 403 must have written a DENIED audit row for that request.
 */
export async function runMatrixCell(
  t: TestApp,
  f: RoleFixtures,
  role: RoleKey,
  c: MatrixCase,
): Promise<void> {
  const agent = await login(t, f[role]);
  const since = await lastAuditId(t.db);
  const req = agent.request(c.method, resolvePath(c, f, role));
  const res = await (c.body ? req.send(c.body(f, role) as object) : req);
  const expected = expectedStatus(c, role);
  expect(res.status, `${c.name} as ${role}: ${res.text}`).toBe(expected);
  if (expected === 403) {
    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(
      rows.some((r) => r.outcome === 'DENIED'),
      `${c.name} as ${role} must audit DENIED`,
    ).toBe(true);
  }
}

/** Calls the endpoint with no session; non-public endpoints answer 401 and audit DENIED. */
export async function runAnonymous(t: TestApp, f: RoleFixtures, c: MatrixCase): Promise<void> {
  const since = await lastAuditId(t.db);
  const client = request(t.server);
  const req = client[c.method](`${API_PREFIX}${resolvePath(c, f, 'employee')}`).set(
    'x-forwarded-for',
    uniqueIp(),
  );
  const res = await (c.body ? req.send(c.body(f, 'employee') as object) : req);
  const expected = c.anonymous ?? 401;
  expect(res.status, `${c.name} anonymously`).toBe(expected);
  if (expected === 401 || expected === 403) {
    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
  }
}

export { ROLE_KEYS };
