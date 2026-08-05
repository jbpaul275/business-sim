import { z } from 'zod';
import { fromCents, fromDisplay, type Money } from '@bizsim/money';

export type { Money };

/** 0 = first operating quarter. Spec §2.1. */
export type PeriodIndex = number;

export const QUARTERS_PER_YEAR = 4;
export const DAYS_PER_QUARTER = 91.25;

/**
 * Money on the wire is a string of integer cents: `"10000000"` = $100,000.00.
 *
 * Not a JSON number. `Number.MAX_SAFE_INTEGER` is only ~$90 trillion in cents,
 * which is enough for this domain — but float round-tripping through JSON is
 * precisely the class of bug the bigint decision exists to prevent, and
 * FREEPLAY capital has no natural ceiling. A string costs nothing and closes
 * the hole. See docs/plan/01-architecture.md §6.
 */
export const zMoney = z
  .union([
    z.string().regex(/^-?\d+$/, 'Money must be a string of integer cents'),
    z.bigint(),
    z.number().int(),
  ])
  .transform((v): Money => fromCents(v));

/** For seed data and LLM output where a decimal dollar figure is natural. */
export const zMoneyFromDollars = z
  .union([z.string(), z.number()])
  .transform((v): Money => fromDisplay(v));

export const zRate = z.number().finite();
export const zPct = z.number().finite().min(0).max(1);
export const zPositive = z.number().finite().positive();
export const zNonNegative = z.number().finite().nonnegative();
export const zPeriod = z.number().int().nonnegative();

export const zRange = z.object({
  low: z.number().finite(),
  high: z.number().finite(),
});
export type Range = z.infer<typeof zRange>;

/** JSON replacer that survives bigint. Snapshots and action logs use it. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export const zLegalForm = z.enum(['SOLE_PROP', 'LLC_PASSTHROUGH', 'S_CORP', 'C_CORP']);
export type LegalForm = z.infer<typeof zLegalForm>;

export const zCostClass = z.enum([
  'VARIABLE_REVENUE',
  'VARIABLE_ACTIVITY',
  'STEP_FIXED',
  'FIXED_PERIOD',
]);
export type CostClass = z.infer<typeof zCostClass>;

export const zStatementLine = z.enum(['COGS', 'LABOR', 'OCCUPANCY', 'MARKETING', 'G&A']);
export type StatementLine = z.infer<typeof zStatementLine>;

export const zArchetype = z.enum([
  'TRAFFIC',
  'UTILIZATION',
  'UNITS_CAC',
  'SUBSCRIPTION',
  'OCCUPANCY',
  'PROJECT_BACKLOG',
]);
export type Archetype = z.infer<typeof zArchetype>;

/**
 * The unit a stream's volume is denominated in, and therefore the unit a
 * step-fixed block's capacity is denominated in.
 *
 * Spec §4.3 lists five drivers and §4.2 lists a different six; neither covers
 * all archetypes (SUBSCRIPTION and UNITS_CAC have no matching driver in either
 * list). This is the union of both plus the two missing ones, so that every
 * archetype maps to exactly one driver. See docs/plan/03-spec-gaps.md G-4.
 */
export const zVolumeDriver = z.enum([
  'TRANSACTIONS',
  'ORDERS',
  'BILLABLE_HOURS',
  'OCCUPIED_UNITS',
  'SUBSCRIBERS',
  'PROJECTS_ACTIVE',
  'REVENUE',
]);
export type VolumeDriver = z.infer<typeof zVolumeDriver>;

/** Spec §3.8: each archetype has exactly one binding volume unit. */
export const ARCHETYPE_DRIVER: Record<Archetype, VolumeDriver> = {
  TRAFFIC: 'TRANSACTIONS',
  UNITS_CAC: 'ORDERS',
  UTILIZATION: 'BILLABLE_HOURS',
  OCCUPANCY: 'OCCUPIED_UNITS',
  SUBSCRIPTION: 'SUBSCRIBERS',
  PROJECT_BACKLOG: 'REVENUE',
};

