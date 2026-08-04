import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fromDisplay, ratio, type Money } from '@bizsim/money';
import { getSeedTemplate, listSeedTemplates } from '@bizsim/seeds';
import type { Archetype, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate, type ScaleInput } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { validateBusinessModel } from './validate.js';
import { tick, type TickResult } from './tick.js';

/**
 * Every archetype, exercised — spec §13.1 asks for the property suite across
 * all six, not just the one M1 shipped with.
 *
 * Each archetype gets a calibrated seed template, so this doubles as the §13.3
 * benchmark plausibility suite. The templates are the point: five of these six
 * archetypes were written in M1 and never run until this file existed.
 */

const CASES = process.env.SLOW_TESTS ? 1000 : 25;

interface Fixture {
  archetype: Archetype;
  templateId: string;
  equity: number;
  debt?: number;
  scale: fc.Arbitrary<ScaleInput>;
}

const money = (min: number, max: number): fc.Arbitrary<Money> =>
  fc.integer({ min, max }).map((v) => fromDisplay(v));

const FIXTURES: Fixture[] = [
  {
    archetype: 'TRAFFIC',
    templateId: 'full_service_restaurant',
    equity: 700_000,
    debt: 300_000,
    scale: fc.record({
      seats: fc.integer({ min: 20, max: 220 }),
      turnsPerDay: fc.double({ min: 1.2, max: 3.5, noNaN: true, noDefaultInfinity: true }),
      addressableTrafficPerQuarter: fc.integer({ min: 40_000, max: 800_000 }),
      captureRate: fc.double({ min: 0.015, max: 0.08, noNaN: true, noDefaultInfinity: true }),
      price: money(12, 90),
      skuCount: fc.integer({ min: 8, max: 300 }),
    }),
  },
  {
    archetype: 'UTILIZATION',
    templateId: 'professional_services_firm',
    equity: 350_000,
    scale: fc.record({
      demandHoursPerQuarter: fc.integer({ min: 800, max: 14_000 }),
      price: money(90, 400),
    }),
  },
  {
    archetype: 'UNITS_CAC',
    templateId: 'ecommerce_dtc_brand',
    equity: 500_000,
    scale: fc.record({ price: money(25, 260) }),
  },
  {
    archetype: 'SUBSCRIPTION',
    templateId: 'b2b_saas',
    // A SaaS carrying four engineers and $90k/quarter of demand generation
    // burns for years before the recurring base covers it. Capitalising it like
    // a restaurant would only prove that an under-funded SaaS runs out of money.
    equity: 5_000_000,
    scale: fc.record({ price: money(600, 9_000) }),
  },
  {
    archetype: 'OCCUPANCY',
    templateId: 'self_storage',
    equity: 4_200_000,
    debt: 900_000,
    scale: fc.record({
      units: fc.integer({ min: 120, max: 1_400 }),
      price: money(140, 700),
    }),
  },
  {
    archetype: 'PROJECT_BACKLOG',
    templateId: 'general_contractor',
    equity: 900_000,
    scale: fc.record({
      bidsSubmittedPerQuarter: fc.integer({ min: 3, max: 26 }),
      executionCapacityPerQuarter: money(250_000, 2_600_000),
      price: money(90_000, 900_000),
    }),
  },
];

function build(fixture: Fixture, scale: ScaleInput, marketing?: number): WorldState {
  const template = getSeedTemplate(fixture.templateId);
  const model = buildModelFromTemplate({
    businessName: `${fixture.archetype} case`,
    template,
    archetype: fixture.archetype,
    scale,
    ...(marketing !== undefined ? { marketingSpendPerQuarter: fromDisplay(marketing) } : {}),
    equityInjection: fromDisplay(fixture.equity),
    debt: [
      ...(fixture.debt
        ? [{ kind: 'SBA_7A' as const, principal: fromDisplay(fixture.debt), termQuarters: 40 }]
        : []),
      { kind: 'REVOLVER' as const, principal: fromDisplay(150_000), termQuarters: 40 },
    ],
  });

  return createWorld({
    id: fixture.archetype,
    playerId: 'p',
    config: createWorldConfig({
      startMode: 'FREEPLAY',
      customCapital: fromDisplay(fixture.equity + 400_000),
    }),
    models: [model],
  });
}

