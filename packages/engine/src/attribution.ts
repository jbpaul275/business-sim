import { fromDisplay, mulRate, toDisplay, type Money } from '@bizsim/money';
import {
  ARCHETYPE_DRIVER,
  type AttributedLine,
  type Assumption,
  type AttributionDriver,
  type Business,
  type DeltaAttribution,
  type StatementSet,
  type StreamMetrics,
  type WorldState,
} from '@bizsim/schemas';
import { demandFactors, streamPrice } from './archetypes.js';
import { createContext } from './context.js';
import {
  fixedPeriodCosts,
  marketingCost,
  stepFixedCosts,
  variableWithActivity,
  variableWithRevenue,
  type CostLineResult,
} from './costs.js';
import { quarterOfYear } from './modifiers.js';

/**
 * Per-quarter delta attribution — spec §10.4.
 *
 * The trace (context.ts) answers "which assumptions CAN move this line"; this
 * module answers the question the player actually asks: "why did this line
 * move THIS quarter, and whose number is that". The answer has to be
 * deterministic — §11.5 forbids the narration inventing mechanisms, and the
 * only way to hold that line is for the mechanisms to arrive precomputed.
 *
 * Method, revenue: demand is a product of shared multipliers (season, ramp,
 * marketing, price response) over an underlying base, and every factor is a
 * pure function of (stream, period) — so last quarter's factors are exactly
 * recomputable from last quarter's state. The quarter-over-quarter move
 * decomposes in log space: ln(R₁/R₀) = Σ ln(f₁/f₀) + residual, and each
 * term's share of the actual dollar delta is its contribution. The residual —
 * subscriber bases compounding, backlog carrying over, an adjusted parameter —
 * is reported as a driver, not hidden.
 *
 * Method, costs: the cost classes are pure functions of (business, period,
 * revenue, volume), and both endpoints of the comparison are on hand. Each
 * class is re-evaluated at both quarters through the same engine code that
 * produced the statements, and the per-line diffs are the drivers. No second
 * formula to drift.
 *
 * All driver amounts on a line are normalised to sum exactly to the line's
 * actual delta. Approximation error and anything the re-evaluation cannot see
 * (crisis-deferred owner comp, workers' comp riders) land in an explicit
 * remainder driver rather than silently inflating the named ones.
 */

export interface QuarterSnapshot {
  /** World state as of the CLOSE of the quarter. */
  state: WorldState;
  statements: StatementSet;
}

/** A line's move is worth explaining above max($1,000, 1% of revenue). */
const lineThreshold = (revenueScale: Money): Money => {
  const pctFloor = mulRate(abs(revenueScale), 0.01);
  const dollarFloor = fromDisplay(1_000);
  return pctFloor > dollarFloor ? pctFloor : dollarFloor;
};

/** Drivers below max($250, 4% of the move) fold into the remainder. */
const driverThreshold = (delta: Money): Money => {
  const pctFloor = mulRate(abs(delta), 0.04);
  const dollarFloor = fromDisplay(250);
  return pctFloor > dollarFloor ? pctFloor : dollarFloor;
};

const abs = (m: Money): Money => (m < 0n ? -m : m);

const LINE_LABEL: Record<AttributedLine, string> = {
  revenue: 'Revenue',
  costOfGoodsSold: 'COGS',
  labor: 'Labor',
  occupancy: 'Occupancy',
  marketing: 'Marketing',
  generalAndAdmin: 'G&A',
};

