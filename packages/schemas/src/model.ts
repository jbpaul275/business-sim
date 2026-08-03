import { z } from 'zod';
import {
  zAssetCategory,
  zArchetype,
  zDebtKind,
  zMoney,
  zNonNegative,
  zPct,
  zPeriod,
  zPositive,
  zRate,
  zStatementLine,
  zVolumeDriver,
  type Money,
  type PeriodIndex,
} from './primitives.js';

// ---------------------------------------------------------------------------
// Shared modifiers — spec §3.0
// ---------------------------------------------------------------------------

/**
 * `baseMarketingSpendPerQuarter` lives here rather than on the two CAC
 * archetypes. Spec §3.0 declares `spendRatio` a "common index term" used by all
 * six archetypes, but the field it divides by only exists on `UnitsCacParams`
 * and `SubscriptionParams` — undefined for the other four.
 * See docs/plan/03-spec-gaps.md G-1.
 */
export const zSharedModifierParams = z.object({
  rampFloor: zPct,
  rampConstant: zPositive,
  marketingMaxLift: zNonNegative,
  halfSaturationSpend: zMoney,
  priceElasticity: zNonNegative,
  baseMarketingSpendPerQuarter: zMoney,
});
export type SharedModifierParams = z.infer<typeof zSharedModifierParams>;

export const DEFAULT_MODIFIERS: Omit<SharedModifierParams, 'halfSaturationSpend' | 'baseMarketingSpendPerQuarter'> = {
  rampFloor: 0.4,
  rampConstant: 3.0,
  marketingMaxLift: 0.35,
  priceElasticity: 1.2,
};

/** Spec §3.0: default elasticity by archetype. */
export const DEFAULT_ELASTICITY = {
  TRAFFIC: 1.2,
  UNITS_CAC: 1.5,
  SUBSCRIPTION: 0.8,
  OCCUPANCY: 1.0,
  UTILIZATION: 0.7,
  PROJECT_BACKLOG: 1.8,
} as const;

// ---------------------------------------------------------------------------
// Archetype parameters — spec §3.1–3.6
// ---------------------------------------------------------------------------

/**
 * Square feet per seat below which a floor plan is not a business decision but
 * a building-code violation. IBC Table 1004.5 puts assembly standing space at
 * 5 net sq ft per occupant and concentrated seating at 7; 7 against *gross*
 * floor area (which includes back of house, so it is far more generous than it
 * looks) sits under anything real and only catches fabrications.
 *
 * This is the line D-5 draws: the engine refuses physical impossibility and
 * nothing else. A shop may seat more people than its benchmark suggests, price
 * however it likes, and lose money doing it — but 100,000 seats in 900 square
 * feet is arithmetic, not ambition.
 */
export const MIN_SQ_FT_PER_SEAT = 7;

/** The most seats a footprint can physically hold. */
export const maxSeatsFor = (floorAreaSqFt: number): number =>
  Math.floor(floorAreaSqFt / MIN_SQ_FT_PER_SEAT);

export const zTrafficParams = z.object({
  kind: z.literal('TRAFFIC'),
  addressableTrafficPerQuarter: zNonNegative,
  captureRate: zPct,
  avgTicket: zMoney,
  referencePrice: zMoney,
  operatingDaysPerQuarter: zPositive,
  capacityModel: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('SEAT_TURNS'),
      seats: zPositive,
      turnsPerDay: zPositive,
      /**
       * The box the seats have to fit in. Required, not optional: a capacity
       * claim with no footprint behind it is unfalsifiable, and D-5 leans on
       * this being checkable — "no single-location ice cream shop does a
       * billion in revenue" is only arithmetic if something bounds the seat
       * count. See `MIN_SQ_FT_PER_SEAT`.
       */
      floorAreaSqFt: zPositive,
    }),
    z.object({
      kind: z.literal('THROUGHPUT'),
      transactionsPerHour: zPositive,
      operatingHoursPerDay: zPositive,
    }),
  ]),
  peakConcentration: zPct,
  skuCount: zPositive,
  baselineSkuCount: zPositive,
});
export type TrafficParams = z.infer<typeof zTrafficParams>;