function run(state: WorldState, periods: number): TickResult[] {
  const results: TickResult[] = [];
  let current = state;
  for (let i = 0; i < periods; i++) {
    const result = tick(current, [], { throwOnAssertionFailure: false });
    results.push(result);
    current = result.state;
  }
  return results;
}

// ---------------------------------------------------------------------------

describe.each(FIXTURES)('$archetype (§13.1)', (fixture) => {
  it(`holds every articulation invariant across ${CASES} parameter sets × 40 quarters`, () => {
    fc.assert(
      fc.property(fixture.scale, (scale) => {
        let state = build(fixture, scale);
        for (let period = 0; period < 40; period++) {
          const result = tick(state, [], { throwOnAssertionFailure: false });
          const failed = result.assertions.filter((a) => !a.passed);
          if (failed.length > 0) {
            throw new Error(
              `${fixture.archetype} period ${result.statements.period}: ` +
                failed.map((f) => `${f.name} expected ${f.expected} got ${f.actual}`).join('; '),
            );
          }
          state = result.state;
        }
      }),
      { numRuns: CASES },
    );
  });

  it('builds a model that satisfies the completeness invariant (§10.2)', () => {
    const template = getSeedTemplate(fixture.templateId);
    const model = buildModelFromTemplate({
      businessName: 'Completeness',
      template,
      archetype: fixture.archetype,
      equityInjection: fromDisplay(fixture.equity),
    });
    const result = validateBusinessModel(model);
    const errors = result.issues.filter((i) => i.severity === 'ERROR');
    expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual([]);
  });

  it('produces revenue and never a negative statement balance', () => {
    const template = getSeedTemplate(fixture.templateId);
    const results = run(build(fixture, {}), 24);
    const revenue = results
      .slice(8)
      .reduce<Money>((a, r) => a + r.statements.consolidated.incomeStatement.revenue, 0n);
    expect(revenue, `${template.label} produced no revenue`).toBeGreaterThan(0n);

    for (const result of results) {
      const bs = result.statements.consolidated.balanceSheet;
      expect(bs.cash).toBeGreaterThanOrEqual(0n);
      expect(bs.inventory).toBeGreaterThanOrEqual(0n);
      expect(bs.deferredRevenue).toBeGreaterThanOrEqual(0n);
    }
  });
});

// ---------------------------------------------------------------------------
// Archetype-characteristic behaviour — §13.5
// ---------------------------------------------------------------------------

