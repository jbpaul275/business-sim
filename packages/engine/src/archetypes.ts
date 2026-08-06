import { mulRate, ratio, type Money } from '@bizsim/money';
import {
  ARCHETYPE_DRIVER,
  type ArchetypeParams,
  type PeriodIndex,
  type RevenueStream,
  type StreamMetrics,
  type StreamState,
  type VolumeDriver,
} from '@bizsim/schemas';
import type { TickContext } from './context.js';
import {
  count,
  factor as asFactor,
  figureId,
  money as asMoney,
  number as asNumber,
  rate as asRate,
  type DerivationStep,
} from './derivation.js';
import {
  clamp,
  effectiveCac,
  marketingMultiplier,
  maturityRamp,
  priceEffect,
  seasonalityFactor,
  serviceComplexityFactor,
  spendRatio,
} from './modifiers.js';

/**
 * Revenue archetypes — spec §3.
 *
 * Each archetype is two functions:
 *
 *   demand()  — UNCONSTRAINED demand, computed before any capacity is applied.
 *   realize() — demand capped by capacity, plus revenue and carried state.
 *
 * The split is not stylistic. Spec §4.3 requires step-fixed staffing to be
 * driven by unconstrained demand, never by realized volume: realized volume is
 * already capped by staffing, so feeding it back as the staffing signal locks
 * the business at whatever headcount it started with forever. Keeping demand in
 * its own function means the staffing calculation cannot accidentally see the
 * capped number. See §13.5's under-staffing trap regression.
 */

export interface DemandResult {
  streamId: string;
  driver: VolumeDriver;
  /** In driver units. For the REVENUE driver, cents expressed as a number. */
  demandVolume: number;
  /** Physical ceiling independent of staffing, or null if none applies. */
  physicalCapacity: number | null;
  priceClamped: boolean;
  priceMultiplier: number;
  marketingMultiplier: number;
  rampFactor: number;
}

export interface RealizeResult {
  streamId: string;
  realizedVolume: number;
  lostDemand: number;
  revenue: Money;
  newState: StreamState;
  /** Realized volumes by driver, for VARIABLE_ACTIVITY costs (§4.2). */
  activity: Partial<Record<VolumeDriver, number>>;
  metrics: StreamMetrics;
  /** SUBSCRIPTION prepay (§5.3). */
  deferredCashCollected?: Money;
  recognizedSubscriptionRevenue?: Money;
  /** PROJECT_BACKLOG (§3.6). */
  retainageWithheld?: Money;
  retainageReleased?: Money;
}

const quartersSinceLaunch = (stream: RevenueStream, period: PeriodIndex): number =>
  period - stream.launchPeriod;

/** The price field `SET_PRICE` targets, per archetype (§3.0.1). */
export function streamPrice(stream: RevenueStream): Money {
  const p = stream.params;
  switch (p.kind) {
    case 'TRAFFIC':
      return p.avgTicket;
    case 'UTILIZATION':
      return p.blendedHourlyRate;
    case 'UNITS_CAC':
      return p.avgOrderValue;
    case 'SUBSCRIPTION':
      return p.arpuPerQuarter;
    case 'OCCUPANCY':
      return p.ratePerUnitPerQuarter;
    case 'PROJECT_BACKLOG':
      return p.avgContractValue;
  }
}

export function setStreamPrice(stream: RevenueStream, price: Money): void {
  const p = stream.params;
  switch (p.kind) {
    case 'TRAFFIC':
      p.avgTicket = price;
      break;
    case 'UTILIZATION':
      p.blendedHourlyRate = price;
      break;
    case 'UNITS_CAC':
      p.avgOrderValue = price;
      break;
    case 'SUBSCRIPTION':
      p.arpuPerQuarter = price;
      break;
    case 'OCCUPANCY':
      p.ratePerUnitPerQuarter = price;
      break;
    case 'PROJECT_BACKLOG':
      p.avgContractValue = price;
      break;
  }
}

/**
 * Whether marketing spend moves demand at all for this archetype.
 *
 * A hotel owner raised marketing to $18k a quarter, watched nothing happen, and
 * was told the spend had "saturated" — an explanation of a curve that is not
 * being evaluated. For OCCUPANCY the multiplier is not diminishing, it is
 * absent: the spend is expensed and drives nothing. The advisor has to be able
 * to say that, and it has to read it from the same table the engine uses.
 */
