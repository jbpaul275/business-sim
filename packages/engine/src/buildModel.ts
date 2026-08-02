import { fromDisplay, mulRate, type Money } from '@bizsim/money';
import {
  DEFAULT_MAINTENANCE_PCT,
  type Archetype,
  type Assumption,
  type BusinessModel,
  type CostStructure,
  type LegalForm,
  type RevenueStreamSpec,
  type SeedTemplate,
  type StepFixedCost,
} from '@bizsim/schemas';
import { injectOmissionGuardLines, payrollLoadPct } from './omissionGuard.js';

/**
 * Build a complete `BusinessModel` from a seed template plus a handful of scale
 * inputs.
 *
 * This is model synthesis WITHOUT the LLM. M3 replaces the caller — an LLM
 * emits archetype choice, stream parameters and cost lines, and the engine
 * fills the rest from the template exactly as it does here. Keeping the path
 * engine-side means seed calibration (§13.3), golden files (§13.2) and the
 * property suite (§13.1) can all run before a single prompt exists, which is
 * what lets M1 and M2 ship without an LLM at all.
 */

export interface TrafficBuildInput {
  archetype: 'TRAFFIC';
  seats: number;
  turnsPerDay?: number;
  addressableTrafficPerQuarter: number;
  captureRate?: number;
  avgTicket?: Money;
  skuCount?: number;
}

export type BuildInput = TrafficBuildInput;

export interface BuildModelOptions {
  businessName: string;
  template: SeedTemplate;
  legalForm?: LegalForm;
  stream: BuildInput;
  marketingSpendPerQuarter?: Money;
  equityInjection: Money;
  debt?: { kind: 'SBA_7A' | 'AMORTIZING' | 'REVOLVER'; principal: Money; termQuarters: number }[];
  /** Lines the player explicitly acknowledged and zeroed (§4.6). */
  acknowledgedZeroes?: ReadonlySet<string>;
}

let assumptionSeq = 0;
const resetAssumptions = (): void => {
  assumptionSeq = 0;
};

function assume(
  out: Assumption[],
  path: string,
  label: string,
  value: number | Money,
  opts: {
    category: Assumption['category'];
    unit: Assumption['unit'];
    isMoney?: boolean;
    range?: { low: number; high: number };
    provenance?: Assumption['provenance'];
    sourceNote: string;
    benchmarkBand?: { low: number; high: number; source: string };
  },
): void {
  const numeric = typeof value === 'bigint' ? Number(value) / 100 : value;
  const range = opts.range ?? { low: numeric * 0.7, high: numeric * 1.3 };
  out.push({
    id: `a${(assumptionSeq += 1)}`,
    businessId: '',
    path,
    label,
    category: opts.category,
    value,
    unit: opts.unit,
    isMoney: opts.isMoney ?? typeof value === 'bigint',
    range,
    provenance: opts.provenance ?? 'BENCHMARK',
    sourceNote: opts.sourceNote,
    outsideBenchmark: opts.benchmarkBand
      ? numeric < opts.benchmarkBand.low || numeric > opts.benchmarkBand.high
      : false,
    challengeHistory: [],
    ...(opts.benchmarkBand ? { benchmarkBand: opts.benchmarkBand } : {}),
  });
}

