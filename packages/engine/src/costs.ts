import { mulRate, sum, type Money } from '@bizsim/money';
import {
  ARCHETYPE_DRIVER,
  type Business,
  type PeriodIndex,
  type RevenueStream,
  type StatementLine,
  type StepFixedCost,
  type VolumeDriver,
} from '@bizsim/schemas';
import type { DemandResult, RealizeResult } from './archetypes.js';
import { lineKey, type TickContext } from './context.js';

/**
 * The cost engine — spec §4. Costs decompose by BEHAVIOUR, not by industry.
 * One universal engine serves all six archetypes; industry knowledge lives in
 * seed templates that populate its parameters.
 */

export type LineTotals = Record<StatementLine, Money>;

export const emptyLineTotals = (): LineTotals => ({
  COGS: 0n,
  LABOR: 0n,
  OCCUPANCY: 0n,
  MARKETING: 0n,
  'G&A': 0n,
});

export interface CostLineResult {
  id: string;
  label: string;
  amount: Money;
  statementLine: StatementLine;
  accruable: boolean;
}

export interface CostBucket {
  byLine: LineTotals;
  total: Money;
  accruable: Money;
  lines: CostLineResult[];
}

const emptyBucket = (): CostBucket => ({
  byLine: emptyLineTotals(),
  total: 0n,
  accruable: 0n,
  lines: [],
});

function push(bucket: CostBucket, line: CostLineResult): void {
  bucket.byLine[line.statementLine] += line.amount;
  bucket.total += line.amount;
  if (line.accruable) bucket.accruable += line.amount;
  bucket.lines.push(line);
}

export const addBuckets = (...buckets: CostBucket[]): CostBucket => {
  const out = emptyBucket();
  for (const b of buckets) {
    for (const k of Object.keys(out.byLine) as StatementLine[]) out.byLine[k] += b.byLine[k];
    out.total += b.total;
    out.accruable += b.accruable;
    out.lines.push(...b.lines);
  }
  return out;
};

const applies = (appliesTo: readonly string[] | 'ALL', streamId: string): boolean =>
  appliesTo === 'ALL' || appliesTo.includes(streamId);

// ---------------------------------------------------------------------------
// Capacity — spec §4.3
// ---------------------------------------------------------------------------

export interface CapacityResolution {
  /** streamId → staffed capacity in that stream's driver units, or null. */
  staffedByStream: Map<string, number | null>;
  /** costId → blocks required by UNCONSTRAINED demand. */
  blocksNeeded: Map<string, number>;
  /** costIds where active blocks fall short of needed. */
  shortfalls: { costId: string; label: string; active: number; needed: number }[];
}

const capacityPerBlockAsNumber = (cost: StepFixedCost): number =>
  cost.capacity.driver === 'REVENUE'
    ? Number(cost.capacity.capacityPerBlock)
    : cost.capacity.capacityPerBlock;

/**
 * Resolve staffed capacity and required blocks.
 *
 * > `blocksNeeded` is computed from UNCONSTRAINED DEMAND, never from realized
 * > volume. Realized volume is already capped by staffing; feeding it back as
 * > the staffing driver creates a self-reinforcing trap where the business locks
 * > at its initial headcount forever and can never justify growing, because the
 * > demand signal it needs has already been clipped by the shortage it is trying
 * > to fix.
 *
 * The spec's own reference implementation shipped this backwards: revenue froze
 * at 4,000 transactions/quarter for ten simulated years while true demand
 * reached 11,600, and every accounting assertion passed the whole time. There is
 * a regression test for exactly this in `understaffing.test.ts`.
 *
 * Allocation across streams (docs/plan/03-spec-gaps.md G-3): a step-fixed line
 * is a business-level pool but constrains stream-level revenue. Where several
 * streams share a driver, the pool is split in proportion to unconstrained
 * demand. Where several lines carry the same driver, the tightest binds — the
 * slowest station gates the line, which is how kitchens actually work.
 */
