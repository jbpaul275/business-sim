import { fromDisplay, mulRate, type Money } from '@bizsim/money';
import {
  DEFAULT_VOLUME_NOUN,
  ARCHETYPE_DRIVER,
  DEFAULT_MAINTENANCE_PCT,
  type Archetype,
  type ArchetypeParams,
  type Assumption,
  benchmarkDeviation,
  type BusinessModel,
  type CostStructure,
  type CostDefault,
  type LegalForm,
  type RevenueStreamSpec,
  type ScaleInput,
  type SeedTemplate,
  type StatementLine,
  type VariableActivityCost,
  type VariableRevenueCost,
  type StepFixedCost,
  type FixedPeriodCost,
  type VolumeDriver,
} from '@bizsim/schemas';
import { injectOmissionGuardLines, payrollLoadPct } from './omissionGuard.js';

/**
 * Build a complete `BusinessModel` from a seed template plus a handful of scale
 * inputs. This is model synthesis WITHOUT the LLM.
 *
 * M3 replaces the caller, not this file: an LLM emits archetype choice, stream
 * parameters and cost lines, and the engine fills the rest from the template
 * exactly as it does here. Keeping the path engine-side is what lets seed
 * calibration (§13.3), golden files (§13.2) and the property suite (§13.1) all
 * run before a single prompt exists.
 *
 * Everything archetype-specific reads from template data rather than from code
 * here, which is the point of §4.7: adding a template is a JSON change, not a
 * deploy. The only per-archetype code is `streamParams`, which shapes a flat
 * bag of defaults into the right discriminated union.
 */

/** Re-exported: the canonical shape now lives in @bizsim/schemas. */
export type { ScaleInput };

