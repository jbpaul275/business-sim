import { describe, expect, it } from 'vitest';
import { fromDisplay, ratio, type Money } from '@bizsim/money';
import {
  computeConfidenceScore,
  maxSeatsFor,
  zSeedTemplate,
  type AssumptionRegister,
  type SeedTemplate,
  type SeedTemplateInput,
  type WorldState,
} from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { serviceComplexityFactor } from './modifiers.js';
import { validateBusinessModel } from './validate.js';
import { applyAction } from './actions.js';
import { emptyActionFlows } from './period.js';
import { tick, type TickResult } from './tick.js';

/**
 * The sim is not a yes-machine, and it is not a no-machine either.
 *
 * §11.2 is explicit about the 256-flavour ice cream shop: do NOT refuse and do
 * NOT flatter. Model it honestly — SKU count raises per-customer service time,
 * which lowers throughput, which caps revenue at peak; and *also* raise capture
 * rate for genuine novelty appeal. "The output should be a business that is
 * viable under some conditions and not others. The player should learn what
 * those conditions are, not be told yes or no."
 *
 * That is the product thesis. Plenty of enormously successful businesses looked
 * absurd at the outset, and a tool that filters for plausibility filters out
 * exactly the ideas worth modelling. The engine's job is to say what would have
 * to be true, and what it costs to find out.
 *
 * The one line the engine holds is PHYSICAL and CONTRACTUAL impossibility
 * (§11.3 rule 6) — zero payroll load, negative depreciable base, ending a
 * period with cash it never had. Those are not opinions about a business; they
 * are statements about arithmetic and contracts.
 *
 * Note what this file does NOT do: it does not reach for
 * `full_service_restaurant` and bolt flavours onto it. A novel concept gets its
 * own cost lines and NO borrowed benchmark bands — see D-5 in
 * docs/plan/04-risks-and-decisions.md. Inheriting a restaurant's bands would
 * flag every line as out-of-band, which reads as "this is wrong" when the truth
 * is "nobody knows."
 */

// ---------------------------------------------------------------------------
// The concept, as data
// ---------------------------------------------------------------------------

/** A dipping cabinet holds about a dozen flavours. This is the physical part. */
const FLAVOURS_PER_CABINET = 12;
const CABINET_COST = 9_000;
/** Floor space and power a cabinet costs per quarter, at $48/sq ft/yr NNN. */
const CABINET_RENT_PER_QUARTER = 180;
const CABINET_POWER_PER_QUARTER = 220;
/** Service positions at the counter. More counter, more shop to rent. */
const BASE_POSITIONS = 30;
const POSITION_RENT_PER_QUARTER = 240;

const cabinetsFor = (flavours: number): number => Math.ceil(flavours / FLAVOURS_PER_CABINET);

/**
 * Breadth slows the whole shop's inventory, because the tail turns slowly while
 * the head keeps turning fast. Blended days rise with the log of SKU count
 * rather than linearly — 256 flavours does not sit 6× as long as 40 does.
 */
const inventoryDaysFor = (flavours: number): number =>
  Math.round(21 * (1 + 0.25 * Math.log2(Math.max(flavours, 1) / 40)));

/**
 * A scoop shop, priced and staffed as a scoop shop. Everything here is an
 * assumption, and every one of them is registered — that is the deliverable,
 * not the verdict at the bottom.
 */
