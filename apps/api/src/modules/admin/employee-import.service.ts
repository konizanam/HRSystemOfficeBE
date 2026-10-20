import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import {
  AUTH_POLICY,
  businessFromDate,
  dec,
  DECIMAL_STRING_PATTERN,
  EMPLOYEE_IMPORT_COLUMNS,
  EMPLOYEE_IMPORT_MAX_ROWS,
  EMPLOYEE_IMPORT_REQUIRED_COLUMNS,
  type EmployeeImportColumn,
  type EmployeeImportRequest,
  type EmployeeImportResponse,
  type EmployeeImportRowResult,
  isBusinessDate,
  ROLES,
} from '@peoplehub/shared';
import { createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { greetingName, webUrl } from '../auth/auth.service';
import { parseCsv } from '../leave/csv';
import { MailService } from '../notifications/mail.service';
import { ADMIN_EMPLOYEE_INCLUDE, type EmployeeHrInput, EmployeeAdminService } from './employee-admin.service';
import { ADMIN_USER_INCLUDE, UserAdminService } from './user-admin.service';

/** Roles the import may grant or remove; admin roles are granted in user administration. */
const IMPORT_ROLES: readonly Role[] = ['EMPLOYEE', 'MANAGER'];

const HR_FIELDS = [
  'companyId',
  'companyRuleId',
  'reportsToId',
  'jobTitle',
  'jobGrade',
  'department',
  'hourlyRate',
  'dateEngaged',
] as const;

interface ParsedRow {
  result: EmployeeImportRowResult;
  values: Record<EmployeeImportColumn, string>;
  existingId: number | null;
  companyId?: number;
  companyRuleId?: number;
  /** Manager in the database, or by code from the file. */
  reportsTo: { id: number } | { code: string } | null;
  roles: Role[];
  user: { kind: 'CREATE' } | { kind: 'UPDATE'; userId: string; roles: Role[]; email: string | null } | null;
}

/**
 * POST /admin/import/employees (section 12.10): a CSV of employees and their logins. A dry run
 * checks every row and returns what would happen plus a token bound to the file; a commit with
 * that token re-checks everything in one transaction and applies it. New employees are created;
 * existing ones (by employee code) get their HR fields updated (names and personal details are
 * not touched). A `username` creates the employee's login (LOCAL users get an emailed
 * set-password link) or updates the EMPLOYEE/MANAGER roles and email of the existing one.
 * Every row is audited, unchanged rows included.
 */
@Injectable()
export class EmployeeImportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly employees: EmployeeAdminService,
    private readonly users: UserAdminService,
    private readonly mail: MailService,
  ) {}

  async run(ctx: SecurityContext, input: EmployeeImportRequest): Promise<EmployeeImportResponse> {
    const confirmToken = createHash('sha256').update(input.csv).digest('hex');
    const parsed = await this.parse(ctx, input.csv, this.db.prisma);
    const summary = (committed: boolean, rows: ParsedRow[]): EmployeeImportResponse => {
      const results = rows.map((r) => r.result);
      return {
        mode: input.mode,
        confirmToken,
        totalRows: results.length,
        validRows: results.filter((r) => r.ok).length,
        invalidRows: results.filter((r) => !r.ok).length,
        created: results.filter((r) => r.ok && r.employeeAction === 'CREATE').length,
        updated: results.filter((r) => r.ok && r.employeeAction === 'UPDATE').length,
        unchanged: results.filter((r) => r.ok && r.employeeAction === 'UNCHANGED').length,
        committed,
        rows: results,
      };
    };
    if (input.mode === 'DRY_RUN') return summary(false, parsed);
    if (input.confirmToken !== confirmToken) {
      throw ValidationError.field('confirmToken', 'Run a dry run of this exact file before committing it');
    }
    this.assertAllValid(parsed);

    const invitations: { email: string; firstName: string; token: string }[] = [];
    const committed = await this.db.tx(
      ctx,
      async (tx) => {
        const rows = await this.parse(ctx, input.csv, tx);
        this.assertAllValid(rows);
        await this.commit(tx, ctx, rows, confirmToken, invitations);
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'EMPLOYEE.IMPORT_COMMITTED',
          entityType: null,
          metadata: {
            confirmToken,
            rows: rows.length,
            created: rows.filter((r) => r.result.employeeAction === 'CREATE').length,
            updated: rows.filter((r) => r.result.employeeAction === 'UPDATE').length,
            unchanged: rows.filter((r) => r.result.employeeAction === 'UNCHANGED').length,
            usersCreated: rows.filter((r) => r.result.userAction === 'CREATE').length,
          },
        });
        return rows;
      },
      { timeoutMs: 300_000 },
    );
    for (const invite of invitations) {
      this.mail.sendInBackground({
        to: invite.email,
        template: 'password-reset',
        data: {
          firstName: invite.firstName,
          link: `${webUrl()}/reset-password?token=${encodeURIComponent(invite.token)}`,
          expiresMinutes: AUTH_POLICY.resetTokenMinutes,
        },
      });
    }
    return summary(true, committed);
  }

  private assertAllValid(rows: ParsedRow[]): void {
    if (rows.length === 0) throw ValidationError.field('csv', 'The file has no data rows');
    const invalid = rows.filter((r) => !r.result.ok);
    if (invalid.length > 0) {
      throw new ValidationError(
        invalid.map((r) => ({ path: `rows.${r.result.row}`, message: r.result.errors.join('; ') })),
        'Fix the rows with errors and run the dry run again',
      );
    }
  }

  // ───────────── Parsing and checks ─────────────

  private async parse(ctx: SecurityContext, csv: string, client: Tx): Promise<ParsedRow[]> {
    const table = parseCsv(csv);
    const header = (table[0] ?? []).map((h) => h.trim());
    const missing = EMPLOYEE_IMPORT_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    if (missing.length > 0) {
      throw ValidationError.field('csv', `The header row is missing: ${missing.join(', ')}`);
    }
    const unknown = header.filter((h) => h && !(EMPLOYEE_IMPORT_COLUMNS as readonly string[]).includes(h));
    if (unknown.length > 0) throw ValidationError.field('csv', `Unknown columns: ${unknown.join(', ')}`);
    const data = table.slice(1);
    if (data.length > EMPLOYEE_IMPORT_MAX_ROWS) {
      throw ValidationError.field('csv', `Import at most ${EMPLOYEE_IMPORT_MAX_ROWS} rows at a time`);
    }

    const codes = data.map((raw) => (raw[header.indexOf('employeeCode')] ?? '').trim());
    const [companies, existingEmployees] = await Promise.all([
      client.company.findMany({ include: { rules: true } }),
      client.employee.findMany({
        where: { employeeCode: { in: codes.filter((c) => c) } },
        include: { user: { include: ADMIN_USER_INCLUDE }, reportsTo: { select: { employeeCode: true } } },
      }),
    ]);
    const companyByCode = new Map(companies.map((c) => [c.code, c]));
    const employeeByCode = new Map(existingEmployees.map((e) => [e.employeeCode, e]));
    const fileRowsByCode = new Map<string, number>();
    const seenEntity = new Set<string>();
    const seenUsername = new Set<string>();
    const seenEmail = new Set<string>();

    const out: ParsedRow[] = [];
    for (const [index, raw] of data.entries()) {
      const values = Object.fromEntries(
        EMPLOYEE_IMPORT_COLUMNS.map((c) => [
          c,
          header.includes(c) ? (raw[header.indexOf(c)] ?? '').trim() : '',
        ]),
      ) as Record<EmployeeImportColumn, string>;
      const errors: string[] = [];
      const warnings: string[] = [];
      const result: EmployeeImportRowResult = {
        row: index + 1,
        employeeCode: values.employeeCode,
        ok: false,
        errors,
        warnings,
        employeeAction: null,
        userAction: null,
        changedFields: [],
        employeeId: null,
        userId: null,
      };
      const row: ParsedRow = { result, values, existingId: null, reportsTo: null, roles: [], user: null };
      out.push(row);

      const code = values.employeeCode;
      if (!code) errors.push('employeeCode is required');
      else if (fileRowsByCode.has(code))
        errors.push(`employeeCode ${code} appears more than once in the file`);
      else fileRowsByCode.set(code, index);
      const existing = code ? employeeByCode.get(code) : undefined;
      if (existing?.deletedAt) errors.push(`Employee ${code} was deleted`);
      row.existingId = existing && !existing.deletedAt ? existing.id : null;
      result.employeeId = row.existingId;

      // Company and company rule.
      const company = companyByCode.get(values.companyCode);
      if (!values.companyCode) errors.push('companyCode is required');
      else if (!company) errors.push(`Unknown company ${values.companyCode}`);
      else if (!ctx.isSystem && !ctx.companyIds.includes(company.id)) {
        errors.push(`Company ${values.companyCode} is outside your administration scope`);
      } else if (!company.isActive && company.id !== existing?.companyId) {
        errors.push(`Company ${values.companyCode} is deactivated`);
      }
      const rule = company?.rules.find((r) => r.code === values.companyRuleCode);
      if (!values.companyRuleCode) errors.push('companyRuleCode is required');
      else if (company && !rule)
        errors.push(`Unknown company rule ${values.companyRuleCode} in ${company.code}`);
      else if (rule && !rule.isActive && rule.id !== existing?.companyRuleId) {
        errors.push(`Company rule ${values.companyRuleCode} is deactivated`);
      }
      row.companyId = company?.id;
      row.companyRuleId = rule?.id;
      if (existing && company && !ctx.isSystem && !ctx.companyIds.includes(existing.companyId)) {
        errors.push(`Employee ${code} belongs to a company outside your administration scope`);
      }

      // New-employee fields.
      if (!existing) {
        for (const c of ['entityCode', 'firstName', 'lastName', 'dateEngaged'] as const) {
          if (!values[c]) errors.push(`${c} is required for a new employee`);
        }
        if (values.entityCode && !/^[A-Za-z]{0,3}\d{1,9}$/.test(values.entityCode)) {
          errors.push('entityCode must be up to 9 digits, optionally after a letter prefix');
        }
        if (values.entityCode) {
          if (seenEntity.has(values.entityCode))
            errors.push(`entityCode ${values.entityCode} appears more than once`);
          seenEntity.add(values.entityCode);
          const taken = await client.employee.findUnique({
            where: { entityCode: values.entityCode },
            select: { id: true },
          });
          if (taken) errors.push(`entityCode ${values.entityCode} is already in use`);
        }
      } else {
        if (values.firstName && values.firstName !== existing.firstName) {
          warnings.push('firstName differs; names are changed through personal details, not the import');
        }
        if (values.lastName && values.lastName !== existing.lastName) {
          warnings.push('lastName differs; names are changed through personal details, not the import');
        }
        if (existing.status === 'TERMINATED')
          warnings.push('The employee is terminated; only HR fields change');
      }
      if (values.dateEngaged && !isBusinessDate(values.dateEngaged))
        errors.push('dateEngaged must be YYYY-MM-DD');
      if (
        values.hourlyRate &&
        (!DECIMAL_STRING_PATTERN.test(values.hourlyRate) || dec(values.hourlyRate).lt(0))
      ) {
        errors.push('hourlyRate must be a decimal number of 0 or more');
      }

      // Reports-to: an employee in the database or a row of this file.
      if (values.reportsToEmployeeCode) {
        if (values.reportsToEmployeeCode === code) errors.push('An employee cannot report to themselves');
        else if (
          data.some(
            (other) => (other[header.indexOf('employeeCode')] ?? '').trim() === values.reportsToEmployeeCode,
          )
        ) {
          row.reportsTo = { code: values.reportsToEmployeeCode };
        } else {
          const manager = await client.employee.findFirst({
            where: { employeeCode: values.reportsToEmployeeCode, deletedAt: null },
            select: { id: true, companyId: true, status: true },
          });
          if (!manager) errors.push(`Unknown manager ${values.reportsToEmployeeCode}`);
          else if (company && manager.companyId !== company.id) {
            errors.push('The manager must work for the same company');
          } else if (manager.status === 'TERMINATED') errors.push('The manager is terminated');
          else row.reportsTo = { id: manager.id };
        }
      }

      // Login.
      const roles = values.roles
        ? values.roles
            .split(/[|;]/)
            .map((r) => r.trim().toUpperCase())
            .filter((r) => r)
        : ['EMPLOYEE'];
      const badRoles = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
      if (badRoles.length) errors.push(`Unknown roles: ${badRoles.join(', ')}`);
      const adminRoles = roles.filter(
        (r) => !(IMPORT_ROLES as readonly string[]).includes(r) && !badRoles.includes(r),
      );
      if (adminRoles.length) {
        errors.push(
          `The import grants EMPLOYEE and MANAGER only; grant ${adminRoles.join(', ')} in user administration`,
        );
      }
      row.roles = [
        ...new Set(roles.filter((r): r is Role => (IMPORT_ROLES as readonly string[]).includes(r))),
      ];
      const provider = (values.authProvider || 'LOCAL').toUpperCase();
      if (provider !== 'LOCAL' && provider !== 'OAUTH') errors.push('authProvider must be LOCAL or OAUTH');
      if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('email is not valid');
      if (values.username) {
        const existingUser = existing?.user ?? null;
        if (existingUser) {
          if (existingUser.username.toLowerCase() !== values.username.toLowerCase()) {
            errors.push(`The employee already has the login ${existingUser.username}`);
          } else {
            const kept = existingUser.roles.filter((r) => !IMPORT_ROLES.includes(r));
            const next = [...new Set([...kept, ...row.roles])];
            const email = values.email || existingUser.email;
            const rolesChange =
              next.length !== existingUser.roles.length || next.some((r) => !existingUser.roles.includes(r));
            const emailChange = (email ?? null) !== (existingUser.email ?? null);
            if (emailChange && email) {
              const clash = await client.user.findFirst({
                where: { email: { equals: email, mode: 'insensitive' }, id: { not: existingUser.id } },
                select: { id: true },
              });
              if (clash) errors.push('email is already used by another user');
            }
            row.user = { kind: 'UPDATE', userId: existingUser.id, roles: next, email: email ?? null };
            result.userAction = rolesChange || emailChange ? 'UPDATE' : 'UNCHANGED';
            result.userId = existingUser.id;
          }
        } else {
          if (!/^[A-Za-z0-9._@-]{3,150}$/.test(values.username)) errors.push('username is not valid');
          const key = values.username.toLowerCase();
          if (seenUsername.has(key)) errors.push(`username ${values.username} appears more than once`);
          seenUsername.add(key);
          const taken = await client.user.findFirst({
            where: { username: { equals: values.username, mode: 'insensitive' } },
            select: { id: true },
          });
          if (taken) errors.push(`username ${values.username} is already in use`);
          if (values.email) {
            const emailKey = values.email.toLowerCase();
            if (seenEmail.has(emailKey)) errors.push(`email ${values.email} appears more than once`);
            seenEmail.add(emailKey);
            const clash = await client.user.findFirst({
              where: { email: { equals: values.email, mode: 'insensitive' } },
              select: { id: true },
            });
            if (clash) errors.push('email is already used by another user');
          }
          if (provider === 'OAUTH' && !values.externalSubject)
            errors.push('OAUTH logins need externalSubject');
          if (provider === 'LOCAL' && !values.email) {
            warnings.push('No email: the login cannot get a set-password link; use Reset password later');
          }
          row.user = { kind: 'CREATE' };
          result.userAction = 'CREATE';
        }
      } else if (values.email || values.roles) {
        warnings.push('email and roles are ignored without a username');
      }

      if (existing && errors.length === 0) {
        result.changedFields = this.changedFields(existing, this.hrInput(row));
        if (
          row.reportsTo &&
          'code' in row.reportsTo &&
          existing.reportsTo?.employeeCode !== row.reportsTo.code
        ) {
          result.changedFields.push('reportsToId');
        }
      }
      result.employeeAction = existing ? (result.changedFields.length ? 'UPDATE' : 'UNCHANGED') : 'CREATE';
      result.ok = errors.length === 0;
    }

    // A manager from the file must be valid and in the same company.
    for (const row of out) {
      if (!row.reportsTo || !('code' in row.reportsTo)) continue;
      const managerRow = out.find((r) => r.values.employeeCode === (row.reportsTo as { code: string }).code);
      if (!managerRow || !managerRow.result.ok) {
        row.result.errors.push(`The manager row ${(row.reportsTo as { code: string }).code} has errors`);
      } else if (managerRow.companyId !== row.companyId) {
        row.result.errors.push('The manager must work for the same company');
      }
      row.result.ok = row.result.errors.length === 0;
    }
    return out;
  }

  /**
   * The HR fields of a row. Empty cells leave a field unchanged; a manager from the file is
   * resolved at commit, once that row exists.
   */
  private hrInput(row: ParsedRow): EmployeeHrInput {
    const v = row.values;
    return {
      companyId: row.companyId,
      companyRuleId: row.companyRuleId,
      ...(row.reportsTo && 'id' in row.reportsTo ? { reportsToId: row.reportsTo.id } : {}),
      ...(v.jobTitle ? { jobTitle: v.jobTitle } : {}),
      ...(v.jobGrade ? { jobGrade: v.jobGrade } : {}),
      ...(v.department ? { department: v.department } : {}),
      ...(v.hourlyRate ? { hourlyRate: dec(v.hourlyRate).toFixed(4) } : {}),
      ...(v.dateEngaged ? { dateEngaged: v.dateEngaged } : {}),
    };
  }

  private changedFields(
    existing: {
      companyId: number;
      companyRuleId: number;
      reportsToId: number | null;
      jobTitle: string | null;
      jobGrade: string | null;
      department: string | null;
      hourlyRate: { toString(): string } | null;
      dateEngaged: Date | null;
    },
    hr: EmployeeHrInput,
  ): (typeof HR_FIELDS)[number][] {
    const current: Record<(typeof HR_FIELDS)[number], string | number | null> = {
      companyId: existing.companyId,
      companyRuleId: existing.companyRuleId,
      reportsToId: existing.reportsToId,
      jobTitle: existing.jobTitle,
      jobGrade: existing.jobGrade,
      department: existing.department,
      hourlyRate: existing.hourlyRate === null ? null : dec(existing.hourlyRate).toFixed(4),
      dateEngaged: existing.dateEngaged ? businessFromDate(existing.dateEngaged) : null,
    };
    return HR_FIELDS.filter((f) => hr[f] !== undefined && (hr[f] ?? null) !== current[f]);
  }

  // ───────────── Commit ─────────────

  private async commit(
    tx: Tx,
    ctx: SecurityContext,
    rows: ParsedRow[],
    confirmToken: string,
    invitations: { email: string; firstName: string; token: string }[],
  ): Promise<void> {
    const idByCode = new Map<string, number>();
    const deferred: ParsedRow[] = [];
    const meta = (row: ParsedRow) => ({ importRow: row.result.row, confirmToken });

    for (const row of rows) {
      const fileManager = row.reportsTo && 'code' in row.reportsTo ? row.reportsTo.code : null;
      const managerId = fileManager ? (idByCode.get(fileManager) ?? null) : undefined;
      if (fileManager && managerId === null) deferred.push(row);
      if (row.existingId === null) {
        const hr = this.hrInput(row);
        const created = await this.employees.createInTx(
          tx,
          ctx,
          {
            employeeCode: row.values.employeeCode,
            entityCode: row.values.entityCode,
            title: row.values.title || null,
            initials: row.values.initials || null,
            firstName: row.values.firstName,
            lastName: row.values.lastName,
            knownAs: row.values.knownAs || null,
            companyId: row.companyId as number,
            companyRuleId: row.companyRuleId as number,
            reportsToId: managerId ?? hr.reportsToId ?? null,
            jobTitle: hr.jobTitle ?? null,
            jobGrade: hr.jobGrade ?? null,
            department: hr.department ?? null,
            hourlyRate: hr.hourlyRate ?? null,
            dateEngaged: row.values.dateEngaged,
          },
          { action: 'EMPLOYEE.IMPORT_CREATED', metadata: meta(row) },
        );
        row.result.employeeId = created.id;
        idByCode.set(row.values.employeeCode, created.id);
      } else {
        idByCode.set(row.values.employeeCode, row.existingId);
        await this.db.lockRow(tx, 'Employee', row.existingId);
        const before = await tx.employee.findUniqueOrThrow({
          where: { id: row.existingId },
          include: ADMIN_EMPLOYEE_INCLUDE,
        });
        const hr = this.hrInput(row);
        if (managerId !== undefined && managerId !== null) hr.reportsToId = managerId;
        const changed = this.changedFields(before, hr);
        if (changed.length > 0) {
          const patch: EmployeeHrInput = Object.fromEntries(changed.map((f) => [f, hr[f]]));
          await this.employees.updateInTx(tx, ctx, before, patch, undefined, {
            action: 'EMPLOYEE.IMPORT_UPDATED',
            metadata: meta(row),
          });
        } else {
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'EMPLOYEE.IMPORT_UNCHANGED',
            entityType: 'Employee',
            entityId: before.id,
            subjectEmployeeId: before.id,
            metadata: meta(row),
          });
        }
      }
    }

    // Managers that came later in the file.
    for (const row of deferred) {
      const id = idByCode.get(row.values.employeeCode) as number;
      const managerId = idByCode.get((row.reportsTo as { code: string }).code) as number;
      await this.db.lockRow(tx, 'Employee', id);
      const before = await tx.employee.findUniqueOrThrow({ where: { id }, include: ADMIN_EMPLOYEE_INCLUDE });
      if (before.reportsToId === managerId) continue;
      await this.employees.updateInTx(tx, ctx, before, { reportsToId: managerId }, undefined, {
        action: 'EMPLOYEE.IMPORT_UPDATED',
        metadata: { ...meta(row), reportsToResolved: true },
      });
    }

    // Logins.
    for (const row of rows) {
      if (!row.user) continue;
      const employeeId = idByCode.get(row.values.employeeCode) as number;
      if (row.user.kind === 'CREATE') {
        const provider = (row.values.authProvider || 'LOCAL').toUpperCase() as 'LOCAL' | 'OAUTH';
        const { user, token } = await this.users.createInTx(
          tx,
          ctx,
          {
            username: row.values.username,
            email: row.values.email || null,
            authProvider: provider,
            externalSubject: provider === 'OAUTH' ? row.values.externalSubject : null,
            roles: row.roles.length ? row.roles : ['EMPLOYEE'],
            employeeId,
          },
          null,
          { metadata: meta(row) },
        );
        row.result.userId = user.id;
        if (token && user.email)
          invitations.push({ email: user.email, firstName: greetingName(user), token });
      } else if (row.result.userAction === 'UPDATE') {
        const before = await this.users.lock(tx, row.user.userId);
        let current = before;
        if ((row.user.email ?? null) !== (before.email ?? null)) {
          current = await tx.user.update({
            where: { id: before.id },
            data: { email: row.user.email, version: { increment: 1 } },
            include: ADMIN_USER_INCLUDE,
          });
          this.audit.record(tx, ctx, {
            category: 'SECURITY',
            action: 'SECURITY.USER_UPDATED',
            entityType: 'User',
            entityId: before.id,
            subjectEmployeeId: before.employeeId,
            before: { email: before.email },
            after: { email: current.email },
            metadata: meta(row),
          });
        }
        await this.users.applyRoles(tx, ctx, current, row.user.roles, 'Employee import', meta(row));
      }
    }
  }
}