export interface BuildModelOptions {
  /** What one unit of volume is called: loads, covers, rounds, visits. */
  volumeNoun?: string;
  businessName: string;
  template: SeedTemplate;
  archetype?: Archetype;
  legalForm?: LegalForm;
  scale?: ScaleInput;
  marketingSpendPerQuarter?: Money;
  equityInjection: Money;
  debt?: { kind: 'SBA_7A' | 'AMORTIZING' | 'REVOLVER'; principal: Money; termQuarters: number }[];
  /** Lines the player explicitly acknowledged and zeroed (§4.6). */
  acknowledgedZeroes?: ReadonlySet<string>;
  /**
   * Money in the deal from neither the founder nor a lender — a tax credit, a
   * grant, a partner's cheque. See `zFinancingPlan.outsideCapital`.
   */
  outsideCapital?: Money;
  /**
   * Where a given assumption's value actually came from, by model path.
   *
   * Without this every registered assumption defaults to `BENCHMARK`, which is
   * true for a seed template and a lie for anything else. A concept the model
   * invented from nothing registered 49 assumptions as BENCHMARK and zero as
   * LLM_ESTIMATE — the register claiming published support for numbers that
   * had none, which is the one thing §10 exists to prevent.
   *
   * Returning undefined leaves the default alone. Explicitly-set provenance at
   * the call site still wins: a statutory rate is CATALOG no matter who
   * assembled the template around it.
   */
  provenanceFor?: (path: string) => Assumption['provenance'] | undefined;
  /**
   * Same shape, for the note beside the value. A caller that moved a figure
   * for a stated reason — the founder profile's ramp floor exists because of
   * the player's years in the trade — supplies the sentence that says so;
   * everywhere else the call site's generic note stands. The hook wins where
   * it answers, because a targeted note beats a generic one.
   */
  sourceNoteFor?: (path: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Assumption registration
// ---------------------------------------------------------------------------

interface AssumptionSink {
  next: number;
  out: Assumption[];
  provenanceFor?: ((path: string) => Assumption['provenance'] | undefined) | undefined;
  sourceNoteFor?: ((path: string) => string | undefined) | undefined;
}

function assume(
  sink: AssumptionSink,
  path: string,
  label: string,
  value: number | Money,
  opts: {
    category: Assumption['category'];
    unit: Assumption['unit'];
    range?: { low: number; high: number };
    provenance?: Assumption['provenance'];
    sourceNote: string;
    benchmarkBand?: { low: number; high: number; source: string };
  },
): void {
  const numeric = typeof value === 'bigint' ? Number(value) / 100 : value;
  const range = opts.range ?? {
    low: numeric >= 0 ? numeric * 0.7 : numeric * 1.3,
    high: numeric >= 0 ? numeric * 1.3 : numeric * 0.7,
  };
  const assumption: Assumption = {
    id: `a${(sink.next += 1)}`,
    businessId: '',
    path,
    label,
    category: opts.category,
    value,
    unit: opts.unit,
    isMoney: typeof value === 'bigint',
    range,
    provenance: opts.provenance ?? sink.provenanceFor?.(path) ?? 'BENCHMARK',
    sourceNote: sink.sourceNoteFor?.(path) ?? opts.sourceNote,
    outsideBenchmark: opts.benchmarkBand
      ? numeric < opts.benchmarkBand.low || numeric > opts.benchmarkBand.high
      : false,
    challengeHistory: [],
    ...(opts.benchmarkBand ? { benchmarkBand: opts.benchmarkBand } : {}),
  };

  // Derived, never supplied: the magnitude has to stay consistent with the
  // value and band or the challenge loop argues from a stale number (D-5).
  const deviation = benchmarkDeviation(assumption);
  if (deviation !== undefined) assumption.benchmarkDeviation = deviation;

  sink.out.push(assumption);
}

/**
 * The generic word for a driver's unit, used when a cost line is gated on a
 * different driver than the business's binding unit and the stream's own
 * volume noun would name the wrong thing.
 */
const DRIVER_NOUN: Record<VolumeDriver, string> = {
  TRANSACTIONS: 'transactions',
  ORDERS: 'orders',
  BILLABLE_HOURS: 'billable hours',
  OCCUPIED_UNITS: 'units occupied',
  SUBSCRIBERS: 'subscribers',
  PROJECTS_ACTIVE: 'active projects',
  REVENUE: 'revenue',
};

const humanise = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ Pct$/, ' %')
    .trim();

/** Infer a unit from the parameter name, so templates do not have to declare one. */
function unitFor(key: string, value: number | Money): Assumption['unit'] {
  if (typeof value === 'bigint') return 'USD';
  if (/Days$/.test(key)) return 'days';
  if (/Hours/.test(key)) return 'hours';
  if (/Years$/.test(key)) return 'years';
  if (/(Rate|Pct|occupancy|Utilization|utilisation|churn|attrition)/i.test(key)) return 'pct';
  if (/(Count|units|seats|Headcount|bids)/i.test(key)) return 'count';
  return 'ratio';
}

// ---------------------------------------------------------------------------
// Stream parameters
// ---------------------------------------------------------------------------

function streamParams(
  archetype: Archetype,
  template: SeedTemplate,
  scale: ScaleInput,
): ArchetypeParams {
  const d = template.streamParamDefaults;
  const num = (key: string, fallback: number): number => {
    const v = d[key];
    return typeof v === 'number' ? v : fallback;
  };
  const cash = (key: string, fallback: number): Money => fromDisplay(num(key, fallback));

  switch (archetype) {
    case 'TRAFFIC': {
      const avgTicket = scale.price ?? cash('avgTicket', 30);
      return {
        kind: 'TRAFFIC',
        addressableTrafficPerQuarter:
          scale.addressableTrafficPerQuarter ?? num('addressableTrafficPerQuarter', 150_000),
        captureRate: scale.captureRate ?? num('captureRate', 0.04),
        avgTicket,
        referencePrice: avgTicket,
        operatingDaysPerQuarter: num('operatingDaysPerQuarter', 91),
        capacityModel: {
          kind: 'SEAT_TURNS',
          seats: scale.seats ?? num('seats', 60),
          turnsPerDay: scale.turnsPerDay ?? num('turnsPerDay', 2),
          floorAreaSqFt: scale.floorAreaSqFt ?? num('floorAreaSqFt', 2_000),
        },
        peakConcentration: num('peakConcentration', 0.45),
        skuCount: scale.skuCount ?? num('skuCount', 40),
        baselineSkuCount: num('baselineSkuCount', 40),
      };
    }
    case 'UTILIZATION': {
      const rate = scale.price ?? cash('blendedHourlyRate', 150);
      return {
        kind: 'UTILIZATION',
        billableHoursPerHeadPerQuarter: num('billableHoursPerHeadPerQuarter', 480),
        targetUtilization: num('targetUtilization', 0.7),
        blendedHourlyRate: rate,
        referencePrice: rate,
        // The number services founders most reliably forget. Never 1.0.
        realizationRate: num('realizationRate', 0.9),
        demandHoursPerQuarter:
          scale.demandHoursPerQuarter ?? num('demandHoursPerQuarter', 4_000),
      };
    }
    case 'UNITS_CAC': {
      const aov = scale.price ?? cash('avgOrderValue', 85);
      return {
        kind: 'UNITS_CAC',
        baseCac: cash('baseCac', 38),
        cacInflationCoefficient: num('cacInflationCoefficient', 0.35),
        avgOrderValue: aov,
        referencePrice: aov,
        ordersPerNewCustomerFirstQuarter: num('ordersPerNewCustomerFirstQuarter', 1),
        repeatPurchaseRatePerQuarter: num('repeatPurchaseRatePerQuarter', 0.25),
        quarterlyCustomerAttrition: num('quarterlyCustomerAttrition', 0.12),
      };
    }
    case 'SUBSCRIPTION': {
      const arpu = scale.price ?? cash('arpuPerQuarter', 300);
      return {
        kind: 'SUBSCRIPTION',
        baseCac: cash('baseCac', 900),
        cacInflationCoefficient: num('cacInflationCoefficient', 0.3),
        arpuPerQuarter: arpu,
        referencePrice: arpu,
        quarterlyChurnRate: num('quarterlyChurnRate', 0.03),
        setupFee: cash('setupFee', 0),
        netRevenueRetention: num('netRevenueRetention', 1.02),
        prepayMonths: num('prepayMonths', 0),
      };
    }
    case 'OCCUPANCY': {
      const rate = scale.price ?? cash('ratePerUnitPerQuarter', 330);
      return {
        kind: 'OCCUPANCY',
        units: scale.units ?? num('units', 500),
        stabilizedOccupancy: num('stabilizedOccupancy', 0.88),
        ratePerUnitPerQuarter: rate,
        referencePrice: rate,
        concessionsPct: num('concessionsPct', 0.04),
        ancillaryRevenuePctOfBase: num('ancillaryRevenuePctOfBase', 0.08),
      };
    }
    case 'PROJECT_BACKLOG': {
      const contract = scale.price ?? cash('avgContractValue', 320_000);
      return {
        kind: 'PROJECT_BACKLOG',
        bidsSubmittedPerQuarter:
          scale.bidsSubmittedPerQuarter ?? num('bidsSubmittedPerQuarter', 9),
        winRate: num('winRate', 0.2),
        avgContractValue: contract,
        referencePrice: contract,
        executionCapacityPerQuarter:
          scale.executionCapacityPerQuarter ?? cash('executionCapacityPerQuarter', 700_000),
        retainagePct: num('retainagePct', 0.1),
        retainageReleaseLagQuarters: num('retainageReleaseLagQuarters', 2),
        progressBillingLagDays: num('progressBillingLagDays', 45),
        changeOrderPctOfContract: num('changeOrderPctOfContract', 0.06),
      };
    }
  }
}

/** A rough mature-demand figure, used only to size opening staffing. */
function plannedDemand(params: ArchetypeParams, template: SeedTemplate): number {
  const lift = 1 + template.modifierDefaults.marketingMaxLift * (1 - Math.exp(-1));
  switch (params.kind) {
    case 'TRAFFIC':
      return params.addressableTrafficPerQuarter * params.captureRate * lift;
    case 'UTILIZATION':
      return params.demandHoursPerQuarter * lift;
    // Acquisition-driven archetypes have no demand figure to read off the
    // parameters, so the steady state implied by spend and churn stands in.
    // Returning zero here would open the business at its minimum block count
    // and then cap it there — a SaaS staffed for 120 accounts can never serve
    // more than 120 accounts, because blocks do not auto-scale (§4.3). That is
    // the under-staffing trap arriving through the front door.
    case 'UNITS_CAC': {
      const spend = Number(template.modifierDefaults.baseMarketingSpendPerQuarter);
      const customers =
        params.baseCac > 0n && params.quarterlyCustomerAttrition > 0
          ? spend / Number(params.baseCac) / params.quarterlyCustomerAttrition
          : 0;
      return customers * params.repeatPurchaseRatePerQuarter * lift;
    }
    case 'SUBSCRIPTION': {
      const spend = Number(template.modifierDefaults.baseMarketingSpendPerQuarter);
      if (params.baseCac <= 0n || params.quarterlyChurnRate <= 0) return 0;
      return (spend / Number(params.baseCac) / params.quarterlyChurnRate) * lift;
    }
    case 'OCCUPANCY':
      return params.units * params.stabilizedOccupancy;
    case 'PROJECT_BACKLOG':
      return Number(params.executionCapacityPerQuarter);
  }
}

// ---------------------------------------------------------------------------
// Cost structure, driven entirely by template data
// ---------------------------------------------------------------------------

function costsFromTemplate(
  template: SeedTemplate,
  archetype: Archetype,
  demand: number,
  load: number,
): CostStructure {
  const variableWithRevenue: VariableRevenueCost[] = [];
  const variableWithActivity: VariableActivityCost[] = [];
  const stepFixed: StepFixedCost[] = [];
  const fixedPeriod: FixedPeriodCost[] = [];

  const asMoney = (c: CostDefault): Money =>
    typeof c.value === 'number' ? fromDisplay(c.value) : fromDisplay(c.value);
  const asRate = (c: CostDefault): number =>
    typeof c.value === 'number' ? c.value : Number(c.value);

  for (const c of template.costDefaults) {
    const statementLine = c.statementLine as StatementLine;
    switch (c.class) {
      case 'VARIABLE_REVENUE':
        variableWithRevenue.push({
          id: c.lineId,
          label: c.label,
          class: 'VARIABLE_REVENUE',
          pctOfRevenue: asRate(c),
          appliesToStreamIds: 'ALL',
          statementLine,
          accruable: c.accruable,
        });
        break;

      case 'VARIABLE_ACTIVITY':
        variableWithActivity.push({
          id: c.lineId,
          label: c.label,
          class: 'VARIABLE_ACTIVITY',
          costPerUnit: asMoney(c),
          driver: c.driver ?? ARCHETYPE_DRIVER[archetype],
          appliesToStreamIds: 'ALL',
          statementLine,
          accruable: c.accruable,
        });
        break;

      case 'STEP_FIXED': {
        const driver = c.driver ?? ARCHETYPE_DRIVER[archetype];
        // Template capacities are authored in the natural unit — transactions,
        // hours, units — except for the REVENUE driver, where the natural unit
        // is dollars and the engine works in cents. Read literally, a crew that
        // executes $450k a quarter looks like 450,000 cents and the model hires
        // two hundred crews.
        const capacityPerBlock =
          driver === 'REVENUE'
            ? Number(fromDisplay(c.capacityPerBlock ?? 1))
            : (c.capacityPerBlock ?? 1);
        const blockCost = asMoney(c);
        const ownerBlocks = c.ownerBlocks ?? 0;
        // Open staffed to planned mature demand. Blocks never auto-scale
        // during play (§4.3) — growing is a player decision with a lead time
        // — but nobody opens a 64-seat dining room with one cook, and
        // starting short would bake the under-staffing trap into every
        // scenario rather than testing for it. An owner-worked block (07)
        // fills one of those slots, so one fewer is hired — that is the
        // "staffing need reduced" the profile promises, and it may go all
        // the way to zero paid staff: a solo operator is a business.
        const staffedToDemand = Math.max(
          c.minimumBlocks,
          capacityPerBlock > 0 ? Math.ceil(demand / capacityPerBlock) : c.minimumBlocks,
        );
        stepFixed.push({
          id: c.lineId,
          label: c.label,
          class: 'STEP_FIXED',
          blockCostPerQuarter: blockCost,
          capacity: { driver: driver as 'TRANSACTIONS', capacityPerBlock },
          appliesToStreamIds: 'ALL',
          minimumBlocks: c.minimumBlocks,
          currentBlocks: Math.max(0, staffedToDemand - ownerBlocks),
          ownerBlocks,
          pendingBlocks: 0,
          addLeadTimeQuarters: 1,
          // Default severance is four weeks of the block cost (§4.3).
          removeSeverancePerBlock: mulRate(blockCost, 4 / 13),
          isLabor: c.isLabor,
          statementLine,
        });
        break;
      }

      case 'FIXED_PERIOD':
        fixedPeriod.push({
          id: c.lineId,
          label: c.label,
          class: 'FIXED_PERIOD',
          amountPerQuarter: asMoney(c),
          annualEscalatorPct: c.annualEscalatorPct,
          startPeriod: 0,
          renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
          statementLine,
          accruable: c.accruable,
          isLabor: c.isLabor,
          isOwnerComp: false,
          isPrepaidExpense: c.isPrepaidExpense,
        });
        break;
    }
  }

  return { variableWithRevenue, variableWithActivity, stepFixed, fixedPeriod, payrollLoadPct: load };
}

// ---------------------------------------------------------------------------

export function buildModelFromTemplate(options: BuildModelOptions): BusinessModel {
  const t = options.template;
  const archetype = options.archetype ?? t.defaultArchetypes[0] ?? 'TRAFFIC';
  const scale = options.scale ?? {};
  const sink: AssumptionSink = {
    next: 0,
    out: [],
    provenanceFor: options.provenanceFor,
    sourceNoteFor: options.sourceNoteFor,
  };

  const streamId = 's1';
  const params = streamParams(archetype, t, scale);
  const marketing =
    options.marketingSpendPerQuarter ?? t.modifierDefaults.baseMarketingSpendPerQuarter;

  const stream: RevenueStreamSpec = {
    id: streamId,
    label: options.businessName,
    archetype,
    params,
    modifiers: { ...t.modifierDefaults },
    marketingSpendPerQuarter: marketing,
    seasonality: t.seasonality,
    launchPeriod: 0,
    // The trade's own word for a unit of volume, when the caller knows it. A
    // seeded template does not, so the archetype's binding unit stands in.
    volumeNoun: options.volumeNoun ?? t.volumeNoun ?? DEFAULT_VOLUME_NOUN[archetype],
  };

  // ── Assumptions for every stream parameter (§10.2) ───────────────────────
  const base = `streams.${streamId}`;
  for (const [key, value] of Object.entries(params)) {
    if (key === 'kind') continue;
    if (key === 'capacityModel') {
      for (const [ck, cv] of Object.entries(value as Record<string, unknown>)) {
        if (ck === 'kind') continue;
        assume(sink, `${base}.params.capacityModel.${ck}`, humanise(ck), cv as number, {
          category: 'CAPEX',
          unit: unitFor(ck, cv as number),
          sourceNote: `Seed default for ${t.label}.`,
        });
      }
      continue;
    }
    assume(sink, `${base}.params.${key}`, humanise(key), value as number | Money, {
      category: 'REVENUE',
      unit: unitFor(key, value as number | Money),
      sourceNote:
        key === 'referencePrice'
          ? 'Elasticity anchor, snapshotted at concept lock.'
          : `Seed default for ${t.label}.`,
      ...(key === 'referencePrice' ? { provenance: 'CATALOG' as const } : {}),
    });
  }
  for (const [key, value] of Object.entries(t.modifierDefaults)) {
    assume(sink, `${base}.modifiers.${key}`, humanise(key), value as number | Money, {
      category: 'REVENUE',
      unit: unitFor(key, value as number | Money),
      sourceNote: `Seed default for ${t.label}.`,
    });
  }
  /**
   * Not the player's assertion, and it has not been for a while.
   *
   * This was hardcoded to PLAYER_ASSUMED with the note "Player-set marketing
   * budget for this stream" back when setup asked for a marketing budget.
   * That question was removed on purpose — asking someone for a number they
   * have no basis for is an intake form pretending to be a decision — and the
   * register was never told. So every run since has opened by listing the
   * engine's own default under "your assertions with no evidence behind them",
   * which is both false and the most damning line on the screen.
   *
   * The provenance now resolves the same way every other assumption's does: an
   * LLM-drafted concept's figure is the model's estimate, a seed template's is
   * a seed default. If a caller ever does supply a player's own number, they
   * can say so through `provenanceFor` like everything else.
   */
  assume(sink, `${base}.marketingSpendPerQuarter`, 'Marketing spend per quarter', marketing, {
    category: 'COST',
    unit: 'USD',
    sourceNote: 'Opening marketing budget. `marketing <amount>` changes it in any quarter.',
  });
  assume(sink, `${base}.seasonality`, 'Seasonality profile', 1, {
    category: 'REVENUE',
    unit: 'ratio',
    sourceNote: 'Quarterly seasonal index, averaging 1.00.',
  });

  // ── Costs ───────────────────────────────────────────────────────────────
  const load = payrollLoadPct(t.workersCompPct, t.offersBenefits);
  const costs = costsFromTemplate(t, archetype, plannedDemand(params, t), load);

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
    archetypes: [archetype],
    hasLocation: t.monthlyRent > 0n,
    hasEmployees: costs.stepFixed.some((c) => c.isLabor),
    assets: capex.map((c) => ({
      grossCost: mulRate(c.grossCost, c.quantity),
      maintenancePctOfGrossPerYear: DEFAULT_MAINTENANCE_PCT[c.category],
    })),
    ...(options.acknowledgedZeroes ? { acknowledgedZeroes: options.acknowledgedZeroes } : {}),
  });

  // Every cost line, injected or not, needs a registered assumption (§10.2).
  /**
   * A band is only meaningful against a value in the same units. Template
   * bands are authored per cost line, but a line's assumption may be a rate
   * (pctOfRevenue) or an amount (amountPerQuarter) — and comparing a 6-10%
   * band against $33,000 of rent flags every lease ever written as out of
   * band, which is worse than having no band at all: it trains the player to
   * ignore the flag that §11.3.1 depends on.
   */
  const bandFor = (
    lineId: string,
    expects: 'rate' | 'money',
  ): { low: number; high: number; source: string } | undefined => {
    const band = t.costDefaults.find((c) => c.lineId === lineId)?.benchmarkBand;
    if (!band) return undefined;
    const looksLikeRate = Math.abs(band.high) <= 1;
    return looksLikeRate === (expects === 'rate') ? band : undefined;
  };

  for (const cost of withGuard.variableWithRevenue) {
    assume(sink, `costs.${cost.id}.pctOfRevenue`, cost.label, cost.pctOfRevenue, {
      category: 'COST',
      unit: 'pct',
      sourceNote:
        t.costDefaults.find((c) => c.lineId === cost.id)?.sourceNote ??
        `Injected by the omission guard for ${t.label}.`,
      ...(bandFor(cost.id, 'rate') ? { benchmarkBand: bandFor(cost.id, 'rate')! } : {}),
    });
  }
  for (const cost of withGuard.variableWithActivity) {
    assume(sink, `costs.${cost.id}.costPerUnit`, cost.label, cost.costPerUnit, {
      category: 'COST',
      unit: 'USD',
      sourceNote: t.costDefaults.find((c) => c.lineId === cost.id)?.sourceNote ?? '',
    });
  }
  for (const cost of withGuard.stepFixed) {
    const note = t.costDefaults.find((c) => c.lineId === cost.id)?.sourceNote ?? '';
    assume(sink, `costs.${cost.id}.blockCostPerQuarter`, `${cost.label} — cost per block`, cost.blockCostPerQuarter, {
      category: 'COST',
      unit: 'USD',
      sourceNote: note,
      ...(bandFor(cost.id, 'money') ? { benchmarkBand: bandFor(cost.id, 'money')! } : {}),
    });
    // A bare "11,000" beside dollar lines reads as money — a play-tester took
    // a crew shift's transaction capacity for a $11,000 cost. The label names
    // what the count counts, in the trade's own word where the driver is the
    // business's binding unit. REVENUE-driver capacity is stored in cents (see
    // the STEP_FIXED build above) and stays unlabelled rather than wearing a
    // noun its raw value would contradict.
    const capacityNoun =
      cost.capacity.driver === 'REVENUE'
        ? undefined
        : cost.capacity.driver === ARCHETYPE_DRIVER[archetype]
          ? stream.volumeNoun
          : DRIVER_NOUN[cost.capacity.driver];
    assume(
      sink,
      `costs.${cost.id}.capacityPerBlock`,
      `${cost.label} — capacity per block${capacityNoun ? ` (${capacityNoun})` : ''}`,
      cost.capacity.capacityPerBlock,
      {
        category: 'COST',
        unit: 'count',
        sourceNote: 'Volume one block supports before the next step is required.',
      },
    );
    // The owner-worked block registers like everything else — no hidden
    // multipliers (07). PLAYER_SOURCED because it exists only when the player
    // declared it; revising it to 0 in play is how they step back.
    if ((cost.ownerBlocks ?? 0) > 0) {
      assume(sink, `costs.${cost.id}.ownerBlocks`, `${cost.label} — worked by you`, cost.ownerBlocks, {
        category: 'COST',
        unit: 'count',
        range: { low: 0, high: 1 },
        provenance: 'PLAYER_SOURCED',
        sourceNote:
          'One block of this line is the owner working it, as declared in setup. ' +
          'It carries capacity and costs nothing beyond owner comp. Revise to 0 to step back.',
      });
    }
  }
  for (const cost of withGuard.fixedPeriod) {
    assume(sink, `costs.${cost.id}.amountPerQuarter`, cost.label, cost.amountPerQuarter, {
      category: 'COST',
      unit: 'USD',
      sourceNote:
        t.costDefaults.find((c) => c.lineId === cost.id)?.sourceNote ??
        `Injected by the omission guard for ${t.label}.`,
      ...(bandFor(cost.id, 'money') ? { benchmarkBand: bandFor(cost.id, 'money')! } : {}),
    });
    assume(sink, `costs.${cost.id}.annualEscalatorPct`, `${cost.label} — annual escalator`, cost.annualEscalatorPct, {
      category: 'COST',
      unit: 'pct',
      range: { low: 0, high: 0.05 },
      sourceNote: 'Contractual escalator, not an estimate.',
      provenance: 'CATALOG',
    });
  }
  assume(sink, 'costs.payrollLoadPct', 'Payroll load', load, {
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
    assume(sink, `workingCapital.${key}`, humanise(key), value as number, {
      category: 'WORKING_CAPITAL',
      unit: unitFor(key, value as number),
      sourceNote: `Seed default for ${t.label}.`,
    });
  }
  for (const c of capex) {
    assume(sink, `capex.${c.label}.grossCost`, c.label, c.grossCost, {
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
      outsideCapital: options.outsideCapital ?? 0n,
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
    assumptions: sink.out,
    openNotes: [],
  };
}
