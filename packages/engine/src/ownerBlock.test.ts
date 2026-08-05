import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { Action, SeedTemplate, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';
import { validateBusinessModel } from './validate.js';

/**
 * The owner-worked block — docs/plan/07-founder-profile.md stage 2.
 *
 * "I'll run it myself, 80 hours a week" fills one staffing slot: capacity
 * yes, payroll no, because the owner is already paid through the owner-comp
 * line and paying twice would be the duplicate-overheads bug in reverse.
 * Everything here is the deterministic half; how the block gets DECLARED
 * (the founder profile, never a persona picker) is the llm layer's contract.
 */

const SCALE = {
  seats: 64,
  turnsPerDay: 2,
  addressableTrafficPerQuarter: 180_000,
  captureRate: 0.05,
  price: fromDisplay(42),
};

/** The restaurant template with one owner-worked block on its labor line. */
function templates(): { plain: SeedTemplate; ownered: SeedTemplate; laborId: string } {
  const plain = getSeedTemplate('full_service_restaurant');
  const ownered = structuredClone(plain);
  const labor = ownered.costDefaults.find((c) => c.class === 'STEP_FIXED' && c.isLabor);
  if (!labor) throw new Error('restaurant template lost its labor line');
  labor.ownerBlocks = 1;
  return { plain, ownered, laborId: labor.lineId };
}

function modelFor(template: SeedTemplate) {
  return buildModelFromTemplate({
    businessName: 'Owner-operated',
    template,
    scale: SCALE,
    equityInjection: fromDisplay(500_000),
  });
}

function worldFor(template: SeedTemplate): WorldState {
  return createWorld({
    id: 'w',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [modelFor(template)],
  });
}

describe('the owner-worked block', () => {
  it('hires one fewer block and registers the declaration', () => {
    const { plain, ownered, laborId } = templates();
    const base = modelFor(plain).costs.stepFixed.find((c) => c.id === laborId)!;
    const line = modelFor(ownered).costs.stepFixed.find((c) => c.id === laborId)!;
    expect(line.ownerBlocks).toBe(1);
    expect(line.currentBlocks).toBe(base.currentBlocks - 1);

    const assumption = modelFor(ownered).assumptions.find(
      (a) => a.path === `costs.${laborId}.ownerBlocks`,
    );
    expect(assumption).toBeDefined();
    expect(assumption!.provenance).toBe('PLAYER_SOURCED');
    expect(assumption!.label).toContain('worked by you');
    // No hidden multipliers: the plain build registers no such line.
    expect(
      modelFor(plain).assumptions.some((a) => a.path === `costs.${laborId}.ownerBlocks`),
    ).toBe(false);
  });

  it('carries capacity but no payroll: same revenue, one block less labor', () => {
    const { plain, ownered } = templates();
    const a = tick(worldFor(plain), [], { throwOnAssertionFailure: false });
    const b = tick(worldFor(ownered), [], { throwOnAssertionFailure: false });
    const isA = a.statements.byBusiness[a.state.businesses[0]!.id]!.incomeStatement;
    const isB = b.statements.byBusiness[b.state.businesses[0]!.id]!.incomeStatement;
    // Capacity is identical — the owner's block serves customers like any other.
    expect(isB.revenue).toBe(isA.revenue);
    // Payroll is one block lighter; every other line is untouched.
    expect(isB.labor < isA.labor).toBe(true);
    expect(isB.occupancy).toBe(isA.occupancy);
  });

  it('a solo operator with zero paid staff is a business, not a validation error', () => {
    const { ownered, laborId } = templates();
    const model = modelFor(ownered);
    const line = model.costs.stepFixed.find((c) => c.id === laborId)!;
    line.currentBlocks = 0;
    line.minimumBlocks = 1;
    const issues = validateBusinessModel(model).issues.filter(
      (i) => i.path === `costs.${laborId}.currentBlocks`,
    );
    expect(issues).toEqual([]);
  });

  it('a clone hires a real block where the parent had the owner — one person, one site', () => {
    const { ownered, laborId } = templates();
    let state = worldFor(ownered);
    const parentLine = state.businesses[0]!.costs.stepFixed.find((c) => c.id === laborId)!;
    expect(parentLine.ownerBlocks).toBe(1);

    const cloneAction: Action = {
      kind: 'START_BUSINESS',
      mode: 'CLONE',
      cloneFromId: state.businesses[0]!.id,
      clone: { name: 'Second site', equity: fromDisplay(900_000), scale: 1 },
    };
    // Same shape as clone.test's `open`: the action on the first tick, then
    // enough quarters for the §9.5 lead time to elapse.
    for (let i = 0; i < 4; i++) {
      state = tick(state, i === 0 ? [cloneAction] : [], { throwOnAssertionFailure: false }).state;
    }
    const second = state.businesses.find((b) => b.name === 'Second site');
    expect(second).toBeDefined();
    const clonedLine = second!.costs.stepFixed.find((c) => c.id === laborId)!;
    expect(clonedLine.ownerBlocks).toBe(0);
    // The owner's slot became a hired one: staffing did not silently shrink.
    expect(clonedLine.currentBlocks).toBeGreaterThanOrEqual(parentLine.currentBlocks + 1);
  });
});