export function marketingMovesDemand(kind: ArchetypeParams['kind']): boolean {
  return APPLIES[kind].marketing;
}

/** Spec §3.0.2 — the exemptions are deliberate, not oversights. */
const APPLIES = {
  TRAFFIC: { ramp: true, marketing: true },
  UTILIZATION: { ramp: true, marketing: true },
  UNITS_CAC: { ramp: false, marketing: true },
  SUBSCRIPTION: { ramp: true, marketing: true },
  OCCUPANCY: { ramp: true, marketing: false },
  PROJECT_BACKLOG: { ramp: false, marketing: true },
} as const;

/**
 * The shared multipliers a stream's demand carried in a given period — §10.4's
 * raw material. Pure in (stream, period), exactly like the fragment of
 * `computeDemand` it mirrors, so attribution can recompute last quarter's
 * factors from last quarter's state instead of asking the tick to have saved
 * them.
 *
 * `season` is 1 for PROJECT_BACKLOG because `computeDemand` never applies it
 * there: backlog is the anti-seasonal mechanism, work signed in the busy
 * quarter executes in the slow one. For UNITS_CAC and SUBSCRIPTION the factor
 * touches only part of demand (repeat orders, adds), so a decomposition using
 * these is approximate for those kinds — the residual absorbs the difference.
 */
export interface DemandFactors {
  season: number;
  ramp: number;
  marketing: number;
  /** The demand response to price — `priceEffect().multiplier`. */
  priceResponse: number;
  /** The price itself — revenue per unit moves with it directly. */
  priceLevel: Money;
}

export function demandFactors(stream: RevenueStream, period: PeriodIndex): DemandFactors {
  const m = stream.modifiers;
  const applies = APPLIES[stream.params.kind];
  const price = streamPrice(stream);
  const pe = priceEffect(price, stream.params.referencePrice, m.priceElasticity);
  return {
    season:
      stream.params.kind === 'PROJECT_BACKLOG'
        ? 1
        : seasonalityFactor(stream.seasonality, period),
    ramp: applies.ramp
      ? maturityRamp(period - stream.launchPeriod, m.rampFloor, m.rampConstant)
      : 1,
    marketing: applies.marketing
      ? marketingMultiplier(stream.marketingSpendPerQuarter, m.marketingMaxLift, m.halfSaturationSpend)
      : 1,
    priceResponse: pe.multiplier,
    priceLevel: price,
  };
}

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

