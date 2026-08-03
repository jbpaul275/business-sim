import { ratio, toCompact, type Money } from '@bizsim/money';
import { streamPrice, type TickResult } from '@bizsim/engine';
import type { Business, EngineEvent, PeriodIndex, StreamMetrics } from '@bizsim/schemas';
import { contributionModel, priceUnits, type PriceUnits } from './pricing.js';

/**
 * "What would have had to be true."
 *
 * §9.4 calls this mandatory on insolvency and says why: *"For a prospective
 * founder, this is the single most valuable output the product can generate —
 * it converts a loss into a specific, checkable claim about the real world."*
 *
 * Until now a failed run ended with a wall of numbers. A storage business died
 * $1.5M underwater and the last thing on screen was a liquidation figure, which
 * tells the player they lost without telling them what would have had to be
 * different. The gap between those two is the entire product.
 *
 * Everything below is arithmetic on the run's own history. No model is called
 * and nothing is narrated: an analysis that invents a reason is worse than none,
 * because it is exactly as confident as one that did the work.
 *
 * The single-lever framing is deliberate and is stated to the player. Each
 * answer holds everything else at what it actually was, which is not how a
 * business works — but "you would have needed 94% occupancy" is checkable
 * against the world, and "some combination of price, volume and cost" is not.
 */

/** One quarter, reduced to what the analysis needs. */
export interface RunPoint {
  period: PeriodIndex;
  revenue: Money;
  ebitda: Money;
  cash: Money;
  /** Costs no decision could reach inside the quarter. */
  fixedAndStep: Money;
  breakEvenRevenue: Money;
  /** The archetype's own operating figure — occupancy, covers/day, utilisation. */
  breakEven?: { unit: string; value: number } | undefined;
  achieved?: { unit: string; value: number } | undefined;
  debtService: Money;
  crisisRemedies: number;
  lostDemand: number;
  /**
   * Absent on the closing period, which reports real metrics but no streams —
   * a closed business has none. That absence is what marks a quarter as one the
   * business did not actually trade through, and every average below uses it to
   * exclude the stub rather than averaging a zero into the evidence.
   */
  metrics?: StreamMetrics | undefined;
  /**
   * The pricing answer, computed while the business still exists.
   *
   * Liquidation clears `business.streams`, so after a closure there is nothing
   * left to price against — and a closure is exactly when this question gets
   * asked. `required` absent means no price inside the band the model will
   * defend covers the quarter's unreachable costs, which is a finding rather
   * than a gap.
   */
  price?: { charged: PriceUnits; required?: PriceUnits | undefined } | undefined;
}

export function runPoint(result: TickResult, business: Business): RunPoint | undefined {
  const entry = result.statements.byBusiness[business.id];
  if (!entry) return undefined;
  const m = entry.derivedMetrics;
  const stream = m.streamMetrics[0];

  // The costs a single quarter's decisions cannot reach. Read off the business
  // rather than the statement, because the statement's occupancy and G&A lines
  // mix in variable costs that a falling volume would have taken with it.
  const fixedAndStep =
    business.costs.fixedPeriod.reduce<Money>((a, c) => a + c.amountPerQuarter, 0n) +
    business.costs.stepFixed.reduce<Money>(
      (a, c) => a + c.blockCostPerQuarter * BigInt(c.currentBlocks),
      0n,
    );

  return {
    period: result.statements.period,
    revenue: entry.incomeStatement.revenue,
    ebitda: entry.incomeStatement.ebitda,
    cash: entry.balanceSheet.cash,
    fixedAndStep,
    breakEvenRevenue: m.breakEvenRevenue,
    breakEven: m.breakEvenVolume,
    achieved: stream ? achievedVolume(stream) : undefined,
    debtService: business.trailingDebtService[business.trailingDebtService.length - 1] ?? 0n,
    crisisRemedies: result.events.filter((e: EngineEvent) => e.kind === 'CRISIS_REMEDY_APPLIED').length,
    lostDemand: stream?.lostDemand ?? 0,
    metrics: stream,
    price: stream ? pricePoint(business, stream, fixedAndStep) : undefined,
  };
}