function iceCreamTemplate(flavours: number, positions: number): SeedTemplate {
  const cabinets = cabinetsFor(flavours);
  const quarterlyRent =
    8_000 +
    cabinets * CABINET_RENT_PER_QUARTER +
    Math.max(0, positions - BASE_POSITIONS) * POSITION_RENT_PER_QUARTER;

  const input: SeedTemplateInput = {
    id: `ice_cream_${flavours}`,
    label: `${flavours}-flavour scoop shop`,
    defaultArchetypes: ['TRAFFIC'],
    costDefaults: [
      {
        lineId: 'product_cost',
        label: 'Dairy, mix-ins & packaging',
        class: 'VARIABLE_REVENUE',
        statementLine: 'COGS',
        value: 0.28,
        accruable: true,
        sourceNote: 'Scoop-shop product cost including cones, cups and spoilage on slow movers.',
      },
      {
        lineId: 'counter_staff',
        label: 'Counter staff',
        class: 'STEP_FIXED',
        statementLine: 'LABOR',
        value: 9_000,
        isMoney: true,
        isLabor: true,
        driver: 'TRANSACTIONS',
        capacityPerBlock: 4_000,
        minimumBlocks: 1,
        sourceNote:
          'One block is roughly one FTE across the service week, covering ~44 orders a day.',
      },
      {
        lineId: 'shift_lead',
        label: 'Shift lead',
        class: 'FIXED_PERIOD',
        statementLine: 'LABOR',
        value: 11_000,
        isMoney: true,
        isLabor: true,
        annualEscalatorPct: 0.03,
        sourceNote: 'Salaried lead at $44k/yr; someone opens and closes regardless of volume.',
      },
      {
        lineId: 'rent',
        label: 'Rent',
        class: 'FIXED_PERIOD',
        statementLine: 'OCCUPANCY',
        value: quarterlyRent,
        isMoney: true,
        accruable: true,
        annualEscalatorPct: 0.03,
        sourceNote:
          `900 sq ft base plus ~15 sq ft per dipping cabinet (${cabinets} cabinets) and ` +
          `~20 sq ft per service position beyond ${BASE_POSITIONS}, at $48/sq ft/yr NNN.`,
      },
    ],
    streamParamDefaults: {
      captureRate: 0.06,
      avgTicket: 9,
      operatingDaysPerQuarter: 91,
      // A counter position turns far faster than a dining seat.
      turnsPerDay: 12,
      seats: positions,
      // The box everything has to fit in: 900 sq ft of shop, ~15 per dipping
      // cabinet, ~20 per service position. Stated, so it can be checked.
      floorAreaSqFt: 900 + cabinets * 15 + positions * 20,
      peakConcentration: 0.55,
      baselineSkuCount: 40,
      skuCount: flavours,
      addressableTrafficPerQuarter: 520_000,
    },
    modifierDefaults: {
      rampFloor: 0.4,
      rampConstant: 3.0,
      marketingMaxLift: 0.35,
      halfSaturationSpend: 6_000,
      priceElasticity: 1.2,
      baseMarketingSpendPerQuarter: 6_000,
    },
    workingCapitalDefaults: {
      dsoDays: 1,
      dioDays: inventoryDaysFor(flavours),
      dpoDays: 21,
      prepaidInsuranceMonths: 6,
      securityDepositMonths: 2,
      customerDepositPct: 0,
    },
    payrollLoadPct: 0.1315,
    workersCompPct: 0.03,
    offersBenefits: false,
    // Ice cream is violently seasonal. Each quarter's three monthly weights
    // average to its quarterly figure, which §12.2 requires.
    seasonality: [0.55, 1.15, 1.55, 0.75],
    monthlySeasonalWeight: [
      0.45, 0.5, 0.7, 0.95, 1.15, 1.35, 1.7, 1.65, 1.3, 0.9, 0.7, 0.65,
    ],
    typicalCapex: [
      {
        label: 'Dipping cabinets',
        category: 'EQUIPMENT',
        cost: CABINET_COST,
        usefulLifeYears: 10,
        quantity: cabinets,
      },
      {
        label: 'Buildout & counter',
        category: 'LEASEHOLD_IMPROVEMENTS',
        cost: 120_000,
        usefulLifeYears: 15,
      },
      { label: 'Seating & signage', category: 'FF&E', cost: 35_000, usefulLifeYears: 7 },
    ],
    // Deliberately empty. There is no published operating benchmark for a
    // 256-flavour shop, and borrowing a restaurant's would be a fabrication
    // dressed as a citation.
    plausibility: {},
    monthlyRent: Math.round(quarterlyRent / 3),
    preOpening: { payrollAndTraining: 15_000, marketing: 8_000, permitsAndLegal: 9_000 },
    generalLiabilityInsurancePerYear: 4_000,
    propertyInsurancePerYear: 3_000,
    accountingAndLegalPerYear: 6_000,
    softwareAndPosPerYear: 4_000,
    permitsAndLicensesPerYear: 2_500,
    utilitiesPerQuarter: 3_000 + cabinets * CABINET_POWER_PER_QUARTER,
    ownerCompPerYear: 60_000,
    badDebtPctOfRevenue: 0,
    repairsPctOfRevenue: 0.015,
    cardProcessingRate: 0.028,
    cardMixPct: 0.9,
  };

  return zSeedTemplate.parse(input);
}

