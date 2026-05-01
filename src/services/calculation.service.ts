import { getDb } from '../config/database.js';
import { estimateLineItems } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

export interface LandedCostInputs {
  factoryCostPerUnit: number;
  packingCostPerUnit: number;
  otherPerUnit: number;
  freightPerUnit: number;
  dutyPct: number;
  tariffPct: number;
  tariffMuPct: number;
  otherCostPct: number;
  paddingPct: number;
  quantity: number;
  sellPricePerUnit: number;
  unitsPerCarton?: number;
  dimLCm?: number;
  dimWCm?: number;
  dimHCm?: number;
  weightKgPerCarton?: number;
  exchangeRate?: number; // vendor currency to USD
}

export interface LandedCostResult {
  usdFactoryCost: number;
  baseCostPerUnit: number;
  landedCostPerUnit: number;
  extendedLandedCost: number;
  salesAmount: number;
  skuMarginPct: number;
  cbmPerCarton: number;
  totalCartons: number;
  totalCbm: number;
  chargeableWeightKg: number;
}

export function calculateLandedCost(inputs: LandedCostInputs): LandedCostResult {
  const {
    factoryCostPerUnit = 0,
    packingCostPerUnit = 0,
    otherPerUnit = 0,
    freightPerUnit = 0,
    dutyPct = 0,
    tariffPct = 0,
    tariffMuPct = 0,
    otherCostPct = 0,
    paddingPct = 0,
    quantity = 0,
    sellPricePerUnit = 0,
    unitsPerCarton = 0,
    dimLCm = 0,
    dimWCm = 0,
    dimHCm = 0,
    weightKgPerCarton = 0,
    exchangeRate = 1,
  } = inputs;

  // 1. USD factory cost (convert from vendor currency)
  const usdFactoryCost = round4(factoryCostPerUnit * exchangeRate);

  // 2. Base cost before percentages
  const baseCostPerUnit = round4(usdFactoryCost + packingCostPerUnit + otherPerUnit);

  // 3. Apply duty + tariff + tariff markup + freight + other%
  const dutyAmount    = round4(baseCostPerUnit * (dutyPct / 100));
  const tariffAmount  = round4(baseCostPerUnit * (tariffPct / 100));
  const tariffMuAmt   = round4(tariffAmount * (tariffMuPct / 100));
  const otherCostAmt  = round4(baseCostPerUnit * (otherCostPct / 100));

  const prePadding = round4(
    baseCostPerUnit + dutyAmount + tariffAmount + tariffMuAmt + otherCostAmt + freightPerUnit,
  );

  // 4. Padding
  const paddingAmount     = round4(prePadding * (paddingPct / 100));
  const landedCostPerUnit = round4(prePadding + paddingAmount);
  const extendedLandedCost = round2(landedCostPerUnit * quantity);

  // 5. Sales + margin
  const salesAmount = round2(sellPricePerUnit * quantity);
  const skuMarginPct = sellPricePerUnit > 0
    ? round3(((sellPricePerUnit - landedCostPerUnit) / sellPricePerUnit) * 100)
    : 0;

  // 6. Packing calculations
  const cbmPerCarton = unitsPerCarton > 0
    ? round5((dimLCm * dimWCm * dimHCm) / 1_000_000)
    : 0;
  const totalCartons = unitsPerCarton > 0 ? Math.ceil(quantity / unitsPerCarton) : 0;
  const totalCbm = round3(cbmPerCarton * totalCartons);

  // 7. Chargeable weight (greater of actual vs volumetric)
  const actualWeightKg = round3(totalCartons * weightKgPerCarton);
  const volumetricWeightKg = round3((totalCbm * 1_000_000) / 5000); // 5000 cm³/kg standard
  const chargeableWeightKg = Math.max(actualWeightKg, volumetricWeightKg);

  return {
    usdFactoryCost,
    baseCostPerUnit,
    landedCostPerUnit,
    extendedLandedCost,
    salesAmount,
    skuMarginPct,
    cbmPerCarton,
    totalCartons,
    totalCbm,
    chargeableWeightKg,
  };
}

// ─── Persist calculation results ─────────────────────────────────

export async function recalculateAndSave(lineItemId: number): Promise<LandedCostResult | null> {
  const db = getDb();

  const [item] = await db
    .select()
    .from(estimateLineItems)
    .where(eq(estimateLineItems.id, lineItemId))
    .limit(1);

  if (!item) {
    logger.warn({ lineItemId }, 'Line item not found for recalculation');
    return null;
  }

  const result = calculateLandedCost({
    factoryCostPerUnit: parseFloat(item.factoryCostPerUnit ?? '0'),
    packingCostPerUnit: parseFloat(item.packingCostPerUnit ?? '0'),
    otherPerUnit: parseFloat(item.otherPerUnit ?? '0'),
    freightPerUnit: parseFloat(item.freightPerUnit ?? '0'),
    dutyPct: parseFloat(item.dutyPct ?? '0'),
    tariffPct: parseFloat(item.tariffPct ?? '10'),
    tariffMuPct: parseFloat(item.tariffMuPct ?? '0'),
    otherCostPct: parseFloat(item.otherCostPct ?? '0'),
    paddingPct: parseFloat(item.paddingPct ?? '0'),
    quantity: parseFloat(item.quantity ?? '0'),
    sellPricePerUnit: parseFloat(item.sellPricePerUnit ?? '0'),
    unitsPerCarton: item.unitsPerCarton ?? 0,
    dimLCm: parseFloat(item.dimLCm ?? '0'),
    dimWCm: parseFloat(item.dimWCm ?? '0'),
    dimHCm: parseFloat(item.dimHCm ?? '0'),
    weightKgPerCarton: parseFloat(item.weightKgPerCarton ?? '0'),
    exchangeRate: 1, // TODO: fetch from currency service
  });

  await db
    .update(estimateLineItems)
    .set({
      usdFactoryCost: String(result.usdFactoryCost),
      landedCostPerUnit: String(result.landedCostPerUnit),
      extendedLandedCost: String(result.extendedLandedCost),
      salesAmount: String(result.salesAmount),
      skuMarginPct: String(result.skuMarginPct),
      cbmPerCarton: String(result.cbmPerCarton),
      totalCartons: result.totalCartons,
      totalCbm: String(result.totalCbm),
      chargeableWeightKg: String(result.chargeableWeightKg),
      syncStatus: 'dirty',
      updatedAt: new Date(),
    })
    .where(eq(estimateLineItems.id, lineItemId));

  return result;
}

// ─── Rounding helpers ─────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round5 = (n: number) => Math.round(n * 100000) / 100000;