export const zUtilizationParams = z.object({
  kind: z.literal('UTILIZATION'),
  billableHoursPerHeadPerQuarter: zPositive,
  targetUtilization: zPct,
  blendedHourlyRate: zMoney,
  referencePrice: zMoney,
  realizationRate: zPct,
  demandHoursPerQuarter: zNonNegative,
});
export type UtilizationParams = z.infer<typeof zUtilizationParams>;

export const zUnitsCacParams = z.object({
  kind: z.literal('UNITS_CAC'),
  baseCac: zMoney,
  cacInflationCoefficient: zNonNegative,
  avgOrderValue: zMoney,
  referencePrice: zMoney,
  ordersPerNewCustomerFirstQuarter: zPositive,
  repeatPurchaseRatePerQuarter: zNonNegative,
  quarterlyCustomerAttrition: zPct,
});
export type UnitsCacParams = z.infer<typeof zUnitsCacParams>;

export const zSubscriptionParams = z.object({
  kind: z.literal('SUBSCRIPTION'),
  baseCac: zMoney,
  cacInflationCoefficient: zNonNegative,
  arpuPerQuarter: zMoney,
  referencePrice: zMoney,
  quarterlyChurnRate: zPct,
  setupFee: zMoney,
  netRevenueRetention: zPositive,
  prepayMonths: zNonNegative,
});
export type SubscriptionParams = z.infer<typeof zSubscriptionParams>;

export const zOccupancyParams = z.object({
  kind: z.literal('OCCUPANCY'),
  units: zPositive,
  stabilizedOccupancy: zPct,
  ratePerUnitPerQuarter: zMoney,
  referencePrice: zMoney,
  concessionsPct: zPct,
  ancillaryRevenuePctOfBase: zNonNegative,
});
export type OccupancyParams = z.infer<typeof zOccupancyParams>;

/**
 * `bizDevSpendPerQuarter` from spec §3.6 is deliberately absent. It duplicated
 * `RevenueStream.marketingSpendPerQuarter` (§3.0.5): one drove the win rate but
 * was never booked as a cost, the other was expensed but drove nothing — an
 * uncosted growth lever on one side and a dead field on the other.
 * See docs/plan/03-spec-gaps.md G-2. The UI labels the shared field
 * "business development" for this archetype.
 */
export const zProjectParams = z.object({
  kind: z.literal('PROJECT_BACKLOG'),
  bidsSubmittedPerQuarter: zNonNegative,
  winRate: zPct,
  avgContractValue: zMoney,
  referencePrice: zMoney,
  executionCapacityPerQuarter: zMoney,
  retainagePct: zPct,
  retainageReleaseLagQuarters: z.number().int().nonnegative(),
  progressBillingLagDays: zNonNegative,
  changeOrderPctOfContract: zNonNegative,
});
export type ProjectParams = z.infer<typeof zProjectParams>;

export const zArchetypeParams = z.discriminatedUnion('kind', [
  zTrafficParams,
  zUtilizationParams,
  zUnitsCacParams,
  zSubscriptionParams,
  zOccupancyParams,
  zProjectParams,
]);
export type ArchetypeParams = z.infer<typeof zArchetypeParams>;

// ---------------------------------------------------------------------------
// Revenue streams — spec §3
// ---------------------------------------------------------------------------

export interface StreamState {
  quartersSinceLaunch: number;
  customers?: number;
  subscribers?: number;
  backlog?: Money;
  retainageSchedule?: { period: PeriodIndex; amount: Money }[];
  currentOccupancy?: number;
  cumulativeLostDemand?: number;
}

