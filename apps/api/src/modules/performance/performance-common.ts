import type { Prisma, TemplateItemKind } from '@prisma/client';
import {
  businessFromDate,
  type PerformanceItem,
  type RatingScale,
  type RatingScalePoint,
  RatingScalePointsSchema,
  ratingScaleBounds,
  type SectionTotal,
  sectionWeightIssues,
  sectionWeightTotals,
  TEMPLATE_ITEM_KIND_LABELS,
  TEMPLATE_ITEM_PARAMETER_TABLES,
  type TemplateItemInput,
} from '@peoplehub/shared';
import { type FieldError, ValidationError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
import { PARAMETER_ACTIVE } from '../details/lookup.service';

/** pg-boss job that creates the contracts of an initiation (section 5.9). */
export const PERFORMANCE_INITIATE_JOB = 'performance.initiateContracts';
/** Daily job that sends the "Specific Date" review notifications. */
export const PERFORMANCE_REVIEW_NOTIFY_JOB = 'performance.reviewNotify';

export const PERFORMANCE_TEMPLATE_ENTITY = 'PerformanceTemplate';
export const CONTRACT_INITIATION_ENTITY = 'ContractInitiation';
export const PERFORMANCE_CONTRACT_ENTITY = 'PerformanceContract';
export const REVIEW_ENTITY = 'Review';

/** The points of a stored scale; an unreadable value yields no points. */
export function scalePoints(row: { points: Prisma.JsonValue }): RatingScalePoint[] {
  const parsed = RatingScalePointsSchema.safeParse(row.points);
  return parsed.success ? parsed.data : [];
}

export function toRatingScaleDto(row: { id: number; name: string; points: Prisma.JsonValue }): RatingScale {
  const points = scalePoints(row);
  const bounds = points.length > 0 ? ratingScaleBounds(points) : null;
  return {
    id: row.id,
    name: row.name,
    points,
    min: bounds ? bounds.min.toString() : '0',
    max: bounds ? bounds.max.toString() : '0',
  };
}

export function personName(e: { firstName: string; lastName: string } | null | undefined): string | null {
  return e ? `${e.firstName} ${e.lastName}` : null;
}

export function dateOrNull(value: Date | null | undefined): string | null {
  return value ? businessFromDate(value) : null;
}

/** Display names of users: the linked employee's name, else the username. */
export async function userDisplayNames(
  client: Tx,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return new Map();
  const users = await client.user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, username: true, employee: { select: { firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, personName(u.employee) ?? u.username]));
}

/** A template or contract item row as the API shows it. */
export interface ItemRow {
  id: number;
  kind: TemplateItemKind;
  parameterValueId: number | null;
  parameterValue?: { code: string } | null;
  title: string;
  weight: Prisma.Decimal;
  target: string | null;
  sortOrder: number;
}

export function toItemDto(row: ItemRow): PerformanceItem {
  return {
    id: row.id,
    kind: row.kind,
    parameterValueId: row.parameterValueId,
    parameterCode: row.parameterValue?.code ?? null,
    title: row.title,
    weight: row.weight.toFixed(2),
    target: row.target,
    sortOrder: row.sortOrder,
  };
}

export function sectionTotalsOf(
  items: { kind: TemplateItemKind; weight: Prisma.Decimal | string }[],
): SectionTotal[] {
  return sectionWeightTotals(items.map((i) => ({ section: i.kind, weight: i.weight.toString() }))).map(
    (s) => ({
      ...s,
      section: s.section as TemplateItemKind,
    }),
  );
}

/** Prisma include/orderBy for the live items of a template or contract. */
export const LIVE_ITEMS = {
  where: { deletedAt: null },
  include: { parameterValue: { select: { code: true } } },
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
} satisfies Prisma.PerformanceTemplateItemFindManyArgs;

/** A validated item, ready to write. */
export interface ResolvedItem {
  id?: number;
  kind: TemplateItemKind;
  parameterValueId: number | null;
  title: string;
  weight: string;
  target: string | null;
  sortOrder: number;
}

/**
 * Checks a template or contract item list (section 5.9): ids belong to the record, a parameter
 * link points at an active row of a table that matches the kind (objectives have none), every item
 * has a title (the parameter's description by default), and the weights of each section (kind)
 * add up to 100. Throws one 422 with every problem; `path` prefixes the field paths.
 */
export async function resolveItems(
  tx: Tx,
  inputs: readonly TemplateItemInput[],
  existing: ReadonlyMap<number, { parameterValueId: number | null }>,
  path = 'items',
): Promise<ResolvedItem[]> {
  const errors: FieldError[] = [];
  const paramIds = [...new Set(inputs.map((i) => i.parameterValueId).filter((id): id is number => !!id))];
  const params = new Map(
    (
      await tx.parameterValue.findMany({
        where: { id: { in: paramIds } },
        select: { id: true, tableName: true, description: true, status: true },
      })
    ).map((p) => [p.id, p]),
  );
  const seenIds = new Set<number>();
  const resolved: ResolvedItem[] = [];
  inputs.forEach((input, index) => {
    const at = `${path}.${index}`;
    if (input.id !== undefined) {
      if (!existing.has(input.id) || seenIds.has(input.id))
        errors.push({ path: `${at}.id`, message: 'Unknown item' });
      seenIds.add(input.id);
    }
    let title = input.title ?? null;
    const paramId = input.parameterValueId ?? null;
    if (paramId !== null) {
      const param = params.get(paramId);
      const allowed = TEMPLATE_ITEM_PARAMETER_TABLES[input.kind] as readonly string[];
      const unchanged = input.id !== undefined && existing.get(input.id)?.parameterValueId === paramId;
      if (!param || !allowed.includes(param.tableName)) {
        errors.push({
          path: `${at}.parameterValueId`,
          message:
            allowed.length === 0
              ? 'An objective is not linked to a parameter'
              : `Pick a value from ${allowed.join(' or ')}`,
        });
      } else if (param.status !== PARAMETER_ACTIVE && !unchanged) {
        errors.push({ path: `${at}.parameterValueId`, message: 'This value is no longer active' });
      } else {
        title = title ?? param.description;
      }
    }
    if (!title) errors.push({ path: `${at}.title`, message: 'Enter a title' });
    resolved.push({
      id: input.id,
      kind: input.kind,
      parameterValueId: paramId,
      title: title ?? '',
      weight: input.weight,
      target: input.target ?? null,
      sortOrder: input.sortOrder ?? (index + 1) * 10,
    });
  });
  for (const issue of sectionWeightIssues(resolved.map((r) => ({ section: r.kind, weight: r.weight })))) {
    const label = TEMPLATE_ITEM_KIND_LABELS[issue.section as TemplateItemKind];
    errors.push({ path, message: `The ${label} weights add up to ${issue.total}; they must add up to 100` });
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return resolved;
}

/** Audit snapshot of an item list (stable and small). */
export function itemsSnapshot(
  items: {
    id?: number;
    kind: string;
    parameterValueId: number | null;
    title: string;
    weight: string | Prisma.Decimal;
    target: string | null;
  }[],
): Record<string, unknown>[] {
  return items.map((i) => ({
    id: i.id ?? null,
    kind: i.kind,
    parameterValueId: i.parameterValueId,
    title: i.title,
    weight: i.weight.toString(),
    target: i.target,
  }));
}
