import { z } from 'zod';
import {
  zArchetype,
  zCostClass,
  zMoneyFromDollars,
  zNonNegative,
  zPositive,
  zStatementLine,
  zVolumeDriver,
} from './primitives.js';
import { zWorkingCapitalPolicy } from './model.js';

/**
 * A named bundle of default parameter values plus benchmark bands. Stored as
 * data, not code, so seeds can be revised without a deploy (spec §4.7).
 *
 * The bands do double duty: they seed the model AND they power the cost-side
 * pushback loop (§11.3.1). An out-of-band value is what turns the register from
 * a passive log into an active reviewer.
 */
export const zBenchmarkBand = z.object({
  low: z.number(),
  high: z.number(),
  source: z.string().min(1),
});

export const zCostDefault = z.object({
  lineId: z.string(),
  label: z.string(),
  class: zCostClass,
  statementLine: zStatementLine,
  /** Rates are plain numbers; amounts are dollars and become Money. */
  value: z.union([z.number(), z.string()]),
  isMoney: z.boolean().default(false),
  isLabor: z.boolean().default(false),
  accruable: z.boolean().default(false),
  /** STEP_FIXED and VARIABLE_ACTIVITY: the volume driver this line scales with. */
  driver: zVolumeDriver.optional(),
  /** STEP_FIXED: volume one block supports, in driver units. */
  capacityPerBlock: z.number().positive().optional(),
  /** STEP_FIXED: you need at least one manager regardless of volume. */
  minimumBlocks: z.number().int().nonnegative().default(0),
  /** FIXED_PERIOD: contractual escalator, not an estimate. */
  annualEscalatorPct: z.number().default(0.02),
  isPrepaidExpense: z.boolean().default(false),
  benchmarkBand: zBenchmarkBand.optional(),
  sourceNote: z.string().min(1),
});
export type CostDefault = z.infer<typeof zCostDefault>;

export const zSeedTemplate = z.object({
  id: z.string(),
  label: z.string(),
  naicsCode: z.string().optional(),
  defaultArchetypes: z.array(zArchetype).min(1),
  costDefaults: z.array(zCostDefault),
  streamParamDefaults: z.record(z.union([z.number(), z.string()])),
  modifierDefaults: z.object({
    rampFloor: z.number(),
    rampConstant: z.number(),
    marketingMaxLift: z.number(),
    halfSaturationSpend: zMoneyFromDollars,
    priceElasticity: z.number(),
    baseMarketingSpendPerQuarter: zMoneyFromDollars,
  }),
  workingCapitalDefaults: zWorkingCapitalPolicy,
  payrollLoadPct: z.number(),
  workersCompPct: z.number(),
  offersBenefits: z.boolean(),
  /**
   * What one unit of volume is called in this trade — covers, loads, rounds.
   *
   * A seed template is a business, and a business has a word for what it sells.
   * Without one every screen borrowed the first template's: a ready-mix plant's
   * post-mortem told its owner he needed "12 covers/day" of concrete.
   */
  volumeNoun: z.string().default('transactions'),
  seasonality: z.tuple([zPositive, zPositive, zPositive, zPositive]),
  /**
   * The monthly refinement of `seasonality`, required by the year-one export
   * interpolation (§12.2). Each quarter's three weights must average to that
   * quarter's seasonality value — validated, not assumed.
   */
  monthlySeasonalWeight: z.array(zPositive).length(12),
  typicalCapex: z.array(
    z.object({
      label: z.string(),
      category: z.enum([
        'EQUIPMENT',
        'LEASEHOLD_IMPROVEMENTS',
        'VEHICLES',
        'REAL_PROPERTY',
        'FF&E',
      ]),
      cost: zMoneyFromDollars,
      usefulLifeYears: zPositive,
      quantity: z.number().int().positive().default(1),
    }),
  ),
  /** Bands the §13.3 plausibility tests assert against. */
  plausibility: z.object({
    cogsPctOfRevenue: zBenchmarkBand.optional(),
    laborPctOfRevenue: zBenchmarkBand.optional(),
    occupancyPctOfRevenue: zBenchmarkBand.optional(),
    ebitdaMarginPct: zBenchmarkBand.optional(),
  }),
  monthlyRent: zMoneyFromDollars,
  preOpening: z.object({
    payrollAndTraining: zMoneyFromDollars,
    marketing: zMoneyFromDollars,
    permitsAndLegal: zMoneyFromDollars,
  }),
  generalLiabilityInsurancePerYear: zMoneyFromDollars,
  propertyInsurancePerYear: zMoneyFromDollars,
  accountingAndLegalPerYear: zMoneyFromDollars,
  softwareAndPosPerYear: zMoneyFromDollars,
  permitsAndLicensesPerYear: zMoneyFromDollars,
  utilitiesPerQuarter: zMoneyFromDollars,
  ownerCompPerYear: zMoneyFromDollars,
  badDebtPctOfRevenue: zNonNegative,
  repairsPctOfRevenue: zNonNegative,
  cardProcessingRate: zNonNegative,
  cardMixPct: zNonNegative,
});
export type SeedTemplate = z.infer<typeof zSeedTemplate>;
export type SeedTemplateInput = z.input<typeof zSeedTemplate>;

/**
 * The cost catalog — spec §11.3 rule 1's prerequisite, and D-2's build task.
 *
 * Rule 1 says a bare assertion moves a value "at most to the nearer boundary of
 * the existing range". Without a sourced range that rule arbitrates between two
 * guesses while presenting the result as authoritative — which is the exact
 * behaviour the contract exists to prevent, one level up.
 *
 * Tiers are the mechanism behind rule 3's discriminating question. "$10k or
 * $60k" is an argument; "countertop 3-quart or floor 20-quart" is a question
 * with an answer, and the answer settles the number.
 */
export const zCatalogItem = z.object({
  id: z.string(),
  label: z.string(),
  /** Seed templates this is relevant to. Empty means it applies to anything. */
  templates: z.array(z.string()),
  unit: z.enum(['USD', 'pct']),
  low: z.number(),
  high: z.number(),
  tiers: z.array(z.object({ tier: z.string(), low: z.number(), high: z.number() })),
  /** Where the range came from, in a sentence a player can go and check. */
  source: z.string(),
  /** What a player or a draft might call this line. */
  keywords: z.array(z.string()),
});
export type CatalogItem = z.infer<typeof zCatalogItem>;