interface ShopOptions {
  flavours: number;
  ticket: number;
  captureRate: number;
  /** Counter positions. This is the shop's throughput ceiling before drag. */
  positions?: number;
  equity?: number;
  capital?: number;
}

const shopModel = (o: ShopOptions) =>
  buildModelFromTemplate({
    businessName: `${o.flavours}-flavour scoop shop`,
    template: iceCreamTemplate(o.flavours, o.positions ?? BASE_POSITIONS),
    archetype: 'TRAFFIC',
    scale: { captureRate: o.captureRate, price: fromDisplay(o.ticket), skuCount: o.flavours },
    marketingSpendPerQuarter: fromDisplay(6_000),
    // Capitalised to clear the buildout and a full seasonal trough. An
    // undercapitalised shop just spends every quarter on the crisis ladder,
    // which tells you about the funding, not about the concept.
    equityInjection: fromDisplay(o.equity ?? 700_000),
  });

function iceCreamShop(o: ShopOptions): WorldState {
  return createWorld({
    id: 'ice-cream',
    playerId: 'p',
    config: createWorldConfig({
      startMode: 'FREEPLAY',
      customCapital: fromDisplay(o.capital ?? 1_200_000),
    }),
    models: [shopModel(o)],
  });
}

function run(state: WorldState, periods: number): TickResult[] {
  const out: TickResult[] = [];
  let current = state;
  for (let i = 0; i < periods; i++) {
    const result = tick(current, [], { throwOnAssertionFailure: true });
    out.push(result);
    current = result.state;
  }
  return out;
}