function pricePoint(
  business: Business,
  metrics: StreamMetrics,
  target: Money,
): RunPoint['price'] {
  const stream = business.streams[0];
  if (!stream) return undefined;
  const charged = streamPrice(stream);
  const solved = requiredPrice(business, metrics, Number(target));
  return {
    charged: priceUnits(stream, charged),
    ...(solved.found ? { required: priceUnits(stream, solved.price) } : {}),
  };
}

/**
 * The same figure `breakEvenVolume` reports, as it actually came out.
 *
 * The comparison is the whole point — "break-even occupancy 94%" means nothing
 * without "you reached 76%" beside it — so the two have to be the same unit,
 * computed the same way, or the sentence is a lie with a number in it.
 */
function achievedVolume(m: StreamMetrics): { unit: string; value: number } | undefined {
  switch (m.archetype) {
    case 'OCCUPANCY':
      return m.occupancy !== undefined ? { unit: 'occupancy', value: m.occupancy } : undefined;
    case 'UTILIZATION':
      return m.realizedUtilization !== undefined
        ? { unit: 'utilization', value: m.realizedUtilization }
        : undefined;
    case 'TRAFFIC':
      return { unit: 'covers/day', value: m.realizedVolume / 91 };
    case 'SUBSCRIPTION':
      return { unit: 'subscribers', value: m.realizedVolume };
    case 'UNITS_CAC':
      return { unit: 'orders/quarter', value: m.realizedVolume };
    default:
      return undefined;
  }
}

const asUnit = (unit: string, value: number): string =>
  unit === 'occupancy' || unit === 'utilization' || unit === 'win rate'
    ? `${(value * 100).toFixed(1)}%`
    : `${Math.round(value).toLocaleString()} ${unit}`;

/**
 * The price that would have been enough — not the price that earns the most.
 *
 * Walked over the same contribution curve the advisor's optimum uses, looking
 * for the cheapest price at which contribution covers the costs no decision can
 * reach. When no price in the defensible band gets there, that is the finding,
 * and it is a more useful one than a number: this was never a pricing problem.
 */
function requiredPrice(
  business: Business,
  metrics: StreamMetrics,
  target: number,
): { price: Money; found: true } | { found: false } {
  const stream = business.streams[0];
  if (!stream) return { found: false };
  const model = contributionModel(business, stream, metrics, streamPrice(stream));
  if (!model) return { found: false };

  const { low, high } = model.band;
  const steps = 400;
  let best: Money | undefined;
  for (let i = 0; i <= steps; i++) {
    const price = low + ((high - low) * BigInt(i)) / BigInt(steps);
    if (price <= 0n) continue;
    if (model.at(price).value >= target) {
      // The cheapest sufficient price, because a founder raising a rate wants
      // the smallest rise that works, not the largest the model allows.
      if (best === undefined || price < best) best = price;
    }
  }
  return best === undefined ? { found: false } : { price: best, found: true };
}

export interface Postmortem {
  /** Whether the run is being explained as a failure or as a success. */
  verdict: 'FAILED' | 'STRUGGLING' | 'WORKED';
  lines: string[];
}

