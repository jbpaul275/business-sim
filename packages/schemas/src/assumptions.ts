import { z } from 'zod';
import {
  PROVENANCE_RANK,
  isWellSourced,
  zMoney,
  zPeriod,
  zProvenance,
  zRange,
  type Money,
  type PeriodIndex,
  type Provenance,
} from './primitives.js';

export const zAssumptionCategory = z.enum([
  'REVENUE',
  'COST',
  'CAPEX',
  'WORKING_CAPITAL',
  'FINANCING',
  'TAX',
]);
export type AssumptionCategory = z.infer<typeof zAssumptionCategory>;

export const zChallengeRuling = z.enum([
  'CONCEDE',
  'PARTIAL',
  'DEFEND',
  'NEED_CLARIFICATION',
]);
export type ChallengeRuling = z.infer<typeof zChallengeRuling>;

export const zChallengeRecord = z.object({
  period: zPeriod,
  priorValue: z.union([z.number(), zMoney]),
  assertedValue: z.union([z.number(), zMoney]),
  statedBasis: z.string().nullable(),
  ruling: zChallengeRuling,
  resultingValue: z.union([z.number(), zMoney]),
  reasoning: z.string(),
});
export type ChallengeRecord = z.infer<typeof zChallengeRecord>;

export const zAssumption = z.object({
  id: z.string(),
  businessId: z.string(),
  /** JSON pointer into the model: `streams[0].params.avgTicket`. */
  path: z.string(),
  label: z.string(),
  category: zAssumptionCategory,

  value: z.union([z.number(), zMoney]),
  unit: z.enum(['USD', 'pct', 'count', 'days', 'hours', 'years', 'ratio']),
  isMoney: z.boolean(),

  range: zRange,
  provenance: zProvenance,
  sourceNote: z.string(),
  citation: z.string().optional(),

  benchmarkBand: z.object({ low: z.number(), high: z.number(), source: z.string() }).optional(),
  outsideBenchmark: z.boolean(),

  challengeHistory: z.array(zChallengeRecord),
  lockedAtPeriod: zPeriod.optional(),
  sensitivityRank: z.number().int().optional(),
});
export type Assumption = z.infer<typeof zAssumption>;

export interface AssumptionRegister {
  byId: Record<string, Assumption>;
  /** Model path → assumption id. The reverse index the trace reads. */
  byPath: Record<string, string>;
  confidenceScore: number;
}

export const emptyRegister = (): AssumptionRegister => ({
  byId: {},
  byPath: {},
  confidenceScore: 0,
});

/** Numeric value of an assumption, whatever its representation. */
export const assumptionNumber = (a: Assumption): number =>
  typeof a.value === 'bigint' ? Number(a.value) / 100 : a.value;

export const assumptionMoney = (a: Assumption): Money =>
  typeof a.value === 'bigint' ? a.value : BigInt(Math.round(a.value * 100));

/**
 * Spec §10.5. Deterministic numeric comparison, engine logic — never LLM
 * judgement. Bands are expressed in the assumption's own units.
 */
export function isOutsideBenchmark(a: Assumption): boolean {
  if (!a.benchmarkBand) return false;
  const v = a.isMoney ? Number(a.value) / 100 : Number(a.value);
  return v < a.benchmarkBand.low || v > a.benchmarkBand.high;
}

/**
 * Spec §10.3: the revenue-weighted share of assumptions at PLAYER_SOURCED or
 * better. Weighting is by sensitivity rank where one has been computed (§12.3)
 * and uniform otherwise — an unranked register should not claim precision it
 * has not earned.
 */
export function computeConfidenceScore(register: AssumptionRegister): number {
  const all = Object.values(register.byId);
  if (all.length === 0) return 0;

  const ranked = all.filter((a) => a.sensitivityRank !== undefined);
  if (ranked.length === 0) {
    return all.filter((a) => isWellSourced(a.provenance)).length / all.length;
  }

  // Weight inversely by rank: rank 1 is the most impactful assumption.
  let weighted = 0;
  let total = 0;
  for (const a of all) {
    const weight = a.sensitivityRank !== undefined ? 1 / a.sensitivityRank : 1 / all.length;
    total += weight;
    if (isWellSourced(a.provenance)) weighted += weight;
  }
  return total === 0 ? 0 : weighted / total;
}

export const provenanceRank = (p: Provenance): number => PROVENANCE_RANK[p];

export interface AssumptionSeed {
  path: string;
  label: string;
  category: AssumptionCategory;
  value: number | Money;
  unit: Assumption['unit'];
  isMoney: boolean;
  range: { low: number; high: number };
  provenance: Provenance;
  sourceNote: string;
  citation?: string;
  benchmarkBand?: { low: number; high: number; source: string };
  lockedAtPeriod?: PeriodIndex;
}