/** Trailing-four-quarter EBITDA margin, so seasonality nets out. */
const maturedMargin = (results: TickResult[]): number => {
  const slice = results.slice(-4);
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

const servedAtPeak = (results: TickResult[]): number =>
  Math.max(
    ...results.map(
      (r) =>
        Object.values(r.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]
          ?.realizedVolume ?? 0,
    ),
  );

// ---------------------------------------------------------------------------

describe('the 256-flavour ice cream shop (§11.2)', () => {
  it('is modelled, not refused', () => {
    // Nothing anywhere in validation gets an opinion about whether 256 flavours
    // is a good idea. The model is valid or it is not, on structural grounds.
    const result = validateBusinessModel(shopModel({ flavours: 256, ticket: 9, captureRate: 0.05 }));
    expect(result.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('charges the concept its real cost: 256 flavours is a 21% throughput haircut', () => {
    expect(serviceComplexityFactor(40, 40)).toBeCloseTo(1.0, 6);
    expect(serviceComplexityFactor(256, 40)).toBeCloseTo(1.268, 3);
    // Throughput is the reciprocal — this is the mechanism, not a penalty
    // bolted on because the concept sounded silly.
    expect(1 / serviceComplexityFactor(256, 40)).toBeCloseTo(0.789, 3);
  });

  it('charges it in freezers and inventory too, not just in seconds per order', () => {
    // The part a spreadsheet-by-vibes misses: 256 flavours is 22 dipping
    // cabinets, and they need floor space, power and capital.
    expect(cabinetsFor(40)).toBe(4);
    expect(cabinetsFor(256)).toBe(22);

    const cabinetCapex = (flavours: number): Money => {
      const line = shopModel({ flavours, ticket: 9, captureRate: 0.05 }).capex.find(
        (c) => c.label === 'Dipping cabinets',
      );
      return line ? line.grossCost * BigInt(line.quantity) : 0n;
    };

    expect(cabinetCapex(40)).toBe(fromDisplay(36_000));
    expect(cabinetCapex(256)).toBe(fromDisplay(198_000));

    // And slow movers sit on the shelf, which is working capital, not P&L.
    expect(inventoryDaysFor(40)).toBe(21);
    expect(inventoryDaysFor(256)).toBeGreaterThan(inventoryDaysFor(40));
  });

  it('serves fewer customers at peak than the same shop with 40 flavours', () => {
    const plain = run(iceCreamShop({ flavours: 40, ticket: 9, captureRate: 0.06 }), 12);
    const wild = run(iceCreamShop({ flavours: 256, ticket: 9, captureRate: 0.06 }), 12);

    // Same demand, same counter, slower service: the ceiling is genuinely lower.
    expect(servedAtPeak(wild)).toBeLessThan(servedAtPeak(plain));
  });

  /**
   * The point of the whole exercise, and the answer is a condition rather than
   * a verdict: 256 flavours works if you build the counter to serve the queue
   * the novelty draws, and does not work if you build a normal shop and hang
   * 256 flavours on it.
   *
   * All four of these are the same concept. Only the conditions differ.
   */
  it('is conditionally viable — the player learns the conditions, not a verdict', () => {
    const margins = {
      // 256 flavours at a plain shop's price and draw: pure cost, no benefit.
      naive: maturedMargin(run(iceCreamShop({ flavours: 256, ticket: 9, captureRate: 0.05 }), 24)),
      // Novelty draws a queue and carries a premium. §11.2 says to raise
      // capture rate for genuine novelty appeal, not only to charge for the
      // complexity. But a 30-position counter cannot serve that queue.
      priced: maturedMargin(
        run(iceCreamShop({ flavours: 256, ticket: 13, captureRate: 0.085 }), 24),
      ),
      // Same concept, same prices, counter built for the traffic it creates.
      built: maturedMargin(
        run(iceCreamShop({ flavours: 256, ticket: 13, captureRate: 0.085, positions: 40 }), 24),
      ),
      // The control: 40 flavours, same premium, same bigger counter.
      plain: maturedMargin(
        run(iceCreamShop({ flavours: 40, ticket: 13, captureRate: 0.085, positions: 40 }), 24),
      ),
    };

    // Pricing for novelty helps, and by itself is not enough — the shop is
    // turning people away at the counter, and no ticket price fixes that.
    expect(margins.priced).toBeGreaterThan(margins.naive);
    expect(margins.naive).toBeLessThan(0);
    expect(margins.priced, 'a premium alone does not rescue a capacity ceiling').toBeLessThan(0);

    // Build the counter and the same concept clears comfortably.
    expect(margins.built, 'the concept is reachable, not merely less bad').toBeGreaterThan(0.1);

    // And it is not a free lunch: the same novelty on 40 flavours, with no
    // complexity drag and four freezers instead of twenty-two, still does
    // better. 256 flavours is a real cost that has to be earned back.
    expect(margins.plain).toBeGreaterThan(margins.built);
  });

  it('and the penalty is only what it costs — once capacity clears, the gap is freezers', () => {
    // With enough counter that neither shop is turning anyone away, both serve
    // the same queue, and the whole remaining difference is the 22 dipping
    // cabinets and the inventory sitting in them. That difference is small,
    // which is the honest answer: the complexity bites at the counter, not on
    // the P&L.
    const wild = maturedMargin(
      run(iceCreamShop({ flavours: 256, ticket: 13, captureRate: 0.085, positions: 75 }), 24),
    );
    const plain = maturedMargin(
      run(iceCreamShop({ flavours: 40, ticket: 13, captureRate: 0.085, positions: 75 }), 24),
    );

    expect(plain).toBeGreaterThan(wild);
    expect(plain - wild).toBeLessThan(0.05);
  });

  it('says so when it does not know, instead of borrowing someone else’s numbers', () => {
    const model = shopModel({ flavours: 256, ticket: 13, captureRate: 0.085 });
    const register: AssumptionRegister = {
      byId: Object.fromEntries(model.assumptions.map((a) => [a.id, a])),
      byPath: Object.fromEntries(model.assumptions.map((a) => [a.path, a.id])),
      confidenceScore: 0,
    };

    // No line claims a benchmark it cannot cite, so nothing is flagged
    // "outside benchmark" on the strength of a restaurant's operating report.
    expect(model.assumptions.length).toBeGreaterThan(0);
    expect(model.assumptions.every((a) => a.benchmarkBand === undefined)).toBe(true);
    expect(model.assumptions.some((a) => a.outsideBenchmark)).toBe(false);

    // The honest consequence, reported rather than hidden: the register carries
    // all 50-odd assumptions, and the §10.3 confidence score — the share sourced
    // at PLAYER_SOURCED or better — says roughly a fifth of them are. This
    // concept is mostly estimate, and the score says so out loud.
    const score = computeConfidenceScore(register);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
    expect(model.assumptions.length).toBeGreaterThan(40);
  });

  it('scales the drag with the ambition, without ever hitting a wall', () => {
    // 2,000 flavours is absurd by any standard and still produces a number.
    // The curve is logarithmic: it never returns zero throughput, because
    // "impossible" is not the same as "very expensive".
    const factors = [40, 128, 256, 512, 2000].map((n) => serviceComplexityFactor(n, 40));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeGreaterThan(factors[i - 1]!);
      expect(Number.isFinite(factors[i]!)).toBe(true);
    }

    // 167 freezers and $1.5M of capital, which is the actual answer to "can I
    // do 2,000 flavours" — yes, and here is the bill.
    const results = run(
      iceCreamShop({ flavours: 2000, ticket: 13, captureRate: 0.085, equity: 2_600_000, capital: 3_500_000 }),
      12,
    );
    expect(results).toHaveLength(12);
    for (const r of results) expect(r.assertions.filter((a) => !a.passed)).toEqual([]);
  });
});

describe('what the engine does refuse (§11.3 rule 6)', () => {
  /**
   * The line is physical and contractual impossibility, and nothing else. These
   * are not judgements about a business; they are arithmetic.
   */
  it('cannot depreciate an asset past its depreciable base', () => {
    const results = run(iceCreamShop({ flavours: 256, ticket: 13, captureRate: 0.085 }), 40);
    for (const r of results) {
      const bs = r.statements.consolidated.balanceSheet;
      expect(bs.accumulatedDepreciation).toBeLessThanOrEqual(bs.ppeGross);
    }
  });

  it('cannot end a period holding negative cash, however wild the concept', () => {
    // Underpriced, over-freezered and barely visited: this one fails. That is
    // an outcome, not a refusal — and it still balances to the cent.
    const results = run(iceCreamShop({ flavours: 512, ticket: 4, captureRate: 0.015 }), 20);
    for (const r of results) {
      expect(r.statements.consolidated.balanceSheet.cash).toBeGreaterThanOrEqual(0n);
    }
  });

  /**
   * The billion-dollar scoop shop, which is the case that shows where the line
   * actually falls. Revenue is servable customers × price; both factors may run
   * far outside any benchmark, but their product is bounded by a physical box.
   * Take the box away and the concept is unfalsifiable — which is not the same
   * as ambitious.
   */
  it('refuses more seats than the floor can physically hold', () => {
    const model = shopModel({ flavours: 256, ticket: 13, captureRate: 0.085 });
    const capacity = model.streams[0]!.params;
    if (capacity.kind !== 'TRAFFIC' || capacity.capacityModel.kind !== 'SEAT_TURNS') {
      throw new Error('expected a seat-turns TRAFFIC stream');
    }

    // As designed it fits, and validation has nothing to say.
    expect(validateBusinessModel(model).valid).toBe(true);

    // Now claim the throughput a billion-dollar single location would need.
    capacity.capacityModel.seats = 100_000;
    const result = validateBusinessModel(model);
    expect(result.valid).toBe(false);

    const issue = result.issues.find((i) => i.code === 'CAPACITY_EXCEEDS_FOOTPRINT');
    expect(issue?.severity).toBe('ERROR');
    // And it says what would have to be true, rather than just refusing.
    expect(issue?.message).toContain('700000 sq ft');
  });

  it('lets the same concept have the seats if it takes the space', () => {
    // Nothing here is an opinion about whether a 1,200-seat ice cream hall is
    // a good idea. Take the square footage and the model is valid; the rent
    // that comes with it is the player's problem, which is the correct place
    // for that argument to happen.
    const roomy = shopModel({
      flavours: 256,
      ticket: 13,
      captureRate: 0.085,
      positions: 1_200,
    });
    expect(validateBusinessModel(roomy).valid).toBe(true);

    const params = roomy.streams[0]!.params;
    if (params.kind !== 'TRAFFIC' || params.capacityModel.kind !== 'SEAT_TURNS') {
      throw new Error('expected a seat-turns TRAFFIC stream');
    }
    expect(params.capacityModel.seats).toBe(1_200);
    expect(maxSeatsFor(params.capacityModel.floorAreaSqFt)).toBeGreaterThanOrEqual(1_200);
  });

  it('cannot be bought around one buildout at a time', () => {
    // The runtime half of the same rule. EXPAND_CAPACITY used to add seats with
    // nothing bounding them, so a player could reach any capacity by repeating
    // the action — the validation gate only ever ran at concept lock.
    const state = iceCreamShop({ flavours: 256, ticket: 13, captureRate: 0.085 });
    const business = state.businesses[0]!;
    const params = business.streams[0]!.params;
    if (params.kind !== 'TRAFFIC' || params.capacityModel.kind !== 'SEAT_TURNS') {
      throw new Error('expected a seat-turns TRAFFIC stream');
    }
    const { floorAreaSqFt } = params.capacityModel;
    const ceiling = maxSeatsFor(floorAreaSqFt);

    const ctx = {
      state,
      flows: new Map([[business.id, emptyActionFlows()]]),
      nextId: () => 'asset-1',
      realizedGains: [],
    };
    applyAction(
      ctx,
      {
        kind: 'EXPAND_CAPACITY',
        businessId: business.id,
        spec: {
          streamId: business.streams[0]!.id,
          deltaSeats: 100_000,
          buildoutCost: fromDisplay(50_000),
        },
      },
      'MATURED',
    );
    expect(params.capacityModel.seats).toBe(ceiling);

    // Buying the floor space first is a different matter, and is allowed.
    applyAction(
      ctx,
      {
        kind: 'EXPAND_CAPACITY',
        businessId: business.id,
        spec: {
          streamId: business.streams[0]!.id,
          deltaSeats: 40,
          deltaFloorAreaSqFt: 2_000,
          buildoutCost: fromDisplay(50_000),
        },
      },
      'MATURED',
    );
    expect(params.capacityModel.seats).toBe(ceiling + 40);
    expect(params.capacityModel.floorAreaSqFt).toBe(floorAreaSqFt + 2_000);
  });

  it('rejects a payroll load of zero — that is a contract, not a preference', () => {
    const model = shopModel({ flavours: 256, ticket: 9, captureRate: 0.05 });
    model.costs.payrollLoadPct = 0;
    const result = validateBusinessModel(model);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ZERO_PAYROLL_LOAD')).toBe(true);
  });
});