export function attributeQuarter(
  prev: QuarterSnapshot,
  curr: QuarterSnapshot,
  businessId: string,
): DeltaAttribution[] {
  const prevBusiness = prev.state.businesses.find((b) => b.id === businessId);
  const currBusiness = curr.state.businesses.find((b) => b.id === businessId);
  const prevEntry = prev.statements.byBusiness[businessId];
  const currEntry = curr.statements.byBusiness[businessId];
  if (!prevBusiness || !currBusiness || !prevEntry || !currEntry) return [];

  const period = curr.statements.period;
  const scale =
    abs(currEntry.incomeStatement.revenue) > abs(prevEntry.incomeStatement.revenue)
      ? currEntry.incomeStatement.revenue
      : prevEntry.incomeStatement.revenue;
  const threshold = lineThreshold(scale);

  const out: DeltaAttribution[] = [];
  const push = (line: AttributedLine, drivers: AttributionDriver[]): void => {
    const previous = prevEntry.incomeStatement[line];
    const current = currEntry.incomeStatement[line];
    const delta = current - previous;
    if (abs(delta) < threshold) return;
    out.push({
      line,
      lineLabel: LINE_LABEL[line],
      previous,
      current,
      delta,
      drivers: finishDrivers(drivers, delta),
    });
  };

  push(
    'revenue',
    revenueDrivers(prevBusiness, currBusiness, prevEntry.derivedMetrics.streamMetrics, currEntry.derivedMetrics.streamMetrics, period),
  );

  const costDrivers = costLineDrivers(
    prevBusiness,
    currBusiness,
    prevEntry.derivedMetrics.streamMetrics,
    currEntry.derivedMetrics.streamMetrics,
    period,
  );
  push('costOfGoodsSold', costDrivers.get('COGS') ?? []);
  push('labor', costDrivers.get('LABOR') ?? []);
  push('occupancy', costDrivers.get('OCCUPANCY') ?? []);
  push('marketing', costDrivers.get('MARKETING') ?? []);
  push('generalAndAdmin', costDrivers.get('G&A') ?? []);

  return out;
}

/**
 * Fold small drivers together, add the remainder the estimates missed, and
 * normalise so the list sums to the line's actual delta.
 */
