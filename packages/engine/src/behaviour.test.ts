import { describe, expect, it } from 'vitest';
import { fromDisplay, ratio, sum, type Money } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import { PAYROLL_LOAD_COMPONENTS, type Action, type WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { payrollLoadPct } from './omissionGuard.js';
import { tick, type TickResult } from './tick.js';
import { marketingMultiplier, priceEffect } from './modifiers.js';

/**
 * Economic sanity and behavioural regressions — spec §13.5.
 *
 * Appendix A's closing lesson: articulation tests prove the books tie, not that
 * the business logic is right. A forty-quarter reference run passed every
 * accounting assertion while revenue sat frozen for ten simulated years. These
 * are the tests that would have caught it.
 */

interface Run {
  results: TickResult[];
  final: WorldState;
}

function run(state: WorldState, periods: number, actionsFor?: (p: number) => Action[]): Run {
  const results: TickResult[] = [];
  let current = state;
  for (let i = 0; i < periods; i++) {
    const period = current.currentPeriod + 1;
    const result = tick(current, actionsFor?.(period) ?? [], {
      throwOnAssertionFailure: true,
    });
    results.push(result);
    current = result.state;
  }
  return { results, final: current };
}

const revenueOf = (r: TickResult): Money => r.statements.consolidated.incomeStatement.revenue;

function restaurantWorld(overrides: {
  seats?: number;
  traffic?: number;
  turns?: number;
  marketing?: number;
  equity?: number;
  blocks?: number;
  cogsPct?: number;
  dso?: number;
  ticket?: number;
}): WorldState {
  const template = getSeedTemplate('full_service_restaurant');
  const model = buildModelFromTemplate({
    businessName: 'Test',
    template,
    scale: {
      seats: overrides.seats ?? 64,
      turnsPerDay: overrides.turns ?? 2,
      addressableTrafficPerQuarter: overrides.traffic ?? 180_000,
      captureRate: 0.05,
      price: fromDisplay(overrides.ticket ?? 42),
    },
    marketingSpendPerQuarter: fromDisplay(overrides.marketing ?? 8_000),
    equityInjection: fromDisplay(overrides.equity ?? 500_000),
    debt: [{ kind: 'REVOLVER', principal: fromDisplay(50_000), termQuarters: 40 }],
  });

  if (overrides.blocks !== undefined) {
    model.costs.stepFixed = model.costs.stepFixed.map((c) => ({
      ...c,
      currentBlocks: overrides.blocks as number,
    }));
  }
  if (overrides.cogsPct !== undefined) {
    model.costs.variableWithRevenue = model.costs.variableWithRevenue.map((c) =>
      c.id === 'food_cost' ? { ...c, pctOfRevenue: overrides.cogsPct as number } : c,
    );
  }
  if (overrides.dso !== undefined) {
    model.workingCapital = { ...model.workingCapital, dsoDays: overrides.dso, dpoDays: 10 };
  }

  return createWorld({
    id: 't',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

// ---------------------------------------------------------------------------

describe('under-staffing trap regression (§4.3, §13.5)', () => {
  /**
   * THE regression. `blocksNeeded` must be driven by unconstrained demand, not
   * by realized volume. Realized volume is already capped by staffing, so
   * feeding it back as the staffing signal freezes the business at its opening
   * headcount forever — and every accounting assertion still passes.
   *
   * The spec's reference run reproduced exactly that: 4,000 transactions per
   * quarter for ten straight years while true demand reached 11,600.
   */
  it('grows realized transactions when a block is added each quarter', () => {
    const world = restaurantWorld({ seats: 200, turns: 3, traffic: 600_000, blocks: 1 });

    const { results } = run(world, 16, (period) =>
      period < 12
        ? [
            { kind: 'ADD_STEP_BLOCK', costId: 'kitchen_labor', blocks: 1 },
            { kind: 'ADD_STEP_BLOCK', costId: 'front_of_house', blocks: 1 },
          ]
        : [],
    );

    const volumes = results.map(
      (r) => Object.values(r.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]?.realizedVolume ?? 0,
    );

    // Strictly increasing while blocks are being added and demand still exceeds
    // capacity. If blocksNeeded were wired to realized volume this would be a
    // flat line at the opening ceiling.
    for (let i = 1; i < 12; i++) {
      expect(volumes[i]!, `period ${i} volume did not grow over period ${i - 1}`).toBeGreaterThan(
        volumes[i - 1]!,
      );
    }
    expect(volumes[11]!).toBeGreaterThan(volumes[0]! * 3);
  });

  it('reports blocksNeeded from demand even while capacity is binding', () => {
    const world = restaurantWorld({ seats: 200, turns: 3, traffic: 600_000, blocks: 1 });
    const { results } = run(world, 4);

    const constrained = results
      .flatMap((r) => r.events)
      .filter((e) => e.kind === 'CAPACITY_CONSTRAINED' && e.detail.blocksNeeded !== undefined);

    expect(constrained.length).toBeGreaterThan(0);
    // The gap must be visible and large — a demand-driven signal, not one
    // clipped by the shortage it is meant to diagnose.
    expect(Number(constrained[0]!.detail.blocksNeeded)).toBeGreaterThan(
      Number(constrained[0]!.detail.blocksActive),
    );
  });
});

describe('payroll load components (§4.5, §13.5)', () => {
  it('stated defaults equal the sum of their parts', () => {
    const withoutBenefits =
      PAYROLL_LOAD_COMPONENTS.employerFica +
      PAYROLL_LOAD_COMPONENTS.unemploymentInsurance +
      PAYROLL_LOAD_COMPONENTS.workersCompDefault;
    const withBenefits = withoutBenefits + PAYROLL_LOAD_COMPONENTS.benefitsLoad;

    // §4.5 documents 0.10-0.17 without benefits, 0.25-0.32 with.
    expect(withoutBenefits).toBeGreaterThanOrEqual(0.1);
    expect(withoutBenefits).toBeLessThanOrEqual(0.17);
    expect(withBenefits).toBeGreaterThanOrEqual(0.25);
    expect(withBenefits).toBeLessThanOrEqual(0.32);

    expect(payrollLoadPct(0.02, false)).toBeCloseTo(withoutBenefits, 10);
    expect(payrollLoadPct(0.02, true)).toBeCloseTo(withBenefits, 10);
  });

  it('is applied to labor lines and cannot be bypassed', () => {
    const world = restaurantWorld({});
    const business = world.businesses[0]!;
    const load = business.costs.payrollLoadPct;
    expect(load).toBeGreaterThan(0);

    const { results } = run(world, 1);
    const labor = results[0]!.statements.consolidated.incomeStatement.labor;

    const rawBlockCost = sum(
      business.costs.stepFixed.map((c) =>
        BigInt(c.currentBlocks) * c.blockCostPerQuarter,
      ),
    );
    // Owner compensation carries the payroll load too, but books to G&A
    // (§4.6), so it belongs to a different statement line and is excluded here.
    const rawFixedLabor = sum(
      business.costs.fixedPeriod
        .filter((c) => c.isLabor && c.statementLine === 'LABOR')
        .map((c) => c.amountPerQuarter),
    );
    const raw = rawBlockCost + rawFixedLabor;

    expect(Number(labor)).toBeCloseTo(Number(raw) * (1 + load), -2);
    // The load is real money: a founder modelling $20/hr owes about $23.
    expect(labor).toBeGreaterThan(raw);
  });
});

describe('working capital drives the cash crisis (§13.5)', () => {
  /**
   * "A business growing revenue 40% per year with dsoDays = 60 and thin margins
   * MUST hit a cash crisis. If it doesn't, working capital is wired wrong."
   *
   * The single most important behavioural test in the suite.
   */
  it('a fast-growing, thin-margin business on 60-day terms runs out of cash', () => {
    const world = restaurantWorld({
      seats: 300,
      turns: 3.5,
      traffic: 1_200_000,
      marketing: 60_000,
      equity: 150_000,
      cogsPct: 0.46,
      dso: 60,
    });

    const { results } = run(world, 12);
    const crises = results.flatMap((r) => r.events).filter((e) => e.kind === 'CASH_CRISIS');
    expect(crises.length, 'expected a cash crisis but none occurred').toBeGreaterThan(0);
  });

  it('the same business on cash terms survives longer', () => {
    const base = {
      seats: 300,
      turns: 3.5,
      traffic: 1_200_000,
      marketing: 60_000,
      equity: 150_000,
      cogsPct: 0.46,
    };
    const slow = run(restaurantWorld({ ...base, dso: 60 }), 12);
    const fast = run(restaurantWorld({ ...base, dso: 1 }), 12);

    const crisesIn = (r: Run): number =>
      r.results.flatMap((x) => x.events).filter((e) => e.kind === 'CASH_CRISIS').length;

    // Collecting on the day of sale rather than in 60 days is worth real cash.
    expect(crisesIn(fast)).toBeLessThan(crisesIn(slow));
  });

  it('ΔNWC is positive while the business is growing', () => {
    const { results } = run(restaurantWorld({ dso: 45 }), 6);
    const growthPeriods = results.slice(1, 5);
    const positive = growthPeriods.filter(
      (r) => r.statements.consolidated.cashFlow.changeInNetWorkingCapital > 0n,
    );
    expect(positive.length).toBeGreaterThan(0);
  });
});

describe('step-fixed costs behave like steps (§13.5)', () => {
  it('adding a block costs margin this quarter and adds capacity next quarter', () => {
    const world = restaurantWorld({ seats: 200, turns: 3, traffic: 600_000, blocks: 2 });

    const withoutHire = run(world, 4);
    const withHire = run(world, 4, (period) =>
      period === 1 ? [{ kind: 'ADD_STEP_BLOCK', costId: 'kitchen_labor', blocks: 1 }] : [],
    );

    const ebitdaAt = (r: Run, i: number): Money =>
      r.results[i]!.statements.consolidated.incomeStatement.ebitda;
    const revenueAt = (r: Run, i: number): Money => revenueOf(r.results[i]!);

    // Period 1: cost lands, capacity has not.
    expect(ebitdaAt(withHire, 1)).toBeLessThan(ebitdaAt(withoutHire, 1));
    expect(revenueAt(withHire, 1)).toBe(revenueAt(withoutHire, 1));

    // Period 2: the capacity arrives and revenue overtakes.
    expect(revenueAt(withHire, 2)).toBeGreaterThan(revenueAt(withoutHire, 2));
  });
});

describe('price and marketing response (§13.5)', () => {
  it('raising price on an elastic stream reduces volume', () => {
    const world = restaurantWorld({ seats: 400, turns: 4, traffic: 180_000 });

    const flat = run(world, 3);
    const raised = run(world, 3, (period) =>
      period === 0 ? [{ kind: 'SET_PRICE', streamId: 's1', newPrice: fromDisplay(58) }] : [],
    );

    const volumeAt = (r: Run, i: number): number =>
      Object.values(r.results[i]!.statements.byBusiness)[0]!.derivedMetrics.streamMetrics[0]!
        .realizedVolume;

    expect(volumeAt(raised, 1)).toBeLessThan(volumeAt(flat, 1));
    // Volume and price never both rise — that would be a free lunch.
    expect(volumeAt(raised, 1)).not.toBeGreaterThan(volumeAt(flat, 1));
  });

  it('marketing exhibits diminishing returns — the second $10k buys less than the first', () => {
    const maxLift = 0.35;
    const half = fromDisplay(8_000);
    const at = (spend: number): number => marketingMultiplier(fromDisplay(spend), maxLift, half);

    const firstTenK = at(10_000) - at(0);
    const secondTenK = at(20_000) - at(10_000);
    expect(secondTenK).toBeLessThan(firstTenK);
    expect(secondTenK).toBeGreaterThan(0);
  });

  it('clamps the price RATIO, not the result, and reports the clamp', () => {
    const reference = fromDisplay(40);
    const extreme = priceEffect(fromDisplay(400), reference, 1.2);
    expect(extreme.clamped).toBe(true);
    // Clamped at a 3× ratio: 3^-1.2, not an unbounded extrapolation.
    expect(extreme.multiplier).toBeCloseTo(Math.pow(3, -1.2), 10);

    const inBand = priceEffect(fromDisplay(48), reference, 1.2);
    expect(inBand.clamped).toBe(false);
  });
});

describe('benchmark plausibility (§13.3)', () => {
  it('the seeded full-service restaurant lands in band by year 3', () => {
    const template = getSeedTemplate('full_service_restaurant');
    const world = restaurantWorld({});
    const { results } = run(world, 16);

    const year3 = results.filter((r) => Math.floor(r.statements.period / 4) === 2);
    const totalOf = (fn: (r: TickResult) => Money): Money =>
      year3.reduce<Money>((acc, r) => acc + fn(r), 0n);

    const revenue = totalOf((r) => r.statements.consolidated.incomeStatement.revenue);
    const cogs = totalOf((r) => r.statements.consolidated.incomeStatement.costOfGoodsSold);
    const labor = totalOf((r) => r.statements.consolidated.incomeStatement.labor);
    const occupancy = totalOf((r) => r.statements.consolidated.incomeStatement.occupancy);
    const ebitda = totalOf((r) => r.statements.consolidated.incomeStatement.ebitda);

    const bands = template.plausibility;
    const check = (
      name: string,
      value: number,
      band?: { low: number; high: number },
    ): void => {
      if (!band) return;
      expect(value, `${name} = ${(value * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(band.low);
      expect(value, `${name} = ${(value * 100).toFixed(1)}%`).toBeLessThanOrEqual(band.high);
    };

    check('food cost', ratio(cogs, revenue), bands.cogsPctOfRevenue);
    check('labor', ratio(labor, revenue), bands.laborPctOfRevenue);
    check('occupancy', ratio(occupancy, revenue), bands.occupancyPctOfRevenue);
    check('EBITDA margin', ratio(ebitda, revenue), bands.ebitdaMarginPct);
  });

  /**
   * The behaviour Appendix A found emerging from the mechanics rather than
   * being designed in: a capacity-constrained business on an escalating lease
   * gets slowly strangled.
   */
  it('an escalating lease against a hard capacity ceiling erodes margin over ten years', () => {
    const { results } = run(restaurantWorld({}), 40);
    const marginIn = (year: number): number => {
      const slice = results.filter((r) => Math.floor(r.statements.period / 4) === year);
      const revenue = slice.reduce<Money>(
        (a, r) => a + r.statements.consolidated.incomeStatement.revenue,
        0n,
      );
      const ebitda = slice.reduce<Money>(
        (a, r) => a + r.statements.consolidated.incomeStatement.ebitda,
        0n,
      );
      return ratio(ebitda, revenue);
    };
    expect(marginIn(9)).toBeLessThan(marginIn(3));
  });
});

describe('growing the market rather than the building', () => {
  it('raises addressable demand two quarters out, and revenue follows', () => {
    // A plumbing shop at 82% utilisation with no bench had no way to grow:
    // every capacity lever adds room inside a demand pool fixed at concept
    // lock. A second territory is genuinely both — you buy the yard and the
    // market grows — so it rides the same action and the same lead time.
    const model = buildModelFromTemplate({
      businessName: 'Plumber',
      template: getSeedTemplate('professional_services_firm'),
      archetype: 'UTILIZATION',
      scale: { demandHoursPerQuarter: 1_200, price: fromDisplay(300) },
      equityInjection: fromDisplay(2_000_000),
    });
    let state: WorldState = createWorld({
      id: 'plumber',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model],
    });
    const id = state.businesses[0]!.id;
    const demand = (): number => {
      const p = state.businesses[0]!.streams[0]!.params;
      return p.kind === 'UTILIZATION' ? p.demandHoursPerQuarter : 0;
    };
    const before = demand();

    state = tick(state, [
      {
        kind: 'EXPAND_CAPACITY',
        businessId: id,
        spec: { streamId: 's1', buildoutCost: fromDisplay(150_000), deltaDemandHoursPerQuarter: 480 },
      },
    ], { throwOnAssertionFailure: false }).state;

    // The cost lands now; the market does not.
    expect(demand(), 'market must not open the quarter it is paid for').toBe(before);

    state = tick(state, [], { throwOnAssertionFailure: false }).state;
    state = tick(state, [], { throwOnAssertionFailure: false }).state;
    expect(demand()).toBeGreaterThan(before);
    expect(demand()).toBe(before + 480);
  });

  it('leaves an archetype with no territory untouched', () => {
    // The action is shared; the effect is not. A storage business grows by
    // building units, and a demand delta aimed at it must do nothing rather
    // than something surprising.
    const model = buildModelFromTemplate({
      businessName: 'Storage',
      template: getSeedTemplate('self_storage'),
      archetype: 'OCCUPANCY',
      scale: { units: 400, price: fromDisplay(330) },
      equityInjection: fromDisplay(3_000_000),
    });
    let state: WorldState = createWorld({
      id: 'storage',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model],
    });
    const units = (): number => {
      const p = state.businesses[0]!.streams[0]!.params;
      return p.kind === 'OCCUPANCY' ? p.units : 0;
    };
    const before = units();
    for (let i = 0; i < 3; i++) {
      state = tick(state, i === 0 ? [
        {
          kind: 'EXPAND_CAPACITY',
          businessId: state.businesses[0]!.id,
          spec: { streamId: 's1', buildoutCost: fromDisplay(100_000), deltaDemandHoursPerQuarter: 500 },
        },
      ] : [], { throwOnAssertionFailure: false }).state;
    }
    expect(units()).toBe(before);
  });
});

describe('money in the deal that is neither yours nor a loan', () => {
  it('funds the business without touching the household', () => {
    // A Nevada solar farm was drafted with $1.0M sponsor equity, ~$1.5M of
    // transferred federal ITC and ~$3.2M of debt. The funding screen carried
    // the equity and the debt, silently dropped the credit, and the project
    // the model had costed at $5.7M of funding arrived at the gate with $4.0M
    // and was refused as unaffordable. The credit was the single largest fact
    // about whether the project was financeable.
    const build = (outsideCapital: Money) =>
      buildModelFromTemplate({
        businessName: 'Solar',
        template: getSeedTemplate('self_storage'),
        archetype: 'OCCUPANCY',
        scale: { units: 400, price: fromDisplay(330) },
        equityInjection: fromDisplay(1_000_000),
        outsideCapital,
      });

    const alone = createWorld({
      id: 'a',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [build(0n)],
    });
    const backed = createWorld({
      id: 'b',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [build(fromDisplay(1_500_000))],
    });

    // The money is in the business...
    expect(backed.businesses[0]!.cash - alone.businesses[0]!.cash).toBe(fromDisplay(1_500_000));
    // ...as contributed capital, because that is what it is...
    expect(
      backed.businesses[0]!.balances.contributedCapital -
        alone.businesses[0]!.balances.contributedCapital,
    ).toBe(fromDisplay(1_500_000));
    // ...and the household did not pay for it.
    expect(backed.household.cash).toBe(alone.household.cash);
    expect(backed.household.cumulativeInjections).toBe(alone.household.cumulativeInjections);
  });

  it('defaults to nothing, so every existing model is unchanged', () => {
    const model = buildModelFromTemplate({
      businessName: 'Plain',
      template: getSeedTemplate('full_service_restaurant'),
      scale: { seats: 60, price: fromDisplay(30) },
      equityInjection: fromDisplay(500_000),
    });
    expect(model.financingPlan.outsideCapital).toBe(0n);
  });
});

/**
 * "I want to add a small indoor waterpark."
 *
 * Asked three times of a hotel at 70% occupancy and answered three times with
 * "you already have 19 idle". Every lever the game owned was a quantity — more
 * rooms, more marketing, a different price — and none of them is what a player
 * means by building something new. An amenity is a claim that the product is
 * worth more, which is a claim about the REFERENCE price: demand reads the
 * ratio between what you charge and what the market thinks it is worth, so
 * moving the second one with the first held is exactly "better, same price".
 */
describe('a better product, not more of the same one (§3.0.1)', () => {
  const hotel = (): WorldState =>
    createWorld({
      id: 'hotel',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [
        buildModelFromTemplate({
          businessName: 'Hotel',
          template: getSeedTemplate('self_storage'),
          scale: { units: 64, price: fromDisplay(8_213) },
          equityInjection: fromDisplay(2_400_000),
        }),
      ],
    });

  const upgrade = (state: WorldState, pct: number): Action => ({
    kind: 'EXPAND_CAPACITY',
    businessId: state.businesses[0]!.id,
    spec: {
      streamId: state.businesses[0]!.streams[0]!.id,
      buildoutCost: fromDisplay(800_000),
      qualityUpliftPct: pct,
    },
  });

  it('turns a quality claim into demand at the same price', () => {
    const base = run(hotel(), 8).results;
    const improved = run(hotel(), 8, (p) => (p === 1 ? [upgrade(hotel(), 0.15)] : [])).results;

    const occupancyOf = (r: TickResult): number =>
      Object.values(r.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]?.occupancy ?? 0;

    // Two quarters of lead time: nothing before it lands.
    expect(occupancyOf(improved[1]!)).toBeCloseTo(occupancyOf(base[1]!), 5);
    // And more of them after.
    expect(occupancyOf(improved[7]!)).toBeGreaterThan(occupancyOf(base[7]!));
    expect(revenueOf(improved[7]!)).toBeGreaterThan(revenueOf(base[7]!));
  });

  it('can be taken as rate instead of volume, at the player’s choice', () => {
    // The same uplift with the price raised by the same amount: volume holds
    // roughly flat and the money arrives as revenue per unit instead. This is
    // the whole reason the lever moves the reference price rather than demand
    // directly — one knob, two ways to spend it.
    const state = hotel();
    const streamId = state.businesses[0]!.streams[0]!.id;
    const bothResults = run(hotel(), 8, (p) =>
      p === 1
        ? [
            upgrade(state, 0.15),
            { kind: 'SET_PRICE', streamId, newPrice: fromDisplay(8_213 * 1.15) },
          ]
        : [],
    ).results;
    const base = run(hotel(), 8).results;

    const occ = (r: TickResult): number =>
      Object.values(r.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]?.occupancy ?? 0;
    // Price rises the moment it is set; the uplift lands two quarters later, so
    // by period 7 the two have met and occupancy is back where it started.
    expect(occ(bothResults[7]!)).toBeCloseTo(occ(base[7]!), 2);
    expect(revenueOf(bothResults[7]!)).toBeGreaterThan(revenueOf(base[7]!));
  });

  it('costs what it costs, and capitalises rather than vanishing', () => {
    const improved = run(hotel(), 8, (p) => (p === 1 ? [upgrade(hotel(), 0.15)] : [])).results;
    const base = run(hotel(), 8).results;
    // $800k of buildout, half in each of two quarters, onto PP&E.
    const ppeOf = (r: TickResult): Money => r.statements.consolidated.balanceSheet.ppeGross;
    expect(ppeOf(improved[7]!) - ppeOf(base[7]!)).toBe(fromDisplay(800_000));
  });
});
