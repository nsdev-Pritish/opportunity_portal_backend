import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { estimates, estimateLineItems, estimateFreightGroups } from '../db/schema/index.js';
import { AppError } from './errors.js';

/**
 * Check every value against its column's size BEFORE it is written, so a value that won't fit
 * is reported by field and line ("Line 8 (SET UP FEE) — Margin %: …") instead of Postgres's
 * anonymous "numeric field overflow", which names neither.
 *
 * Limits are read from the Drizzle schema itself (precision/scale, varchar length, integer
 * range), so there is no separate list to maintain — change a column and the check follows.
 * Payload keys that aren't columns (e.g. vendorNsId) are skipped, which is what lets the same
 * check run on portal payloads and on NetSuite sync payloads alike.
 *
 * toFriendlyDbError (dbErrors.ts) stays in place as the safety net for anything this misses.
 */

// Readable names for the fields users actually type. Anything not listed falls back to a
// humanised column name (dutyPct → "Duty %"), so the check works for every column regardless.
const LABELS: Record<string, string> = {
  // Line items
  quantity: 'Quantity',
  sellPricePerUnit: 'Sell Price',
  skuMarginPct: 'Margin %',
  salesAmount: 'Sales Amount',
  factoryCostPerUnit: 'Factory Cost',
  packingCostPerUnit: 'Packing Cost',
  sampleFees: 'Sample Fees',
  otherPerUnit: 'Other Cost',
  freightPerUnit: 'Freight per Unit',
  tariffMuPct: 'Tariff Markup %',
  landedCostPerUnit: 'Landed Cost',
  extendedLandedCost: 'Extended Landed Cost',
  usdFactoryCost: 'USD Factory Cost',
  unitsPerCarton: 'Units per Carton',
  dimLCm: 'Length (cm)',
  dimWCm: 'Width (cm)',
  dimHCm: 'Height (cm)',
  weightKgPerCarton: 'Weight per Carton (kg)',
  cbmPerCarton: 'CBM per Carton',
  totalCartons: 'Total Cartons',
  totalCbm: 'Total CBM',
  chargeableWeightKg: 'Chargeable Weight (kg)',
  shortDescription: 'Item Name',
  htsCode: 'HTS Code',
  vendorSku: 'Vendor SKU',
  // Estimate header
  projectedTotalAmt: 'Projected Total',
  estimatedQty: 'Estimated Quantity',
  customerPo: 'Customer PO',
  projectName: 'Project Name',
};

function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key];
  return key
    .replace(/Pct$/, ' %')
    .replace(/Cm$/, ' (cm)')
    .replace(/Kg$/, ' (kg)')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

const INT_RANGE: Record<string, [number, number]> = {
  PgInteger : [-2_147_483_648, 2_147_483_647],
  PgSmallInt: [-32_768, 32_767],
};

/** The problem with one value, or null when it fits (or isn't a column we can check). */
function checkValue(column: any, key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const label = labelFor(key);

  if (column.columnType === 'PgNumeric' && column.precision !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const scale = column.scale ?? 0;
    // Postgres rounds to `scale` first, then requires |value| < 10^(precision − scale).
    if (Math.abs(n) >= 10 ** (column.precision - scale) - 0.5 * 10 ** -scale) {
      return `${label}: ${value} is too large`;
    }
    return null;
  }

  const intRange = INT_RANGE[column.columnType];
  if (intRange) {
    const n = Number(value);
    if (Number.isFinite(n) && (n < intRange[0] || n > intRange[1])) {
      return `${label}: ${value} is too large`;
    }
    return null;
  }

  if (column.columnType === 'PgVarchar' && column.length !== undefined && typeof value === 'string') {
    const chars = [...value].length; // code points — how Postgres counts characters
    if (chars > column.length) {
      return `${label} is too long`;
    }
  }
  return null;
}

function checkRow(table: PgTable, row: Record<string, unknown>, where: string, problems: string[]) {
  const columns = getTableColumns(table) as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    const column = columns[key];
    if (!column) continue;
    const problem = checkValue(column, key, value);
    if (problem) problems.push(`${where} — ${problem}`);
  }
}

const MAX_LISTED = 5;

type RawRow = Record<string, unknown>;

/**
 * Throw a 400 VALUE_TOO_LARGE naming every value that won't fit, before anything is written.
 * Lines are numbered in payload order, matching the order on screen.
 */
export function assertEstimateValuesFit(input: {
  header?: RawRow;
  lineItems?: Array<RawRow & { components?: RawRow[] }>;
  freightGroups?: RawRow[];
}): void {
  const problems: string[] = [];

  if (input.header) checkRow(estimates, input.header, 'Estimate', problems);

  (input.lineItems ?? []).forEach((line, i) => {
    const name = typeof line.shortDescription === 'string' && line.shortDescription ? ` (${line.shortDescription})` : '';
    const { components, ...values } = line;
    checkRow(estimateLineItems, values, `Line ${i + 1}${name}`, problems);
    (components ?? []).forEach((comp, j) => {
      const compName = typeof comp.shortDescription === 'string' && comp.shortDescription ? ` (${comp.shortDescription})` : '';
      checkRow(estimateLineItems, comp, `Line ${i + 1}, component ${j + 1}${compName}`, problems);
    });
  });

  (input.freightGroups ?? []).forEach((group, i) => {
    const name = typeof group.groupName === 'string' && group.groupName ? ` (${group.groupName})` : '';
    checkRow(estimateFreightGroups, group, `Freight group ${i + 1}${name}`, problems);
  });

  if (problems.length === 0) return;

  const message = problems.length === 1
    ? problems[0]
    : `These values are too large to save: ${problems.slice(0, MAX_LISTED).join('; ')}`
      + (problems.length > MAX_LISTED ? `; and ${problems.length - MAX_LISTED} more` : '');
  throw new AppError(message, 400, 'VALUE_TOO_LARGE');
}