export const zRevenueStream = z.object({
  id: z.string(),
  label: z.string(),
  archetype: zArchetype,
  params: zArchetypeParams,
  modifiers: zSharedModifierParams,
  marketingSpendPerQuarter: zMoney,
  /** Calendar Q1..Q4. Must average 1.00 ± 0.01 (§11.2). */
  seasonality: z.tuple([zPositive, zPositive, zPositive, zPositive]),
  launchPeriod: zPeriod,
  /**
   * Spec §5.1 sums AR over `streamDsoDays` but never defines it; only
   * PROJECT_BACKLOG's `progressBillingLagDays` is named as an override.
   * See docs/plan/03-spec-gaps.md G-5.
   */
  dsoDaysOverride: zNonNegative.optional(),
});
export type RevenueStreamSpec = z.infer<typeof zRevenueStream>;

export interface RevenueStream extends RevenueStreamSpec {
  state: StreamState;
}

// ---------------------------------------------------------------------------
// Costs — spec §4
// ---------------------------------------------------------------------------

export const zAppliesTo = z.union([z.array(z.string()), z.literal('ALL')]);
export type AppliesTo = z.infer<typeof zAppliesTo>;

export const zVariableRevenueCost = z.object({
  id: z.string(),
  label: z.string(),
  class: z.literal('VARIABLE_REVENUE'),
  pctOfRevenue: zNonNegative,
  appliesToStreamIds: zAppliesTo,
  statementLine: zStatementLine,
  accruable: z.boolean(),
});
export type VariableRevenueCost = z.infer<typeof zVariableRevenueCost>;

export const zVariableActivityCost = z.object({
  id: z.string(),
  label: z.string(),
  class: z.literal('VARIABLE_ACTIVITY'),
  costPerUnit: zMoney,
  driver: zVolumeDriver,
  appliesToStreamIds: zAppliesTo,
  statementLine: zStatementLine,
  accruable: z.boolean(),
});
export type VariableActivityCost = z.infer<typeof zVariableActivityCost>;

/**
 * `capacityPerBlock` is discriminated by driver because it means dollars when
 * the driver is `REVENUE` and a count otherwise — spec §4.3 types it as a bare
 * `number` and then divides `Money` by it. See docs/plan/03-spec-gaps.md G-4.
 *
 * `appliesToStreamIds` is an addition: capacity is a business-level pool that
 * constrains stream-level revenue, and the spec gives no allocation rule when a
 * business has several streams. See G-3.
 */
export const zStepFixedCapacity = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('REVENUE'), capacityPerBlock: zMoney }),
  z.object({
    driver: z.enum([
      'TRANSACTIONS',
      'ORDERS',
      'BILLABLE_HOURS',
      'OCCUPIED_UNITS',
      'SUBSCRIBERS',
      'PROJECTS_ACTIVE',
    ]),
    capacityPerBlock: zPositive,
  }),
]);
export type StepFixedCapacity = z.infer<typeof zStepFixedCapacity>;

export const zStepFixedCost = z.object({
  id: z.string(),
  label: z.string(),
  class: z.literal('STEP_FIXED'),
  blockCostPerQuarter: zMoney,
  capacity: zStepFixedCapacity,
  appliesToStreamIds: zAppliesTo,
  minimumBlocks: z.number().int().nonnegative(),
  /** Productive blocks — these carry capacity. */
  currentBlocks: z.number().int().nonnegative(),
  /**
   * Blocks hired but not yet productive. They cost money now and add capacity
   * after `addLeadTimeQuarters` (§9.3.1). Splitting the count is what makes the
   * asymmetry real: cost is driven by current + pending, capacity by current
   * alone. Hiring ahead of demand is how service businesses die, and the model
   * has to reproduce that.
   */
  pendingBlocks: z.number().int().nonnegative().default(0),
  addLeadTimeQuarters: z.number().int().nonnegative(),
  removeSeverancePerBlock: zMoney,
  isLabor: z.boolean(),
  statementLine: zStatementLine,
});
export type StepFixedCost = z.infer<typeof zStepFixedCost>;

