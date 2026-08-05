import { fromDisplay, mulRate, type Money } from '@bizsim/money';
import {
  DEBT_PRODUCTS,
  EXPERIENCE_ADVANCE_FACTOR,
  isExperiencedOperator,
  LEVERAGE_PRICING,
  MIN_OWNER_INJECTION_PCT,
  buildModelFromTemplate,
  collateralValue,
  computeMonthZeroOutlays,
  type MonthZeroOutlays,
  createWorld,
  openingLoanRate,
  underwrite,
  validateBusinessModel,
} from '@bizsim/engine';
import type {
  Archetype,
  BusinessModel,
  Provenance,
  ScaleInput,
  SeedTemplate,
  WorldConfig,
  WorldState,
} from '@bizsim/schemas';

/**
 * Phase 4's arithmetic, pure — shared by every frontend.
 *
 * This lived inline in the CLI's financing loop, which meant the web setup
 * would have had to reimplement it, and the first divergence produces the
 * exact fault this flow spent PR #5 stamping out: a screen recommending a plan
 * the lender refuses one screen later. The numbers here ARE the contract —
 * proposal, quote, ceiling, gate — so they live once, with the prompts and
 * panes elsewhere.
 */

export interface FundingContext {
  businessName: string;
  template: SeedTemplate;
  archetype: Archetype;
  scale: ScaleInput;
  marketing: Money;
  config: WorldConfig;
  provenanceFor?: ((path: string) => Provenance | undefined) | undefined;
  sourceNoteFor?: ((path: string) => string | undefined) | undefined;
  /** The operator's stated years in this trade — the lender's file (07). */
  domainYears?: number | undefined;
}

export interface FundingProposal {
  /** Month zero plus one quarter of fixed costs — what opening actually takes. */
  needed: Money;
  monthZero: Money;
  /**
   * The itemized opening budget — what `needed` is made OF. A single
   * aggregate cannot be argued with: a recruiter who opened a real firm for
   * $5k needs to see the $90k "buildout" line to say the model invented an
   * office, and the engine had the breakdown all along.
   */
  outlays: MonthZeroOutlays;
  /** The runway component of `needed`, alongside the outlays. */
  quarterOfFixed: Money;
  /** Lending value of the build's assets. */
  lendable: Money;
  /** What a lender will write in total: min(collateral, 10× the injection). */
  ceiling: Money;
  investable: Money;
  proposedEquity: Money;
  proposedLoan: Money;
  proposedRevolver: Money;
  /** What even the capped plan cannot cover. Zero when the plan funds opening. */
  shortBy: Money;
  /** The smallest equity a lender will cover the rest of. */
  equityFloor: Money;
}

const REVOLVER_TARGET = fromDisplay(100_000);

const min = (a: Money, b: Money): Money => (a < b ? a : b);
const max0 = (m: Money): Money => (m > 0n ? m : 0n);

/** The bare probe both the outlay figure and the collateral come from. */
function probe(ctx: FundingContext): { model: BusinessModel; world: WorldState } {
  const model = buildModelFromTemplate({
    businessName: ctx.businessName,
    template: ctx.template,
    archetype: ctx.archetype,
    scale: ctx.scale,
    marketingSpendPerQuarter: ctx.marketing,
    equityInjection: 0n,
    ...(ctx.provenanceFor ? { provenanceFor: ctx.provenanceFor } : {}),
    ...(ctx.sourceNoteFor ? { sourceNoteFor: ctx.sourceNoteFor } : {}),
  });
  const world = createWorld({
    id: 'probe',
    playerId: 'probe',
    config: ctx.config,
    annualLivingExpenses: 0n,
    models: [model],
  });
  return { model, world };
}

/**
 * The worked plan the funding screen opens with: a round number with room in
 * it, only as much loan as a lender will actually write, and an honest
 * `shortBy` when even that cannot cover opening.
 */
