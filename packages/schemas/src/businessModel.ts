import { z } from 'zod';
import {
  zLegalForm,
  zMoney,
  zNonNegative,
  zPct,
  zPositive,
  zRange,
  zProvenance,
  type Money,
} from './primitives.js';
import {
  zCostStructure,
  zFixedAsset,
  zRevenueStream,
  zWorkingCapitalPolicy,
} from './model.js';
import { zDebtSpec } from './actions.js';
import { zAssumption } from './assumptions.js';

/**
 * The full synthesised model — spec §11.2 emits it, §9.1 Phase 4 freezes it.
 * This is the authoritative definition the spec defers to.
 *
 * Note what is NOT here: no balances, no cash, no accumulated depreciation.
 * A BusinessModel is a specification; `openingBalanceSheet()` turns it into a
 * `Business` by applying the month-zero outlays in §5.4.
 */
export const zCapexSpec = z.object({
  label: z.string(),
  category: zFixedAsset.shape.category,
  grossCost: zMoney,
  quantity: z.number().int().positive(),
  usefulLifeYears: zPositive,
  salvageValue: zMoney.optional(),
  section179Elected: z.boolean().default(false),
  replacementCycleYears: zPositive.optional(),
  sourceNote: z.string().default(''),
});
export type CapexSpec = z.infer<typeof zCapexSpec>;

export const zFinancingPlan = z.object({
  equityInjection: zMoney,
  debtRequests: z.array(zDebtSpec),
});
export type FinancingPlan = z.infer<typeof zFinancingPlan>;

/**
 * Scale knobs for model synthesis — the handful of numbers that decide how big
 * the business is, separate from the cost structure that decides what it costs.
 *
 * Lives here rather than in the engine because both the engine's template path
 * and the LLM concept path produce one, and `packages/llm` cannot import the
 * engine (spec §1.1, enforced by dependency-cruiser).
 */
export interface ScaleInput {
  /** Per-archetype scale knobs. Anything omitted falls back to the template. */
  seats?: number;
  turnsPerDay?: number;
  /** The box the seats sit in. Bounds `seats` — see `MIN_SQ_FT_PER_SEAT`. */
  floorAreaSqFt?: number;
  addressableTrafficPerQuarter?: number;
  captureRate?: number;
  skuCount?: number;
  demandHoursPerQuarter?: number;
  units?: number;
  bidsSubmittedPerQuarter?: number;
  executionCapacityPerQuarter?: Money;
  /** The archetype's price field (§3.0.1). */
  price?: Money;
}

export const zBusinessModel = z.object({
  businessName: z.string().min(1),
  legalForm: zLegalForm,
  seedTemplateId: z.string(),
  streams: z.array(zRevenueStream).min(1),
  costs: zCostStructure,
  workingCapital: zWorkingCapitalPolicy,
  capex: z.array(zCapexSpec),
  financingPlan: zFinancingPlan,
  /** Pre-opening payroll, training, marketing, permits — §5.4. */
  preOpeningCosts: z.object({
    payrollAndTraining: zMoney,
    marketing: zMoney,
    permitsAndLegal: zMoney,
  }),
  /**
   * Monthly rent, needed for the lease-signing outlay in §5.4
   * (first + last + security). Derived from the OCCUPANCY fixed-period lines
   * at synthesis; carried explicitly so month-zero does not have to guess.
   */
  monthlyRent: zMoney,
  assumptions: z.array(zAssumption),
  openNotes: z.array(z.string()).default([]),
});
export type BusinessModel = z.infer<typeof zBusinessModel>;

/**
 * The shape the LLM emits (spec §11.2). Looser than `BusinessModel`: every
 * numeric carries range/sourceNote/provenance, the omission-guard lines are
 * absent because the engine injects them, and the engine fills anything the
 * model left out from the seed template.
 */
export const zSynthesisedParam = z.object({
  value: z.number(),
  range: zRange,
  sourceNote: z.string().min(1),
  provenance: zProvenance,
});
export type SynthesisedParam = z.infer<typeof zSynthesisedParam>;

export const zModelSynthesisOutput = z.object({
  businessName: z.string().min(1),
  legalForm: zLegalForm,
  seedTemplateId: z.string(),
  streams: z
    .array(
      z.object({
        label: z.string(),
        archetype: zRevenueStream.shape.archetype,
        archetypeRationale: z.string().min(1),
        params: z.record(zSynthesisedParam),
        seasonality: z.tuple([zPositive, zPositive, zPositive, zPositive]),
        marketingSpendPerQuarter: zNonNegative,
      }),
    )
    .min(1),
  costLines: z.array(
    z.object({
      label: z.string(),
      class: zCostStructure.shape.stepFixed.element.shape.class.or(
        z.enum(['VARIABLE_REVENUE', 'VARIABLE_ACTIVITY', 'FIXED_PERIOD']),
      ),
      params: z.record(z.union([z.number(), z.string(), z.boolean()])),
      isLabor: z.boolean(),
      accruable: z.boolean(),
      statementLine: zCostStructure.shape.fixedPeriod.element.shape.statementLine,
      sourceNote: z.string().min(1),
      provenance: zProvenance,
    }),
  ),
  capex: z.array(
    z.object({
      label: z.string(),
      category: zFixedAsset.shape.category,
      grossCost: zNonNegative,
      usefulLifeYears: zPositive,
      quantity: z.number().int().positive(),
      sourceNote: z.string().min(1),
    }),
  ),
  workingCapital: z.object({
    dsoDays: zNonNegative,
    dioDays: zNonNegative,
    dpoDays: zNonNegative,
    prepaidInsuranceMonths: zNonNegative,
    securityDepositMonths: zNonNegative,
    customerDepositPct: zPct,
  }),
  financingPlan: z.object({
    equityInjection: zNonNegative,
    debtRequests: z.array(
      z.object({
        kind: zDebtSpec.shape.kind,
        requestedPrincipal: zNonNegative,
        termQuarters: z.number().int().positive(),
        personalGuarantee: z.boolean(),
      }),
    ),
  }),
  openNotes: z.array(z.string()),
});
export type ModelSynthesisOutput = z.infer<typeof zModelSynthesisOutput>;

export interface ValidationIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}
