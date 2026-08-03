import { describe, expect, it } from 'vitest';
import { fromDisplay, type Money } from '@bizsim/money';
import {
  buildModelFromTemplate,
  createWorld,
  createWorldConfig,
  tick,
  type TickResult,
} from '@bizsim/engine';
import { getSeedTemplate } from '@bizsim/seeds';
import type { Business, StreamMetrics, WorldState } from '@bizsim/schemas';
import { priceOptimum, priceUnits } from './pricing.js';

/**
 * "what's the optimal price?"
 *
 * Asked by a hotel owner in period 8 of a run that was working, and answered
 * with the elasticity paragraph he had already been shown twice — which never
 * contained a price. The question has an arithmetic answer and the engine holds
 * every term of it.
 */

interface Fixture {
  business: Business;
  metrics: StreamMetrics;
  price: Money;
}

/**
 * A lodging business with a per-room-night cost and elastic guests.
 *
 * The self-storage template is the only OCCUPANCY seed, and it is drafted with
 * an elasticity of exactly 1 and no per-unit variable cost — the one corner
 * where the optimum is a plateau and the argmax is noise. Both are adjusted
 * here rather than worked around, because a pricing test on a business with no
 * pricing decision tests nothing.
 */
function hotel(
  options: {
    elasticity?: number;
    perUnitCost?: number;
    units?: number;
    price?: number;
    quarters?: number;
  } = {},
): Fixture {
  const model = buildModelFromTemplate({
    businessName: 'Reference Hotel',
    template: getSeedTemplate('self_storage'),
    scale: {
      units: options.units ?? 64,
      price: fromDisplay(options.price ?? 8_213),
    },
    equityInjection: fromDisplay(2_400_000),
  });
  model.streams[0]!.label = 'Guest rooms';
  model.streams[0]!.modifiers.priceElasticity = options.elasticity ?? 1.6;
  if (options.perUnitCost !== undefined) {
    model.costs.variableWithActivity.push({
      id: 'housekeeping',
      label: 'Housekeeping and linen',
      class: 'VARIABLE_ACTIVITY',
      driver: 'OCCUPIED_UNITS',
      costPerUnit: fromDisplay(options.perUnitCost),
      statementLine: 'COGS',
      appliesToStreamIds: 'ALL',
      accruable: true,
    });
  }

  let state: WorldState = createWorld({
    id: 'hotel',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });

  // Far enough in that the ramp has finished and the numbers are the mature
  // ones a player would be asking about.
  let result: TickResult | undefined;
  for (let i = 0; i < (options.quarters ?? 12); i++) {
    result = tick(state, [], { throwOnAssertionFailure: true });
    state = result.state;
  }
  const business = state.businesses[0]!;
  const metrics = result!.statements.byBusiness[business.id]!.derivedMetrics.streamMetrics[0]!;
  const params = business.streams[0]!.params;
  if (params.kind !== 'OCCUPANCY') throw new Error('fixture is not an occupancy business');
  return { business, metrics, price: params.ratePerUnitPerQuarter };
}