export const zFixedPeriodCost = z.object({
  id: z.string(),
  label: z.string(),
  class: z.literal('FIXED_PERIOD'),
  amountPerQuarter: zMoney,
  annualEscalatorPct: zRate,
  startPeriod: zPeriod,
  endPeriod: zPeriod.optional(),
  renewalBehavior: z.enum([
    'AUTO_RENEW_AT_MARKET',
    'AUTO_RENEW_AT_ESCALATOR',
    'EXPIRES',
  ]),
  statementLine: zStatementLine,
  accruable: z.boolean(),
  isLabor: z.boolean(),
  /** Owner comp is the §4.6 line that crisis remedy 4 defers. Marked, not special-cased. */
  isOwnerComp: z.boolean().default(false),
  /**
   * Paid ahead of the period it covers — insurance, mostly. Drives the prepaid
   * expenses balance (§5.1) and the month-zero outlay (§5.4).
   */
  isPrepaidExpense: z.boolean().default(false),
});
export type FixedPeriodCost = z.infer<typeof zFixedPeriodCost>;

export const zCostStructure = z.object({
  variableWithRevenue: z.array(zVariableRevenueCost),
  variableWithActivity: z.array(zVariableActivityCost),
  stepFixed: z.array(zStepFixedCost),
  fixedPeriod: z.array(zFixedPeriodCost),
  /**
   * Spec §4.5. Applied by the engine to every `isLabor` line, never entered by
   * the LLM or the player. Challengeable, but it cannot be set to zero.
   */
  payrollLoadPct: z.number().finite().min(0.05).max(0.45),
});
export type CostStructure = z.infer<typeof zCostStructure>;

/** Spec §4.5 components. Tested to sum to the documented totals. */
export const PAYROLL_LOAD_COMPONENTS = {
  employerFica: 0.0765,
  unemploymentInsurance: 0.015,
  workersCompDefault: 0.02,
  benefitsLoad: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Assets, debt, working capital — spec §2.5, §2.6, §5
// ---------------------------------------------------------------------------

export const zFixedAsset = z.object({
  id: z.string(),
  label: z.string(),
  category: zAssetCategory,
  grossCost: zMoney,
  acquiredPeriod: zPeriod,
  usefulLifeYears: zPositive,
  accumulatedDepreciation: zMoney,
  salvageValue: zMoney,
  replacementCycleYears: zPositive.optional(),
  maintenancePctOfGrossPerYear: zNonNegative,
  section179Elected: z.boolean(),
});
export type FixedAsset = z.infer<typeof zFixedAsset>;

export const zCovenant = z.object({
  metric: z.enum(['DSCR', 'CURRENT_RATIO', 'DEBT_TO_EBITDA']),
  operator: z.enum(['GTE', 'LTE']),
  threshold: z.number().finite(),
  testFrequencyQuarters: z.number().int().positive(),
  breachConsequence: z.enum(['RATE_STEP_UP', 'ACCELERATION', 'WARNING']),
});
export type Covenant = z.infer<typeof zCovenant>;

export const zDebt = z.object({
  id: z.string(),
  label: z.string(),
  kind: zDebtKind,
  originalPrincipal: zMoney,
  outstandingPrincipal: zMoney,
  annualRate: zRate,
  termQuarters: z.number().int().positive(),
  originatedPeriod: zPeriod,
  originationFeePct: zNonNegative,
  personalGuarantee: z.boolean(),
  revolverLimit: zMoney.optional(),
  covenants: z.array(zCovenant),
});
export type Debt = z.infer<typeof zDebt>;

export const zWorkingCapitalPolicy = z.object({
  dsoDays: zNonNegative,
  dioDays: zNonNegative,
  dpoDays: zNonNegative,
  prepaidInsuranceMonths: zNonNegative,
  securityDepositMonths: zNonNegative,
  customerDepositPct: zPct,
});
export type WorkingCapitalPolicy = z.infer<typeof zWorkingCapitalPolicy>;
