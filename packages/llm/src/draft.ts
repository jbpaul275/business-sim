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
/**
 * Provenance and its note default rather than being required.
 *
 * A live draft omitted `provenance` on three of nine parameters and the
 * session ended — the third distinct "model produced a very slightly wrong
 * draft, run is over" failure. The unconstrained fallback makes this a normal
 * outcome rather than an impossible one: with no decoding grammar there is
 * nothing forcing a field to appear.
 *
 * `LLM_ESTIMATE` is the safe default in the one direction that matters. §10.3
 * ranks it below CATALOG, PLAYER_SOURCED and BENCHMARK, so a forgotten tag can
 * only ever *understate* how well a number is supported. The failure this
 * whole subsystem exists to prevent is the opposite one — the register
 * claiming published backing for an invention — and defaulting downward cannot
 * cause it. A model that forgot to say where a number came from did not look
 * it up.
 */
export const zDraftParam = z.object({
  name: z.string(),
  value: z.number(),
  low: z.number(),
  high: z.number(),
  sourceNote: z.string().default(''),
  provenance: zProvenanceWire.default('LLM_ESTIMATE'),
});
export type DraftParam = z.infer<typeof zDraftParam>;

/**
 * Four quarterly weights out of whatever cadence the model actually wrote.
 *
 * "Seasonality needs exactly 4 quarterly weights" went to a live model twice
 * in repair rounds and it still emitted a monthly curve — a coffee shop
 * thinks in months — and the player got "could not produce a buildable
 * draft" over cadence. The conversion is arithmetic, so it happens here,
 * before validation ever sees it: a multiple of four averages down in
 * consecutive groups (12 monthlies → 4 quarterly means), halves and a single
 * flat weight repeat up, and a cadence with no clean mapping keeps its first
 * four (padded flat) — downstream normalisation rescales the mean to 1.0
 * either way. The wire schema also says minItems/maxItems 4, so a provider
 * that enforces grammars never lets the wrong cadence exist at all; this is
 * the salvage for the providers that do not. Non-arrays and non-numeric
 * entries pass through untouched for the schema to reject honestly.
 */
export function coerceSeasonality(value: unknown): unknown {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number')) return value;
  const q = value as number[];
  if (q.length === 4) return q;
  if (q.length === 0) return [1, 1, 1, 1];
  if (q.length % 4 === 0) {
    const size = q.length / 4;
    return [0, 1, 2, 3].map(
      (i) => q.slice(i * size, (i + 1) * size).reduce((a, b) => a + b, 0) / size,
    );
  }
  if (4 % q.length === 0) {
    return q.flatMap((v) => Array.from({ length: 4 / q.length }, () => v));
  }
  return [q[0] ?? 1, q[1] ?? 1, q[2] ?? 1, q[3] ?? 1];
}

/**
 * Who is building this — docs/plan/07-founder-profile.md, stage 1.
 *
 * Every field obeys the biography law: it may carry ONLY what the player
 * actually said. A model that infers "probably experienced" from tone has
 * fabricated a credential, which is worse than fabricating a number — the
 * downstream effects (ramp, lender file, adjudication range) would flatter
 * the player with their own invented résumé. Unasked or unanswered means the
 * neutral defaults, and the neutral defaults produce zero effects.
 *
 * No effects are wired yet: this stage only carries the profile through the
 * draft, the journal, and the drafting context, so later stages can map it.
 */