export function proposeFunding(ctx: FundingContext): FundingProposal {
  const { model, world } = probe(ctx);
  const investable = ctx.config.startCapital;

  const outlays = computeMonthZeroOutlays(model);
  const monthZero = outlays.total;
  const quarterOfFixed = model.costs.fixedPeriod.reduce<Money>((a, c) => a + c.amountPerQuarter, 0n);
  const needed = monthZero + quarterOfFixed;

  // Round up to the nearest $1M when they have $1M+, else the nearest $100k —
  // the excess is opening cash, the cheapest runway there is.
  const unit = investable >= fromDisplay(1_000_000) ? fromDisplay(1_000_000) : fromDisplay(100_000);
  const roundedNeed = ((needed + unit - 1n) / unit) * unit;
  const proposedEquity = min(roundedNeed, investable);
  const gap = max0(needed - proposedEquity);
  // Grossed up for the fee: a loan does not deliver its own principal.
  const originationPct = DEBT_PRODUCTS.SBA_7A.originationFeePct;
  const wanted = gap > 0n ? mulRate(gap, 1 / (1 - originationPct)) : 0n;

  // The advance-rate credit, applied at the SAME factor the underwriter
  // applies — the screen must never propose what the lender then refuses.
  const rawCollateral = collateralValue(world.businesses[0]!);
  const lendable = isExperiencedOperator(ctx.domainYears ?? 0)
    ? mulRate(rawCollateral, EXPERIENCE_ADVANCE_FACTOR)
    : rawCollateral;
  const onEquity = mulRate(proposedEquity, 1 / MIN_OWNER_INJECTION_PCT);
  const ceiling = min(lendable, onEquity);
  const proposedLoan = min(wanted, ceiling);
  const headroom = max0(ceiling - proposedLoan);
  const proposedRevolver = min(headroom, REVOLVER_TARGET);

  const shortBy = max0(needed - (proposedEquity + proposedLoan));

  // The smallest equity a lender will cover the rest of: the gap loan must
  // clear both ceilings — collateral, and ten times the injection.
  const byCollateral = needed - mulRate(lendable, 1 - originationPct);
  const byInjection = mulRate(needed, 1 / (1 + (1 - originationPct) / MIN_OWNER_INJECTION_PCT));
  const equityFloor = max0(byCollateral > byInjection ? byCollateral : byInjection);

  return {
    needed,
    monthZero,
    outlays,
    quarterOfFixed,
    lendable,
    ceiling,
    investable,
    proposedEquity,
    proposedLoan,
    proposedRevolver,
    shortBy,
    equityFloor,
  };
}

/**
 * The three depths a player can open at, named. Choosing depth means
 * comparing depths — one proposal plus a naked equity box is not a choice.
 * Each is just an equity figure; the loan, revolver and pricing all derive
 * from it through the same arithmetic `fund` applies, so a card can never
 * promise a plan the lender then refuses on different numbers.
 */
export interface NamedPlan {
  key: 'lean' | 'proposed' | 'cushioned';
  label: string;
  /** What this depth is FOR, in one clause. */
  tagline: string;
  equity: Money;
  plan: CandidatePlan;
}

