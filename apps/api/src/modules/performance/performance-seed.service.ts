import { Injectable } from '@nestjs/common';
import type { Prisma, TemplateItemKind } from '@prisma/client';
import {
  dateFromBusiness,
  parameterParentTable,
  type PerformanceParameterTable,
  type RatingScalePoint,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { type SecurityContext, SYSTEM_USER_ID } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { PERFORMANCE_TEMPLATE_ENTITY } from './performance-common';

interface SeedParameter {
  code: string;
  description: string;
  /** Code of the parent row in the parent table. */
  parent?: string;
}

/**
 * Parameter rows (section 14): ReviewCategory and ReviewType as specified, and samples for the
 * other tables (ASSUMPTION A97). Parents come before their children.
 */
export const PERFORMANCE_PARAMETER_SEED: [PerformanceParameterTable, SeedParameter[]][] = [
  [
    'ReviewCategory',
    [
      { code: 'ANNUAL', description: 'Annual Review' },
      { code: 'PROBATION', description: 'Probation Review' },
      { code: 'MIDYEAR', description: 'Mid-Year Review' },
    ],
  ],
  [
    'ReviewType',
    [
      { code: 'SELF', description: 'Self Assessment' },
      { code: 'MANAGER', description: 'Manager Review' },
      { code: '360', description: '360 Degree Review' },
    ],
  ],
  [
    'JobTitleType',
    [
      { code: 'PERMANENT', description: 'Permanent' },
      { code: 'FIXED_TERM', description: 'Fixed-Term Contract' },
      { code: 'TEMPORARY', description: 'Temporary' },
    ],
  ],
  [
    'JobGrade',
    [
      { code: 'A', description: 'Grade A (Unskilled)' },
      { code: 'B', description: 'Grade B (Semi-skilled)' },
      { code: 'C', description: 'Grade C (Skilled)' },
      { code: 'D', description: 'Grade D (Professional)' },
      { code: 'E', description: 'Grade E (Senior Management)' },
      { code: 'F', description: 'Grade F (Executive)' },
    ],
  ],
  [
    'KeyPerformanceArea',
    [
      { code: 'FINANCIAL', description: 'Financial' },
      { code: 'CUSTOMER', description: 'Customer' },
      { code: 'PROCESS', description: 'Internal Processes' },
      { code: 'PEOPLE', description: 'Learning and Growth' },
    ],
  ],
  [
    'KeyPerformanceIndicator',
    [
      { code: 'FIN_BUDGET', description: 'Stay within the approved budget', parent: 'FINANCIAL' },
      { code: 'FIN_REVENUE', description: 'Meet the revenue target', parent: 'FINANCIAL' },
      { code: 'CUS_SATISFACTION', description: 'Customer satisfaction score', parent: 'CUSTOMER' },
      { code: 'PRO_TURNAROUND', description: 'Turnaround time of requests', parent: 'PROCESS' },
      { code: 'PEO_TRAINING', description: 'Training hours completed', parent: 'PEOPLE' },
    ],
  ],
  [
    'SubKeyPerformanceIndicator',
    [
      { code: 'FIN_BUDGET_VARIANCE', description: 'Budget variance below 5%', parent: 'FIN_BUDGET' },
      { code: 'CUS_SURVEY', description: 'Survey score of at least 80%', parent: 'CUS_SATISFACTION' },
      { code: 'PRO_SLA', description: 'Requests closed within the agreed time', parent: 'PRO_TURNAROUND' },
    ],
  ],
  [
    'CompetencyArea',
    [
      { code: 'CORE', description: 'Core Competencies' },
      { code: 'LEADERSHIP', description: 'Leadership' },
      { code: 'TECHNICAL', description: 'Technical' },
    ],
  ],
  [
    'Competency',
    [
      { code: 'COMMUNICATION', description: 'Communication', parent: 'CORE' },
      { code: 'TEAMWORK', description: 'Teamwork', parent: 'CORE' },
      { code: 'DECISION_MAKING', description: 'Decision Making', parent: 'LEADERSHIP' },
      { code: 'PROBLEM_SOLVING', description: 'Problem Solving', parent: 'TECHNICAL' },
    ],
  ],
  [
    'SubCompetency',
    [
      { code: 'WRITTEN', description: 'Written communication', parent: 'COMMUNICATION' },
      { code: 'VERBAL', description: 'Verbal communication', parent: 'COMMUNICATION' },
      { code: 'COLLABORATION', description: 'Collaboration', parent: 'TEAMWORK' },
    ],
  ],
  [
    'LevelOfComplexity',
    [
      { code: 'LOW', description: 'Low' },
      { code: 'MEDIUM', description: 'Medium' },
      { code: 'HIGH', description: 'High' },
    ],
  ],
];

/** Rating scale "1–5" (section 14); labels 2 to 4 are ASSUMPTION A97. */
export const SEED_RATING_SCALE_NAME = '1–5';
export const SEED_RATING_SCALE_POINTS: RatingScalePoint[] = [
  { value: 1, label: 'Unacceptable' },
  { value: 2, label: 'Needs Improvement' },
  { value: 3, label: 'Meets Expectations' },
  { value: 4, label: 'Exceeds Expectations' },
  { value: 5, label: 'Outstanding' },
];

export const SEED_TEMPLATE_NAME = 'Annual Performance Contract 2026';

/** The active template's items: two sections whose weights add up to 100 each. */
const SEED_TEMPLATE_ITEMS: {
  kind: TemplateItemKind;
  table: PerformanceParameterTable;
  code: string;
  weight: string;
  target: string;
}[] = [
  {
    kind: 'KPA',
    table: 'KeyPerformanceArea',
    code: 'FINANCIAL',
    weight: '30',
    target: 'Budget variance below 5%',
  },
  {
    kind: 'KPA',
    table: 'KeyPerformanceArea',
    code: 'CUSTOMER',
    weight: '30',
    target: 'Satisfaction score of 80% or more',
  },
  {
    kind: 'KPA',
    table: 'KeyPerformanceArea',
    code: 'PROCESS',
    weight: '25',
    target: 'Requests closed within 3 days',
  },
  { kind: 'KPA', table: 'KeyPerformanceArea', code: 'PEOPLE', weight: '15', target: '40 training hours' },
  {
    kind: 'COMPETENCY',
    table: 'Competency',
    code: 'COMMUNICATION',
    weight: '40',
    target: 'Clear and timely updates',
  },
  {
    kind: 'COMPETENCY',
    table: 'Competency',
    code: 'TEAMWORK',
    weight: '35',
    target: 'Shares work and knowledge',
  },
  {
    kind: 'COMPETENCY',
    table: 'Competency',
    code: 'PROBLEM_SOLVING',
    weight: '25',
    target: 'Finds root causes',
  },
];

/**
 * Performance seed data (section 14), idempotent: rows are created only when missing, so HR edits
 * survive a re-seed and a second run writes nothing.
 */
@Injectable()
export class PerformanceSeedService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async seed(ctx: SecurityContext, ownerUsername = 'hr.admin'): Promise<Record<string, number>> {
    return this.db.tx(ctx, async (tx) => {
      const parameters = await this.seedParameters(tx, ctx);
      const scale = await this.seedScale(tx, ctx);
      const template = await this.seedTemplate(tx, ctx, scale.id, ownerUsername);
      return {
        performanceParametersCreated: parameters,
        ratingScalesCreated: scale.created,
        templatesCreated: template,
      };
    });
  }

  private async seedParameters(tx: Tx, ctx: SecurityContext): Promise<number> {
    let created = 0;
    for (const [tableName, rows] of PERFORMANCE_PARAMETER_SEED) {
      const existing = new Map(
        (await tx.parameterValue.findMany({ where: { tableName }, select: { id: true, code: true } })).map(
          (r) => [r.code, r.id],
        ),
      );
      for (const [index, row] of rows.entries()) {
        if (existing.has(row.code)) continue;
        let parentId: number | null = null;
        if (row.parent) {
          const parentTable = parameterParentTable(tableName);
          const parent = parentTable
            ? await tx.parameterValue.findUnique({
                where: { tableName_code: { tableName: parentTable, code: row.parent } },
                select: { id: true },
              })
            : null;
          parentId = parent?.id ?? null;
        }
        const value = await tx.parameterValue.create({
          data: {
            tableName,
            code: row.code,
            description: row.description,
            parentId,
            sortOrder: (index + 1) * 10,
          },
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'PERFORMANCE_PARAMETER.SEEDED',
          entityType: 'ParameterValue',
          entityId: value.id,
          after: value,
          metadata: { table: tableName },
        });
        created += 1;
      }
    }
    return created;
  }

  private async seedScale(tx: Tx, ctx: SecurityContext): Promise<{ id: number; created: number }> {
    const existing = await tx.ratingScale.findUnique({ where: { name: SEED_RATING_SCALE_NAME } });
    if (existing) return { id: existing.id, created: 0 };
    const scale = await tx.ratingScale.create({
      data: {
        name: SEED_RATING_SCALE_NAME,
        points: SEED_RATING_SCALE_POINTS as unknown as Prisma.InputJsonValue,
      },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'RATING_SCALE.SEEDED',
      entityType: 'RatingScale',
      entityId: scale.id,
      after: scale,
    });
    return { id: scale.id, created: 1 };
  }

  private async seedTemplate(
    tx: Tx,
    ctx: SecurityContext,
    ratingScaleId: number,
    ownerUsername: string,
  ): Promise<number> {
    const existing = await tx.performanceTemplate.findFirst({
      where: { name: SEED_TEMPLATE_NAME },
      select: { id: true },
    });
    if (existing) return 0;
    const owner = await tx.user.findUnique({ where: { username: ownerUsername }, select: { id: true } });
    const template = await tx.performanceTemplate.create({
      data: {
        name: SEED_TEMPLATE_NAME,
        contractStartDate: dateFromBusiness('2026-01-01'),
        contractEndDate: dateFromBusiness('2026-12-31'),
        ratingScaleId,
        processDefinition: 'Annual performance cycle',
        ownerUserId: owner?.id ?? SYSTEM_USER_ID,
        status: 'ACTIVE',
      },
    });
    const items: Record<string, unknown>[] = [];
    for (const [index, item] of SEED_TEMPLATE_ITEMS.entries()) {
      const param = await tx.parameterValue.findUnique({
        where: { tableName_code: { tableName: item.table, code: item.code } },
        select: { id: true, description: true },
      });
      const row = await tx.performanceTemplateItem.create({
        data: {
          templateId: template.id,
          kind: item.kind,
          parameterValueId: param?.id ?? null,
          title: param?.description ?? item.code,
          weight: item.weight,
          target: item.target,
          sortOrder: (index + 1) * 10,
        },
      });
      items.push({ id: row.id, kind: row.kind, title: row.title, weight: item.weight });
    }
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'PERFORMANCE_TEMPLATE.SEEDED',
      entityType: PERFORMANCE_TEMPLATE_ENTITY,
      entityId: template.id,
      after: { ...template, items },
    });
    return 1;
  }
}