describe('the price the model actually implies', () => {
  it('finds the contribution peak the closed form predicts', () => {
    // Contribution is `A·P^-ε·(kP − a)`, so the interior optimum is
    // `P* = εa / (k(ε−1))`. The implementation walks a grid instead of solving
    // this, because the closed form is wrong wherever capacity binds and
    // undefined at ε ≤ 1 — but where it IS valid, the two must agree, and that
    // is the only cheap check on the grid being the right curve.
    // The per-unit cost has to be a real share of the rate for the peak to be
    // interior at all: below about 35% of price the optimum sits down where
    // every room is full, and capacity — not the curve — is what stops it.
    const { business, metrics, price } = hotel({ elasticity: 1.6, perUnitCost: 4_000 });
    const optimum = priceOptimum(business, business.streams[0]!, metrics, price);
    expect(optimum).toBeDefined();

    const revenuePerUnit = Number(metrics.revenue) / metrics.realizedVolume;
    const pctOfRevenue = business.costs.variableWithRevenue.reduce(
      (a, c) => a + c.pctOfRevenue,
      0,
    );
    const k = (revenuePerUnit / Number(price)) * (1 - pctOfRevenue);
    const a = Number(fromDisplay(4_000));
    const closedForm = (1.6 * a) / (k * 0.6);

    expect(Number(optimum!.price)).toBeGreaterThan(closedForm * 0.97);
    expect(Number(optimum!.price)).toBeLessThan(closedForm * 1.03);
    expect(optimum!.binding).toBe('CONTRIBUTION');
    expect(optimum!.flat).toBe(false);
  });

  it('reports more contribution at the price it recommends than at today’s', () => {
    // The whole claim. If this can fail, the recommendation is a number with a
    // sentence attached rather than an answer.
    const { business, metrics, price } = hotel({ elasticity: 1.6, perUnitCost: 4_000 });
    const optimum = priceOptimum(business, business.streams[0]!, metrics, price)!;
    expect(optimum.contribution).toBeGreaterThan(optimum.contributionNow);
  });

  it('says the curve is flat rather than picking a point off a plateau', () => {
    // At an elasticity of 1 the volume response returns exactly what the rate
    // change costs. The argmax of a plateau is noise, and "cut your rate 22% to
    // earn the same money" is a worse answer than "price is not your lever".
    // The seeded storage business in its opening quarter: elasticity 1, no
    // per-unit cost, and 80% of the units still empty, so nothing clamps and
    // the whole band pays the same.
    const { business, metrics, price } = hotel({
      elasticity: 1.0,
      price: 345,
      units: 620,
      quarters: 1,
    });
    const optimum = priceOptimum(business, business.streams[0]!, metrics, price)!;
    expect(optimum.flat).toBe(true);
  });

  it('stops at the price that fills the building, not below it', () => {
    // Below a sold-out price the extra demand has nowhere to go, so a further
    // cut only lowers what the units that were always going to fill earn.
    const { business, metrics, price } = hotel({ elasticity: 1.6, perUnitCost: 20, units: 12 });
    const optimum = priceOptimum(business, business.streams[0]!, metrics, price)!;
    if (optimum.binding === 'CAPACITY') {
      expect(optimum.volume).toBeLessThanOrEqual((metrics.capacityVolume ?? 0) + 1e-6);
    }
    // Whatever binds, it never recommends a price whose demand it cannot serve
    // and counts the unserved demand as contribution.
    expect(optimum.volume).toBeLessThanOrEqual((metrics.capacityVolume ?? Infinity) + 1e-6);
  });

  it('never recommends a price outside the band the engine will model', () => {
    // Past 3× the reference price the demand response is clamped, so anything
    // out there is a statement about the clamp.
    const { business, metrics, price } = hotel({ elasticity: 1.6, perUnitCost: 200 });
    const optimum = priceOptimum(business, business.streams[0]!, metrics, price)!;
    expect(optimum.price).toBeGreaterThanOrEqual(optimum.band.low);
    expect(optimum.price).toBeLessThanOrEqual(optimum.band.high);
  });
});

describe('the units the player is thinking in', () => {
  it('translates a quarterly room rate into a nightly one', () => {
    // `price 8213` is correct and meaningless. The player has spent the whole
    // session thinking in a $90 nightly rate.
    const { business, price } = hotel();
    const units = priceUnits(business.streams[0]!, price);
    expect(units.command).toBe(8_213);
    expect(units.per).toBe('per unit per quarter');
    expect(units.colloquial).toBe('$90 a night');
  });

  it('rents storage by the month, because that is how storage is rented', () => {
    const { business, price } = hotel({ price: 345 });
    business.streams[0]!.label = 'Storage units';
    const units = priceUnits(business.streams[0]!, price);
    expect(units.colloquial).toBe('$115 a month');
  });

  it('leaves an hourly rate alone', () => {
    const { business } = hotel();
    const stream = business.streams[0]!;
    const hourly = {
      ...stream,
      params: { ...stream.params, kind: 'UTILIZATION' as const },
    } as typeof stream;
    expect(priceUnits(hourly, fromDisplay(150)).colloquial).toBeUndefined();
    expect(priceUnits(hourly, fromDisplay(150)).per).toBe('per billable hour');
  });
});