export const zFounderProfile = z.object({
  /** Years of hands-on experience in this concept's domain. 0 = new ground. */
  domainYears: z
    .number()
    .default(0)
    .describe('Years the player SAID they have in this domain. 0 unless they stated it.'),
  /** What the player says they will personally work. */
  ownerHoursPerWeek: z
    .number()
    .default(40)
    .describe('Hours per week the player SAID they will work in the business. 40 unless stated.'),
  /** The player's words the numbers came from — quoted, not paraphrased. */
  basis: z
    .string()
    .default('')
    .describe("The player's own words these figures came from. Empty when they said nothing."),
});
export type FounderProfile = z.infer<typeof zFounderProfile>;

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
  seasonality: z
    .preprocess(coerceSeasonality, z.array(z.number()).length(4))
    .describe(
      'Exactly four quarterly demand multipliers, Q1 through Q4, averaging 1.0 across the year. Quarterly, never monthly.',
    ),
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
  /**
   * What one unit of volume is called in this trade.
   *
   * A ready-mix plant sells loads, a restaurant serves covers, a clinic sees
   * visits, a course sells rounds. The engine had one word for all of them —
   * "covers/day", inherited from the first template anyone wrote — and a
   * concrete producer's post-mortem told him he needed "12 covers/day".
   *
   * Plural, lower case, the word an operator in this business would use on a
   * whiteboard. It changes nothing the engine computes and everything about
   * whether the player recognises their own business on the screen.
   */
  volumeNoun: z.string().default('transactions'),
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
  /**
   * The floor below which this line cannot go — **not** the opening headcount.
   *
   * A cafe was drafted with four barista blocks and `minimumBlocks: 4`, which
   * says the business is physically incapable of running with three. It is
   * not; four is what opening day was planned around. The player watched
   * demand sit at 51% of capacity, correctly decided to cut, and was refused
   * every quarter — "already at its minimum block count" — while emergency
   * debt at 19.5% compounded underneath. A launch plan written into the floor
   * is a doom loop with no exit.
   *
   * This is almost always 0 or 1: one person to open the door, one licensed
   * operator a permit requires, one crew a safety rule will not let you send
   * out alone. Anything above 1 is a claim that fewer is *impossible*, not
   * that fewer would be uncomfortable.
   */
  minimumBlocks: z.number().nullable(),
  sourceNote: z.string().default(''),
  /** Defaults downward for the same reason as `zDraftParam.provenance`. */
  provenance: zProvenanceWire.default('LLM_ESTIMATE'),
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
  sourceNote: z.string().default(''),
  /**
   * Capex was the one place a draft could not say where a number came from.
   *
   * A player said "I found a 5,000 sq ft property... for $400k" — the clearest
   * player-sourced figure in the session — and the register credited it to the
   * model, because this schema had a sourceNote and no provenance field. The
   * default degrades downward, same rule as everywhere else: a forgotten tag
   * can only understate support, never claim it.
   */
  provenance: zProvenanceWire.default('LLM_ESTIMATE'),
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
  /**
   * One stream, not an array of them.
   *
   * It was `z.array(zDraftStream)` and the mapper read `[0]`, which made the
   * schema a standing invitation to write revenue that would be silently
   * dropped. The prompt asked for one; `draftIssues` rejected more than one;
   * and a live TCG concept still came back with two streams three rounds
   * running — the model apologising each time — because a JSON array is a
   * stronger instruction than a paragraph. Structured outputs compile a
   * grammar from this shape, so a single object is not a rule the model can
   * fail to follow. It is one it cannot express.
   *
   * Multi-stream is real work in the engine (`buildModelFromTemplate` builds
   * exactly one `RevenueStreamSpec`). When it exists, this goes back to an
   * array — and the array will mean something.
   */
  stream: zDraftStream,
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
  /**
   * Defaulted so every draft that predates the field — persisted sessions,
   * fixtures, one-shot transports that never learned it — parses to the
   * neutral profile, which produces zero effects.
   */
  founderProfile: zFounderProfile.default({}),
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

/**
 * The model emitted a draft the schema will not accept.
 *
 * Distinct from a corrupted response: this one parsed as JSON and simply had
 * the wrong shape. It exists so the failure reaches the player as a sentence.
 * A four-stream draft came back with its fourth stream truncated and the
 * ZodError went to the terminal verbatim — six `invalid_type` objects with
 * `path: ["streams", 3, "archetype"]`, under the heading "The interview could
 * not continue". That is a stack trace wearing a hat: it tells the player
 * nothing they can act on and buries the one useful fact.
 */
export class MalformedDraftError extends Error {
  constructor(readonly detail: string) {
    super(
      `The model's draft could not be read — ${detail}. This is a generation fault, ` +
        `not a problem with what you described.`,
    );
    this.name = 'MalformedDraftError';
  }
}

/**
 * Validate a draft, or fail readably.
 *
 * Used on both paths that can produce one: the transport, which parses the
 * model's text, and the interview, which re-checks whatever a transport hands
 * it. Either can be the first to see a bad shape, so neither may let a raw
 * validator error escape.
 */
export function assertDraftShape(value: unknown): ConceptDraft {
  const result = zConceptDraft.safeParse(value);
  if (result.success) return result.data;

  // The first few paths, in the shape a person reads. Not all of them: one
  // missing field usually cascades into a dozen.
  const where = result.error.issues
    .slice(0, 3)
    .map((i) => i.path.join('.'))
    .filter(Boolean);
  throw new MalformedDraftError(
    where.length > 0
      ? `fields were missing or wrong: ${where.join(', ')}`
      : 'it did not match the schema',
  );
}