export function resolveCapacity(
  business: Business,
  demands: readonly DemandResult[],
): CapacityResolution {
  const staffedByStream = new Map<string, number | null>();
  const blocksNeeded = new Map<string, number>();
  const shortfalls: CapacityResolution['shortfalls'] = [];

  for (const d of demands) staffedByStream.set(d.streamId, null);

  for (const cost of business.costs.stepFixed) {
    const relevant = demands.filter(
      (d) => d.driver === cost.capacity.driver && applies(cost.appliesToStreamIds, d.streamId),
    );

    const perBlock = capacityPerBlockAsNumber(cost);
    const totalDemand = relevant.reduce((acc, d) => acc + d.demandVolume, 0);
    const needed = Math.max(
      cost.minimumBlocks,
      perBlock > 0 ? Math.ceil(totalDemand / perBlock) : cost.minimumBlocks,
    );
    blocksNeeded.set(cost.id, needed);

    if (cost.currentBlocks < needed) {
      shortfalls.push({
        costId: cost.id,
        label: cost.label,
        active: cost.currentBlocks,
        needed,
      });
    }

    if (relevant.length === 0) continue;

    const pool = cost.currentBlocks * perBlock;
    for (const d of relevant) {
      const share =
        totalDemand > 0 ? (d.demandVolume / totalDemand) * pool : pool / relevant.length;
      const existing = staffedByStream.get(d.streamId);
      staffedByStream.set(d.streamId, existing === null || existing === undefined ? share : Math.min(existing, share));
    }
  }

  return { staffedByStream, blocksNeeded, shortfalls };
}

// ---------------------------------------------------------------------------
// Cost classes
// ---------------------------------------------------------------------------

/** §4.1 — scales directly with revenue dollars. */
export function variableWithRevenue(
  ctx: TickContext,
  business: Business,
  revenueByStream: ReadonlyMap<string, Money>,
): CostBucket {
  const bucket = emptyBucket();
  for (const cost of business.costs.variableWithRevenue) {
    ctx.scope(lineKey(cost.statementLine), () => {
      const base = sum(
        [...revenueByStream.entries()]
          .filter(([streamId]) => applies(cost.appliesToStreamIds, streamId))
          .map(([, revenue]) => revenue),
      );
      const pct = ctx.p(`costs.${cost.id}.pctOfRevenue`, cost.pctOfRevenue);
      push(bucket, {
        id: cost.id,
        label: cost.label,
        amount: mulRate(base, pct),
        statementLine: cost.statementLine,
        accruable: cost.accruable,
      });
    });
  }
  return bucket;
}

/**
 * §4.2 — scales with a volume driver decoupled from price, evaluated on
 * REALIZED volume. You only pay to ship an order you actually shipped. This is
 * the opposite of the step-fixed rule and the distinction is load-bearing: when
 * the player raises prices, revenue-linked costs rise and activity-linked costs
 * do not, which is exactly why price increases are so powerful.
 */
export function variableWithActivity(
  ctx: TickContext,
  business: Business,
  outcomes: readonly RealizeResult[],
): CostBucket {
  const bucket = emptyBucket();
  for (const cost of business.costs.variableWithActivity) {
    ctx.scope(lineKey(cost.statementLine), () => {
      let volume = 0;
      for (const outcome of outcomes) {
        if (!applies(cost.appliesToStreamIds, outcome.streamId)) continue;
        volume += outcome.activity[cost.driver as VolumeDriver] ?? 0;
      }
      const perUnit = ctx.p(`costs.${cost.id}.costPerUnit`, cost.costPerUnit);
      push(bucket, {
        id: cost.id,
        label: cost.label,
        amount: mulRate(perUnit, volume),
        statementLine: cost.statementLine,
        accruable: cost.accruable,
      });
    });
  }
  return bucket;
}

/**
 * §4.3 — cost is driven by blocks ACTIVE, not blocks needed. You pay the cook
 * for a quarter before they raise throughput (§9.3.1), and that asymmetry is
 * the whole point of the class.
 */