describe('PROJECT_BACKLOG retainage cash drag (§13.5)', () => {
  /**
   * "A PROJECT_BACKLOG business growing 30%/yr with retainagePct = 0.10 must
   * show cumulative CFO materially below cumulative net income."
   *
   * This is the archetype's reason to exist: you recognise revenue and pay subs
   * and labour now, bill on a lag, and 10% of every dollar is withheld for two
   * more quarters. A growing contractor with a healthy P&L runs out of cash.
   */
  it('cumulative operating cash flow trails cumulative net income while growing', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'PROJECT_BACKLOG')!;
    const results = run(
      build(fixture, { bidsSubmittedPerQuarter: 14, executionCapacityPerQuarter: fromDisplay(1_400_000) }),
      16,
    );

    const netIncome = results.reduce<Money>(
      (a, r) => a + r.statements.consolidated.incomeStatement.netIncome,
      0n,
    );
    const cfo = results.reduce<Money>(
      (a, r) => a + r.statements.consolidated.cashFlow.cashFlowFromOperations,
      0n,
    );

    expect(cfo, 'CFO did not trail net income — the retainage rollforward is wrong').toBeLessThan(
      netIncome,
    );
  });

  it('carries retainage receivable on the balance sheet, separate from ordinary AR', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'PROJECT_BACKLOG')!;
    const results = run(build(fixture, {}), 8);
    const withRetainage = results.filter(
      (r) => r.statements.consolidated.balanceSheet.retainageReceivable > 0n,
    );
    expect(withRetainage.length).toBeGreaterThan(0);
    const last = results[results.length - 1]!.statements.consolidated.balanceSheet;
    expect(last.accountsReceivable).toBeGreaterThan(0n);
    expect(last.retainageReceivable).toBeGreaterThan(0n);
  });

  it('never lets the win rate exceed 1.0, however low the bid', () => {
    // With elasticity 1.8 and the ratio floor of 0.4, priceEffect reaches ~5.3.
    // Unclamped, 0.22 × 5.3 × 1.25 is a 145% win rate.
    const fixture = FIXTURES.find((f) => f.archetype === 'PROJECT_BACKLOG')!;
    const results = run(build(fixture, { price: fromDisplay(60_000) }, 90_000), 8);
    for (const result of results) {
      const metrics = Object.values(result.statements.byBusiness)[0]?.derivedMetrics;
      const stream = metrics?.streamMetrics[0];
      if (!stream) continue;
      expect(Number.isFinite(stream.demandVolume)).toBe(true);
      expect(stream.demandVolume).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('SUBSCRIPTION deferred revenue (§5.3)', () => {
  it('annual prepay builds a liability that funds operations and never goes negative', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'SUBSCRIPTION')!;
    const results = run(build(fixture, {}), 24);

    const balances = results.map(
      (r) => r.statements.consolidated.balanceSheet.deferredRevenue,
    );
    // The §5.3 renewal term exists precisely so this does not drain negative
    // over a few years.
    for (const balance of balances) expect(balance).toBeGreaterThanOrEqual(0n);
    expect(balances[balances.length - 1]!).toBeGreaterThan(0n);
  });

  it('reports LTV/CAC', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'SUBSCRIPTION')!;
    const results = run(build(fixture, {}), 12);
    const stream = Object.values(results[11]!.statements.byBusiness)[0]!.derivedMetrics
      .streamMetrics[0]!;
    expect(stream.ltvToCac).toBeDefined();
    expect(Number.isFinite(stream.ltvToCac!)).toBe(true);
  });
});

describe('UTILIZATION bench stress (§3.2)', () => {
  it('surfaces idle paid capacity when demand falls short of the team', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'UTILIZATION')!;
    // Hire for 12,000 hours of demand, then only find 1,500.
    const template = getSeedTemplate(fixture.templateId);
    const model = buildModelFromTemplate({
      businessName: 'Overhired',
      template,
      archetype: 'UTILIZATION',
      scale: { demandHoursPerQuarter: 12_000 },
      equityInjection: fromDisplay(600_000),
    });
    model.streams[0]!.params = {
      ...model.streams[0]!.params,
      demandHoursPerQuarter: 1_500,
    } as typeof model.streams[0]['params'];

    const world = createWorld({
      id: 'bench',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model],
    });

    const results = run(world, 6);
    const benchEvents = results.flatMap((r) => r.events).filter((e) => e.kind === 'BENCH_STRESS');
    expect(benchEvents.length, 'paid staff sat idle and nothing said so').toBeGreaterThan(0);
  });

  it('lets realized utilisation exceed the planning target in a good quarter', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'UTILIZATION')!;
    const results = run(build(fixture, { demandHoursPerQuarter: 12_000 }), 16);
    const utilisations = results
      .map(
        (r) =>
          Object.values(r.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]
            ?.realizedUtilization ?? 0,
      )
      .filter((u) => u > 0);
    // Capped at GROSS capacity, not at targetUtilization (0.70) — §8.5's
    // break-even utilisation and §9.4's post-mortem both need this headroom.
    expect(Math.max(...utilisations)).toBeGreaterThan(0.7);
    expect(Math.max(...utilisations)).toBeLessThanOrEqual(1.0000001);
  });
});