function finishDrivers(raw: AttributionDriver[], delta: Money): AttributionDriver[] {
  const floor = driverThreshold(delta);
  const kept = raw.filter((d) => abs(d.amount) >= floor);
  const foldedCount = raw.length - kept.length;

  // Everything the named drivers do not add up to — folded small drivers,
  // decomposition error, effects the re-evaluation cannot see.
  const remainder = delta - kept.reduce<Money>((a, d) => a + d.amount, 0n);

  const drivers = [...kept];
  if (abs(remainder) >= fromDisplay(1)) {
    drivers.push({
      label: 'Everything else',
      explanation:
        foldedCount > 0
          ? `${foldedCount} smaller effect${foldedCount === 1 ? '' : 's'} and rounding`
          : 'effects the decomposition cannot see individually',
      amount: remainder,
    });
  } else if (drivers.length > 0 && remainder !== 0n) {
    // Sub-dollar residue: fold into the largest driver instead of a noise row.
    drivers[0] = { ...drivers[0]!, amount: drivers[0]!.amount + remainder };
  }

  drivers.sort((a, b) => (abs(b.amount) > abs(a.amount) ? 1 : abs(b.amount) < abs(a.amount) ? -1 : 0));
  return drivers.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

function revenueDrivers(
  prevBusiness: Business,
  currBusiness: Business,
  prevMetrics: readonly StreamMetrics[],
  currMetrics: readonly StreamMetrics[],
  period: number,
): AttributionDriver[] {
  const drivers: AttributionDriver[] = [];

  for (const stream of currBusiness.streams) {
    const prevStream = prevBusiness.streams.find((s) => s.id === stream.id);
    const currM = currMetrics.find((s) => s.streamId === stream.id);
    if (!currM) continue;
    const prevM = prevMetrics.find((s) => s.streamId === stream.id);
    if (!prevStream || !prevM) {
      drivers.push({
        label: stream.label,
        explanation: 'a stream that did not exist last quarter',
        amount: currM.revenue,
      });
      continue;
    }

    const dRev = currM.revenue - prevM.revenue;
    if (dRev === 0n) continue;

    // A log decomposition needs strictly positive endpoints on everything it
    // takes the log of. A stream starting from (or collapsing to) zero is its
    // own explanation.
    if (
      prevM.revenue <= 0n ||
      currM.revenue <= 0n ||
      prevM.demandVolume <= 0 ||
      currM.demandVolume <= 0 ||
      prevM.realizedVolume <= 0 ||
      currM.realizedVolume <= 0
    ) {
      drivers.push({
        label: stream.label,
        explanation: prevM.revenue <= 0n ? 'revenue starting from zero' : 'revenue going to zero',
        amount: dRev,
      });
      continue;
    }

    const f0 = demandFactors(prevStream, period - 1);
    const f1 = demandFactors(stream, period);
    const register = currBusiness.assumptions;
    const path = `streams.${stream.id}`;

    const lookup = (p: string): Pick<AttributionDriver, 'assumptionId' | 'path' | 'provenance'> => {
      const id = register.byPath[p];
      const assumption: Assumption | undefined = id ? register.byId[id] : undefined;
      return {
        ...(id ? { assumptionId: id } : {}),
        path: p,
        ...(assumption ? { provenance: assumption.provenance } : {}),
      };
    };

    interface Component {
      log: number;
      driver: AttributionDriver;
    }
    const components: Component[] = [];
    const add = (log: number, driver: AttributionDriver): void => {
      if (Math.abs(log) > 1e-9 && Number.isFinite(log)) components.push({ log, driver });
    };

    add(Math.log(f1.season / f0.season), {
      label: 'Seasonality',
      explanation: `calendar Q${quarterOfYear(period - 1) + 1}→Q${quarterOfYear(period) + 1} (${f0.season.toFixed(2)}→${f1.season.toFixed(2)})`,
      amount: 0n,
      ...lookup(`${path}.seasonality`),
    });
    add(Math.log(f1.ramp / f0.ramp), {
      label: 'Maturity ramp',
      explanation: `a maturing location, ${(f0.ramp * 100).toFixed(0)}%→${(f1.ramp * 100).toFixed(0)}% of steady state`,
      amount: 0n,
      ...lookup(`${path}.modifiers.rampConstant`),
    });
    add(Math.log(f1.marketing / f0.marketing), {
      label: 'Marketing response',
      explanation: `spend moved $${toDisplay(prevStream.marketingSpendPerQuarter)}→$${toDisplay(stream.marketingSpendPerQuarter)} a quarter`,
      amount: 0n,
      ...lookup(`${path}.modifiers.halfSaturationSpend`),
    });

    // Price moves revenue twice — per-unit take and demand response — and both
    // come from the same decision, so they report as one driver. For
    // PROJECT_BACKLOG demand is already denominated in dollars, so the level
    // term would double-count the contract value.
    const levelLog =
      stream.params.kind === 'PROJECT_BACKLOG'
        ? 0
        : Math.log(Number(f1.priceLevel) / Number(f0.priceLevel));
    const priceLog = levelLog + Math.log(f1.priceResponse / f0.priceResponse);
    add(priceLog, {
      label: 'Price',
      explanation: `price $${toDisplay(streamPrice(prevStream))}→$${toDisplay(streamPrice(stream))}, elasticity ${stream.modifiers.priceElasticity.toFixed(1)}`,
      amount: 0n,
      ...lookup(`${path}.modifiers.priceElasticity`),
    });

    // The demand the shared factors do not explain: bases compounding,
    // backlog carried in, an adjusted underlying parameter.
    const demandLog = Math.log(currM.demandVolume / prevM.demandVolume);
    const factorLog =
      Math.log(f1.season / f0.season) +
      Math.log(f1.ramp / f0.ramp) +
      Math.log(f1.marketing / f0.marketing) +
      Math.log(f1.priceResponse / f0.priceResponse);
    add(demandLog - factorLog, residualDriver(stream.params.kind, lookup, path));

    // The gap between demand and what was actually served, quarter over quarter.
    const clipLog = Math.log(
      currM.realizedVolume / currM.demandVolume / (prevM.realizedVolume / prevM.demandVolume),
    );
    add(clipLog, {
      label: 'Capacity ceiling',
      explanation:
        currM.lostDemand > 0.5
          ? `turned away ${Math.round(currM.lostDemand).toLocaleString()} this quarter vs ${Math.round(prevM.lostDemand).toLocaleString()} last`
          : `stopped turning demand away (${Math.round(prevM.lostDemand).toLocaleString()} lost last quarter)`,
      amount: 0n,
    });

    // Convert log shares into dollars against the stream's actual move. The
    // component logs sum to ln(revenue ratio) by construction — season, ramp,
    // marketing and price-response cancel out of the residual, leaving
    // demand + clip + price level, which IS the revenue ratio.
    const totalLog = components.reduce((a, c) => a + c.log, 0);
    const effectiveTotal = totalLog === 0 ? 1 : totalLog;
    for (const c of components) {
      drivers.push({ ...c.driver, amount: mulRate(dRev, c.log / effectiveTotal) });
    }
  }

  return drivers;
}

/** What the residual means depends on the archetype's state machinery. */
function residualDriver(
  kind: string,
  lookup: (p: string) => Pick<AttributionDriver, 'assumptionId' | 'path' | 'provenance'>,
  path: string,
): AttributionDriver {
  switch (kind) {
    case 'SUBSCRIPTION':
      return {
        label: 'Subscriber base',
        explanation: 'the installed base compounding through adds and churn',
        amount: 0n,
        ...lookup(`${path}.params.quarterlyChurnRate`),
      };
    case 'UNITS_CAC':
      return {
        label: 'Customer base',
        explanation: 'the repeat-purchase base compounding through acquisition and attrition',
        amount: 0n,
        ...lookup(`${path}.params.repeatPurchaseRatePerQuarter`),
      };
    case 'PROJECT_BACKLOG':
      return {
        label: 'Backlog',
        explanation: 'work signed in earlier quarters flowing through execution',
        amount: 0n,
        ...lookup(`${path}.params.winRate`),
      };
    default:
      return {
        label: 'Underlying demand',
        explanation: 'demand parameters (market size, capture) net of the shared multipliers',
        amount: 0n,
        ...lookup(`${path}.params.captureRate`),
      };
  }
}

// ---------------------------------------------------------------------------
// Cost lines
// ---------------------------------------------------------------------------

type StatementLineKey = 'COGS' | 'LABOR' | 'OCCUPANCY' | 'MARKETING' | 'G&A';

/**
 * Re-evaluate every cost class at both quarters through the engine's own cost
 * functions and diff per line. The re-evaluation is exact for step-fixed and
 * fixed-period classes; variable classes are evaluated on recorded stream
 * revenue and realized volume, which is what the tick fed them.
 */
function costLineDrivers(
  prevBusiness: Business,
  currBusiness: Business,
  prevMetrics: readonly StreamMetrics[],
  currMetrics: readonly StreamMetrics[],
  period: number,
): Map<StatementLineKey, AttributionDriver[]> {
  const byLine = new Map<StatementLineKey, AttributionDriver[]>();
  const add = (line: string, driver: AttributionDriver): void => {
    const key = line as StatementLineKey;
    const list = byLine.get(key) ?? [];
    list.push(driver);
    byLine.set(key, list);
  };

  const evaluate = (business: Business, metrics: readonly StreamMetrics[], at: number) => {
    const ctx = createContext(at, undefined, { trace: false });
    const revenueByStream = new Map(metrics.map((s) => [s.streamId, s.revenue]));
    const outcomes = business.streams.map((stream) => {
      const m = metrics.find((s) => s.streamId === stream.id);
      return {
        streamId: stream.id,
        activity: { [ARCHETYPE_DRIVER[stream.params.kind]]: m?.realizedVolume ?? 0 },
      };
    });
    return [
      ...variableWithRevenue(ctx, business, revenueByStream).lines,
      ...variableWithActivity(ctx, business, outcomes).lines,
      ...stepFixedCosts(ctx, business).lines,
      ...fixedPeriodCosts(ctx, business, at).lines,
      ...marketingCost(business).lines,
    ];
  };

  const before = new Map(evaluate(prevBusiness, prevMetrics, period - 1).map((l) => [l.id, l]));
  const after = evaluate(currBusiness, currMetrics, period);
  const register = currBusiness.assumptions;

  const seen = new Set<string>();
  for (const line of after) {
    seen.add(line.id);
    const prior: CostLineResult | undefined = before.get(line.id);
    const delta = line.amount - (prior?.amount ?? 0n);
    if (delta === 0n) continue;
    add(line.statementLine, describeCostDelta(prevBusiness, currBusiness, line.id, line.label, delta, prior === undefined, period, register, prevMetrics, currMetrics));
  }
  for (const [id, prior] of before) {
    if (seen.has(id)) continue;
    add(prior.statementLine, {
      label: prior.label,
      explanation: 'a cost line that ended this quarter',
      amount: -prior.amount,
    });
  }

  return byLine;
}

function describeCostDelta(
  prevBusiness: Business,
  currBusiness: Business,
  costId: string,
  label: string,
  delta: Money,
  isNew: boolean,
  period: number,
  register: Business['assumptions'],
  prevMetrics: readonly StreamMetrics[],
  currMetrics: readonly StreamMetrics[],
): AttributionDriver {
  const lookup = (p: string): Pick<AttributionDriver, 'assumptionId' | 'path' | 'provenance'> => {
    const id = register.byPath[p];
    const assumption = id ? register.byId[id] : undefined;
    return {
      ...(id ? { assumptionId: id } : {}),
      path: p,
      ...(assumption ? { provenance: assumption.provenance } : {}),
    };
  };

  if (isNew) {
    return { label, explanation: 'a cost line that began this quarter', amount: delta };
  }

  const prevStep = prevBusiness.costs.stepFixed.find((c) => c.id === costId);
  const currStep = currBusiness.costs.stepFixed.find((c) => c.id === costId);
  if (prevStep && currStep) {
    const before = prevStep.currentBlocks + prevStep.pendingBlocks;
    const now = currStep.currentBlocks + currStep.pendingBlocks;
    return {
      label,
      explanation:
        before === now
          ? 'block cost revised'
          : `${before}→${now} paid blocks${currStep.pendingBlocks > 0 ? ` (${currStep.pendingBlocks} not yet productive)` : ''}`,
      amount: delta,
      ...lookup(`costs.${costId}.blockCostPerQuarter`),
    };
  }

  const prevFixed = prevBusiness.costs.fixedPeriod.find((c) => c.id === costId);
  const currFixed = currBusiness.costs.fixedPeriod.find((c) => c.id === costId);
  if (prevFixed && currFixed) {
    const yearRolled =
      Math.floor((period - currFixed.startPeriod) / 4) >
      Math.floor((period - 1 - prevFixed.startPeriod) / 4);
    const baseChanged = prevFixed.amountPerQuarter !== currFixed.amountPerQuarter;
    return {
      label,
      explanation: baseChanged
        ? `revised $${toDisplay(prevFixed.amountPerQuarter)}→$${toDisplay(currFixed.amountPerQuarter)} a quarter`
        : yearRolled
          ? `${(currFixed.annualEscalatorPct * 100).toFixed(0)}% annual escalator applied`
          : 'contract terms moved',
      amount: delta,
      ...lookup(`costs.${costId}.amountPerQuarter`),
    };
  }

  const prevVar = prevBusiness.costs.variableWithRevenue.find((c) => c.id === costId);
  const currVar = currBusiness.costs.variableWithRevenue.find((c) => c.id === costId);
  if (prevVar && currVar) {
    const rateChanged = prevVar.pctOfRevenue !== currVar.pctOfRevenue;
    return {
      label,
      explanation: rateChanged
        ? `rate revised ${(prevVar.pctOfRevenue * 100).toFixed(1)}%→${(currVar.pctOfRevenue * 100).toFixed(1)}% of revenue`
        : `follows revenue at ${(currVar.pctOfRevenue * 100).toFixed(1)}%`,
      amount: delta,
      ...lookup(`costs.${costId}.pctOfRevenue`),
    };
  }

  const prevAct = prevBusiness.costs.variableWithActivity.find((c) => c.id === costId);
  const currAct = currBusiness.costs.variableWithActivity.find((c) => c.id === costId);
  if (prevAct && currAct) {
    const rateChanged = prevAct.costPerUnit !== currAct.costPerUnit;
    const prevVol = prevMetrics.reduce((a, s) => a + s.realizedVolume, 0);
    const currVol = currMetrics.reduce((a, s) => a + s.realizedVolume, 0);
    return {
      label,
      explanation: rateChanged
        ? `unit cost revised $${toDisplay(prevAct.costPerUnit)}→$${toDisplay(currAct.costPerUnit)}`
        : `follows volume, ${Math.round(prevVol).toLocaleString()}→${Math.round(currVol).toLocaleString()} served`,
      amount: delta,
      ...lookup(`costs.${costId}.costPerUnit`),
    };
  }

  if (costId.startsWith('marketing:')) {
    return {
      label,
      explanation: 'marketing spend changed — a lever, not an assumption',
      amount: delta,
    };
  }

  return { label, explanation: 'cost basis moved', amount: delta };
}