export function stepFixedCosts(ctx: TickContext, business: Business): CostBucket {
  const bucket = emptyBucket();
  const load = business.costs.payrollLoadPct;
  for (const cost of business.costs.stepFixed) {
    ctx.scope(lineKey(cost.statementLine), () => {
      const perBlock = ctx.p(`costs.${cost.id}.blockCostPerQuarter`, cost.blockCostPerQuarter);
      // Cost is driven by current PLUS pending blocks; capacity by current alone.
      const gross = mulRate(perBlock, cost.currentBlocks + cost.pendingBlocks);
      push(bucket, {
        id: cost.id,
        label: cost.label,
        amount: cost.isLabor ? mulRate(gross, 1 + load) : gross,
        statementLine: cost.statementLine,
        // Labor is never accruable — payroll clears on a two-week cycle
        // regardless of when customers pay (§5.1).
        accruable: false,
      });
    });
  }
  return bucket;
}

export interface FixedPeriodOptions {
  /** Owner comp deferred by crisis remedy 4 — removed from this period's cost. */
  deferOwnerComp: boolean;
}

/** §4.4 — contractual, time-based, with contractual escalators. */
export function fixedPeriodCosts(
  ctx: TickContext,
  business: Business,
  period: PeriodIndex,
  options: FixedPeriodOptions = { deferOwnerComp: false },
): CostBucket & { ownerCompDeferred: Money } {
  const bucket = emptyBucket();
  const load = business.costs.payrollLoadPct;
  let ownerCompDeferred = 0n;

  for (const cost of business.costs.fixedPeriod) {
    if (period < cost.startPeriod) continue;
    if (cost.endPeriod !== undefined && period > cost.endPeriod) continue;

    const yearsElapsed = Math.floor((period - cost.startPeriod) / 4);
    const { escalated } = ctx.scope(lineKey(cost.statementLine), () => {
      const escalator = ctx.p(`costs.${cost.id}.annualEscalatorPct`, cost.annualEscalatorPct);
      const base = ctx.p(`costs.${cost.id}.amountPerQuarter`, cost.amountPerQuarter);
      return { escalated: mulRate(base, Math.pow(1 + escalator, yearsElapsed)) };
    });
    const withLoad = cost.isLabor ? mulRate(escalated, 1 + load) : escalated;

    // Deferring owner compensation does NOT remove the expense. The work was
    // done and the founder is owed for it — §9.4 is explicit that it "accrues
    // as a liability, does not vanish". Removing it from the P&L as well as
    // accruing it would hand the business the same relief twice: once as higher
    // net income and again as a liability that funds operations through ΔNWC.
    if (cost.isOwnerComp && options.deferOwnerComp) {
      ownerCompDeferred += withLoad;
    }

    push(bucket, {
      id: cost.id,
      label: cost.label,
      amount: withLoad,
      statementLine: cost.statementLine,
      accruable: cost.isLabor ? false : cost.accruable,
    });
  }

  return { ...bucket, ownerCompDeferred };
}

/** Marketing is set per stream (§3.0.5), booked in the quarter incurred, never accruable. */
export function marketingCost(business: Business): CostBucket {
  const bucket = emptyBucket();
  for (const stream of business.streams) {
    if (stream.marketingSpendPerQuarter === 0n) continue;
    push(bucket, {
      id: `marketing:${stream.id}`,
      label: `Marketing — ${stream.label}`,
      amount: stream.marketingSpendPerQuarter,
      statementLine: 'MARKETING',
      accruable: false,
    });
  }
  return bucket;
}

/**
 * §3.0.3 — per-stream contribution margin. Step-fixed and fixed-period costs
 * are excluded: they are not attributable to a marginal unit. This is a
 * different number from business-level gross margin (§8.1) and the two are not
 * interchangeable.
 */
