import type { Prisma } from '@prisma/client';
import { API_PREFIX, type ActingAsOption, type EmployeeSummary } from '@peoplehub/shared';

/** Prisma select for everything an EmployeeSummary or "Working as" row shows. */
export const EMPLOYEE_SUMMARY_SELECT = {
  id: true,
  employeeCode: true,
  entityCode: true,
  title: true,
  initials: true,
  firstName: true,
  lastName: true,
  knownAs: true,
  companyId: true,
  companyRuleId: true,
  status: true,
  photoAttachmentId: true,
  company: { select: { name: true } },
  companyRule: { select: { description: true } },
} satisfies Prisma.EmployeeSelect;

export type EmployeeSummaryRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SUMMARY_SELECT }>;

export function attachmentUrl(id: string | null | undefined): string | null {
  return id ? `${API_PREFIX}/attachments/${id}` : null;
}

export function toEmployeeSummary(e: EmployeeSummaryRow): EmployeeSummary {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    entityCode: e.entityCode,
    title: e.title,
    initials: e.initials,
    firstName: e.firstName,
    lastName: e.lastName,
    knownAs: e.knownAs,
    displayName: `${e.firstName} ${e.lastName}`,
    companyId: e.companyId,
    companyName: e.company.name,
    companyRuleId: e.companyRuleId,
    companyRule: e.companyRule.description,
    status: e.status,
    photoUrl: attachmentUrl(e.photoAttachmentId),
  };
}

export function toActingAsOption(e: EmployeeSummaryRow, selfEmployeeId: number | null): ActingAsOption {
  return {
    employeeId: e.id,
    name: `${e.firstName} ${e.lastName}`,
    knownAs: e.knownAs,
    employeeCode: e.employeeCode,
    companyRule: e.companyRule.description,
    status: e.status,
    isSelf: e.id === selfEmployeeId,
  };
}