export function candidatePlans(p: FundingProposal): NamedPlan[] {
  const planFor = (equity: Money): CandidatePlan => {
    const originationPct = DEBT_PRODUCTS.SBA_7A.originationFeePct;
    const gap = max0(p.needed - equity);
    const wanted = gap > 0n ? mulRate(gap, 1 / (1 - originationPct)) : 0n;
    const ceiling = min(p.lendable, mulRate(equity, 1 / MIN_OWNER_INJECTION_PCT));
    const loan = min(wanted, ceiling);
    return { equity, outside: 0n, loan, revolver: revolverFor(p.lendable, equity, loan) };
  };

  // Cushioned adds one rounding unit of pure runway on top of the proposal —
  // the cheapest air there is — capped at what the player actually has.
  const unit = p.investable >= fromDisplay(1_000_000) ? fromDisplay(1_000_000) : fromDisplay(100_000);
  const cushionedEquity = min(p.investable, p.proposedEquity + unit);

  const named: NamedPlan[] = [
    {
      key: 'lean',
      label: 'Lean',
      tagline: 'least cash in, most leverage — keeps your powder dry and the service heavy',
      equity: p.equityFloor,
      plan: planFor(p.equityFloor),
    },
    {
      key: 'proposed',
      label: 'Proposed',
      tagline: 'the worked plan: a round number with room in it',
      equity: p.proposedEquity,
      plan: { equity: p.proposedEquity, outside: 0n, loan: p.proposedLoan, revolver: p.proposedRevolver },
    },
    {
      key: 'cushioned',
      label: 'Cushioned',
      tagline: 'more of your own cash as opening runway',
      equity: cushionedEquity,
      plan: planFor(cushionedEquity),
    },
  ];

  // A depth that collapses into its neighbour is not a choice; a lean plan
  // needing zero equity is an artifact of tiny builds. Distinct equity only.
  const seen = new Set<string>();
  return named.filter((n) => {
    if (n.equity <= 0n && n.key === 'lean') return false;
    const k = n.equity.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface LoanQuote {
  loan: Money;
  rate: number;
  /** Debt as a share of the deal. */
  share: number;
  /** The next-cheaper pricing tier, when one is within reach. */
  cheaper?: { equity: Money; maxDebtShare: number; rate: number };
}

/**
 * Smallest equity that keeps debt at or under share `s` of a `needed`-sized
 * deal: loan/(loan + e) ≤ s solves to e ≥ needed·(1 − s) / (s·(1 − f) + 1 − s).
 * This is the number behind "putting in $X more prices the loan lower" — a
 * hint is only useful if the figure it names actually lands in the tier.
 */
export const equityForShare = (needed: Money, share: number, feePct: number): Money =>
  mulRate(needed, (1 - share) / (share * (1 - feePct) + 1 - share));

/**
 * What a given equity figure buys: the gap loan, priced by leverage. `loan` is
 * zero when the figure fully funds opening.
 */
export function quoteForEquity(
  needed: Money,
  primeRate: number,
  equity: Money,
  operatorYears = 0,
): LoanQuote {
  const originationPct = DEBT_PRODUCTS.SBA_7A.originationFeePct;
  const shortOfNeed = max0(needed - equity);
  const loan = shortOfNeed > 0n ? mulRate(shortOfNeed, 1 / (1 - originationPct)) : 0n;
  if (loan === 0n) return { loan, rate: 0, share: 0 };

  const rate = openingLoanRate(primeRate, loan, equity, operatorYears);
  const share = Number(loan) / Number(loan + equity);
  const tierIndex = LEVERAGE_PRICING.findIndex((t) => share <= t.maxDebtShare);
  const cheaperTier = tierIndex > 0 ? LEVERAGE_PRICING[tierIndex - 1] : undefined;
  return {
    loan,
    rate,
    share,
    ...(cheaperTier
      ? {
          cheaper: {
            equity: equityForShare(needed, cheaperTier.maxDebtShare, originationPct),
            maxDebtShare: cheaperTier.maxDebtShare,
            rate: primeRate + DEBT_PRODUCTS.SBA_7A.spreadOverPrime + cheaperTier.spread,
          },
        }
      : {}),
  };
}

/** The revolver is proposed, never asked for — inside what the ceiling leaves. */
export function revolverFor(lendable: Money, equity: Money, loan: Money): Money {
  const onEquity = mulRate(equity, 1 / MIN_OWNER_INJECTION_PCT);
  const ceiling = min(lendable, onEquity);
  return min(max0(ceiling - loan), REVOLVER_TARGET);
}

export interface CandidatePlan {
  equity: Money;
  /** Anything above the player's own capital: a grant, a credit, a partner. */
  outside: Money;
  loan: Money;
  revolver: Money;
}

export interface CandidateResult {
  model: BusinessModel;
  world: WorldState;
  /** Register-completeness failures — a hard gate no financing fixes. */
  errors: string[];
  warnings: string[];
  /** Facilities the underwriter refused, with its reasons. */
  declined: { kind: string; reason: string }[];
  openingCash: Money;
  /** How far month zero outruns the funding. Zero when the gate passes. */
  shortfall: Money;
}

/** Build the candidate world for a plan and put it through lender and gate. */
export function buildCandidate(ctx: FundingContext, plan: CandidatePlan): CandidateResult {
  const operatorYears = ctx.domainYears ?? 0;
  const debt = [
    ...(plan.loan > 0n
      ? [{ kind: 'SBA_7A' as const, principal: plan.loan, termQuarters: 40, operatorYears }]
      : []),
    ...(plan.revolver > 0n
      ? [{ kind: 'REVOLVER' as const, principal: plan.revolver, termQuarters: 40, operatorYears }]
      : []),
  ];

  const model = buildModelFromTemplate({
    businessName: ctx.businessName,
    template: ctx.template,
    archetype: ctx.archetype,
    scale: ctx.scale,
    marketingSpendPerQuarter: ctx.marketing,
    equityInjection: plan.equity,
    outsideCapital: plan.outside,
    debt,
    ...(ctx.provenanceFor ? { provenanceFor: ctx.provenanceFor } : {}),
    ...(ctx.sourceNoteFor ? { sourceNoteFor: ctx.sourceNoteFor } : {}),
  });

  const validation = validateBusinessModel(model);
  const errors = validation.issues.filter((i) => i.severity === 'ERROR').map((i) => `${i.code}  ${i.message}`);
  const warnings = validation.issues.filter((i) => i.severity === 'WARNING').map((i) => i.message);

  const world = createWorld({
    id: 'player-run',
    playerId: 'player',
    config: ctx.config,
    annualLivingExpenses: 0n,
    models: [model],
  });

  const declined = model.financingPlan.debtRequests
    .map((spec) => ({ spec, decision: underwrite(world.businesses[0]!, spec, ctx.config, world.household, 0) }))
    .filter((d) => !d.decision.approved)
    .map((d) => ({ kind: d.spec.kind, reason: d.decision.reason }));

  const openingCash = world.businesses[0]!.cash;
  return {
    model,
    world,
    errors,
    warnings,
    declined,
    openingCash,
    shortfall: max0(-openingCash),
  };
}
