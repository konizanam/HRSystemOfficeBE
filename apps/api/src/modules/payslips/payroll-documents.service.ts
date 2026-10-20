import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { maskedNumber, type RestrictedFeature } from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { StorageService } from '../../storage/storage.service';
import { ScopeService } from '../auth/scope.service';
import { SettingsService } from '../settings/settings.service';

/** Employee fields a payslip or certificate PDF prints. */
export const DOCUMENT_EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  title: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  department: true,
  dateEngaged: true,
  terminationDate: true,
  identityNumberLast4: true,
  taxNumberLast4: true,
  companyId: true,
  companyRuleId: true,
  company: { select: { id: true, name: true, currency: true, logoAttachmentId: true } },
  companyRule: { select: { description: true } },
  user: { select: { id: true, isActive: true } },
  bankAccounts: {
    where: { isActive: true },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
    select: { accountNumberLast4: true, bank: { select: { name: true } } },
  },
} satisfies Prisma.EmployeeSelect;

export type DocumentEmployee = Prisma.EmployeeGetPayload<{ select: typeof DOCUMENT_EMPLOYEE_SELECT }>;

const LOGO_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * Shared by payslips and tax certificates: who may view an employee's payroll documents, and the
 * company branding and employee block printed on them.
 *
 * Viewers (ASSUMPTION, see docs): the employee themself, or the "Working as" employee when the
 * feature is not restricted (by default it is, section 4.2), and PAYROLL_ADMIN of the employee's
 * company. Managers, HR admins, auditors and system admins cannot.
 */
@Injectable()
export class PayrollDocumentsService {
  private readonly logger = new Logger(PayrollDocumentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
  ) {}

  /** 403 (audited DENIED) while working as someone else when the feature is restricted. */
  assertNotRestricted(ctx: SecurityContext, feature: RestrictedFeature): Promise<void> {
    return this.scope.assertNotRestricted(ctx, feature);
  }

  /** The employee whose documents a list shows: the acting-as employee unless `employeeId` is given. */
  async listSubject(ctx: SecurityContext, employeeId: number | undefined): Promise<number> {
    const id = employeeId ?? ctx.actingAsEmployeeId;
    if (!id) throw new NotFoundError('Employee');
    await this.assertCanView(ctx, id);
    return id;
  }

  /** Own (or acting-as) documents, or a payroll admin of the employee's company; 403 otherwise. */
  async assertCanView(ctx: SecurityContext, employeeId: number): Promise<void> {
    if (employeeId === ctx.actingAsEmployeeId || employeeId === ctx.selfEmployeeId) {
      await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE');
      return;
    }
    await this.scope.assertCanAccessEmployee(ctx, employeeId, 'PAYROLL');
  }

  async employee(employeeId: number, client: Tx = this.db.prisma): Promise<DocumentEmployee> {
    const employee = await client.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: DOCUMENT_EMPLOYEE_SELECT,
    });
    if (!employee) throw new NotFoundError('Employee');
    return employee;
  }

  employeeBlock(e: DocumentEmployee) {
    const bank = e.bankAccounts[0];
    return {
      name: [e.title, e.firstName, e.lastName].filter(Boolean).join(' '),
      employeeCode: e.employeeCode,
      idNumberMasked: maskedNumber(e.identityNumberLast4),
      taxNumberMasked: maskedNumber(e.taxNumberLast4),
      bankMasked: bank ? `${bank.bank.name} ${maskedNumber(bank.accountNumberLast4) ?? ''}`.trim() : null,
    };
  }

  /**
   * The company logo as a data URL for pdfmake: `Company.logoAttachmentId`, else the
   * `company.logoAttachmentId` setting. PNG and JPEG only; anything else prints no logo.
   * `cache` keeps one lookup per company during an import.
   */
  async logo(
    company: { id: number; logoAttachmentId: string | null },
    cache?: Map<number, string | null>,
  ): Promise<string | null> {
    if (cache?.has(company.id)) return cache.get(company.id) ?? null;
    const id = company.logoAttachmentId ?? (await this.settings.get('company.logoAttachmentId'));
    let dataUrl: string | null = null;
    if (id) {
      const row = await this.db.prisma.attachment.findUnique({ where: { id } });
      if (row && !row.deletedAt && LOGO_TYPES.has(row.mimeType)) {
        try {
          const bytes = await this.storage.get(row.storageKey);
          dataUrl = `data:${row.mimeType};base64,${bytes.toString('base64')}`;
        } catch (err) {
          this.logger.warn({ err, attachmentId: id }, 'Company logo could not be read');
        }
      }
    }
    cache?.set(company.id, dataUrl);
    return dataUrl;
  }
}
