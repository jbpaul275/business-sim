import { tick } from '@bizsim/engine';
import { mulRate, type Money } from '@bizsim/money';
import type { WorldState } from '@bizsim/schemas';

/**
 * The depth gauge: what a funding plan actually buys, measured before the dive.
 *
 * Risk in this game was ambient — leverage, buildouts and thin runway were all
 * real, but the player discovered how deep they were only when the crisis
 * ladder fired. A certified plumber with $500k went broke in two quarters and
 * nothing on the funding screen had said his plan touched emergency debt in
 * Q2 *even at plan*. Dave the Diver's rule, applied: depth is chosen, visible,
 * and priced — everyone understands the bargain before taking it.
 *
 * So: tick the candidate world forward silently and report where the ladder
 * first fires, where the cash trough is, and what the debt weighs per quarter
 * — once at plan, once with demand 30% under it, which is both the standard
 * lender stress and exactly how the plumber died. Deterministic, engine-only
 * arithmetic; no model call anywhere near it.
 */

export interface PlanDepth {
  /** How far forward the projection looked. */
  quarters: number;
  /**
   * First projected quarter (1-based) the crisis ladder fires — a CASH_CRISIS,
   * a remedy applied, or insolvency. Absent when the window stays clear. This
   * is the depth mark: the low-oxygen alarm, not yet the drowning.
   */
  firstCrisisQuarter?: number;
  /** The quarter the business closes, when it does inside the window. */
  insolvencyQuarter?: number;
  /** The lowest projected cash balance, and when it comes. */
  troughCash: Money;
  troughQuarter: number;
  /**
   * The heaviest quarter of debt service in the window — interest plus
   * scheduled principal. The weight the plan carries regardless of demand.
   */
  debtServicePerQuarter: Money;
}

const CRISIS_KINDS = new Set(['CASH_CRISIS', 'CRISIS_REMEDY_APPLIED', 'INSOLVENCY']);

const abs = (m: Money): Money => (m < 0n ? -m : m);

/**
 * Project a world forward with no player actions. The input world is cloned —
 * a gauge that mutated the plan it was measuring would be a bug generator —
 * and the engine's own crisis ladder stays on, because the ladder firing IS
 * the reading.
 */
export function planDepth(world: WorldState, businessId: string, quarters = 12): PlanDepth {
  let state = structuredClone(world) as WorldState;
  let firstCrisisQuarter: number | undefined;
  let insolvencyQuarter: number | undefined;
  let troughCash: Money | undefined;
  let troughQuarter = 1;
  let debtServicePerQuarter: Money = 0n;

  for (let q = 1; q <= quarters; q++) {
    const business = state.businesses.find((b) => b.id === businessId);
    if (!business || business.status === 'CLOSED') break;
    const result = tick(state, [], { throwOnAssertionFailure: false });
    state = result.state;

    if (firstCrisisQuarter === undefined) {
      const crisis = result.events.some(
        (e) => CRISIS_KINDS.has(e.kind) && (e.businessId ?? businessId) === businessId,
      );
      if (crisis) firstCrisisQuarter = q;
    }
    const after = state.businesses.find((b) => b.id === businessId);
    if (insolvencyQuarter === undefined && (!after || after.status === 'CLOSED')) {
      insolvencyQuarter = q;
    }

    const entry = result.statements.byBusiness[businessId];
    if (entry) {
      const cash = entry.balanceSheet.cash;
      if (troughCash === undefined || cash < troughCash) {
        troughCash = cash;
        troughQuarter = q;
      }
      const service =
        entry.incomeStatement.interestExpense + abs(entry.cashFlow.debtPrincipalRepayments);
      if (service > debtServicePerQuarter) debtServicePerQuarter = service;
    }
  }

  return {
    quarters,
    ...(firstCrisisQuarter !== undefined ? { firstCrisisQuarter } : {}),
    ...(insolvencyQuarter !== undefined ? { insolvencyQuarter } : {}),
    troughCash: troughCash ?? 0n,
    troughQuarter,
    debtServicePerQuarter,
  };
}

/**
 * The same business with demand 30% under plan, on a copy.
 *
 * One lever per archetype — the parameter that carries "customers showed up
 * lighter than drafted", in the trade's own terms. For the acquisition-driven
 * archetypes the honest stress is efficiency, not volume: the same marketing
 * dollars buy fewer customers, so CAC rises by the same factor.
 */
export function stressDemand(world: WorldState, businessId: string, factor = 0.7): WorldState {
  const stressed = structuredClone(world) as WorldState;
  const business = stressed.businesses.find((b) => b.id === businessId);
  if (!business) return stressed;
  for (const stream of business.streams) {
    const p = stream.params;
    if (p.kind === 'TRAFFIC') p.addressableTrafficPerQuarter *= factor;
    else if (p.kind === 'UTILIZATION') p.demandHoursPerQuarter *= factor;
    else if (p.kind === 'OCCUPANCY') p.stabilizedOccupancy *= factor;
    else if (p.kind === 'PROJECT_BACKLOG') p.winRate *= factor;
    else if (p.kind === 'UNITS_CAC' || p.kind === 'SUBSCRIPTION') {
      // The same spend acquires `factor` as many customers: CAC divides by it.
      p.baseCac = mulRate(p.baseCac, 1 / factor);
    }
  }
  return stressed;
}

/** The gauge a funding card wears: the same plan read at plan and under stress. */
export interface DepthGauge {
  atPlan: PlanDepth;
  stressed: PlanDepth;
}

export function depthGauge(world: WorldState, businessId: string, quarters = 12): DepthGauge {
  return {
    atPlan: planDepth(world, businessId, quarters),
    stressed: planDepth(stressDemand(world, businessId), businessId, quarters),
  };
}
