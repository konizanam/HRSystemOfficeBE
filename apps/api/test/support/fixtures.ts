import type { Prisma, Role } from '@prisma/client';
import { API_PREFIX, CSRF_COOKIE, CSRF_HEADER, type LoginResponse, SESSION_COOKIE } from '@peoplehub/shared';
import * as argon2 from 'argon2';
import request from 'supertest';
import { systemContext } from '../../src/common/context/security-context';
import type { DbService } from '../../src/prisma/db.service';
import type { TestApp } from './app';

// Reusable people, organisations and signed-in agents for integration tests. The test database
// is shared between runs, so every code and username comes from a database sequence and is
// unique forever; tests must never assume an empty database.

export const FIXTURE_PASSWORD = 'Fixture-Pass-2026!';

const ctx = systemContext('test-fixtures');

/** A value that is unique across every test run on this database. */
export async function nextUnique(db: DbService): Promise<number> {
  return db.tx(ctx, (tx) => db.nextSequence(tx, 'TEST:fixture'));
}

let ipCounter = 0;
/**
 * A fresh client IP. The API trusts X-Forwarded-For, so each agent gets its own rate-limit
 * bucket and only the rate-limit test shares one on purpose.
 */
export function uniqueIp(): string {
  ipCounter += 1;
  const n = (process.pid * 1000 + ipCounter) % 16_777_216;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export interface Org {
  companyId: number;
  companyRuleId: number;
  code: string;
}

export async function createOrg(db: DbService, name = 'Fixture Company'): Promise<Org> {
  const code = `T${await nextUnique(db)}`;
  return db.tx(ctx, async (tx) => {
    const company = await tx.company.create({ data: { code, name: `${name} ${code}` } });
    const rule = await tx.companyRule.create({
      data: { companyId: company.id, code: 'STAFF', description: 'Staff' },
    });
    return { companyId: company.id, companyRuleId: rule.id, code };
  });
}

export interface Person {
  userId: string;
  username: string;
  email: string | null;
  password: string;
  roles: Role[];
  employeeId: number | null;
  employeeCode: string | null;
  companyId: number | null;
}

export interface PersonOptions {
  org: Org;
  roles?: Role[];
  /** Label used in the username, e.g. "manager". */
  label?: string;
  reportsToId?: number | null;
  /** false creates a user with no employee record. */
  withEmployee?: boolean;
  password?: string;
  mustChangePassword?: boolean;
  email?: string | null;
  employee?: Partial<Prisma.EmployeeUncheckedCreateInput>;
}

/** Creates an Employee (unless `withEmployee: false`) and a local User with the given roles. */
export async function createPerson(db: DbService, options: PersonOptions): Promise<Person> {
  const n = await nextUnique(db);
  const roles = options.roles ?? ['EMPLOYEE'];
  const label = (options.label ?? roles[roles.length - 1] ?? 'user').toLowerCase().replace(/_/g, '-');
  const username = `t${n}.${label}`;
  const password = options.password ?? FIXTURE_PASSWORD;
  const email = options.email === undefined ? `${username}@example.test` : options.email;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  return db.tx(ctx, async (tx) => {
    const employee =
      options.withEmployee === false
        ? null
        : await tx.employee.create({
            data: {
              entityCode: String(500_000 + n),
              employeeCode: `T${500_000 + n}`,
              companyId: options.org.companyId,
              companyRuleId: options.org.companyRuleId,
              firstName: `First${n}`,
              lastName: `Last${n}`,
              title: 'Mx',
              initials: 'F',
              reportsToId: options.reportsToId ?? null,
              dateEngaged: new Date('2024-01-01T00:00:00Z'),
              ...options.employee,
            },
          });
    const user = await tx.user.create({
      data: {
        username,
        email,
        passwordHash,
        roles,
        employeeId: employee?.id ?? null,
        mustChangePassword: options.mustChangePassword ?? false,
        passwordChangedAt: new Date(),
      },
    });
    await tx.passwordHistory.create({ data: { userId: user.id, hash: passwordHash } });
    return {
      userId: user.id,
      username,
      email,
      password,
      roles,
      employeeId: employee?.id ?? null,
      employeeCode: employee?.employeeCode ?? null,
      companyId: employee?.companyId ?? null,
    };
  });
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A signed-in client: sends the session cookie, the CSRF cookie and header, and its own IP. */
export class Agent {
  constructor(
    readonly server: TestApp['server'],
    readonly sessionToken: string,
    readonly csrfToken: string,
    readonly ip: string,
    readonly login: LoginResponse,
  ) {}

  get cookieHeader(): string {
    return `${SESSION_COOKIE}=${this.sessionToken}; ${CSRF_COOKIE}=${this.csrfToken}`;
  }

  /** `path` is relative to /api/v1. Pass `{ csrf: false }` to leave out the CSRF header. */
  request(method: Method, path: string, options: { csrf?: boolean } = {}): request.Test {
    const client = request(this.server);
    const req = client[method](`${API_PREFIX}${path}`)
      .set('cookie', this.cookieHeader)
      .set('x-forwarded-for', this.ip);
    return options.csrf === false ? req : req.set(CSRF_HEADER, this.csrfToken);
  }

  get(path: string): request.Test {
    return this.request('get', path);
  }
  post(path: string, options?: { csrf?: boolean }): request.Test {
    return this.request('post', path, options);
  }
  put(path: string, options?: { csrf?: boolean }): request.Test {
    return this.request('put', path, options);
  }
  delete(path: string, options?: { csrf?: boolean }): request.Test {
    return this.request('delete', path, options);
  }
}

/** Reads a cookie value from a response's Set-Cookie headers. */
export function cookieFrom(res: request.Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const list = Array.isArray(header) ? header : header ? [header] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [key, ...value] = (pair ?? '').split('=');
    if (key?.trim() === name) return value.join('=');
  }
  return undefined;
}

/** POST /auth/login without asserting the outcome. */
export function loginRequest(
  t: TestApp,
  credentials: { username: string; password: string; totp?: string },
  ip = uniqueIp(),
): request.Test {
  return request(t.server)
    .post(`${API_PREFIX}/auth/login`)
    .set('x-forwarded-for', ip)
    .send({ username: credentials.username, password: credentials.password, totp: credentials.totp });
}

/** Signs in and returns an agent; fails the test unless a session was opened. */
export async function login(
  t: TestApp,
  credentials: { username: string; password: string; totp?: string },
  ip = uniqueIp(),
): Promise<Agent> {
  const res = await loginRequest(t, credentials, ip);
  if (res.status !== 200)
    throw new Error(`Login failed for ${credentials.username}: ${res.status} ${res.text}`);
  const session = cookieFrom(res, SESSION_COOKIE);
  const csrf = cookieFrom(res, CSRF_COOKIE);
  if (!session || !csrf) throw new Error(`Login for ${credentials.username} returned ${res.body.status}`);
  return new Agent(t.server, session, csrf, ip, res.body as LoginResponse);
}

/** One person per role plus a reporting line and a second company (section 14 shape). */
export interface RoleFixtures {
  org: Org;
  otherOrg: Org;
  hrAdmin: Person;
  payrollAdmin: Person;
  sysAdmin: Person;
  auditor: Person;
  /** Top of the line; manager B reports to manager A. */
  managerA: Person;
  managerB: Person;
  /** Report employees of manager B (two levels below manager A). */
  employee: Person;
  employee2: Person;
  /** Same company, outside manager B's line. */
  unrelated: Person;
  /** Another company. */
  otherCompany: Person;
}

export async function createRoleFixtures(db: DbService): Promise<RoleFixtures> {
  const org = await createOrg(db);
  const otherOrg = await createOrg(db, 'Other Company');
  const managerA = await createPerson(db, { org, roles: ['EMPLOYEE', 'MANAGER'], label: 'manager-a' });
  const managerB = await createPerson(db, {
    org,
    roles: ['EMPLOYEE', 'MANAGER'],
    label: 'manager-b',
    reportsToId: managerA.employeeId,
  });
  const [hrAdmin, payrollAdmin, sysAdmin, auditor, employee, employee2, unrelated, otherCompany] =
    await Promise.all([
      createPerson(db, { org, roles: ['EMPLOYEE', 'HR_ADMIN'] }),
      createPerson(db, { org, roles: ['EMPLOYEE', 'PAYROLL_ADMIN'] }),
      createPerson(db, { org, roles: ['EMPLOYEE', 'SYSTEM_ADMIN'] }),
      createPerson(db, { org, roles: ['EMPLOYEE', 'AUDITOR'] }),
      createPerson(db, { org, label: 'employee', reportsToId: managerB.employeeId }),
      createPerson(db, { org, label: 'employee', reportsToId: managerB.employeeId }),
      createPerson(db, { org, label: 'unrelated' }),
      createPerson(db, { org: otherOrg, label: 'other-co' }),
    ]);
  return {
    org,
    otherOrg,
    hrAdmin,
    payrollAdmin,
    sysAdmin,
    auditor,
    managerA,
    managerB,
    employee,
    employee2,
    unrelated,
    otherCompany,
  };
}

/** The role fixture keys, for role × endpoint loops. */
export const ROLE_KEYS = ['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'sysAdmin', 'auditor'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** Audit rows written since `sinceId`, newest last. */
export async function auditSince(db: DbService, sinceId: bigint, where: Prisma.AuditLogWhereInput = {}) {
  return db.prisma.auditLog.findMany({ where: { id: { gt: sinceId }, ...where }, orderBy: { id: 'asc' } });
}

export async function lastAuditId(db: DbService): Promise<bigint> {
  const row = await db.prisma.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  return row?.id ?? 0n;
}

/** JSON text of a row (BigInt-safe), for "never contains the secret" assertions. */
export function asJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