export function postmortem(history: readonly RunPoint[], business: Business): Postmortem {
  if (history.length === 0) {
    return { verdict: 'STRUGGLING', lines: ['No quarters have run yet — there is nothing to explain.'] };
  }

  /**
   * The last quarter that still had a stream, which is not always the last row.
   *
   * Liquidation clears `business.streams`, so the closing period reports a real
   * balance sheet and no stream metrics — and reading the units, the break-even
   * volume or the price off that row silently drops three of the four lines
   * this analysis exists to print, at exactly the moment they are wanted.
   *
   * Money averages still use every row, including the closing one: it is a
   * quarter the business traded, and it is evidence.
   */
  const operating = history.filter((p) => p.metrics !== undefined);
  const last = operating[operating.length - 1] ?? history[history.length - 1]!;
  const cumulativeEbitda = history.reduce<Money>((a, p) => a + p.ebitda, 0n);
  const closed = business.status === 'CLOSED';

  const lines: string[] = [];
  // Quoted back in the closing caveat, so the example is the player's own
  // number rather than one from the transcript this code was written against.
  let volumeClaim: string | undefined;

  // ── What happened, in one sentence ──────────────────────────────────────
  const quarters = history.length;
  const years = (quarters / 4).toFixed(1);
  lines.push(
    closed
      ? `${business.name} ran ${quarters} quarters — ${years} years — and closed. Cumulative EBITDA ` +
          `${toCompact(cumulativeEbitda)}; peak cash need ${toCompact(business.peakCashNeed)}.`
      : `${quarters} quarters in — ${years} years. Cumulative EBITDA ${toCompact(cumulativeEbitda)}, ` +
          `cash ${toCompact(last.cash)}, peak cash need ${toCompact(business.peakCashNeed)}.`,
  );

  // ── The gap ─────────────────────────────────────────────────────────────
  // Averaged over the last four quarters rather than the whole run: the opening
  // ramp is not evidence about the business, and including it flatters a failure
  // and understates a success.
  const recent = history.slice(-4);
  const avgRevenue = recent.reduce<Money>((a, p) => a + p.revenue, 0n) / BigInt(recent.length);
  const avgBreakEven =
    recent.reduce<Money>((a, p) => a + p.breakEvenRevenue, 0n) / BigInt(recent.length);
  const gap = avgBreakEven - avgRevenue;

  /**
   * The verdict comes from the gap, not from cumulative EBITDA.
   *
   * A business ten years in with $634k of lifetime EBITDA and a revenue line
   * that no longer covers its costs is not a business that worked — and when
   * the heading said "WHAT IT RESTS ON" over a body opening "short by $1.4k a
   * quarter", the screen contradicted itself in two lines. Both now read the
   * same number.
   */
  const verdict: Postmortem['verdict'] = closed ? 'FAILED' : gap > 0n ? 'STRUGGLING' : 'WORKED';

  if (gap > 0n) {
    lines.push(
      `Over the last ${recent.length} quarters you averaged ${toCompact(avgRevenue)} of revenue ` +
        `against a break-even of ${toCompact(avgBreakEven)} — short by ${toCompact(gap)} a quarter, ` +
        `${pctOf(gap, avgBreakEven)} of what the business needed.`,
    );
  } else {
    lines.push(
      `Over the last ${recent.length} quarters you averaged ${toCompact(avgRevenue)} of revenue ` +
        `against a break-even of ${toCompact(avgBreakEven)} — clear by ${toCompact(-gap)} a quarter. ` +
        `That margin is what the run rests on.`,
    );
  }

  // ── What would have had to be true ──────────────────────────────────────
  lines.push('');
  lines.push(
    verdict === 'WORKED'
      ? 'What it rests on — each of these on its own, everything else unchanged:'
      : 'What would have had to be true — each of these on its own, everything else unchanged:',
  );

  // Volume, in the operator's own unit. §9.4 names exactly these.
  //
  // Averaged over the same four quarters as the gap above, not read off the
  // final one. A seasonal business's last quarter can be its best or its worst,
  // and quoting a revenue gap from a four-quarter mean beside an occupancy
  // figure from one quarter produces two numbers that appear to disagree.
  const required = mean(recent.map((p) => p.breakEven?.value));
  const achieved = mean(recent.map((p) => p.achieved?.value));
  const unit = last.breakEven?.unit;
  if (required !== undefined && achieved !== undefined && unit && unit === last.achieved?.unit) {
    const best = history.reduce(
      (peak, p) => (p.achieved && p.achieved.value > peak ? p.achieved.value : peak),
      0,
    );
    volumeClaim = `${asUnit(unit, required)}${unit === 'occupancy' || unit === 'utilization' ? ` ${unit}` : ''}`;
    lines.push(
      `  Volume: ${volumeClaim} to break even, against the ${asUnit(unit, achieved)} you averaged. ` +
        `The best quarter of the whole run reached ${asUnit(unit, best)}.`,
    );
  }

  // Price, solved against the costs a quarter cannot reach.
  const price = last.price;
  if (price && gap > 0n) {
    const show = (u: PriceUnits): string =>
      `$${u.command.toLocaleString()}${u.colloquial ? ` (${u.colloquial})` : ''}`;
    lines.push(
      price.required
        ? `  Price: ${show(price.required)} would have covered it, against the ` +
            `${show(price.charged)} you charged — and that already accounts for the volume the ` +
            `rise costs you.`
        : `  Price: no price the model will defend closes the gap. Raising the rate loses volume ` +
            `faster than it adds margin here, so this was never a pricing problem.`,
    );
  }

  // Cost, as the share of the unreachable base that would have had to go.
  if (gap > 0n && last.fixedAndStep > 0n) {
    const shortfall = -(recent.reduce<Money>((a, p) => a + p.ebitda, 0n) / BigInt(recent.length));
    if (shortfall > 0n) {
      lines.push(
        `  Cost: ${toCompact(shortfall)} a quarter would have had to come out of a fixed and ` +
          `staffing base of ${toCompact(last.fixedAndStep)} — ${pctOf(shortfall, last.fixedAndStep)} ` +
          `of everything a single quarter cannot change.`,
      );
    }
  }

  // Capital, against what the run actually consumed.
  if (business.peakCashNeed > 0n) {
    lines.push(
      `  Capital: peak cash need reached ${toCompact(business.peakCashNeed)} at period ` +
        `${business.peakCashNeedPeriod}. That is the cheque this business needed to survive its own ` +
        `plan, whatever it earned afterwards.`,
    );
  }

  // ── When it turned ──────────────────────────────────────────────────────
  const firstCrisis = history.find((p) => p.crisisRemedies > 0);
  const lastCrisis = [...history].reverse().find((p) => p.crisisRemedies > 0);
  const lastCovered = [...history].reverse().find((p) => p.ebitda >= p.debtService);
  if (firstCrisis || lastCovered) {
    lines.push('');
    if (firstCrisis && lastCrisis) {
      const when =
        firstCrisis.period === 0
          ? 'in the opening quarter'
          : `at period ${firstCrisis.period}, ${((firstCrisis.period / 4) + 0.25).toFixed(1)} years in`;
      // A crisis a business traded out of is a scar, not a cause of death, and
      // saying "everything after that was funded rather than earned" of a run
      // that went on to earn $13M is simply false.
      const recovered = lastCrisis.period < last.period - 3;
      lines.push(
        recovered
          ? `The first cash crisis came ${when}, and the last at period ${lastCrisis.period} — ` +
              `${last.period - lastCrisis.period} quarters ago. You traded out of it.`
          : `The first cash crisis came ${when}, and they did not stop. Everything after that was ` +
              `funded rather than earned.`,
      );
    }
    if (lastCovered && lastCovered.period < last.period) {
      lines.push(
        `Period ${lastCovered.period} was the last quarter EBITDA covered debt service. It never did again.`,
      );
    }
  }

  // ── What was actually binding ───────────────────────────────────────────
  const turnedAway = history.filter((p) => p.lostDemand > 0.5).length;
  if (turnedAway > 0) {
    lines.push(
      `You were capacity-bound in ${turnedAway} of ${quarters} quarters — demand was not the ` +
        `constraint in those, the building was.`,
    );
  }

  lines.push('');
  lines.push(
    'Each line above holds everything else at what it actually was. Businesses do not move one ' +
      `lever at a time — but ${volumeClaim ? `"${volumeClaim}"` : 'a single number'} is a claim you ` +
      'can check against the real world, and "some combination of things" is not.',
  );

  return { verdict, lines };
}

const pctOf = (part: Money, whole: Money): string =>
  whole > 0n ? `${(ratio(part, whole) * 100).toFixed(0)}%` : '—';

/** The mean of the values that exist, or undefined when none do. */
function mean(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((a, v) => a + v, 0) / present.length;
}