export function buildModelFromTemplate(options: BuildModelOptions): BusinessModel {
  resetAssumptions();
  const t = options.template;
  const assumptions: Assumption[] = [];
  const defaults = t.streamParamDefaults;

  const num = (key: string, fallback: number): number => {
    const v = defaults[key];
    return typeof v === 'number' ? v : fallback;
  };

  const streamId = 's1';
  const marketing = options.marketingSpendPerQuarter ?? t.modifierDefaults.baseMarketingSpendPerQuarter;
  const avgTicket = options.stream.avgTicket ?? fromDisplay(num('avgTicket', 42));
  const captureRate = options.stream.captureRate ?? num('captureRate', 0.05);
  const skuCount = options.stream.skuCount ?? num('skuCount', 40);

  const stream: RevenueStreamSpec = {
    id: streamId,
    label: options.businessName,
    archetype: 'TRAFFIC',
    params: {
      kind: 'TRAFFIC',
      addressableTrafficPerQuarter: options.stream.addressableTrafficPerQuarter,
      captureRate,
      avgTicket,
      referencePrice: avgTicket,
      operatingDaysPerQuarter: num('operatingDaysPerQuarter', 91),
      capacityModel: {
        kind: 'SEAT_TURNS',
        seats: options.stream.seats,
        turnsPerDay: options.stream.turnsPerDay ?? num('turnsPerDay', 2),
      },
      peakConcentration: num('peakConcentration', 0.45),
      skuCount,
      baselineSkuCount: num('baselineSkuCount', 40),
    },
    modifiers: { ...t.modifierDefaults },
    marketingSpendPerQuarter: marketing,
    seasonality: t.seasonality,
    launchPeriod: 0,
  };

  const base = `streams.${streamId}`;
  assume(assumptions, `${base}.params.addressableTrafficPerQuarter`, 'Trade-area traffic per quarter', options.stream.addressableTrafficPerQuarter, {
    category: 'REVENUE',
    unit: 'count',
    sourceNote: 'Foot and vehicle traffic in the trade area, per site study.',
    provenance: 'PLAYER_ASSUMED',
  });
  assume(assumptions, `${base}.params.captureRate`, 'Capture rate', captureRate, {
    category: 'REVENUE',
    unit: 'pct',
    range: { low: 0.02, high: 0.08 },
    sourceNote: 'Share of trade-area traffic that transacts in a given quarter.',
    benchmarkBand: { low: 0.02, high: 0.08, source: 'IBISWorld 72251' },
  });
  assume(assumptions, `${base}.params.avgTicket`, 'Average ticket', avgTicket, {
    category: 'REVENUE',
    unit: 'USD',
    sourceNote: 'Blended check average across lunch and dinner service.',
    benchmarkBand: { low: 22, high: 65, source: 'NRA Restaurant Operations Report' },
  });
  assume(assumptions, `${base}.params.referencePrice`, 'Reference price at lock', avgTicket, {
    category: 'REVENUE',
    unit: 'USD',
    sourceNote: 'Elasticity anchor, snapshotted at concept lock.',
    provenance: 'CATALOG',
  });
  assume(assumptions, `${base}.params.operatingDaysPerQuarter`, 'Operating days per quarter', stream.params.kind === 'TRAFFIC' ? stream.params.operatingDaysPerQuarter : 91, {
    category: 'REVENUE',
    unit: 'days',
    range: { low: 60, high: 91 },
    sourceNote: 'Seven-day service less holiday closures.',
  });
  assume(assumptions, `${base}.params.capacityModel.seats`, 'Seats', options.stream.seats, {
    category: 'CAPEX',
    unit: 'count',
    sourceNote: 'Dining room seat count at the planned layout.',
    provenance: 'PLAYER_SOURCED',
  });
  assume(assumptions, `${base}.params.capacityModel.turnsPerDay`, 'Turns per day', options.stream.turnsPerDay ?? num('turnsPerDay', 2), {
    category: 'REVENUE',
    unit: 'ratio',
    range: { low: 1.2, high: 3.5 },
    sourceNote: 'Seat turns across the service day.',
    benchmarkBand: { low: 1.2, high: 3.0, source: 'NRA Restaurant Operations Report' },
  });
  assume(assumptions, `${base}.params.peakConcentration`, 'Peak-hour concentration', num('peakConcentration', 0.45), {
    category: 'REVENUE',
    unit: 'pct',
    range: { low: 0.3, high: 0.6 },
    sourceNote: 'Share of demand arriving in peak service hours.',
  });
  assume(assumptions, `${base}.params.skuCount`, 'Menu breadth', skuCount, {
    category: 'REVENUE',
    unit: 'count',
    range: { low: 10, high: 300 },
    sourceNote: 'Menu item count; drives service complexity and throughput.',
    provenance: 'PLAYER_SOURCED',
  });
  assume(assumptions, `${base}.params.baselineSkuCount`, 'Baseline menu breadth', num('baselineSkuCount', 40), {
    category: 'REVENUE',
    unit: 'count',
    sourceNote: 'Template normal breadth; the complexity factor is relative to this.',
    provenance: 'CATALOG',
  });
  for (const [key, value] of Object.entries(t.modifierDefaults)) {
    assume(assumptions, `${base}.modifiers.${key}`, humanise(key), value as number | Money, {
      category: 'REVENUE',
      unit: typeof value === 'bigint' ? 'USD' : 'ratio',
      sourceNote: `Seed default for ${t.label}.`,
    });
  }
  assume(assumptions, `${base}.marketingSpendPerQuarter`, 'Marketing spend per quarter', marketing, {
    category: 'COST',
    unit: 'USD',
    sourceNote: 'Player-set marketing budget for this stream.',
    provenance: 'PLAYER_ASSUMED',
  });
  assume(assumptions, `${base}.seasonality`, 'Seasonality profile', 1, {
    category: 'REVENUE',
    unit: 'ratio',
    sourceNote: 'Quarterly seasonal index, averaging 1.00.',
  });

  // ── Cost structure ───────────────────────────────────────────────────────
  const load = payrollLoadPct(t.workersCompPct, t.offersBenefits);

  // Open staffed to planned mature demand rather than to some arbitrary count.
  // Blocks never auto-scale during play (§4.3) — growing is a player decision
  // with a lead time — but a founder does not open a 64-seat dining room with
  // one cook, and starting deliberately short would bake the under-staffing
  // trap into every scenario rather than testing for it.
  const matureDemand =
    options.stream.addressableTrafficPerQuarter *
    captureRate *
    (1 + t.modifierDefaults.marketingMaxLift * (1 - Math.exp(-1)));

  const stepFixed: StepFixedCost[] = [
    makeStepBlock('kitchen_labor', 'Kitchen line', fromDisplay(13_000), 2000, 1, matureDemand),
    makeStepBlock('front_of_house', 'Front of house', fromDisplay(8_000), 2600, 1, matureDemand),
  ];

  const costs: CostStructure = {
    payrollLoadPct: load,
    variableWithRevenue: [
      {
        id: 'food_cost',
        label: 'Food & beverage cost',
        class: 'VARIABLE_REVENUE',
        pctOfRevenue: 0.3,
        appliesToStreamIds: 'ALL',
        statementLine: 'COGS',
        accruable: true,
      },
    ],
    variableWithActivity: [],
    stepFixed,
    fixedPeriod: [
      {
        id: 'rent',
        label: 'Rent',
        class: 'FIXED_PERIOD',
        amountPerQuarter: mulRate(t.monthlyRent, 3),
        annualEscalatorPct: 0.03,
        startPeriod: 0,
        renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
        statementLine: 'OCCUPANCY',
        accruable: true,
        isLabor: false,
        isOwnerComp: false,
        isPrepaidExpense: false,
      },
      {
        id: 'management',
        label: 'General manager',
        class: 'FIXED_PERIOD',
        amountPerQuarter: fromDisplay(13_000),
        annualEscalatorPct: 0.03,
        startPeriod: 0,
        renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
        statementLine: 'LABOR',
        accruable: false,
        isLabor: true,
        isOwnerComp: false,
        isPrepaidExpense: false,
      },
    ],
  };

  const capex = t.typicalCapex.map((c) => ({
    label: c.label,
    category: c.category,
    grossCost: c.cost,
    quantity: c.quantity,
    usefulLifeYears: c.usefulLifeYears,
    section179Elected: false,
    sourceNote: `Seed default for ${t.label}.`,
  }));

  const withGuard = injectOmissionGuardLines(costs, {
    template: t,
    archetypes: ['TRAFFIC'] as Archetype[],
    hasLocation: true,
    hasEmployees: true,
    assets: capex.map((c) => ({
      grossCost: mulRate(c.grossCost, c.quantity),
      maintenancePctOfGrossPerYear: DEFAULT_MAINTENANCE_PCT[c.category],
    })),
    ...(options.acknowledgedZeroes ? { acknowledgedZeroes: options.acknowledgedZeroes } : {}),
  });

  // Every cost line, injected or not, needs a registered assumption (§10.2).
  for (const cost of withGuard.variableWithRevenue) {
    assume(assumptions, `costs.${cost.id}.pctOfRevenue`, cost.label, cost.pctOfRevenue, {
      category: 'COST',
      unit: 'pct',
      sourceNote: `Seed default for ${t.label}.`,
      ...(cost.id === 'food_cost'
        ? {
            benchmarkBand: {
              low: 0.28,
              high: 0.32,
              source: 'NRA Restaurant Operations Report',
            },
          }
        : {}),
    });
  }
  for (const cost of withGuard.variableWithActivity) {
    assume(assumptions, `costs.${cost.id}.costPerUnit`, cost.label, cost.costPerUnit, {
      category: 'COST',
      unit: 'USD',
      sourceNote: `Seed default for ${t.label}.`,
    });
  }
  for (const cost of withGuard.stepFixed) {
    assume(assumptions, `costs.${cost.id}.blockCostPerQuarter`, `${cost.label} — cost per block`, cost.blockCostPerQuarter, {
      category: 'COST',
      unit: 'USD',
      sourceNote: `Seed default for ${t.label}.`,
    });
    assume(assumptions, `costs.${cost.id}.capacityPerBlock`, `${cost.label} — capacity per block`, cost.capacity.capacityPerBlock, {
      category: 'COST',
      unit: 'count',
      sourceNote: 'Volume one block supports before the next step is required.',
    });
  }
  for (const cost of withGuard.fixedPeriod) {
    assume(assumptions, `costs.${cost.id}.amountPerQuarter`, cost.label, cost.amountPerQuarter, {
      category: 'COST',
      unit: 'USD',
      sourceNote: `Seed default for ${t.label}.`,
      ...(cost.id === 'rent'
        ? { benchmarkBand: { low: 15_000, high: 60_000, source: 'IBISWorld 72251' } }
        : {}),
    });
    assume(assumptions, `costs.${cost.id}.annualEscalatorPct`, `${cost.label} — annual escalator`, cost.annualEscalatorPct, {
      category: 'COST',
      unit: 'pct',
      range: { low: 0, high: 0.05 },
      sourceNote: 'Contractual escalator, not an estimate.',
      provenance: 'CATALOG',
    });
  }
  assume(assumptions, 'costs.payrollLoadPct', 'Payroll load', load, {
    category: 'COST',
    unit: 'pct',
    range: { low: 0.1, high: 0.32 },
    sourceNote:
      'Employer FICA 7.65% + unemployment 1.5% + workers comp, seeded by industry. ' +
      'Applied by the engine to every labor line; cannot be zero (§4.5).',
    provenance: 'CATALOG',
  });

  const workingCapital = t.workingCapitalDefaults;
  for (const [key, value] of Object.entries(workingCapital)) {
    assume(assumptions, `workingCapital.${key}`, humanise(key), value as number, {
      category: 'WORKING_CAPITAL',
      unit: key.endsWith('Days') ? 'days' : key.endsWith('Months') ? 'years' : 'pct',
      sourceNote: `Seed default for ${t.label}.`,
    });
  }
  for (const c of capex) {
    assume(assumptions, `capex.${c.label}.grossCost`, c.label, c.grossCost, {
      category: 'CAPEX',
      unit: 'USD',
      sourceNote: c.sourceNote,
    });
  }

  return {
    businessName: options.businessName,
    legalForm: options.legalForm ?? 'LLC_PASSTHROUGH',
    seedTemplateId: t.id,
    streams: [stream],
    costs: withGuard,
    workingCapital,
    capex,
    financingPlan: {
      equityInjection: options.equityInjection,
      debtRequests: (options.debt ?? []).map((d) => ({
        kind: d.kind,
        requestedPrincipal: d.principal,
        termQuarters: d.termQuarters,
        personalGuarantee: d.kind === 'SBA_7A',
      })),
    },
    preOpeningCosts: {
      payrollAndTraining: t.preOpening.payrollAndTraining,
      marketing: t.preOpening.marketing,
      permitsAndLegal: t.preOpening.permitsAndLegal,
    },
    monthlyRent: t.monthlyRent,
    assumptions,
    openNotes: [],
  };
}

function makeStepBlock(
  id: string,
  label: string,
  blockCost: Money,
  capacityPerBlock: number,
  minimumBlocks: number,
  plannedDemand: number,
): StepFixedCost {
  const currentBlocks = Math.max(minimumBlocks, Math.ceil(plannedDemand / capacityPerBlock));
  return {
    id,
    label,
    class: 'STEP_FIXED',
    blockCostPerQuarter: blockCost,
    capacity: { driver: 'TRANSACTIONS', capacityPerBlock },
    appliesToStreamIds: 'ALL',
    minimumBlocks,
    currentBlocks,
    pendingBlocks: 0,
    addLeadTimeQuarters: 1,
    // Default severance is four weeks of the block cost (§4.3).
    removeSeverancePerBlock: mulRate(blockCost, 4 / 13),
    isLabor: true,
    statementLine: 'LABOR',
  };
}

const humanise = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/Pct$/, '%')
    .trim();
