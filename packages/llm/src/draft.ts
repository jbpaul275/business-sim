import { z } from 'zod';

/**
 * The wire shape the model emits, and the reason it is not simply
 * `zModelSynthesisOutput` from `@bizsim/schemas`.
 *
 * Structured outputs constrain generation against a JSON Schema, which is what
 * makes the draft shape-guaranteed rather than parsed-and-hoped-for. That
 * buys a hard constraint at the cost of a smaller schema vocabulary:
 * `additionalProperties` must be `false`, so an open `z.record()` — which is
 * how `ModelSynthesisOutput.streams[].params` is typed — cannot be expressed.
 *
 * So parameters travel as an **array** of named entries rather than a map.
 * `toSynthesisOutput` folds them back into the canonical record shape at the
 * package boundary. The array is arguably the better wire format anyway: it is
 * ordered, it cannot silently collide on a key, and every entry is forced to
 * carry its own provenance rather than inheriting it from a sibling.
 *
 * Numeric bounds (`.positive()`, `.min()`) and string length constraints are
 * also outside the supported subset. The SDK strips them from the schema it
 * sends and re-checks them client-side on parse, so they stay meaningful here —
 * as validation, not as generation constraints. Anything load-bearing must
 * therefore also be checked by `validateBusinessModel`, which is the engine's
 * gate and does not trust this file.
 */

export const zProvenanceWire = z.enum([
  'CATALOG',
  'PLAYER_SOURCED',
  'BENCHMARK',
  'LLM_ESTIMATE',
  'PLAYER_ASSUMED',
]);

/**
 * Every number the model emits carries its own range and sourcing. This is the
 * register's raw material (§10), and it is required rather than optional
 * because an assumption with no stated basis is exactly the kind the challenge
 * loop most needs to interrogate.
 */
export const zDraftParam = z.object({
  name: z.string(),
  value: z.number(),
  low: z.number(),
  high: z.number(),
  sourceNote: z.string(),
  provenance: zProvenanceWire,
});
export type DraftParam = z.infer<typeof zDraftParam>;

export const zDraftStream = z.object({
  label: z.string(),
  archetype: z.enum([
    'TRAFFIC',
    'UTILIZATION',
    'UNITS_CAC',
    'SUBSCRIPTION',
    'OCCUPANCY',
    'PROJECT_BACKLOG',
  ]),
  /** Why this archetype and not a neighbouring one. Shown to the player. */
  archetypeRationale: z.string(),
  params: z.array(zDraftParam),
  seasonality: z.array(z.number()),
  marketingSpendPerQuarter: z.number(),
  /**
   * What a mature year of this stream should produce, in dollars — the anchor
   * the parameters were reasoned from, stated separately so it can be checked
   * against them.
   *
   * This exists because a live draft said, in its own open notes, "revenue is
   * anchored to a national average unit volume near $3.5-3.9M" and then emitted
   * traffic and capture figures that produce $1.4M. The cost structure was
   * sized for the store it described; the volume was not. The player saw a
   * McDonald's losing 30% of revenue every quarter and no way to tell that the
   * arithmetic, not the business, was wrong.
   *
   * It is a weak constraint, exactly as intended: a 256-flavour ice cream shop
   * may earn many times what Ben & Jerry's does, but a single location cannot
   * bill a billion dollars, and a model that states one figure and builds
   * another has made an error rather than a bold claim.
   */
  expectedAnnualRevenue: z.number(),
});
export type DraftStream = z.infer<typeof zDraftStream>;

export const zDraftCostLine = z.object({
  label: z.string(),
  class: z.enum(['VARIABLE_REVENUE', 'VARIABLE_ACTIVITY', 'STEP_FIXED', 'FIXED_PERIOD']),
  statementLine: z.enum(['COGS', 'LABOR', 'OCCUPANCY', 'MARKETING', 'G&A']),
  /**
   * Rate for VARIABLE_REVENUE (a fraction of revenue), dollars per period
   * otherwise. Which one applies is determined by `class`, not by the model's
   * say-so — a rate booked as dollars is how a contractor ends up hiring 200
   * crews, so the mapper checks rather than trusts.
   */
  value: z.number(),
  isLabor: z.boolean(),
  accruable: z.boolean(),
  /** STEP_FIXED only: volume one block supports, in driver units. */
  capacityPerBlock: z.number().nullable(),
  minimumBlocks: z.number().nullable(),
  sourceNote: z.string(),
  provenance: zProvenanceWire,
});
export type DraftCostLine = z.infer<typeof zDraftCostLine>;

export const zDraftCapex = z.object({
  label: z.string(),
  category: z.enum([
    'EQUIPMENT',
    'LEASEHOLD_IMPROVEMENTS',
    'VEHICLES',
    'REAL_PROPERTY',
    'FF&E',
  ]),
  grossCost: z.number(),
  usefulLifeYears: z.number(),
  quantity: z.number(),
  sourceNote: z.string(),
});

