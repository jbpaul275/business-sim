import {
  ARCHETYPE_DRIVER,
  payrollLoadPct,
  zSeedTemplate,
  type CostDefault,
  type Provenance,
  type ScaleInput,
  type SeedTemplate,
  type SeedTemplateInput,
} from '@bizsim/schemas';
import { type ConceptDraft, type DraftCostLine, type DraftStream } from './draft.js';

/**
 * Turn a drafted concept into the inputs `buildModelFromTemplate` already
 * takes: a seed template and a set of scale knobs.
 *
 * The design choice worth explaining is that a novel concept becomes a
 * **synthetic seed template** rather than getting its own synthesis path. Every
 * guarantee the engine offers — the omission guard, assumption registration
 * with provenance, validation, the property suite — is already wired to that
 * one entry point. A second path would have to re-earn all of it, and would
 * drift. So the LLM's cost lines are shaped into the same structure the JSON
 * templates use, and the engine cannot tell the difference.
 *
 * What it *can* tell the difference about is sourcing: this template carries
 * `plausibility: {}` and no `benchmarkBand` on any line. That is D-5 in the
 * data — a concept with no comparable inherits no bands, so nothing gets
 * flagged out-of-band against numbers that do not exist, and the confidence
 * score reports the uncertainty instead.
 *
 * This file imports `@bizsim/schemas` and nothing else. It must never reach the
 * engine: spec §1.1 says the LLM never computes a statement value, and
 * dependency-cruiser enforces it.
 */

export interface MappedConcept {
  /** The trade's own word for a unit of volume — loads, covers, rounds. */
  volumeNoun: string;
  template: SeedTemplate;
  scale: ScaleInput;
  marketingSpendPerQuarter: number;
  archetype: DraftStream['archetype'];
  legalForm: ConceptDraft['legalForm'];
  businessName: string;
  /**
   * Where each registered assumption's value came from, by model path.
   *
   * Without this the engine defaults everything to BENCHMARK, which is right
   * for a seed template and wrong for a synthetic one. A Detroit ice rink
   * invented in five turns registered 49 BENCHMARK assumptions and zero
   * LLM_ESTIMATE — the register asserting published support for numbers the
   * model had made up. The draft carries honest per-value provenance; this is
   * what stops the mapper discarding it.
   */
  provenanceFor: (path: string) => Provenance | undefined;
}

/** Scale knobs the archetypes read, keyed as `ScaleInput` spells them. */
const SCALE_KEYS = new Set<string>([
  'seats',
  'turnsPerDay',
  'floorAreaSqFt',
  'addressableTrafficPerQuarter',
  'captureRate',
  'skuCount',
  'demandHoursPerQuarter',
  'units',
  'bidsSubmittedPerQuarter',
  'executionCapacityPerQuarter',
]);

/** Scale fields carried as Money rather than a plain number. */
const MONEY_SCALE_KEYS = new Set<string>(['executionCapacityPerQuarter', 'price']);

/**
 * The parameter each archetype treats as its price (§3.0.1). The draft names it
 * whatever the domain calls it; `ScaleInput.price` is the single slot it lands
 * in.
 */
export const PRICE_KEY: Record<DraftStream['archetype'], string> = {
  TRAFFIC: 'avgTicket',
  UTILIZATION: 'blendedHourlyRate',
  UNITS_CAC: 'avgOrderValue',
  SUBSCRIPTION: 'arpuPerQuarter',
  OCCUPANCY: 'ratePerUnitPerQuarter',
  PROJECT_BACKLOG: 'avgContractValue',
};

/**
 * Exactly what each archetype reads, by the name the engine reads it under.
 *
 * This has to be published to the model, because the names are not guessable
 * from the domain. An airline's seat fare is `ratePerUnitPerQuarter` — nobody
 * would arrive at that unprompted, and the first live OCCUPANCY concept did
 * not: it emitted a sensibly-named fare parameter, the mapper found no
 * `ratePerUnitPerQuarter`, and the price silently became zero.
 *
 * Anything the model omits falls back to the engine's own default, which is
 * fine. The price is the exception — a stream with no price has no revenue —
 * and `draftIssues` treats a missing one as a hard error rather than a default.
 */