/** `REVENUE` capacity is denominated in money; everything else in counts. */
export const isMoneyDriver = (d: VolumeDriver): boolean => d === 'REVENUE';

/**
 * Years of hands-on domain experience at which the world starts treating the
 * operator as one — docs/plan/07-founder-profile.md. One threshold, shared by
 * the lender's file (stage 3) and the challenge loop (stage 4), living here
 * because llm and engine both need it and neither may import the other.
 */
export const EXPERIENCED_OPERATOR_YEARS = 5;

export const zProvenance = z.enum([
  'CATALOG',
  'BENCHMARK',
  'PLAYER_SOURCED',
  'PLAYER_ASSUMED',
  'LLM_ESTIMATE',
  'CLONED_FROM_PARENT',
]);
export type Provenance = z.infer<typeof zProvenance>;

/**
 * Spec §10.3. `PLAYER_ASSUMED` ranks BELOW `LLM_ESTIMATE` deliberately: an
 * unsupported assertion by an optimistic founder is the least reliable input in
 * the system, and the register should say so.
 */
export const PROVENANCE_RANK: Record<Provenance, number> = {
  CATALOG: 5,
  PLAYER_SOURCED: 4,
  CLONED_FROM_PARENT: 3,
  BENCHMARK: 3,
  LLM_ESTIMATE: 2,
  PLAYER_ASSUMED: 1,
};

/** Counts as "researched" for the confidence score (§10.3). */
export const isWellSourced = (p: Provenance): boolean =>
  PROVENANCE_RANK[p] >= PROVENANCE_RANK.PLAYER_SOURCED;

export const zCrisisRemedy = z.enum([
  'REVOLVER',
  'HOUSEHOLD_INJECTION',
  'FACTOR_AR',
  'DEFER_OWNER_COMP',
  'EMERGENCY_DEBT',
  'SALE_LEASEBACK',
  'INSOLVENCY',
]);
export type CrisisRemedy = z.infer<typeof zCrisisRemedy>;

/** Spec §9.4 default policy, least damage first. */
export const DEFAULT_CRISIS_POLICY: CrisisRemedy[] = [
  'REVOLVER',
  'HOUSEHOLD_INJECTION',
  'FACTOR_AR',
  'DEFER_OWNER_COMP',
  'EMERGENCY_DEBT',
  'SALE_LEASEBACK',
  'INSOLVENCY',
];

export const zAssetCategory = z.enum([
  'EQUIPMENT',
  'LEASEHOLD_IMPROVEMENTS',
  'VEHICLES',
  'REAL_PROPERTY',
  'FF&E',
]);
export type AssetCategory = z.infer<typeof zAssetCategory>;

/** Spec §2.5 default useful lives, in years. */
export const DEFAULT_USEFUL_LIFE_YEARS: Record<AssetCategory, number> = {
  EQUIPMENT: 7,
  LEASEHOLD_IMPROVEMENTS: 15,
  VEHICLES: 5,
  REAL_PROPERTY: 39,
  'FF&E': 7,
};

/** Spec §4.6 maintenance reserve, annual % of gross cost. */
export const DEFAULT_MAINTENANCE_PCT: Record<AssetCategory, number> = {
  EQUIPMENT: 0.04,
  LEASEHOLD_IMPROVEMENTS: 0.015,
  VEHICLES: 0.06,
  REAL_PROPERTY: 0.02,
  'FF&E': 0.03,
};

export const zDebtKind = z.enum([
  'AMORTIZING',
  'INTEREST_ONLY',
  'REVOLVER',
  'SBA_7A',
  'EQUIPMENT_FINANCE',
]);
export type DebtKind = z.infer<typeof zDebtKind>;

export const zBusinessStatus = z.enum([
  'PRE_LAUNCH',
  'OPERATING',
  'DELEGATED',
  'CLOSED',
  'SOLD',
]);
export type BusinessStatus = z.infer<typeof zBusinessStatus>;
