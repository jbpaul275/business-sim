import type {
  BusinessStatus,
  CrisisRemedy,
  LegalForm,
  Money,
  PeriodIndex,
} from './primitives.js';
import type {
  CostStructure,
  Debt,
  FixedAsset,
  RevenueStream,
  WorkingCapitalPolicy,
} from './model.js';
import type { AssumptionRegister } from './assumptions.js';
import type { Action } from './actions.js';
import type { EngineEvent } from './events.js';

/**
 * Runtime state is plain TypeScript, not zod. The validated surfaces — the
 * BusinessModel an LLM emits, player Actions, seed templates — are zod, because
 * those cross a trust boundary. WorldState never does: it is produced by the
 * engine and consumed by the engine, and a zod parse of a deeply nested state
 * object on every tick would blow the 1ms budget for no safety gained.
 * See docs/plan/01-architecture.md §6.
 */

export interface WorldConfig {
  startCapital: Money;
  startMode: 'LOW' | 'MID' | 'HIGH' | 'FREEPLAY';
  milestonePeriod: number;
  personalTaxRate: number;
  corporateTaxRate: number;
  stateCorporateTaxRate: number;
  qualifiedDividendRate: number;
  primeRate: number;
  annualInflationPct: number;
  crisisPolicy: CrisisRemedy[];
  currency: 'USD';
}

export interface BusinessBalances {
  accountsReceivable: Money;
  inventory: Money;
  prepaidExpenses: Money;
  accountsPayable: Money;
  accruedLiabilities: Money;
  deferredRevenue: Money;
  deferredOwnerComp: Money;
  deferredTaxLiability: Money;
  retainageReceivable: Money;
  contributedCapital: Money;
  retainedEarnings: Money;
}

export const emptyBalances = (): BusinessBalances => ({
  accountsReceivable: 0n,
  inventory: 0n,
  prepaidExpenses: 0n,
  accountsPayable: 0n,
  accruedLiabilities: 0n,
  deferredRevenue: 0n,
  deferredOwnerComp: 0n,
  deferredTaxLiability: 0n,
  retainageReceivable: 0n,
  contributedCapital: 0n,
  retainedEarnings: 0n,
});

/**
 * Year-to-date accumulators exist because the engine ticks quarterly while
 * every threshold in the tax code is annual: the SE tax wage base, the §179
 * cap, the 80% NOL limitation. Applying an annual band per quarter overstates
 * the 15.3% SE bracket by up to 4×. Each quarter provides
 * (tax on YTD income) − (tax already provided YTD), which is also how real
 * estimated payments work. See docs/plan/03-spec-gaps.md G-6.
 */
export interface TaxState {
  nolCarryforward: Money;
  section179UsedThisYear: Money;
  ytdTaxableIncome: Money;
  ytdTaxProvided: Money;
  ytdSelfEmploymentEarnings: Money;
  ytdSelfEmploymentTaxProvided: Money;
}

export const emptyTaxState = (): TaxState => ({
  nolCarryforward: 0n,
  section179UsedThisYear: 0n,
  ytdTaxableIncome: 0n,
  ytdTaxProvided: 0n,
  ytdSelfEmploymentEarnings: 0n,
  ytdSelfEmploymentTaxProvided: 0n,
});

export interface DelegationState {
  managerCompPerQuarter: Money;
  managerQuality: 'BUDGET' | 'STANDARD' | 'STRONG';
  delegatedAtPeriod: PeriodIndex;
  cumulativeDriftPct: number;
  /** Set by RECLAIM; drift decays to zero over four quarters (§9.6). */
  reclaimedAtPeriod?: PeriodIndex;
}

export interface Business {
  id: string;
  name: string;
  legalForm: LegalForm;
  ownershipPct: number;
  foundedPeriod: PeriodIndex;
  status: BusinessStatus;
  clonedFrom?: string;
  seedTemplateId?: string;

  streams: RevenueStream[];
  costs: CostStructure;
  workingCapital: WorkingCapitalPolicy;
  assets: FixedAsset[];
  debts: Debt[];

  cash: Money;
  balances: BusinessBalances;
  taxState: TaxState;
  /** Drives the lease-signing outlay (§5.4) and the security deposit balance. */
  monthlyRent: Money;

  assumptions: AssumptionRegister;
  delegation?: DelegationState;

  /** Trailing four quarters of EBITDA and debt service, for §6.3 underwriting. */
  trailingEbitda: Money[];
  trailingDebtService: Money[];

  /**
   * Peak cash need (§5.4) is a running extremum, not a per-period figure:
   * the largest cumulative funding gap before financing. Tracked here because
   * the engine has no memory beyond WorldState, and it is the single most
   * useful number a prospective founder can be handed.
   */
  cumulativeUnfinancedCash: Money;
  peakCashNeed: Money;
  peakCashNeedPeriod: PeriodIndex;
}

export interface PersonalDebt extends Debt {
  attachedFromBusinessId?: string;
}

export interface Household {
  cash: Money;
  personalDebts: PersonalDebt[];
  stakes: { businessId: string; ownershipPct: number; costBasis: Money }[];
  cumulativeDraws: Money;
  cumulativeInjections: Money;
  cumulativePersonalTax: Money;
  creditQuality: 'GOOD' | 'IMPAIRED';
  /**
   * Spec §2.3: mandatory and non-zero. Drawn from household cash every period.
   * Floored at 60% of the starting value under duress (§9.4).
   */
  annualLivingExpenses: Money;
  startingAnnualLivingExpenses: Money;
  /** Set by §6.5 guarantee attachment; blocks SBA_7A for eight quarters. */
  creditImpairedUntilPeriod?: PeriodIndex;
}

export interface ScheduledAction {
  action: Action;
  submittedPeriod: PeriodIndex;
  effectivePeriod: PeriodIndex;
  costAppliedPeriod: PeriodIndex;
  costApplied: boolean;
}

export interface WorldState {
  id: string;
  playerId: string;
  createdAtPeriod: 0;
  currentPeriod: PeriodIndex;
  config: WorldConfig;
  household: Household;
  businesses: Business[];
  pendingActions: ScheduledAction[];
  eventLog: EngineEvent[];
  /** Monotonic counter for engine-minted ids. Keeps the tick free of randomness. */
  idCounter: number;
  status: 'ACTIVE' | 'PERSONAL_INSOLVENCY';
}

/** Spec §16 Q4 / docs/plan/03-spec-gaps.md G-11. */
export const FREEPLAY_CAPITAL_CAP: Money = 100_000_000_000n; // $1B

/**
 * The three preset tiers, and what they are for.
 *
 * These were $100,000 and $1,000,000. The low tier could not fund anything a
 * player actually described: a cafe, a pawn shop and a campground all cleared
 * it before the doors opened, so the only outcome available at that tier was a
 * refusal at the gate. A starting amount that cannot start anything is not a
 * difficulty setting.
 *
 * The spread is now roughly an order of magnitude apart, which is what makes
 * them different *games* rather than different amounts: $500k is one location
 * financed carefully, $5M is a real build or a small portfolio, $50M is a
 * project that needs a capital stack rather than a chequebook.
 */
export const START_CAPITAL: Record<'LOW' | 'MID' | 'HIGH', Money> = {
  LOW: 50_000_000n, // $500,000
  MID: 500_000_000n, // $5,000,000
  HIGH: 5_000_000_000n, // $50,000,000
};