/**
 * Operating overheads and opening costs — the §4.6 lines a founder's own
 * spreadsheet reliably omits. All dollars; rates are fractions.
 */
export const zDraftOverheads = z.object({
  ownerCompPerYear: z.number(),
  utilitiesPerQuarter: z.number(),
  generalLiabilityInsurancePerYear: z.number(),
  propertyInsurancePerYear: z.number(),
  accountingAndLegalPerYear: z.number(),
  softwareAndPosPerYear: z.number(),
  permitsAndLicensesPerYear: z.number(),
  badDebtPctOfRevenue: z.number(),
  repairsPctOfRevenue: z.number(),
  cardProcessingRate: z.number(),
  cardMixPct: z.number(),
  /** Feeds the derived payroll load; not the load itself. */
  workersCompPct: z.number(),
  offersBenefits: z.boolean(),
  /** Drives the lease-signing outlay in §5.4 (first + last + security). */
  monthlyRent: z.number(),
  preOpeningPayrollAndTraining: z.number(),
  preOpeningMarketing: z.number(),
  preOpeningPermitsAndLegal: z.number(),
});
export type DraftOverheads = z.infer<typeof zDraftOverheads>;

/**
 * The whole concept, as the model sees it.
 *
 * `seedTemplateId` is nullable, and that is the point of D-5 rather than an
 * oversight: a concept with no comparable gets no template, no borrowed cost
 * structure and no inherited benchmark bands. Forcing every concept into one of
 * twelve templates is precisely the failure this path exists to remove.
 */
export const zConceptDraft = z.object({
  businessName: z.string(),
  /** One or two sentences, in the player's own framing, for confirmation. */
  summary: z.string(),
  legalForm: z.enum(['SOLE_PROP', 'LLC_PASSTHROUGH', 'S_CORP', 'C_CORP']),
  /**
   * A template whose cost structure genuinely fits, or null when none does.
   * Null is a legitimate and common answer — see D-5.
   */
  seedTemplateId: z.string().nullable(),
  streams: z.array(zDraftStream),
  costLines: z.array(zDraftCostLine),
  capex: z.array(zDraftCapex),
  workingCapital: z.object({
    dsoDays: z.number(),
    dioDays: z.number(),
    dpoDays: z.number(),
    prepaidInsuranceMonths: z.number(),
    securityDepositMonths: z.number(),
    customerDepositPct: z.number(),
  }),
  /**
   * The §4.6 omission-guard set: the lines founders leave out of their own
   * spreadsheets. The model states them rather than inheriting them from a
   * template, because inheriting is how a 256-flavour shop ends up carrying a
   * restaurant's insurance premium (D-5).
   *
   * Statutory rates are deliberately absent — payroll load is derived from
   * `workersCompPct` and `offersBenefits` by the engine, at `CATALOG`
   * provenance. Asking a model to guess FICA adds error and buys nothing.
   */
  overheads: zDraftOverheads,
  /**
   * What the model could not pin down and had to estimate, in plain language.
   * Surfaced to the player before the commit gate; these are the lines that
   * should be argued with first.
   */
  openNotes: z.array(z.string()),
});
export type ConceptDraft = z.infer<typeof zConceptDraft>;

/**
 * One conversational turn: a message, and whether the model now has enough to
 * synthesise.
 *
 * The draft is deliberately NOT nested here. Structured outputs constrain
 * generation with a compiled grammar, and nesting `zConceptDraft` inside the
 * turn meant every call — including "whereabouts is it?" — compiled the whole
 * draft grammar. The API rejects that outright:
 *
 *   400 invalid_request_error: The compiled grammar is too large, which would
 *   cause performance issues.
 *
 * Splitting it is also the better design regardless of the limit. A model
 * asking its first question has no business juggling seventeen overhead fields,
 * and the draft is requested in its own call once the interview is done.
 */
export const zInterviewTurn = z.object({
  /**
   * What the model has to say, before the ask. Short: this runs in a terminal
   * and the person is playing a game, not reading a memo.
   */
  message: z.string(),
  /**
   * The one thing to do next, as a single sentence, rendered in bold.
   *
   * A separate field rather than a convention inside `message`, for the same
   * reason `readyToDraft` is a flag: a structured field is always present and
   * always renderable, where "end with a bold sentence" is an instruction that
   * silently stops being followed three turns in.
   */
  cta: z.string(),
  /**
   * True when the next call should ask for the draft. Kept as a flag rather
   * than inferred from the message, because inferring intent from prose is how
   * an interview silently never finishes.
   */
  readyToDraft: z.boolean(),
});
export type InterviewTurn = z.infer<typeof zInterviewTurn>;
