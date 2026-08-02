import { fromDisplay } from '@bizsim/money';
import { buildModelFromTemplate, createWorld, createWorldConfig } from '@bizsim/engine';
import type { WorldState } from '@bizsim/schemas';
import { getSeedTemplate } from '@bizsim/seeds';

/**
 * Reference scenarios used by the CLI, the golden-file suite and seed
 * calibration.
 *
 * The restaurant matches Appendix A's converged reference run: 64 seats,
 * $42 ticket, 180k quarterly trade-area traffic, 5.0% capture.
 */

export function referenceRestaurant(): WorldState {
  const template = getSeedTemplate('full_service_restaurant');

  const model = buildModelFromTemplate({
    businessName: 'Reference Restaurant',
    template,
    legalForm: 'LLC_PASSTHROUGH',
    stream: {
      archetype: 'TRAFFIC',
      seats: 64,
      turnsPerDay: 2.0,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      avgTicket: fromDisplay(42),
    },
    marketingSpendPerQuarter: fromDisplay(8_000),
    equityInjection: fromDisplay(350_000),
    debt: [
      { kind: 'SBA_7A', principal: fromDisplay(400_000), termQuarters: 40 },
      { kind: 'REVOLVER', principal: fromDisplay(100_000), termQuarters: 40 },
    ],
  });

  return createWorld({
    id: 'reference-restaurant',
    playerId: 'reference-player',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

/**
 * A business growing hard on 60-day terms with thin margins. §13.5 calls this
 * the single most important behavioural test in the suite: if it does NOT run
 * out of cash, working capital is wired wrong.
 */
export function growthCashCrunch(): WorldState {
  const template = getSeedTemplate('full_service_restaurant');

  const model = buildModelFromTemplate({
    businessName: 'Growth Cash Crunch',
    template,
    legalForm: 'LLC_PASSTHROUGH',
    stream: {
      archetype: 'TRAFFIC',
      seats: 200,
      turnsPerDay: 3.0,
      addressableTrafficPerQuarter: 900_000,
      captureRate: 0.05,
      avgTicket: fromDisplay(42),
    },
    marketingSpendPerQuarter: fromDisplay(40_000),
    equityInjection: fromDisplay(150_000),
  });

  // Thin margins and slow collection: the combination §13.5 names.
  model.costs.variableWithRevenue = model.costs.variableWithRevenue.map((c) =>
    c.id === 'food_cost' ? { ...c, pctOfRevenue: 0.44 } : c,
  );
  model.workingCapital = { ...model.workingCapital, dsoDays: 60, dpoDays: 10 };

  return createWorld({
    id: 'growth-cash-crunch',
    playerId: 'reference-player',
    config: createWorldConfig({ startMode: 'LOW' }),
    models: [model],
  });
}

/**
 * A TRAFFIC business staffed well below demand. §13.5's under-staffing trap
 * regression drives this one with one block added per quarter.
 */
export function understaffedRestaurant(): WorldState {
  const template = getSeedTemplate('full_service_restaurant');

  const model = buildModelFromTemplate({
    businessName: 'Understaffed Restaurant',
    template,
    stream: {
      archetype: 'TRAFFIC',
      seats: 200,
      turnsPerDay: 3.0,
      addressableTrafficPerQuarter: 600_000,
      captureRate: 0.05,
      avgTicket: fromDisplay(42),
    },
    equityInjection: fromDisplay(600_000),
  });

  // Start deliberately short-staffed: two blocks against demand needing many.
  model.costs.stepFixed = model.costs.stepFixed.map((c) => ({ ...c, currentBlocks: 1 }));

  return createWorld({
    id: 'understaffed',
    playerId: 'reference-player',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

export const SCENARIOS: Record<string, () => WorldState> = {
  restaurant: referenceRestaurant,
  'cash-crunch': growthCashCrunch,
  understaffed: understaffedRestaurant,
};