export const ARCHETYPE_PARAMS: Record<DraftStream['archetype'], readonly string[]> = {
  TRAFFIC: [
    'avgTicket',
    'addressableTrafficPerQuarter',
    'captureRate',
    'operatingDaysPerQuarter',
    'seats',
    'turnsPerDay',
    'floorAreaSqFt',
    'peakConcentration',
    'skuCount',
    'baselineSkuCount',
  ],
  UTILIZATION: [
    'blendedHourlyRate',
    'demandHoursPerQuarter',
    'billableHoursPerHeadPerQuarter',
    'targetUtilization',
    'realizationRate',
  ],
  UNITS_CAC: [
    'avgOrderValue',
    'baseCac',
    'cacInflationCoefficient',
    'ordersPerNewCustomerFirstQuarter',
    'repeatPurchaseRatePerQuarter',
    'quarterlyCustomerAttrition',
  ],
  SUBSCRIPTION: [
    'arpuPerQuarter',
    'baseCac',
    'cacInflationCoefficient',
    'quarterlyChurnRate',
    'setupFee',
    'netRevenueRetention',
    'prepayMonths',
  ],
  OCCUPANCY: [
    'ratePerUnitPerQuarter',
    'units',
    'stabilizedOccupancy',
    'concessionsPct',
    'ancillaryRevenuePctOfBase',
  ],
  PROJECT_BACKLOG: [
    'avgContractValue',
    'bidsSubmittedPerQuarter',
    'winRate',
    'executionCapacityPerQuarter',
  ],
};

const toCents = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

const slug = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'concept';

function costDefaultFrom(
  line: DraftCostLine,
  index: number,
  archetype: DraftStream['archetype'],
): CostDefault {
  const isMoney = line.class !== 'VARIABLE_REVENUE';
  return {
    lineId: `llm_${index}_${line.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`,
    label: line.label,
    class: line.class,
    statementLine: line.statementLine,
    value: line.value,
    isMoney,
    isLabor: line.isLabor,
    accruable: line.accruable,
    minimumBlocks: line.minimumBlocks ?? 0,
    annualEscalatorPct: 0.02,
    isPrepaidExpense: false,
    sourceNote: line.sourceNote,
    // Deliberately no `benchmarkBand`: an absent band is honest, and a
    // borrowed one is a fabrication wearing a citation (D-5).
    ...(line.capacityPerBlock !== null ? { capacityPerBlock: line.capacityPerBlock } : {}),
    // The driver comes from the archetype, never a constant. Hardcoding
    // TRANSACTIONS here meant a UTILIZATION business could not validate at
    // all: §3.8 gives each archetype exactly one binding volume unit, and a
    // recruiting desk is billed in BILLABLE_HOURS, not transactions.
    ...(line.class === 'STEP_FIXED' || line.class === 'VARIABLE_ACTIVITY'
      ? { driver: ARCHETYPE_DRIVER[archetype] }
      : {}),
  };
}

/**
 * Monthly weights from quarterly ones. §12.2 requires each quarter's three
 * monthly weights to average to that quarter's figure; repeating each quarterly
 * value three times satisfies it exactly. A flat month-within-quarter shape is
 * a weaker claim than an invented one, which is the right default when nobody
 * has asked the model about February.
 */
const monthlyFromQuarterly = (seasonality: readonly number[]): number[] =>
  seasonality.flatMap((q) => [q, q, q]);