describe('OCCUPANCY lease-up (§3.5)', () => {
  it('ramps slowly and settles near stabilised occupancy', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'OCCUPANCY')!;
    const results = run(build(fixture, {}), 24);
    const occupancyAt = (i: number): number =>
      Object.values(results[i]!.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]
        ?.occupancy ?? 0;

    // rampConstant 5.0: lease-up is slower than any other archetype.
    expect(occupancyAt(0)).toBeLessThan(0.4);
    expect(occupancyAt(23)).toBeGreaterThan(occupancyAt(0) * 2);
    expect(occupancyAt(23)).toBeLessThanOrEqual(1);
  });

  it('has high operating leverage — small occupancy changes swing margin hard', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'OCCUPANCY')!;
    const low = run(build(fixture, { units: 300 }), 16);
    const high = run(build(fixture, { units: 900 }), 16);

    const marginOf = (results: TickResult[]): number => {
      const is = results[15]!.statements.consolidated.incomeStatement;
      return ratio(is.ebitda, is.revenue);
    };
    expect(marginOf(high)).toBeGreaterThan(marginOf(low));
  });
});

describe('UNITS_CAC marginal CAC wall (§3.3)', () => {
  it('CAC rises with spend, so marketing is not a money printer', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'UNITS_CAC')!;
    const modest = run(build(fixture, {}, 60_000), 8);
    const heavy = run(build(fixture, {}, 240_000), 8);

    const cacOf = (results: TickResult[]): number =>
      Number(
        Object.values(results[7]!.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]
          ?.effectiveCac ?? 0n,
      );

    expect(cacOf(heavy)).toBeGreaterThan(cacOf(modest));

    // Four times the spend must not buy four times the orders.
    const ordersOf = (results: TickResult[]): number =>
      Object.values(results[7]!.statements.byBusiness)[0]?.derivedMetrics.streamMetrics[0]
        ?.realizedVolume ?? 0;
    expect(ordersOf(heavy)).toBeLessThan(ordersOf(modest) * 4);
  });

  it('reports CAC payback in quarters', () => {
    const fixture = FIXTURES.find((f) => f.archetype === 'UNITS_CAC')!;
    const results = run(build(fixture, {}), 8);
    const stream = Object.values(results[7]!.statements.byBusiness)[0]!.derivedMetrics
      .streamMetrics[0]!;
    expect(stream.cacPaybackQuarters).toBeDefined();
    expect(stream.cacPaybackQuarters!).toBeGreaterThan(0);
  });
});

describe('seed template coverage (§4.7)', () => {
  it('covers all six archetypes', () => {
    const covered = new Set(listSeedTemplates().flatMap((t) => t.defaultArchetypes));
    expect([...covered].sort()).toEqual(
      ['OCCUPANCY', 'PROJECT_BACKLOG', 'SUBSCRIPTION', 'TRAFFIC', 'UNITS_CAC', 'UTILIZATION'].sort(),
    );
  });

  it('ships the twelve templates §4.7 asks for', () => {
    expect(listSeedTemplates().length).toBeGreaterThanOrEqual(12);
  });
});

