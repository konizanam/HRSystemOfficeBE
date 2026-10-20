import Decimal from 'decimal.js';

export { Decimal };

/** Anything that can be turned into a Decimal without precision loss. */
export type DecimalInput = Decimal | string | number | { toString(): string };

export function dec(value: DecimalInput | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'number' || typeof value === 'string') return new Decimal(value);
  return new Decimal(value.toString());
}

/** Round half away from zero to `dp` places (Postgres NUMERIC rounding). */
export function roundTo(value: DecimalInput, dp: number): Decimal {
  return dec(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** Leave units are kept to 4 decimal places (section 1.7). */
export function round4(value: DecimalInput): Decimal {
  return roundTo(value, 4);
}

/** Money is kept to 2 decimal places. */
export function round2(value: DecimalInput): Decimal {
  return roundTo(value, 2);
}

/** DTO representation: decimals travel as fixed-point strings (section 10.1). */
export function units4(value: DecimalInput | null | undefined): string {
  return round4(dec(value)).toFixed(4);
}

export function money2(value: DecimalInput | null | undefined): string {
  return round2(dec(value)).toFixed(2);
}

export function sumDecimals(values: Iterable<DecimalInput>): Decimal {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(dec(v));
  return total;
}

/** Pattern for decimal strings accepted by the API. */
export const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;