export function computeDemand(
  ctx: TickContext,
  stream: RevenueStream,
  period: PeriodIndex,
): DemandResult {
  const path = `streams.${stream.id}`;
  const m = stream.modifiers;
  const q = quartersSinceLaunch(stream, period);
  const applies = APPLIES[stream.params.kind];

  const price = streamPrice(stream);
  const reference = ctx.p(`${path}.params.referencePrice`, stream.params.referencePrice);
  const elasticity = ctx.p(`${path}.modifiers.priceElasticity`, m.priceElasticity);
  const pe = priceEffect(price, reference, elasticity);

  const mkt = applies.marketing
    ? marketingMultiplier(
        stream.marketingSpendPerQuarter,
        ctx.p(`${path}.modifiers.marketingMaxLift`, m.marketingMaxLift),
        ctx.p(`${path}.modifiers.halfSaturationSpend`, m.halfSaturationSpend),
      )
    : 1;

  const ramp = applies.ramp
    ? maturityRamp(
        q,
        ctx.p(`${path}.modifiers.rampFloor`, m.rampFloor),
        ctx.p(`${path}.modifiers.rampConstant`, m.rampConstant),
      )
    : 1;

  const season = seasonalityFactor(stream.seasonality, period);

  /**
   * The factors every archetype shares, in the order the formulas apply them.
   * Built only when something will read them (§16 Q3) — the property suite
   * ticks this path 240,000 times and never opens a math panel.
   */
  const commonFactors = (opts: { marketing: boolean; ramp: boolean; season: boolean }): DerivationStep[] => {
    const steps: DerivationStep[] = [];
    if (opts.marketing && applies.marketing) {
      steps.push({
        label: 'Marketing lift',
        value: asFactor(mkt),
        op: '×',
        path: `${path}.modifiers.marketingMaxLift`,
        note: 'from this quarter’s marketing spend, at diminishing returns',
      });
    }
    steps.push({
      label: 'Price response',
      value: asFactor(pe.multiplier),
      op: '×',
      path: `${path}.modifiers.priceElasticity`,
      ...(pe.clamped ? { note: 'clamped — the price is outside the elastic range' } : {}),
    });
    if (opts.ramp && applies.ramp) {
      steps.push({
        label: `Maturity ramp, quarter ${q + 1}`,
        value: asFactor(ramp),
        op: '×',
        path: `${path}.modifiers.rampFloor`,
      });
    }
    if (opts.season) {
      steps.push({
        label: 'Seasonality',
        value: asFactor(season),
        op: '×',
        path: `${path}.seasonality`,
      });
    }
    return steps;
  };

  /** Record the chain that produced this stream's unconstrained demand. */
  const recordDemand = (steps: DerivationStep[], result: DemandResult['demandVolume'] | Money): void => {
    if (!ctx.tracing) return;
    ctx.derive(figureId.streamDemand(stream.id), {
      label: `${stream.label} — demand before capacity`,
      line: 'incomeStatement.revenue',
      steps,
      result:
        typeof result === 'bigint' ? asMoney(result) : count(result, stream.volumeNoun),
    });
  };

  const base: Omit<DemandResult, 'demandVolume' | 'physicalCapacity'> = {
    streamId: stream.id,
    driver: ARCHETYPE_DRIVER[stream.params.kind],
    priceClamped: pe.clamped,
    priceMultiplier: pe.multiplier,
    marketingMultiplier: mkt,
    rampFactor: ramp,
  };

  const p = stream.params;
  switch (p.kind) {
    case 'TRAFFIC': {
      const demand =
        ctx.p(`${path}.params.addressableTrafficPerQuarter`, p.addressableTrafficPerQuarter) *
        ctx.p(`${path}.params.captureRate`, p.captureRate) *
        mkt *
        pe.multiplier *
        ramp *
        season;

      const days = ctx.p(`${path}.params.operatingDaysPerQuarter`, p.operatingDaysPerQuarter);
      const raw =
        p.capacityModel.kind === 'SEAT_TURNS'
          ? ctx.p(`${path}.params.capacityModel.seats`, p.capacityModel.seats) *
            ctx.p(`${path}.params.capacityModel.turnsPerDay`, p.capacityModel.turnsPerDay) *
            days
          : ctx.p(
              `${path}.params.capacityModel.transactionsPerHour`,
              p.capacityModel.transactionsPerHour,
            ) *
            ctx.p(
              `${path}.params.capacityModel.operatingHoursPerDay`,
              p.capacityModel.operatingHoursPerDay,
            ) *
            days;

      const complexity = serviceComplexityFactor(
        ctx.p(`${path}.params.skuCount`, p.skuCount),
        p.baselineSkuCount,
      );
      const effective = raw / complexity;
      const peak = ctx.p(`${path}.params.peakConcentration`, p.peakConcentration);
      const physical = effective * (1 - 0.5 * Math.max(0, peak - 0.35));

      if (ctx.tracing) {
        recordDemand(
          [
            {
              label: 'Addressable traffic',
              value: count(p.addressableTrafficPerQuarter, 'passers-by'),
              path: `${path}.params.addressableTrafficPerQuarter`,
            },
            {
              label: 'Capture rate',
              value: asRate(p.captureRate),
              op: '×',
              path: `${path}.params.captureRate`,
            },
            ...commonFactors({ marketing: true, ramp: true, season: true }),
          ],
          demand,
        );
      }
      return { ...base, demandVolume: demand, physicalCapacity: physical };
    }

    case 'UTILIZATION': {
      const demandHours =
        ctx.p(`${path}.params.demandHoursPerQuarter`, p.demandHoursPerQuarter) *
        mkt *
        pe.multiplier *
        ramp *
        season;
      if (ctx.tracing) {
        recordDemand(
          [
            {
              label: 'Hours the market wants',
              value: count(p.demandHoursPerQuarter, 'hours'),
              path: `${path}.params.demandHoursPerQuarter`,
            },
            ...commonFactors({ marketing: true, ramp: true, season: true }),
          ],
          demandHours,
        );
      }
      // Capacity is entirely a function of staffed blocks (§3.2, §4.3), so
      // there is no physical ceiling independent of headcount.
      return { ...base, demandVolume: demandHours, physicalCapacity: null };
    }

    case 'UNITS_CAC': {
      const cac = effectiveCac(
        ctx.p(`${path}.params.baseCac`, p.baseCac),
        ctx.p(`${path}.params.cacInflationCoefficient`, p.cacInflationCoefficient),
        spendRatio(stream.marketingSpendPerQuarter, m),
      );
      const newCustomers = cac > 0n ? ratio(stream.marketingSpendPerQuarter, cac) : 0;
      const begin = stream.state.customers ?? 0;
      const repeatOrders =
        begin * ctx.p(`${path}.params.repeatPurchaseRatePerQuarter`, p.repeatPurchaseRatePerQuarter) * season;
      const newOrders =
        newCustomers *
        ctx.p(`${path}.params.ordersPerNewCustomerFirstQuarter`, p.ordersPerNewCustomerFirstQuarter);
      const orders = (newOrders + repeatOrders) * pe.multiplier;
      if (ctx.tracing) {
        recordDemand(
          [
            { label: 'Marketing spend', value: asMoney(stream.marketingSpendPerQuarter) },
            {
              label: 'Effective acquisition cost',
              value: asMoney(cac),
              op: '÷',
              path: `${path}.params.baseCac`,
              note: 'the base CAC, inflated by spending above the reference level',
            },
            {
              label: 'Orders per new customer',
              value: asNumber(p.ordersPerNewCustomerFirstQuarter),
              op: '×',
              path: `${path}.params.ordersPerNewCustomerFirstQuarter`,
            },
            {
              label: 'Repeat orders',
              value: count(repeatOrders, 'orders'),
              op: '+',
              path: `${path}.params.repeatPurchaseRatePerQuarter`,
              note: `from ${Math.round(begin).toLocaleString('en-US')} existing customers, after seasonality`,
            },
            ...commonFactors({ marketing: false, ramp: false, season: false }),
          ],
          Math.max(0, orders),
        );
      }
      return { ...base, demandVolume: Math.max(0, orders), physicalCapacity: null };
    }

    case 'SUBSCRIPTION': {
      const cac = effectiveCac(
        ctx.p(`${path}.params.baseCac`, p.baseCac),
        ctx.p(`${path}.params.cacInflationCoefficient`, p.cacInflationCoefficient),
        spendRatio(stream.marketingSpendPerQuarter, m),
      );
      const adds =
        (cac > 0n ? ratio(stream.marketingSpendPerQuarter, cac) : 0) * pe.multiplier * ramp * season;
      const begin = stream.state.subscribers ?? 0;
      const churn = ctx.p(`${path}.params.quarterlyChurnRate`, p.quarterlyChurnRate);
      if (ctx.tracing) {
        recordDemand(
          [
            { label: 'Subscribers at the start', value: count(begin, 'subscribers') },
            {
              label: 'Additions',
              value: count(Math.max(0, adds), 'subscribers'),
              op: '+',
              path: `${path}.params.baseCac`,
              note: 'marketing spend ÷ effective CAC, after price, ramp and seasonality',
            },
            {
              label: 'Churn',
              value: count(begin * churn, 'subscribers'),
              op: '−',
              path: `${path}.params.quarterlyChurnRate`,
            },
          ],
          Math.max(0, begin + Math.max(0, adds) - begin * churn),
        );
      }
      // Demand volume is the ending subscriber count this stream is reaching for.
      return {
        ...base,
        demandVolume: Math.max(0, begin + Math.max(0, adds) - begin * churn),
        physicalCapacity: null,
      };
    }

    case 'OCCUPANCY': {
      const occupancy = clamp(
        ctx.p(`${path}.params.stabilizedOccupancy`, p.stabilizedOccupancy) *
          ramp *
          pe.multiplier *
          season,
        0,
        1,
      );
      const units = ctx.p(`${path}.params.units`, p.units);
      if (ctx.tracing) {
        recordDemand(
          [
            { label: 'Units', value: count(units, 'units'), path: `${path}.params.units` },
            {
              label: 'Occupancy reached',
              value: asRate(occupancy),
              op: '×',
              path: `${path}.params.stabilizedOccupancy`,
              note: 'the stabilized rate, after ramp, price response and seasonality',
            },
          ],
          units * occupancy,
        );
      }
      return { ...base, demandVolume: units * occupancy, physicalCapacity: units };
    }

    case 'PROJECT_BACKLOG': {
      const effWinRate = clamp(
        ctx.p(`${path}.params.winRate`, p.winRate) * pe.multiplier * mkt,
        0,
        1,
      );
      const wins = ctx.p(`${path}.params.bidsSubmittedPerQuarter`, p.bidsSubmittedPerQuarter) * effWinRate;
      const newBacklog = mulRate(
        ctx.p(`${path}.params.avgContractValue`, p.avgContractValue),
        wins * (1 + ctx.p(`${path}.params.changeOrderPctOfContract`, p.changeOrderPctOfContract)),
      );
      const available = (stream.state.backlog ?? 0n) + newBacklog;
      if (ctx.tracing) {
        recordDemand(
          [
            {
              label: 'Bids submitted',
              value: count(p.bidsSubmittedPerQuarter, 'bids'),
              path: `${path}.params.bidsSubmittedPerQuarter`,
            },
            {
              label: 'Effective win rate',
              value: asRate(effWinRate),
              op: '×',
              path: `${path}.params.winRate`,
              note: 'the base win rate, after price response and marketing',
            },
            {
              label: 'Average contract value',
              value: asMoney(p.avgContractValue),
              op: '×',
              path: `${path}.params.avgContractValue`,
            },
            {
              label: 'Change orders',
              value: asFactor(1 + p.changeOrderPctOfContract),
              op: '×',
              path: `${path}.params.changeOrderPctOfContract`,
            },
            {
              label: 'Backlog carried in',
              value: asMoney(stream.state.backlog ?? 0n),
              op: '+',
              note: 'work won in earlier quarters and not yet executed',
            },
          ],
          available,
        );
      }
      // Demand is denominated in revenue dollars; the ceiling is the crew.
      return {
        ...base,
        demandVolume: Number(available),
        physicalCapacity: Number(
          ctx.p(`${path}.params.executionCapacityPerQuarter`, p.executionCapacityPerQuarter),
        ),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Realization
// ---------------------------------------------------------------------------

export function realize(
  ctx: TickContext,
  stream: RevenueStream,
  period: PeriodIndex,
  demand: DemandResult,
  /** Staffed capacity allocated to this stream, or null if unconstrained. */
  staffedCapacity: number | null,
  contributionMarginPct: number,
): RealizeResult {
  const path = `streams.${stream.id}`;
  const p = stream.params;
  const m = stream.modifiers;

  const ceilings = [demand.physicalCapacity, staffedCapacity].filter(
    (c): c is number => c !== null && Number.isFinite(c),
  );
  const capacity = ceilings.length > 0 ? Math.min(...ceilings) : Number.POSITIVE_INFINITY;
  const realized = Math.max(0, Math.min(demand.demandVolume, capacity));
  const lost = Math.max(0, demand.demandVolume - realized);

  const state: StreamState = {
    ...stream.state,
    quartersSinceLaunch: quartersSinceLaunch(stream, period),
  };

  const metrics: StreamMetrics = {
    streamId: stream.id,
    label: stream.label,
    archetype: p.kind,
    demandVolume: demand.demandVolume,
    realizedVolume: realized,
    lostDemand: lost,
    // Only when something actually binds. An archetype with no ceiling reports
    // nothing rather than reporting Infinity, because "capacity ∞" and "no
    // capacity model" are different statements and the player deserves the
    // second one.
    ...(Number.isFinite(capacity) ? { capacityVolume: capacity } : {}),
    revenue: 0n,
    contributionMarginPct,
  };

  /**
   * Demand, less whatever capacity refused, is where every archetype's revenue
   * starts. Naming which ceiling bound matters more than the number: "we turned
   * away 400 visits" is a different decision from "we turned away 400 visits
   * because the counter is too small" (§16 Q3).
   */
  const servedSteps = (noun?: string): DerivationStep[] => {
    const steps: DerivationStep[] = [
      { label: 'Demand before capacity', value: count(demand.demandVolume, noun) },
    ];
    if (lost > 0.5) {
      const staffedBinds =
        staffedCapacity !== null && staffedCapacity <= (demand.physicalCapacity ?? Infinity);
      steps.push({
        label: 'Turned away',
        value: count(lost, noun),
        op: '−',
        note: staffedBinds
          ? 'staffing capped what could be served'
          : 'the physical ceiling capped what could be served',
      });
    }
    return steps;
  };

  const recordRevenue = (steps: DerivationStep[], revenue: Money): void => {
    if (!ctx.tracing) return;
    ctx.derive(figureId.streamRevenue(stream.id), {
      label: `${stream.label} — revenue`,
      line: 'incomeStatement.revenue',
      steps,
      result: asMoney(revenue),
    });
  };

  switch (p.kind) {
    case 'TRAFFIC': {
      const revenue = mulRate(ctx.p(`${path}.params.avgTicket`, p.avgTicket), realized);
      recordRevenue(
        [
          ...servedSteps(stream.volumeNoun),
          {
            label: 'Average ticket',
            value: asMoney(p.avgTicket),
            op: '×',
            path: `${path}.params.avgTicket`,
          },
        ],
        revenue,
      );
      state.cumulativeLostDemand = (stream.state.cumulativeLostDemand ?? 0) + lost;
      metrics.revenue = revenue;
      return {
        streamId: stream.id,
        realizedVolume: realized,
        lostDemand: lost,
        revenue,
        newState: state,
        activity: { TRANSACTIONS: realized },
        metrics,
      };
    }

    case 'UTILIZATION': {
      // Cap at GROSS capacity, not at target utilization — a team can run hot
      // in a good quarter, and both break-even utilization (§8.5) and the
      // post-mortem (§9.4) need realizedUtilization to be able to exceed target.
      const gross = staffedCapacity ?? demand.demandVolume;
      const billableHours = realized;
      const realization = ctx.p(`${path}.params.realizationRate`, p.realizationRate);
      const revenue = mulRate(
        ctx.p(`${path}.params.blendedHourlyRate`, p.blendedHourlyRate),
        billableHours * realization,
      );
      const target = ctx.p(`${path}.params.targetUtilization`, p.targetUtilization);
      recordRevenue(
        [
          ...servedSteps('hours'),
          {
            label: 'Realization rate',
            value: asRate(realization),
            op: '×',
            path: `${path}.params.realizationRate`,
            note: 'the share of worked hours that survives to an invoice',
          },
          {
            label: 'Blended hourly rate',
            value: asMoney(p.blendedHourlyRate),
            op: '×',
            path: `${path}.params.blendedHourlyRate`,
          },
        ],
        revenue,
      );
      metrics.revenue = revenue;
      metrics.realizedUtilization = gross > 0 ? billableHours / gross : 0;
      metrics.benchStress = Math.max(0, gross * target - billableHours);
      return {
        streamId: stream.id,
        realizedVolume: billableHours,
        lostDemand: lost,
        revenue,
        newState: state,
        activity: { BILLABLE_HOURS: billableHours },
        metrics,
      };
    }

    case 'UNITS_CAC': {
      const cac = effectiveCac(p.baseCac, p.cacInflationCoefficient, spendRatio(stream.marketingSpendPerQuarter, m));
      const newCustomers = cac > 0n ? ratio(stream.marketingSpendPerQuarter, cac) : 0;
      const begin = stream.state.customers ?? 0;
      const attrition = ctx.p(`${path}.params.quarterlyCustomerAttrition`, p.quarterlyCustomerAttrition);
      state.customers = Math.max(0, (begin + newCustomers) * (1 - attrition));

      const aov = ctx.p(`${path}.params.avgOrderValue`, p.avgOrderValue);
      const revenue = mulRate(aov, realized);
      recordRevenue(
        [
          ...servedSteps('orders'),
          {
            label: 'Average order value',
            value: asMoney(aov),
            op: '×',
            path: `${path}.params.avgOrderValue`,
          },
        ],
        revenue,
      );
      const perQuarterOrders = p.repeatPurchaseRatePerQuarter;
      metrics.revenue = revenue;
      metrics.effectiveCac = cac;
      metrics.cacPaybackQuarters =
        perQuarterOrders > 0 && contributionMarginPct > 0 && aov > 0n
          ? ratio(cac, mulRate(aov, contributionMarginPct * perQuarterOrders))
          : Number.POSITIVE_INFINITY;
      return {
        streamId: stream.id,
        realizedVolume: realized,
        lostDemand: lost,
        revenue,
        newState: state,
        activity: { ORDERS: realized },
        metrics,
      };
    }

    case 'SUBSCRIPTION': {
      const begin = stream.state.subscribers ?? 0;
      const churnRate = ctx.p(`${path}.params.quarterlyChurnRate`, p.quarterlyChurnRate);
      const churned = begin * churnRate;
      // `realized` is the capacity-capped ending subscriber count; back out how
      // many adds actually landed so setup fees and prepay use the same number.
      const endSubs = Math.max(0, realized);
      const adds = Math.max(0, endSubs - begin + churned);
      state.subscribers = endSubs;
      const avgSubs = (begin + endSubs) / 2;

      const arpu = ctx.p(`${path}.params.arpuPerQuarter`, p.arpuPerQuarter);
      const nrr = ctx.p(`${path}.params.netRevenueRetention`, p.netRevenueRetention);
      // This exact figure — with NRR, without setup fees — is what the deferred
      // revenue rollforward in §5.3 recognises. The two sections must agree or
      // the deferred balance will not tie.
      const subscriptionRevenue = mulRate(arpu, avgSubs * nrr);
      const setupRevenue = mulRate(ctx.p(`${path}.params.setupFee`, p.setupFee), adds);
      const revenue = subscriptionRevenue + setupRevenue;
      recordRevenue(
        [
          {
            label: 'Average subscribers',
            value: count(avgSubs, 'subscribers'),
            note: 'the mean of the opening and closing counts — nobody pays a full quarter for half a quarter',
          },
          { label: 'ARPU', value: asMoney(arpu), op: '×', path: `${path}.params.arpuPerQuarter` },
          {
            label: 'Net revenue retention',
            value: asFactor(nrr),
            op: '×',
            path: `${path}.params.netRevenueRetention`,
          },
          ...(setupRevenue !== 0n
            ? [
                {
                  label: 'Setup fees',
                  value: asMoney(setupRevenue),
                  op: '+' as const,
                  path: `${path}.params.setupFee`,
                  note: `on ${Math.round(adds).toLocaleString('en-US')} new subscribers`,
                },
              ]
            : []),
        ],
        revenue,
      );

      const prepayMonths = ctx.p(`${path}.params.prepayMonths`, p.prepayMonths);
      let deferredCashCollected: Money | undefined;
      if (prepayMonths > 0) {
        // Prepay is collected from new subscribers AND from renewals. Omitting
        // renewals drains the deferred balance negative within a few years.
        const renewals = begin * (1 - churnRate) * (3 / Math.max(3, prepayMonths));
        deferredCashCollected = mulRate(arpu, (adds + renewals) * (prepayMonths / 3));
      }

      metrics.revenue = revenue;
      const cac = effectiveCac(p.baseCac, p.cacInflationCoefficient, spendRatio(stream.marketingSpendPerQuarter, m));
      metrics.ltvToCac =
        churnRate > 0 && cac > 0n
          ? ratio(mulRate(arpu, contributionMarginPct / churnRate), cac)
          : Number.POSITIVE_INFINITY;

      return {
        streamId: stream.id,
        realizedVolume: endSubs,
        lostDemand: lost,
        revenue,
        newState: state,
        activity: { SUBSCRIBERS: endSubs },
        metrics,
        ...(deferredCashCollected !== undefined ? { deferredCashCollected } : {}),
        recognizedSubscriptionRevenue: subscriptionRevenue,
      };
    }

    case 'OCCUPANCY': {
      const occupiedUnits = realized;
      const units = p.units;
      const occupancy = units > 0 ? occupiedUnits / units : 0;
      state.currentOccupancy = occupancy;
      const concessions = ctx.p(`${path}.params.concessionsPct`, p.concessionsPct);
      const baseRevenue = mulRate(
        ctx.p(`${path}.params.ratePerUnitPerQuarter`, p.ratePerUnitPerQuarter),
        occupiedUnits * (1 - concessions),
      );
      // Bad debt is NOT applied here — the omission guard injects it once as a
      // VARIABLE_REVENUE line (§4.6). Applying it in both places double-counts.
      const ancillary = mulRate(
        baseRevenue,
        ctx.p(`${path}.params.ancillaryRevenuePctOfBase`, p.ancillaryRevenuePctOfBase),
      );
      const revenue = baseRevenue + ancillary;
      recordRevenue(
        [
          { label: 'Units occupied', value: count(occupiedUnits, 'units') },
          {
            label: 'Rate per unit',
            value: asMoney(p.ratePerUnitPerQuarter),
            op: '×',
            path: `${path}.params.ratePerUnitPerQuarter`,
          },
          {
            label: 'After concessions',
            value: asFactor(1 - concessions),
            op: '×',
            path: `${path}.params.concessionsPct`,
            note: 'free months and move-in discounts',
          },
          ...(ancillary !== 0n
            ? [
                {
                  label: 'Ancillary revenue',
                  value: asMoney(ancillary),
                  op: '+' as const,
                  path: `${path}.params.ancillaryRevenuePctOfBase`,
                },
              ]
            : []),
        ],
        revenue,
      );
      metrics.revenue = revenue;
      metrics.occupancy = occupancy;
      return {
        streamId: stream.id,
        realizedVolume: occupiedUnits,
        lostDemand: lost,
        revenue,
        newState: state,
        activity: { OCCUPIED_UNITS: occupiedUnits },
        metrics,
      };
    }

    case 'PROJECT_BACKLOG': {
      const effWinRate = clamp(p.winRate * demand.priceMultiplier * demand.marketingMultiplier, 0, 1);
      const wins = p.bidsSubmittedPerQuarter * effWinRate;
      const newBacklog = mulRate(p.avgContractValue, wins * (1 + p.changeOrderPctOfContract));
      const available = (stream.state.backlog ?? 0n) + newBacklog;

      // `realized` is dollars-as-number; convert back at the money boundary.
      const revenue = BigInt(Math.round(realized));
      const recognized = revenue > available ? available : revenue;
      state.backlog = available - recognized;

      const retainagePct = ctx.p(`${path}.params.retainagePct`, p.retainagePct);
      const retainageWithheld = mulRate(recognized, retainagePct);
      const schedule = [...(stream.state.retainageSchedule ?? [])];
      let retainageReleased = 0n;
      const remaining: { period: PeriodIndex; amount: Money }[] = [];
      for (const entry of schedule) {
        if (entry.period <= period) retainageReleased += entry.amount;
        else remaining.push(entry);
      }
      if (retainageWithheld > 0n) {
        remaining.push({
          period: period + p.retainageReleaseLagQuarters,
          amount: retainageWithheld,
        });
      }
      state.retainageSchedule = remaining;

      recordRevenue(
        [
          {
            label: 'Backlog available to execute',
            value: asMoney(available),
            note: 'work carried in, plus what this quarter’s bids won',
          },
          {
            label: 'Executed this quarter',
            value: asMoney(recognized),
            note:
              recognized < available
                ? 'the crew could not get through all of it'
                : 'the crew got through all of it',
          },
        ],
        recognized,
      );
      metrics.revenue = recognized;
      metrics.backlogCoverageQuarters =
        p.executionCapacityPerQuarter > 0n ? ratio(state.backlog, p.executionCapacityPerQuarter) : 0;

      return {
        streamId: stream.id,
        realizedVolume: Number(recognized),
        lostDemand: lost,
        revenue: recognized,
        newState: state,
        activity: {
          REVENUE: Number(recognized),
          PROJECTS_ACTIVE: p.avgContractValue > 0n ? ratio(recognized, p.avgContractValue) : 0,
        },
        metrics,
        retainageWithheld,
        retainageReleased,
      };
    }
  }
}

/** Days-sales-outstanding for a stream (docs/plan/03-spec-gaps.md G-5). */
export function streamDsoDays(stream: RevenueStream, businessDsoDays: number): number {
  if (stream.dsoDaysOverride !== undefined) return stream.dsoDaysOverride;
  if (stream.params.kind === 'PROJECT_BACKLOG') return stream.params.progressBillingLagDays;
  return businessDsoDays;
}
