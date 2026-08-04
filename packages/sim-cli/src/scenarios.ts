import { fromDisplay } from '@bizsim/money';
import { buildModelFromTemplate, createWorld, createWorldConfig } from '@bizsim/engine';
import type { Archetype, WorldState } from '@bizsim/schemas';
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
    scale: {
      seats: 64,
      turnsPerDay: 2.0,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      price: fromDisplay(42),
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
    scale: {
      seats: 200,
      turnsPerDay: 3.0,
      addressableTrafficPerQuarter: 900_000,
      captureRate: 0.05,
      price: fromDisplay(42),
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
    scale: {
      seats: 200,
      turnsPerDay: 3.0,
      addressableTrafficPerQuarter: 600_000,
      captureRate: 0.05,
      price: fromDisplay(42),
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

/**
 * One reference scenario per archetype, so seed calibration (§13.3) can be
 * driven from the command line rather than from a test runner. Appendix A
 * records three iterations to land a single template in band; doing that
 * eleven more times without a harness is eleven rounds of clicking.
 */
function fromTemplate(
  id: string,
  name: string,
  archetype: Archetype,
  equity: number,
  household: number,
  debt: { kind: 'SBA_7A' | 'REVOLVER'; principal: number; termQuarters: number }[] = [],
): () => WorldState {
  return () => {
    const model = buildModelFromTemplate({
      businessName: name,
      template: getSeedTemplate(id),
      archetype,
      equityInjection: fromDisplay(equity),
      debt: debt.map((d) => ({
        kind: d.kind,
        principal: fromDisplay(d.principal),
        termQuarters: d.termQuarters,
      })),
    });
    return createWorld({
      id,
      playerId: 'reference-player',
      config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: fromDisplay(household) }),
      models: [model],
    });
  };
}

export const SCENARIOS: Record<string, () => WorldState> = {
  restaurant: referenceRestaurant,
  'cash-crunch': growthCashCrunch,
  understaffed: understaffedRestaurant,
  services: fromTemplate('professional_services_firm', 'Reference Agency', 'UTILIZATION', 350_000, 750_000, [
    { kind: 'REVOLVER', principal: 150_000, termQuarters: 40 },
  ]),
  ecommerce: fromTemplate('ecommerce_dtc_brand', 'Reference DTC Brand', 'UNITS_CAC', 500_000, 900_000, [
    { kind: 'REVOLVER', principal: 150_000, termQuarters: 40 },
  ]),
  saas: fromTemplate('b2b_saas', 'Reference SaaS', 'SUBSCRIPTION', 5_000_000, 5_400_000),
  storage: fromTemplate('self_storage', 'Reference Storage', 'OCCUPANCY', 1_900_000, 2_400_000, [
    { kind: 'SBA_7A', principal: 2_800_000, termQuarters: 100 },
  ]),
  contractor: fromTemplate('general_contractor', 'Reference Contractor', 'PROJECT_BACKLOG', 900_000, 1_300_000, [
    { kind: 'REVOLVER', principal: 400_000, termQuarters: 40 },
  ]),
  qsr: fromTemplate('quick_service_restaurant', 'Reference QSR', 'TRAFFIC', 700_000, 1_100_000, [
    { kind: 'SBA_7A', principal: 300_000, termQuarters: 40 },
  ]),
  coffee: fromTemplate('coffee_shop', 'Reference Coffee Shop', 'TRAFFIC', 450_000, 800_000, [
    { kind: 'SBA_7A', principal: 150_000, termQuarters: 40 },
  ]),
  retail: fromTemplate('retail_shop', 'Reference Retail Shop', 'TRAFFIC', 500_000, 900_000, [
    { kind: 'REVOLVER', principal: 100_000, termQuarters: 40 },
  ]),
  agency: fromTemplate('marketing_agency', 'Reference Marketing Agency', 'UTILIZATION', 350_000, 750_000, [
    { kind: 'REVOLVER', principal: 120_000, termQuarters: 40 },
  ]),
  trades: fromTemplate('trades_contractor', 'Reference Trades Contractor', 'PROJECT_BACKLOG', 700_000, 1_100_000, [
    { kind: 'REVOLVER', principal: 250_000, termQuarters: 40 },
  ]),
  gym: fromTemplate('gym_fitness', 'Reference Gym', 'SUBSCRIPTION', 1_400_000, 1_800_000, [
    { kind: 'SBA_7A', principal: 600_000, termQuarters: 40 },
  ]),
};