export function streamContributionMarginPct(
  business: Business,
  stream: RevenueStream,
  pricePerUnit: Money,
): number {
  const { pctOfRevenue, perUnit } = streamVariableCosts(business, stream);
  const activityPct = pricePerUnit > 0n ? Number(perUnit) / Number(pricePerUnit) : 0;
  return Math.max(0, 1 - pctOfRevenue - activityPct);
}

/**
 * The two halves of a stream's variable cost, kept apart.
 *
 * Contribution margin collapses them into one percentage, which is the right
 * summary and the wrong input for a pricing question: a commission that is 8%
 * of revenue moves with the price and a laundry cost of $14 a room-night does
 * not. Anything asking "what price maximises contribution" needs to know which
 * is which, so the split is exposed rather than re-derived by every caller.
 */
export interface StreamVariableCosts {
  /** Costs expressed as a share of this stream's revenue — scale with price. */
  pctOfRevenue: number;
  /** Costs per unit of this stream's own driver — do not scale with price. */
  perUnit: Money;
}

export function streamVariableCosts(business: Business, stream: RevenueStream): StreamVariableCosts {
  let pctOfRevenue = 0;
  for (const cost of business.costs.variableWithRevenue) {
    if (applies(cost.appliesToStreamIds, stream.id)) pctOfRevenue += cost.pctOfRevenue;
  }

  // Activity costs are attributed per unit of the stream's own driver. Because
  // both the cost and the revenue are linear in volume, the ratio is the same
  // whether it is evaluated at demand or at realized volume — which is what
  // lets this be computed before capacity is resolved.
  let perUnit = 0n;
  const driver = ARCHETYPE_DRIVER[stream.params.kind];
  for (const cost of business.costs.variableWithActivity) {
    if (!applies(cost.appliesToStreamIds, stream.id)) continue;
    if (cost.driver !== driver) continue;
    perUnit += cost.costPerUnit;
  }

  return { pctOfRevenue, perUnit };
}

/**
 * §4.6 — the maintenance reserve. `FixedAsset.maintenancePctOfGrossPerYear` is
 * the SOURCE of the rate; the omission guard reads it and injects one
 * FIXED_PERIOD line. The asset field is never separately expensed — doing both
 * double-counts maintenance in the P&L. This is also the figure §6.3's DSCR
 * add-back uses, and it is computed in exactly this one place.
 */
export function maintenanceReservePerQuarter(business: Business): Money {
  return sum(
    business.assets.map((a) => mulRate(a.grossCost, a.maintenancePctOfGrossPerYear / 4)),
  );
}

/**
 * Point the maintenance line at the assets that exist NOW.
 *
 * The `og_maintenance` line was computed once, from the drafted capex, at
 * model build — and then frozen. A player who challenged a $3.26M phantom
 * renovation down kept paying $32.6k a quarter to maintain the version of it
 * that no longer existed, and a player who bought machines mid-game
 * maintained them for free. The reserve is derived from the asset base, so it
 * has to move when the base does — both directions.
 *
 * The one exception is a number the player has taken ownership of: a
 * PLAYER_* provenance on the line's assumption means they revised or sourced
 * it, and a derived recompute silently reverting an `assume` would make that
 * command theatre for exactly this line. Derived until claimed, then theirs.
 *
 * The register entry moves with the line — it is a record OF the model, so
 * both move or neither does.
 */
export function syncMaintenanceReserve(business: Business): void {
  const line = business.costs.fixedPeriod.find((c) => c.id === 'og_maintenance');
  if (!line) return;
  const assumptionId = business.assumptions.byPath['costs.og_maintenance.amountPerQuarter'];
  const assumption = assumptionId ? business.assumptions.byId[assumptionId] : undefined;
  if (
    assumption &&
    (assumption.provenance === 'PLAYER_ASSUMED' || assumption.provenance === 'PLAYER_SOURCED')
  ) {
    return;
  }
  const amount = maintenanceReservePerQuarter(business);
  line.amountPerQuarter = amount;
  if (assumption) assumption.value = amount;
}
