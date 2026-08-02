import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import { jsonReplacer, type Action, type WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { replayFromGenesis, type ActionLogEntry } from './replay.js';
import { tick } from './tick.js';

/**
 * Event sourcing (§1.4) and engine purity (§1.3).
 *
 * The replay-equals-snapshot test is the only one that actually proves the
 * event-sourcing claim. Without it the action log is decorative.
 */

function world(): WorldState {
  const model = buildModelFromTemplate({
    businessName: 'Replay Test',
    template: getSeedTemplate('full_service_restaurant'),
    stream: {
      archetype: 'TRAFFIC',
      seats: 64,
      turnsPerDay: 2,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      avgTicket: fromDisplay(42),
    },
    equityInjection: fromDisplay(400_000),
    debt: [{ kind: 'REVOLVER', principal: fromDisplay(100_000), termQuarters: 40 }],
  });
  return createWorld({
    id: 'replay',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

const LOG: ActionLogEntry[] = [
  { period: 1, actions: [{ kind: 'SET_MARKETING_SPEND', streamId: 's1', amountPerQuarter: fromDisplay(14_000) }] },
  { period: 2, actions: [{ kind: 'ADD_STEP_BLOCK', costId: 'kitchen_labor', blocks: 1 }] },
  { period: 4, actions: [{ kind: 'SET_PRICE', streamId: 's1', newPrice: fromDisplay(46) }] },
  {
    period: 6,
    actions: [
      {
        kind: 'PURCHASE_ASSET',
        businessId: 'g5',
        asset: {
          label: 'Second oven',
          category: 'EQUIPMENT',
          grossCost: fromDisplay(40_000),
          quantity: 1,
          usefulLifeYears: 7,
          section179Elected: true,
        },
        financing: 'CASH',
      },
    ],
  },
  { period: 8, actions: [{ kind: 'DISTRIBUTE', businessId: 'g5', amount: fromDisplay(20_000) }] },
];

const serialise = (state: WorldState): string => JSON.stringify(state, jsonReplacer);

describe('event sourcing (§1.4)', () => {
  it('replaying the action log from genesis reproduces the snapshot exactly', () => {
    const genesis = world();

    // Forward run, keeping the snapshot at each period boundary.
    const byPeriod = new Map<number, Action[]>(LOG.map((e) => [e.period, e.actions]));
    let state = genesis;
    const snapshots: string[] = [];
    for (let i = 0; i < 20; i++) {
      const period = state.currentPeriod + 1;
      state = tick(state, byPeriod.get(period) ?? []).state;
      snapshots.push(serialise(state));
    }

    // Independent replay from genesis through the same engine.
    const replayed = replayFromGenesis(world(), LOG, 20);
    expect(replayed).toHaveLength(20);

    for (let i = 0; i < 20; i++) {
      expect(serialise(replayed[i]!.state), `period ${i} diverged on replay`).toBe(snapshots[i]);
    }
  });

  it('tick does not mutate the state it was given', () => {
    const state = world();
    const before = serialise(state);
    tick(state, [{ kind: 'SET_PRICE', streamId: 's1', newPrice: fromDisplay(50) }]);
    expect(serialise(state)).toBe(before);
  });

  it('is deterministic — the same input always yields the same output', () => {
    const state = world();
    const a = tick(state, []);
    const b = tick(state, []);
    expect(serialise(a.state)).toBe(serialise(b.state));
    expect(JSON.stringify(a.statements, jsonReplacer)).toBe(
      JSON.stringify(b.statements, jsonReplacer),
    );
  });

  it('mints ids from a counter in state, never from randomness', () => {
    // Two independent worlds run identically must produce identical ids, which
    // they cannot if anything reaches for Math.random or Date.now.
    const a = replayFromGenesis(world(), LOG, 10);
    const b = replayFromGenesis(world(), LOG, 10);
    expect(a[9]!.state.idCounter).toBe(b[9]!.state.idCounter);
    expect(serialise(a[9]!.state)).toBe(serialise(b[9]!.state));
  });
});

describe('provenance tracing (§10.4)', () => {
  it('records which assumptions fed which statement line when tracing is on', () => {
    const result = tick(world(), [], { trace: true });
    const paths = Object.keys(result.trace.byPath);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain('streams.s1.params.avgTicket');
    expect(paths).toContain('costs.food_cost.pctOfRevenue');
  });

  it('records nothing when tracing is off, so the hot path stays cheap', () => {
    const result = tick(world(), [], { trace: false });
    expect(Object.keys(result.trace.byPath)).toHaveLength(0);
  });
});

describe('performance budget', () => {
  /**
   * ≤1ms per tick, from docs/plan/04-risks-and-decisions.md. This is a product
   * requirement, not a preference: the sensitivity analysis in §12.3 runs up to
   * ~48,000 ticks per export, which is 30 seconds at 0.6ms and unusable at 20ms.
   */
  it('ticks well inside the 1ms budget', () => {
    let state = world();
    // Warm up, then measure.
    for (let i = 0; i < 20; i++) state = tick(state, []).state;

    // Best of several batches. A single mean is at the mercy of a GC pause or a
    // busy CI runner, and a flaky performance gate gets muted, which is worse
    // than no gate. The minimum still catches a genuine regression — code that
    // got slower is slower in every batch.
    const iterations = 100;
    const batches = 5;
    let best = Number.POSITIVE_INFINITY;

    for (let b = 0; b < batches; b++) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) state = tick(state, []).state;
      best = Math.min(best, (performance.now() - start) / iterations);
    }

    expect(best, `${best.toFixed(3)}ms per tick`).toBeLessThan(1);
  });
});
