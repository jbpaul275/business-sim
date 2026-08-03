import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import { buildModelFromTemplate } from './buildModel.js';
import { setAtPath } from './assumptionPath.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';

/**
 * The register has to be a record OF the model, not a document beside it.
 *
 * `ADJUST_ASSUMPTION` set the value on the register and stopped there. Nothing
 * the tick reads ever saw it, so a player who argued a $60k freezer down to
 * $22k and won changed a line in a document and nothing in their business —
 * which makes the whole §11.3 contract theatre.
 */

const model = () =>
  buildModelFromTemplate({
    businessName: 'Pathfinder',
    template: getSeedTemplate('full_service_restaurant'),
    scale: { seats: 64, turnsPerDay: 2, price: fromDisplay(42) },
    equityInjection: fromDisplay(500_000),
  });

describe('resolving a registered path', () => {
  it('writes a stream parameter', () => {
    const m = model();
    expect(setAtPath(m, 'streams.s1.params.avgTicket', fromDisplay(55))).toBe(true);
    const params = m.streams[0]!.params;
    if (params.kind !== 'TRAFFIC') throw new Error('shape');
    expect(params.avgTicket).toBe(fromDisplay(55));
  });

  it('writes a cost line by id, not by position', () => {
    // A register written against array indices points at the wrong line the
    // first time a cost is reordered.
    const m = model();
    const line = m.costs.variableWithRevenue[0]!;
    m.costs.variableWithRevenue.reverse();
    expect(setAtPath(m, `costs.${line.id}.pctOfRevenue`, 0.19)).toBe(true);
    expect(m.costs.variableWithRevenue.find((c) => c.id === line.id)!.pctOfRevenue).toBe(0.19);
  });

  it('writes the one nested case the register flattens', () => {
    const m = model();
    const step = m.costs.stepFixed.find((c) => c.capacity);
    if (!step) return;
    expect(setAtPath(m, `costs.${step.id}.capacityPerBlock`, 9_999)).toBe(true);
    expect(step.capacity!.capacityPerBlock).toBe(9_999);
  });

  it('refuses a path that no longer resolves rather than throwing', () => {
    expect(setAtPath(model(), 'streams.nope.params.avgTicket', 1)).toBe(false);
    expect(setAtPath(model(), 'costs.ghost.pctOfRevenue', 1)).toBe(false);
    expect(setAtPath(model(), 'streams.s1.params.notAField', 1)).toBe(false);
  });

  it('refuses to write a number where money lives, and the reverse', () => {
    // Mixing them produces a `Cannot mix BigInt` throw several steps later, in
    // a formula with nothing to do with the assumption that caused it.
    expect(setAtPath(model(), 'streams.s1.params.avgTicket', 55)).toBe(false);
    expect(setAtPath(model(), 'streams.s1.params.captureRate', fromDisplay(1))).toBe(false);
  });
});

describe('adjusting an assumption moves the business', () => {
  it('changes what the next quarter earns', () => {
    const world = createWorld({
      id: 'adjust',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model()],
    });
    const business = world.businesses[0]!;
    const ticket = Object.values(business.assumptions.byId).find(
      (a) => a.path === 'streams.s1.params.avgTicket',
    );
    expect(ticket, 'the average ticket is registered').toBeDefined();

    const before = tick(world, [], { throwOnAssertionFailure: true });
    const after = tick(
      world,
      [
        {
          kind: 'ADJUST_ASSUMPTION',
          assumptionId: ticket!.id,
          newValue: fromDisplay(63),
          evidence: 'Menu costed at current supplier prices.',
        },
      ],
      { throwOnAssertionFailure: true },
    );

    const revenueOf = (r: typeof before): bigint =>
      r.statements.consolidated.incomeStatement.revenue;
    expect(revenueOf(after)).not.toBe(revenueOf(before));
    // And the register agrees with the model, which is the whole point.
    const registered = after.state.businesses[0]!.assumptions.byId[ticket!.id]!;
    expect(registered.value).toBe(fromDisplay(63));
    expect(registered.provenance).toBe('PLAYER_SOURCED');
  });

  it('says so when the path is broken instead of silently doing nothing', () => {
    const world = createWorld({
      id: 'broken',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model()],
    });
    const business = world.businesses[0]!;
    const first = Object.values(business.assumptions.byId)[0]!;
    first.path = 'streams.gone.params.avgTicket';

    const result = tick(
      world,
      [{ kind: 'ADJUST_ASSUMPTION', assumptionId: first.id, newValue: 1 }],
      { throwOnAssertionFailure: true },
    );
    expect(result.events.some((e) => e.kind === 'ACTION_REJECTED')).toBe(true);
  });
});