export function draftToTemplate(draft: ConceptDraft): MappedConcept {
  const stream = draft.stream;

  const priceKey = PRICE_KEY[stream.archetype];
  const streamParamDefaults: Record<string, number> = {};
  const scale: Record<string, number | bigint> = {};

  for (const param of stream.params) {
    streamParamDefaults[param.name] = param.value;
    if (param.name === priceKey) {
      scale['price'] = toCents(param.value);
    } else if (SCALE_KEYS.has(param.name)) {
      scale[param.name] = MONEY_SCALE_KEYS.has(param.name)
        ? toCents(param.value)
        : param.value;
    }
  }
  // Deliberately no fallback. Defaulting a missing price to zero is what
  // turned an OCCUPANCY airline into MISSING_REFERENCE_PRICE four screens
  // later, with nothing pointing at the cause. `draftIssues` rejects the draft
  // before it gets here, while the model can still be asked to fix it.

  const o = draft.overheads;
  const input: SeedTemplateInput = {
    // Deterministic: the same draft must map to the same template, or replay
    // and golden files stop meaning anything.
    id: `llm_${slug(draft.businessName)}`,
    label: draft.businessName,
    defaultArchetypes: [stream.archetype],
    costDefaults: draft.costLines.map((line, i) => costDefaultFrom(line, i, stream.archetype)),
    streamParamDefaults,
    modifierDefaults: {
      // Not concept-specific and not worth a model's guess: these are the
      // §3.7 response curves, identical across every seeded template.
      rampFloor: 0.4,
      rampConstant: 3.0,
      marketingMaxLift: 0.35,
      halfSaturationSpend: 8_000,
      priceElasticity: 1.2,
      baseMarketingSpendPerQuarter: stream.marketingSpendPerQuarter,
    },
    workingCapitalDefaults: draft.workingCapital,
    // The shared statutory formula, not a second copy of it. The engine
    // recomputes this from workersCompPct/offersBenefits anyway; setting it
    // consistently here keeps the template honest if anything else reads it.
    payrollLoadPct: payrollLoadPct(o.workersCompPct, o.offersBenefits),
    workersCompPct: o.workersCompPct,
    offersBenefits: o.offersBenefits,
    seasonality: [
      stream.seasonality[0] ?? 1,
      stream.seasonality[1] ?? 1,
      stream.seasonality[2] ?? 1,
      stream.seasonality[3] ?? 1,
    ],
    monthlySeasonalWeight: monthlyFromQuarterly(stream.seasonality),
    typicalCapex: draft.capex.map((c) => ({
      label: c.label,
      category: c.category,
      cost: c.grossCost,
      usefulLifeYears: c.usefulLifeYears,
      quantity: Math.max(1, Math.round(c.quantity)),
    })),
    // The whole point. No comparable means no bands — see D-5.
    plausibility: {},
    monthlyRent: o.monthlyRent,
    preOpening: {
      payrollAndTraining: o.preOpeningPayrollAndTraining,
      marketing: o.preOpeningMarketing,
      permitsAndLegal: o.preOpeningPermitsAndLegal,
    },
    generalLiabilityInsurancePerYear: o.generalLiabilityInsurancePerYear,
    propertyInsurancePerYear: o.propertyInsurancePerYear,
    accountingAndLegalPerYear: o.accountingAndLegalPerYear,
    softwareAndPosPerYear: o.softwareAndPosPerYear,
    permitsAndLicensesPerYear: o.permitsAndLicensesPerYear,
    utilitiesPerQuarter: o.utilitiesPerQuarter,
    ownerCompPerYear: o.ownerCompPerYear,
    badDebtPctOfRevenue: o.badDebtPctOfRevenue,
    repairsPctOfRevenue: o.repairsPctOfRevenue,
    cardProcessingRate: o.cardProcessingRate,
    cardMixPct: o.cardMixPct,
  };

  // Per-value provenance, keyed the way the engine's assumption paths end.
  const byName = new Map<string, Provenance>();
  for (const param of stream.params) byName.set(param.name, param.provenance);
  for (const [i, line] of draft.costLines.entries()) {
    byName.set(costDefaultFrom(line, i, stream.archetype).lineId, line.provenance);
  }
  // The seasonal shape is the model's, and carries no provenance of its own.
  byName.set('seasonality', 'LLM_ESTIMATE');
  // So is the opening marketing budget. It arrives on the draft's stream rather
  // than in `params`, so the parameter loop above never sees it, and without
  // this it would fall through to the `streams.*` catch-all and be reported as
  // an engine default the model never touched.
  byName.set('marketingSpendPerQuarter', 'LLM_ESTIMATE');

  const provenanceFor = (path: string): Provenance | undefined => {
    // A cost line the mapper minted carries the draft's own claim. An id it
    // does not recognise is an omission-guard line — but on a synthetic
    // template the guard reads `ownerCompPerYear`, `utilitiesPerQuarter` and
    // the rest straight off this draft's overheads, so those are the model's
    // figures too, arriving by a different door. Only the maintenance reserve
    // mixes in an engine rate, and understating its support is the safe error.
    const costLine = /^costs\.([^.]+)\./.exec(path)?.[1];
    if (costLine) return byName.get(costLine) ?? 'LLM_ESTIMATE';

    // §3.7 response curves: spec constants this file writes on every template
    // alike. The model never sees them and never guessed them.
    if (path.startsWith('streams.') && path.includes('.modifiers.')) return 'CATALOG';

    const named = byName.get(path.split('.').pop() ?? '');
    if (named) return named;

    // Working capital and capex came out of the same draft, but their paths
    // carry a field or an asset label rather than a parameter name.
    if (/^(workingCapital|capex)\./.test(path)) return 'LLM_ESTIMATE';

    // A stream parameter the draft never named is the engine's own archetype
    // default. Calling that an LLM estimate would be the same lie inverted.
    if (path.startsWith('streams.')) return 'CATALOG';
    return undefined;
  };

  return {
    template: zSeedTemplate.parse(input),
    scale: scale as ScaleInput,
    provenanceFor,
    marketingSpendPerQuarter: stream.marketingSpendPerQuarter,
    archetype: stream.archetype,
    legalForm: draft.legalForm,
    businessName: draft.businessName,
    volumeNoun: stream.volumeNoun,
  };
}