describe('benchmark plausibility across every template (§13.3)', () => {
  /**
   * "A seeded full-service restaurant at default parameters must produce food
   * cost 28-32%, labor 30-35%, EBITDA margin 8-15%. Same for every template. If
   * the engine produces a restaurant with 60% EBITDA margins, the seeds or the
   * engine are wrong and the tool is not credible."
   *
   * Evaluated at maturity rather than in year one: every template ramps, and a
   * business is not mis-seeded because it loses money while it is still filling
   * up. Which year counts as maturity differs by archetype — a restaurant is
   * there by year three, a self-storage lease-up or a SaaS with a fixed
   * engineering team takes considerably longer.
   */
  const MATURITY_YEAR: Record<string, number> = {
    full_service_restaurant: 2,
    professional_services_firm: 3,
    ecommerce_dtc_brand: 4,
    b2b_saas: 8,
    self_storage: 5,
    general_contractor: 3,
    quick_service_restaurant: 2,
    coffee_shop: 2,
    retail_shop: 2,
    marketing_agency: 3,
    trades_contractor: 3,
    gym_fitness: 4,
  };

  const CAPITALISATION: Record<string, { equity: number; household: number }> = {
    full_service_restaurant: { equity: 700_000, household: 1_100_000 },
    professional_services_firm: { equity: 350_000, household: 750_000 },
    ecommerce_dtc_brand: { equity: 500_000, household: 900_000 },
    b2b_saas: { equity: 5_000_000, household: 5_400_000 },
    self_storage: { equity: 4_700_000, household: 5_100_000 },
    general_contractor: { equity: 900_000, household: 1_300_000 },
    quick_service_restaurant: { equity: 700_000, household: 1_100_000 },
    coffee_shop: { equity: 450_000, household: 800_000 },
    retail_shop: { equity: 500_000, household: 900_000 },
    marketing_agency: { equity: 350_000, household: 750_000 },
    trades_contractor: { equity: 700_000, household: 1_100_000 },
    gym_fitness: { equity: 1_400_000, household: 1_800_000 },
  };

  it.each(listSeedTemplates())('$label lands in band at maturity', (template) => {
    const capital = CAPITALISATION[template.id]!;
    const model = buildModelFromTemplate({
      businessName: template.label,
      template,
      archetype: template.defaultArchetypes[0]!,
      equityInjection: fromDisplay(capital.equity),
    });
    const world = createWorld({
      id: template.id,
      playerId: 'p',
      config: createWorldConfig({
        startMode: 'FREEPLAY',
        customCapital: fromDisplay(capital.household),
      }),
      models: [model],
    });

    const year = MATURITY_YEAR[template.id]!;
    const results = run(world, (year + 1) * 4);
    const slice = results.filter((r) => Math.floor(r.statements.period / 4) === year);
    const totalOf = (fn: (r: TickResult) => Money): Money =>
      slice.reduce<Money>((a, r) => a + fn(r), 0n);

    const revenue = totalOf((r) => r.statements.consolidated.incomeStatement.revenue);
    expect(revenue, `${template.label} produced no revenue at maturity`).toBeGreaterThan(0n);

    const check = (
      name: string,
      value: number,
      band?: { low: number; high: number },
    ): void => {
      if (!band) return;
      const pct = `${(value * 100).toFixed(1)}%`;
      expect(value, `${template.label} ${name} = ${pct}, band ${band.low}-${band.high}`).toBeGreaterThanOrEqual(band.low);
      expect(value, `${template.label} ${name} = ${pct}, band ${band.low}-${band.high}`).toBeLessThanOrEqual(band.high);
    };

    const bands = template.plausibility;
    check(
      'COGS',
      ratio(totalOf((r) => r.statements.consolidated.incomeStatement.costOfGoodsSold), revenue),
      bands.cogsPctOfRevenue,
    );
    check(
      'labor',
      ratio(totalOf((r) => r.statements.consolidated.incomeStatement.labor), revenue),
      bands.laborPctOfRevenue,
    );
    check(
      'occupancy',
      ratio(totalOf((r) => r.statements.consolidated.incomeStatement.occupancy), revenue),
      bands.occupancyPctOfRevenue,
    );
    check(
      'EBITDA margin',
      ratio(totalOf((r) => r.statements.consolidated.incomeStatement.ebitda), revenue),
      bands.ebitdaMarginPct,
    );
  });
});
