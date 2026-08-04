import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  EMPTY_USAGE,
  ScriptedTransport,
  isCancellation,
  isTransient,
  type ConceptTransport,
} from './client.js';
import { ConceptInterview, draftIssues, paramsToRecord } from './interview.js';
import { MalformedDraftError } from './draft.js';
import type { InterviewMessage } from './client.js';
import { CONCEPT_INTERVIEW_SYSTEM } from './prompt.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { zConceptDraft, zInterviewTurn, type ConceptDraft, type InterviewTurn } from './draft.js';

/**
 * The interview is the input method for §9.1 Phases 1-2 — the thing that
 * replaces "pick one of twelve industries" with a conversation. What is worth
 * testing here is everything except the model: the loop, the guards, and the
 * mapping into the shape the engine consumes.
 */

const draft = (over: Partial<ConceptDraft> = {}): ConceptDraft => ({
  businessName: '256-flavour scoop shop',
  summary: 'A counter-service ice cream shop carrying 256 flavours.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  stream: {
      label: 'Counter sales',
      archetype: 'TRAFFIC',
      archetypeRationale:
        'Passers-by convert at a rate, capped by counter throughput. Not UNITS_CAC: ' +
        'there is no per-customer acquisition spend.',
      params: [
        {
          name: 'avgTicket',
          value: 9,
          low: 7,
          high: 12,
          sourceNote: 'Two scoops plus a topping at metro prices.',
          provenance: 'LLM_ESTIMATE',
        },
      ],
      seasonality: [0.55, 1.15, 1.55, 0.75],
      marketingSpendPerQuarter: 6_000,
      expectedAnnualRevenue: 900_000,
      volumeNoun: 'transactions',
    },
  costLines: [
    {
      label: 'Dairy, mix-ins & packaging',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.28,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Scoop-shop product cost including spoilage on slow movers.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  capex: [
    {
      label: 'Dipping cabinets',
      category: 'EQUIPMENT',
      grossCost: 9_000,
      usefulLifeYears: 10,
      quantity: 22,
      sourceNote: '22 cabinets at 12 flavours each.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  workingCapital: {
    dsoDays: 1,
    dioDays: 35,
    dpoDays: 21,
    prepaidInsuranceMonths: 6,
    securityDepositMonths: 2,
    customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 60_000,
    utilitiesPerQuarter: 7_840,
    generalLiabilityInsurancePerYear: 4_000,
    propertyInsurancePerYear: 3_000,
    accountingAndLegalPerYear: 6_000,
    softwareAndPosPerYear: 4_000,
    permitsAndLicensesPerYear: 2_500,
    badDebtPctOfRevenue: 0,
    repairsPctOfRevenue: 0.015,
    cardProcessingRate: 0.028,
    cardMixPct: 0.9,
    workersCompPct: 0.03,
    offersBenefits: false,
    monthlyRent: 3_986,
    preOpeningPayrollAndTraining: 15_000,
    preOpeningMarketing: 8_000,
    preOpeningPermitsAndLegal: 9_000,
  },
  openNotes: ['Capture rate is an estimate; nobody has run a 256-flavour shop here.'],
  ...over,
});

const asks = (message: string, cta = 'Tell me.'): InterviewTurn => ({
  message,
  cta,
  readyToDraft: false,
});
const ready = (message: string, cta = 'Press enter to see the numbers.'): InterviewTurn => ({
  message,
  cta,
  readyToDraft: true,
});

describe('ConceptInterview', () => {
  it('asks one question at a time and carries the transcript forward', async () => {
    const transport = new ScriptedTransport([
      asks('Where is it, and roughly how big is the space?'),
      asks('How many people can you serve at the counter at once?'),
      ready("Here's the model."),
    ], [draft()]);
    const interview = new ConceptInterview({ transport });

    const first = await interview.send('I want to open an ice cream shop with 256 flavours.');
    expect(first.status).toBe('ASKING');
    expect(first.message).toContain('how big');

    const second = await interview.send('Austin, about 900 square feet.');
    expect(second.status).toBe('ASKING');

    const third = await interview.send('Maybe 30 people at the counter.');
    expect(third.status).toBe('DRAFTED');
    if (third.status !== 'DRAFTED') throw new Error('unreachable');
    expect(third.draft.businessName).toBe('256-flavour scoop shop');

    // Every call sees the whole conversation, not just the latest message —
    // including the draft call, which is the last one and which also sees the
    // model's own closing message.
    const draftCall = transport.seen.at(-1)!;
    expect(draftCall.messages).toHaveLength(6);
    expect(draftCall.messages[0]?.content).toContain('256 flavours');
    // The transcript carries the CTA too, so the draft call sees the same
    // conversation the player did — including the question they answered.
    expect(draftCall.messages.at(-1)?.content).toContain("Here's the model.");
    expect(draftCall.messages.at(-1)?.content).toContain('Press enter to see the numbers.');
  });

  it('does not offer a list of business types to choose from', async () => {
    // The correction that produced this whole path: "it's still requiring me to
    // pick an industry from a fixed list." With no templates passed, the model
    // has nothing to pick from and must synthesise.
    const transport = new ScriptedTransport([asks('What is the business, and where?')]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A place that rents telescopes by the hour.');

    const system = transport.seen[0]!.system;
    expect(system).not.toContain('Available seed templates');
    expect(system).toContain('the business comes from what they tell you');
  });

  it('offers templates only when there are templates to offer', async () => {
    const transport = new ScriptedTransport([asks('Where is it?')]);
    const interview = new ConceptInterview({
      transport,
      templates: [{ id: 'full_service_restaurant', label: 'Full-service restaurant' }],
    });
    await interview.send('A bistro.');

    const system = transport.seen[0]!.system;
    expect(system).toContain('`full_service_restaurant`');
    expect(system).toContain('Otherwise null');
  });

  it('carries a call to action on every turn, including the last', async () => {
    // The player's ask: every reply ends with one bold sentence saying what to
    // do next. A structured field rather than a convention inside `message`,
    // because "remember to end with a bold sentence" is an instruction that
    // silently stops being followed and nobody notices.
    const transport = new ScriptedTransport(
      [asks('A ridge changes the draw.', 'How many scopes?'), ready('Enough to build on.', 'Press enter.')],
      [draft()],
    );
    const interview = new ConceptInterview({ transport });

    const asking = await interview.send('Telescope rental.');
    expect(asking.cta).toBe('How many scopes?');

    const drafted = await interview.send('Twenty-four.');
    expect(drafted.cta).toBe('Press enter.');
  });

  it('never lets a whitespace-only turn into the transcript', async () => {
    // A hotel interview died here. The model returned an empty message and cta;
    // the transcript took "" + "\n\n" + "" as the assistant turn, and the NEXT
    // call was rejected — "text content blocks must contain non-whitespace
    // text" — so the failure surfaced one turn away from its cause.
    const transport = new ScriptedTransport([
      { message: '   ', cta: '  ', readyToDraft: false },
      asks('Still here.', 'How many rooms?'),
    ]);
    const interview = new ConceptInterview({ transport });

    await interview.send('A hotel under $25k a key.');
    await interview.send('Des Moines, maybe.');

    for (const entry of interview.transcript) {
      expect(entry.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('does not blame the model for an empty player line', async () => {
    const transport = new ScriptedTransport([asks('Where is it?')]);
    const interview = new ConceptInterview({ transport });

    const state = await interview.send('   ');
    expect(state.status).toBe('ASKING');
    expect(state.cta).toContain('Say something about the business');
    // No call was made and nothing empty was recorded.
    expect(transport.seen).toHaveLength(0);
    expect(interview.transcript).toHaveLength(0);
  });

  it('keeps the reasoning it already paid for', async () => {
    // Thinking is billed whether or not the summary comes back, and the default
    // discards it. Keeping it means "why did you say that?" costs nothing — the
    // short answer and the full working are one response, not two.
    const transport = new ScriptedTransport(
      [asks('Jefferson County is the better trade.', 'Which submarket?')],
      [],
      ['Compared land cost against traffic counts; North County is cheaper but the volumes that make it cheap are what get a site rejected.'],
    );
    const interview = new ConceptInterview({ transport });

    await interview.send('Where should I put a QSR in St. Louis?');
    expect(interview.lastReasoning).toContain('get a site rejected');
  });

  it('leaves reasoning undefined when the model returned none', async () => {
    const transport = new ScriptedTransport([asks('Where is it?')]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A bistro.');
    expect(interview.lastReasoning).toBeUndefined();
  });

  it('notices when a turn stops being a turn and starts being a memo', async () => {
    const wall = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const transport = new ScriptedTransport([asks(wall), asks('short one')]);
    const interview = new ConceptInterview({ transport });

    await interview.send('A bistro.');
    expect(interview.verboseTurns).toBe(1);
    await interview.send('Austin.');
    expect(interview.verboseTurns).toBe(1);
  });

  it('stops rather than interviewing forever', async () => {
    const transport = new ScriptedTransport([asks('One?'), asks('Two?')]);
    const interview = new ConceptInterview({ transport, maxTurns: 2 });

    expect((await interview.send('a')).status).toBe('ASKING');
    expect((await interview.send('b')).status).toBe('ASKING');
    // A third would exhaust the script; the turn cap should bite first.
    const third = await interview.send('c');
    expect(third.status).toBe('EXHAUSTED');
  });
});

describe('a question gets an answer before it gets a financial model', () => {
  /**
   * Live: asked how many people per event and at what ticket price, the player
   * said "well to know that I need to know the biggest vessel I can get for
   * $1m" — the information needed to answer — and the interview spent 85
   * seconds building the whole model without a word about the ship.
   */
  const SHIP = 'well to know that I need to know the biggest vessel I can get for $1m';

  it('does not draft on a turn where the player asked for information', async () => {
    const transport = new ScriptedTransport([ready('Enough to build against.')], [draft()]);
    const interview = new ConceptInterview({ transport });

    const state = await interview.send(SHIP);
    expect(state.status).toBe('ASKING');
    // The model's own words still reach the player — this withholds the
    // drafting, not the reply, so it costs no extra call.
    expect(state.message).toBe('Enough to build against.');
    expect(state.cta).toContain('go ahead');
  });

  it('drafts as soon as the player says they have heard enough', async () => {
    const transport = new ScriptedTransport(
      [ready('Enough to build against.'), ready('Building it now.')],
      [draft()],
    );
    const interview = new ConceptInterview({ transport });

    expect((await interview.send(SHIP)).status).toBe('ASKING');
    // Not a trap: the player is allowed to decide the question does not matter.
    expect((await interview.send('go ahead')).status).toBe('DRAFTED');
  });

  it('is narrow enough not to cost a turn on an ordinary answer', async () => {
    // A guard that fires on hedged answers would add a turn to the flow the
    // player already thinks is too long. These all carry an answer.
    for (const said of [
      'about 450 people at $60 a head',
      'not sure, call it 450',
      'Austin, roughly 900 square feet',
      'the ship is 40 years old',
    ]) {
      const transport = new ScriptedTransport([ready('Right.')], [draft()]);
      const interview = new ConceptInterview({ transport });
      expect((await interview.send(said)).status, said).toBe('DRAFTED');
    }
  });

  it('catches the shapes that mean "I cannot answer that yet"', async () => {
    for (const said of [
      'what do you think?',
      'which market would you pick',
      'you tell me',
      "I don't know, what's typical?",
      SHIP,
    ]) {
      const transport = new ScriptedTransport([ready('Right.')], [draft()]);
      const interview = new ConceptInterview({ transport });
      expect((await interview.send(said)).status, said).toBe('ASKING');
    }
  });

  it('leaves a turn that was not ready to draft exactly as it was', async () => {
    // The guard only ever removes an intention to draft. A model still asking
    // questions keeps its own cta.
    const transport = new ScriptedTransport([asks('Right.', 'How big is the ship?')], [draft()]);
    const interview = new ConceptInterview({ transport });
    const state = await interview.send('what do you think?');
    expect(state.status).toBe('ASKING');
    expect(state.cta).toBe('How big is the ship?');
  });
});

describe('figures the model states become commitments', () => {
  /**
   * Live, a vending-machine interview: turn 4 quoted "$75-$150/day in a strong
   * location, $25-$50 in a mediocre one"; turn 6 called the player's plan
   * "above the $15-$25/day a typical US machine does". The earlier range was
   * prose in history and nothing made it binding. Now every money sentence the
   * model has stated is extracted from the transcript and appended to the
   * system prompt of every later call — including the draft call, whose
   * parameters have to square with what the conversation promised.
   */
  // Figures deliberately different from the ones the static prompt uses in
  // its own example, so these assertions cannot pass against the prompt text.
  const QUOTED = asks(
    'A well-placed machine does $60-$140 a day in a strong spot, $20-$40 in a mediocre one.',
    'How many machines?',
  );

  it('hands the model its own figures back on the next call', async () => {
    const transport = new ScriptedTransport([QUOTED, asks('And where?')]);
    const interview = new ConceptInterview({ transport });

    await interview.send('A vending machine business in Rochester.');
    // The first call had nothing to commit to.
    expect(transport.seen[0]!.system).not.toContain('## Figures you have already stated');

    await interview.send('Forty machines.');
    const second = transport.seen[1]!.system;
    expect(second).toContain('## Figures you have already stated');
    expect(second).toContain('$60-$140 a day in a strong spot');
  });

  it('carries the commitments into the draft call too', async () => {
    const transport = new ScriptedTransport([QUOTED, ready('Building it now.')], [draft()]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A vending machine business.');
    await interview.send('Forty machines, go ahead.');

    const draftCall = transport.seen.at(-1)!;
    expect(draftCall.system).toContain('$60-$140 a day in a strong spot');
  });

  it('adds nothing when the model has not stated a figure', async () => {
    const transport = new ScriptedTransport([asks('Where is it?'), asks('How big?')]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A bistro.');
    await interview.send('Austin.');
    for (const call of transport.seen) {
      expect(call.system).not.toContain('Figures you have already stated');
    }
  });

  it('retracts the figures of an undone turn', async () => {
    // Recomputed from the transcript, not accumulated — so taking back the
    // exchange takes back its figures with no bookkeeping.
    const transport = new ScriptedTransport([QUOTED, asks('Where is it?')]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A vending machine business.');
    interview.undo();

    await interview.send('A bistro, actually.');
    expect(transport.seen[1]!.system).not.toContain('$60-$140');
    expect(transport.seen[1]!.system).not.toContain('## Figures you have already stated');
  });

  it('tells the model the rule in the prompt as well', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('A figure you quote is a commitment');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('revise it openly');
  });
});

describe('repairDraft', () => {
  /**
   * A schema-rejected draft used to go back to the model as a *player
   * message*, which cost a full conversational turn — the model answering
   * "resending it now" at 8-15 seconds and one billed call — before the
   * re-draft. The correction is for the drafting call, so it goes to the
   * drafting call.
   */
  it('re-drafts with the correction and without a conversational turn', async () => {
    const transport = new ScriptedTransport([ready('Building it now.')], [draft()]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A soft-serve truck, go ahead.');
    const callsBefore = transport.seen.length;

    await interview.repairDraft('That draft did not match the schema — overheads.monthlyRent.');

    // Exactly one more call reached the transport: the draft. No turn.
    expect(transport.seen.length).toBe(callsBefore + 1);
    const repairCall = transport.seen.at(-1)!;
    expect(repairCall.messages.at(-1)?.content).toContain('overheads.monthlyRent');
  });

  it('replaces a previous correction rather than stacking user messages', async () => {
    // Some providers reject non-alternating roles, and the newer correction
    // supersedes the older one anyway.
    const transport = new ScriptedTransport([ready('Building it now.')], [draft()]);
    const interview = new ConceptInterview({ transport });
    await interview.send('A soft-serve truck, go ahead.');

    await interview.repairDraft('First correction: fields were missing.');
    await interview.repairDraft('Second correction: still missing.');

    const lastCall = transport.seen.at(-1)!;
    const userTail = lastCall.messages.filter((m) => m.content.includes('correction'));
    expect(userTail).toHaveLength(1);
    expect(userTail[0]!.content).toContain('Second correction');
  });
});

describe('paramsToRecord', () => {
  it('folds the wire array into the record the engine expects', () => {
    const record = paramsToRecord(draft().stream.params);
    expect(record['avgTicket']).toEqual({
      value: 9,
      range: { low: 7, high: 12 },
      sourceNote: 'Two scoops plus a topping at metro prices.',
      provenance: 'LLM_ESTIMATE',
    });
  });

  it('refuses to silently pick a winner among duplicates', () => {
    const p = draft().stream.params[0]!;
    expect(() => paramsToRecord([p, { ...p, value: 40 }])).toThrow(/Duplicate parameter/);
  });
});

describe('draftIssues', () => {
  it('passes a coherent draft', () => {
    expect(draftIssues(draft())).toEqual([]);
  });

  /**
   * The critical negative test. D-5 permits the engine to refuse physical
   * impossibility and nothing else, so these guards must catch *incoherent
   * data* without ever catching an unusual business.
   */
  it('has no opinion about a business being strange, expensive, or unwise', () => {
    const strange = draft({
      businessName: 'Telescope rental, $4,000 an hour',
      stream: {
          ...draft().stream,
          params: [
            {
              name: 'avgTicket',
              value: 4_000,
              low: 4_000,
              high: 4_000,
              sourceNote: 'The founder asserts this with no evidence.',
              provenance: 'PLAYER_ASSUMED',
            },
            {
              name: 'captureRate',
              value: 0.85,
              low: 0.8,
              high: 0.9,
              sourceNote: 'Also asserted.',
              provenance: 'PLAYER_ASSUMED',
            },
          ],
        },
    });
    // Wildly out of band on both price and capture, entirely unsourced — and
    // still a valid model. Arguing with it is the challenge loop's job, and
    // arguing is not refusing.
    expect(draftIssues(strange)).toEqual([]);
  });

  it('catches a rate booked as dollars — the unit slip that hires 200 crews', () => {
    const broken = draft({
      costLines: [{ ...draft().costLines[0]!, class: 'VARIABLE_REVENUE', value: 13_000 }],
    });
    const issues = draftIssues(broken);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('fraction of revenue');
  });

  it('catches seasonality that rescales the year instead of redistributing it', () => {
    const broken = draft({
      stream: { ...draft().stream, seasonality: [1.5, 1.5, 1.5, 1.5] },
    });
    expect(draftIssues(broken)[0]).toContain('rescales annual');
  });

  it('catches a step-fixed line with no block capacity', () => {
    const broken = draft({
      costLines: [
        {
          ...draft().costLines[0]!,
          class: 'STEP_FIXED',
          value: 9_000,
          capacityPerBlock: null,
        },
      ],
    });
    expect(draftIssues(broken)[0]).toContain('capacityPerBlock');
  });

  /**
   * The free wall. A phone-game draft carried `Customer support (part-time)`
   * at $0 a block supporting 1,500 subscribers, and every other check passed
   * it: the class is right, the capacity is positive, the minimum is 1. The
   * player was then told they were at "34.8% of capacity (1,500)" on a game
   * sold through an app store — a ceiling that both does not exist and could
   * have been lifted for nothing by hiring a second free block.
   */
  it('rejects a step-fixed block that costs nothing to add', () => {
    const free = draft({
      costLines: [
        {
          ...draft().costLines[0]!,
          label: 'Customer support (part-time)',
          class: 'STEP_FIXED',
          value: 0,
          capacityPerBlock: 1_500,
        },
      ],
    });
    const issues = draftIssues(free);
    expect(issues).toHaveLength(1);
    // Both ways out are named, so the retry has somewhere to go.
    expect(issues[0]).toContain('drop the line');
    expect(issues[0]).toContain('real quarterly cost');
  });

  it('leaves a priced block alone however small the price', () => {
    // A cheap block is a business decision; a free one is a modelling error.
    // The guard has to tell them apart or it becomes an opinion about wages.
    const cheap = draft({
      costLines: [
        { ...draft().costLines[0]!, class: 'STEP_FIXED', value: 1, capacityPerBlock: 1_500 },
      ],
    });
    expect(draftIssues(cheap)).toEqual([]);
  });

  it('names the missing price parameter instead of defaulting it to zero', () => {
    // The airline run. OCCUPANCY prices under `ratePerUnitPerQuarter` — not a
    // name anyone reaches for describing a seat fare — so the model emitted
    // something sensible, the mapper found no match, and the price silently
    // became zero. It surfaced four screens later as MISSING_REFERENCE_PRICE
    // with nothing pointing at the cause.
    const airline = draft({
      stream: {
          ...draft().stream,
          archetype: 'OCCUPANCY',
          params: [
            {
              name: 'farePerSeat',
              value: 84,
              low: 60,
              high: 110,
              sourceNote: 'Launch fare, one-way.',
              provenance: 'PLAYER_SOURCED',
            },
          ],
        },
    });
    const issues = draftIssues(airline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('ratePerUnitPerQuarter');
    // And it says what the archetype does read, so the retry can succeed.
    expect(issues[0]).toContain('units');
  });

  it('rejects a price of zero rather than modelling a business with no revenue', () => {
    const free = draft({
      stream: {
          ...draft().stream,
          params: [{ ...draft().stream.params[0]!, value: 0 }],
        },
    });
    expect(draftIssues(free)[0]).toContain('no price has no revenue');
  });

  it('catches a UTILIZATION business with no staffed capacity', () => {
    // The recruiting-firm run. UTILIZATION bills hours against staffed blocks,
    // and without a STEP_FIXED labour line there is no ceiling on what the
    // model can sell. It surfaced at the commit gate as
    // UTILIZATION_WITHOUT_STAFFING, after the whole draft had been built.
    const firm = draft({
      stream: {
          ...draft().stream,
          archetype: 'UTILIZATION',
          params: [
            {
              name: 'blendedHourlyRate',
              value: 180,
              low: 150,
              high: 220,
              sourceNote: 'Fee as a share of placed salary, per hour worked.',
              provenance: 'LLM_ESTIMATE',
            },
          ],
        },
    });
    expect(draftIssues(firm).some((i) => i.includes('staffed capacity'))).toBe(true);
  });

});

describe('a malformed draft is a sentence, not a validator dump', () => {
  it('reports missing fields in the shape a person reads', async () => {
    // A truncated fourth stream sent six `invalid_type` objects to the
    // terminal verbatim — `path: ["streams", 3, "archetype"]` and five more —
    // under the heading "The interview could not continue". That is a stack
    // trace wearing a hat.
    const broken = { ...draft(), stream: { label: 'Only a label' } };
    const transport: ConceptTransport = {
      turn: async () => ({ turn: ready('Building it.') }),
      advise: () => Promise.reject(new Error('no advice in this double')),
      adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
      draft: async () => broken as never,
      usage: EMPTY_USAGE,
    };
    const interview = new ConceptInterview({ transport });

    await expect(interview.send('A veggie burger place in Toledo.')).rejects.toThrow(
      /could not be read/,
    );
  });
});

describe('a forgotten provenance tag', () => {
  it('defaults downward rather than failing the draft', () => {
    // A live draft omitted `provenance` on three of nine parameters and the
    // session ended. LLM_ESTIMATE is the safe default in the direction that
    // matters: §10.3 ranks it below CATALOG, PLAYER_SOURCED and BENCHMARK, so
    // a forgotten tag can only understate how well a number is supported. The
    // failure this subsystem exists to prevent is the opposite one.
    const parsed = zConceptDraft.parse({
      ...draft(),
      stream: {
          ...draft().stream,
          params: [{ name: 'avgTicket', value: 12, low: 9, high: 15 }],
        },
    });
    expect(parsed.stream.params[0]!.provenance).toBe('LLM_ESTIMATE');
    expect(parsed.stream.params[0]!.sourceNote).toBe('');
  });

  it('never defaults upward into a claim of support', () => {
    // The whole point. If this ever defaulted to BENCHMARK, a model that
    // forgot to say where a number came from would be asserting it was
    // published — which is the exact failure §10 exists to prevent.
    const parsed = zConceptDraft.parse({
      ...draft(),
      costLines: [
        {
          label: 'Mix and cones',
          class: 'VARIABLE_REVENUE',
          statementLine: 'COGS',
          value: 0.3,
          isLabor: false,
          accruable: true,
          capacityPerBlock: null,
          minimumBlocks: null,
        },
      ],
    });
    expect(parsed.costLines[0]!.provenance).toBe('LLM_ESTIMATE');
  });

  it('still requires the numbers themselves', () => {
    // Metadata defaults; load-bearing values do not. A missing value is a
    // fault the model has to fix, not one to paper over with a zero.
    expect(() =>
      zConceptDraft.parse({
        ...draft(),
        stream: { ...draft().stream, params: [{ name: 'avgTicket', low: 9, high: 15 }] },
      }),
    ).toThrow();
  });
});

describe('how hard the turn worked', () => {
  it('records wall clock and thinking tokens for the last turn', async () => {
    // Two currencies because they measure different things, and the gap
    // between them is the point: 30 seconds with 400 thinking tokens is slow
    // for reasons the prompt cannot fix; 9,000 thinking tokens on "which
    // town?" is the prompt's problem.
    const transport: ConceptTransport = {
      turn: async () => ({
        turn: asks('A ridge changes the draw.', 'How many scopes?'),
        usage: {
          inputTokens: 5_200,
          cachedInputTokens: 0,
          outputTokens: 2_140,
          thinkingTokens: 2_060,
        },
      }),
      advise: () => Promise.reject(new Error('no advice in this double')),
      adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
      draft: async () => draft(),
      usage: EMPTY_USAGE,
    };
    const interview = new ConceptInterview({ transport });

    await interview.send('Telescope rental on a dark-sky ridge.');
    expect(interview.lastTurn?.thinkingTokens).toBe(2_060);
    expect(interview.lastTurn?.outputTokens).toBe(2_140);
    expect(interview.lastTurn?.ms).toBeGreaterThanOrEqual(0);
  });

  it('times the retry too, because the player waits for both', async () => {
    // The transport retries a garbled or empty reply itself. Timing only the
    // successful call would report half the wait.
    let calls = 0;
    const transport: ConceptTransport = {
      turn: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 12));
        return { turn: asks('Right.', 'How many scopes?') };
      },
      advise: () => Promise.reject(new Error('no advice in this double')),
      adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
      draft: async () => draft(),
      usage: EMPTY_USAGE,
    };
    const interview = new ConceptInterview({ transport });
    await interview.send('Telescope rental.');
    expect(calls).toBe(1);
    expect(interview.lastTurn?.ms).toBeGreaterThanOrEqual(10);
  });

  it('times the draft separately from the turn that triggered it', async () => {
    let usage = EMPTY_USAGE;
    const transport: ConceptTransport = {
      turn: async () => ({ turn: ready('Enough to build against.', 'Here it is.') }),
      advise: () => Promise.reject(new Error('no advice in this double')),
      adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
      draft: async () => {
        await new Promise((r) => setTimeout(r, 15));
        // What the draft call spent, as the real transport would record it.
        usage = { ...usage, calls: 1, thinkingTokens: 9_400, outputTokens: 12_000 };
        return draft();
      },
      get usage() {
        return usage;
      },
    };
    const interview = new ConceptInterview({ transport });
    expect((await interview.send('24 scopes, 1400 sq ft.')).status).toBe('DRAFTED');
    expect(interview.lastDraft?.ms).toBeGreaterThanOrEqual(12);
    // Read as a delta on the transport's running total, so it also picks up
    // the unconstrained retry when the draft grammar will not compile.
    expect(interview.lastDraft?.thinkingTokens).toBe(9_400);
    // The turn itself was instant; the wait was the draft, and they are not
    // conflated.
    expect(interview.lastTurn!.ms).toBeLessThan(interview.lastDraft!.ms);
  });

  it('reports nothing before a turn has been taken', () => {
    const interview = new ConceptInterview({ transport: new ScriptedTransport([]) });
    expect(interview.lastTurn).toBeUndefined();
    expect(interview.lastDraft).toBeUndefined();
  });
});

describe('a floor that is really a launch plan', () => {
  it('rejects a minimum that would make the line uncuttable', () => {
    // A cafe was drafted with four barista blocks and `minimumBlocks: 4` — a
    // claim that three baristas is physically impossible. Demand arrived at
    // half of capacity, the player tried to cut every quarter and was refused
    // every quarter, while 19.5% emergency debt compounded underneath. The
    // floor was never something the player chose or could see.
    const cafe = draft({
      costLines: [
        {
          label: 'Baristas and counter staff',
          class: 'STEP_FIXED',
          statementLine: 'LABOR',
          value: 21_000,
          isLabor: true,
          accruable: false,
          capacityPerBlock: 4_800,
          minimumBlocks: 4,
          sourceNote: 'Four on at open.',
          provenance: 'LLM_ESTIMATE',
        },
      ],
    });
    const issues = draftIssues(cafe);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cannot run with fewer');
    // And it says what to do instead, because "too high" is not actionable.
    expect(issues[0]).toContain('capacityPerBlock');
  });

  it('leaves a real floor alone', () => {
    // One person to open the door is a genuine constraint.
    const ok = draft({
      costLines: [
        {
          label: 'Counter staff',
          class: 'STEP_FIXED',
          statementLine: 'LABOR',
          value: 21_000,
          isLabor: true,
          accruable: false,
          capacityPerBlock: 4_800,
          minimumBlocks: 1,
          sourceNote: 'Someone has to be there.',
          provenance: 'LLM_ESTIMATE',
        },
      ],
    });
    expect(draftIssues(ok)).toEqual([]);
  });

  it('tells the model what the floor means before it has to be corrected', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Cost lines have to be able to shrink');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('cannot operate at all');
  });
});

describe('permission that is not waited for', () => {
  it('holds when the model asks to be told to go', async () => {
    // Live, on a lunar tourism base: "Say go and I'll draft the full model —
    // berths, seat-lease costs, ground crew and consumables — for you to argue
    // with." It then drafted immediately, without the player saying anything.
    // Asking for consent and acting before it arrives is worse than not
    // asking: the player learns the cta is rhetorical, and the cta is the only
    // place the next step is ever stated.
    const transport = new ScriptedTransport(
      [ready('Leasing transport keeps it variable.', "Say go and I'll draft the full model.")],
      [draft()],
    );
    const interview = new ConceptInterview({ transport });

    const state = await interview.send('We just operate the base, SpaceX flies it.');
    expect(state.status).toBe('ASKING');
    // The model's own sentence stays: replacing it would answer a question the
    // player has not seen yet.
    expect(state.cta).toBe("Say go and I'll draft the full model.");
  });

  it('drafts on the next turn, once told', async () => {
    const transport = new ScriptedTransport(
      [
        ready('Leasing transport keeps it variable.', 'Shall I draft that?'),
        ready('Building it now.', 'The figures land in a moment.'),
      ],
      [draft()],
    );
    const interview = new ConceptInterview({ transport });
    expect((await interview.send('We just operate the base.')).status).toBe('ASKING');
    expect((await interview.send('go')).status).toBe('DRAFTED');
  });

  it('does not hold a turn that simply states what is happening', async () => {
    // The correct shape, and it must not cost a turn.
    for (const cta of [
      'Building it now — the figures land in a moment.',
      'Here are the numbers.',
      'Press enter to see the model.',
    ]) {
      const transport = new ScriptedTransport([ready('Enough to build against.', cta)], [draft()]);
      const interview = new ConceptInterview({ transport });
      expect((await interview.send('4 berths at $10M a day.')).status, cta).toBe('DRAFTED');
    }
  });

  it('tells the model not to write that cta in the first place', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Do not ask permission you are not going to wait for');
  });
});

describe('the stream the mapper cannot see twice', () => {
  it('cannot express a second stream at all', () => {
    // A veggie burger place drafted four streams; a TCG concept drafted two,
    // three rounds running, the model apologising each time. `draftToTemplate`
    // reads one, so the rest were revenue that would never appear anywhere.
    //
    // The prompt asked for one. `draftIssues` rejected more than one. Neither
    // worked, because a JSON array is a stronger instruction than a paragraph:
    // a schema offering `streams: []` is a schema saying "as many as you
    // like". So the wire shape is a single object now, and structured outputs
    // compile the grammar from it — this is not a rule the model can fail to
    // follow, it is one it cannot express.
    // The guarantee is structural, so it is checked where it actually lives:
    // the JSON Schema handed to the API, from which the decoding grammar is
    // compiled. `stream` is an object there. There is no array to fill.
    const schema = zodToJsonSchema(zConceptDraft, { $refStrategy: 'none' }) as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties['stream']?.type).toBe('object');
    expect(schema.properties['streams']).toBeUndefined();
    expect(schema.required).toContain('stream');

    // And a draft with no stream is rejected outright rather than defaulted.
    const { stream: _dropped, ...withoutStream } = draft();
    expect(zConceptDraft.safeParse(withoutStream).success).toBe(false);
  });

  it('leaves a single-stream draft alone', () => {
    expect(draftIssues(draft())).toEqual([]);
  });

  it('tells the model that a second stream is not modelled', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('one revenue stream');
  });
});

describe('terms of art', () => {
  it('tells the model to gloss them in the same sentence', () => {
    // "Do you have a PIP or inspection number for the building itself?" — a
    // Property Improvement Plan, very likely the largest number in a hotel
    // acquisition, asked of someone who had never heard the term and could
    // not tell whether it was a document they should have, a number to go and
    // get, or something that did not apply to them.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Gloss the jargon, in the same sentence');
    // Named, so the rule has teeth rather than being a sentiment.
    for (const term of ['cap rate', 'RevPAR', 'PIP', 'DSCR', 'retainage', 'FF&E']) {
      expect(CONCEPT_INTERVIEW_SYSTEM, term).toContain(term);
    }
  });

  it('says who the player is, since that is what the rule rests on', () => {
    // Someone who already knows what a PIP is does not need a simulator to
    // tell them a $15k-a-key hotel has deferred capex.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('entering this industry for the first time');
  });
});

describe('the question policy', () => {
  /**
   * A question is only worth a turn when the answer is unpredictable AND
   * consequential AND the player is the better source. The named failure is
   * "Pepsi or Coke?" asked of a new vending operator: the model would answer
   * it better than the player (they'd ordinarily just ask), the draft comes
   * out the same either way, and it is a brand question asked before the
   * category question. Coarse checks that the load-bearing phrases survive.
   */
  it('requires unpredictable, consequential answers', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('when you cannot predict the answer');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('produce different models');
  });

  it('carries the reversal test — never ask what you would answer better', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('"you tell me"');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('outsourcing its job');
  });

  it('market rates fail the reversal test even when the question says "your"', () => {
    // Live: a plumber who had just moved to Toledo was asked "what does a
    // typical service call bill at in your area?" — with a range attached,
    // which made an unaskable question feel askable. The rate is the model's
    // benchmark; the player-owned half of pricing is positioning.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Market rates are yours, not theirs');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('service call bill');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('positioning');
  });

  it('never says an archetype enum to the player', () => {
    // Live: "a plumbing shop is usually PROJECT_BACKLOG" — metadata wearing
    // a word costume, said to a plumber.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('never see in conversation');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('metadata wearing a word costume');
  });

  it('orders forks coarse-to-fine, with the vending case named', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Brand comes after category comes after concept');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Pepsi or Coke');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('widest fork');
  });

  it('one question is one question mark, and no throat-clearing', () => {
    // "Do you have a property in mind — a listing, an asking price, a size?"
    // is four questions impersonating one; details are the next turn's
    // questions. "First question:" is words without substance.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('One question is one question mark');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('four questions impersonate');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('no throat-clearing');
  });

  it('the game is set now — no hypothetical futures, no era question', () => {
    // A moon hotel is the first real one at today's costs, the way anyone
    // asking Claude about a moon hotel means it. Modeling improved-economics
    // futures is a quagmire the game deliberately refuses.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('The game is set now');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Never ask which era');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('present-day prices');
  });

  it('carries the three worked openers', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('hotel on the moon');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('typical San Antonio hotel');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('dolphin-themed');
  });

  it('the answer distribution picks the question form', () => {
    // Predict the answers first. One answer at 95% → don't ask. Two roughly
    // even → name them both ("is that a dog or a cat?" is right in a living
    // room, even though it can lose to an overgrown ferret). Many live →
    // ask openly; a closed menu excludes real answers ("worker housing for
    // my moon factory") and an "or something else?" tail is insurance, not
    // an option — if cutting it loses nothing, it was never doing work.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Predict the answers before you shape the question');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('95% of the probability');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('dog or a cat');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('ask openly and do not guide');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('it was never an option, it was insurance');
  });

  it('"a mix" and "does it even matter?" are wins, not resistance', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('"A mix" — model both streams');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('does it even matter?');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('done your job for you');
  });

  it('the interview and the draft both see what the player has to invest', async () => {
    // Capital was collected in Phase 0 and used by the funding math, but the
    // model drafting the concept never saw it — so it could not scale the
    // concept to the person, and the openNotes rule about "needs four times
    // the capital they have" was arithmetic it had no inputs for. The amount
    // rides the system prompt, which the draft call shares.
    const transport = new ScriptedTransport([
      { message: 'Noted.', cta: 'Where would it be?', readyToDraft: false },
    ]);
    const interview = new ConceptInterview({ transport, investable: '$500,000' });
    await interview.send('a tiny observatory hotel');
    expect(transport.seen[0]!.system).toContain('What they have');
    expect(transport.seen[0]!.system).toContain('$500,000');

    // Without the option, no fabricated capital line appears.
    const bare = new ScriptedTransport([
      { message: 'Noted.', cta: 'Where?', readyToDraft: false },
    ]);
    await new ConceptInterview({ transport: bare }).send('same idea');
    expect(bare.seen[0]!.system).not.toContain('What they have');
  });

  it('the more standardized the business, the more personal the question', () => {
    // A Subway aspirant should not be asked about fees the franchisor
    // publishes — every content question fails the reversal test, and what
    // remains is the player: working the counter themselves, or paying a
    // manager with the margin. A principle, not worked examples — the space
    // of conversations is unbounded, so the prompt teaches generation, not
    // a lookup table.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain(
      'the more the world has already specified the business',
    );
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('the more personal the right question becomes');
  });
});

describe('the prompt carries D-5', () => {
  /**
   * The prompt is the only place the absurdity principle actually binds at
   * runtime, so it is worth asserting that the load-bearing instructions have
   * not been edited away. These are coarse checks — they cannot prove the model
   * behaves — but they fail loudly if someone deletes the rule.
   */
  it('permits the absurd and refuses only the impossible', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Do not talk them out of it');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('physical and contractual impossibility');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('256 flavours');
  });

  it('treats benchmarks as weak constraints rather than gates', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('weak constraints, not gates');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('what makes it true');
    // The joint-claim case: high price OK, high capture OK, both is a question.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('only absurd in combination');
  });

  it('publishes the exact parameter names, because they are not guessable', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('ratePerUnitPerQuarter');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('avgTicket');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Parameter names are fixed');
  });

  it('asks for one sentence of archetype rationale, not a defence', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('not the alternatives you considered and rejected');
  });

  it('forbids borrowing a template that does not fit', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('quietly borrow its numbers');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Null is a normal answer');
  });

  it('forbids dressing an estimate as a source', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('An invented citation is worse than an admitted guess');
  });

  it('treats a recalled figure as an estimate, not a citation', () => {
    // First live run: the model offered a franchise's royalty and ad-fund rates
    // as "documented rather than guessed". It has read no FDD. The numbers may
    // be right; "documented" is the part that is not.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain(
      'A figure you remember is not a figure you looked up',
    );
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('grounded rather than guessed');
  });

  it('forbids disclaiming its way into authority', () => {
    // Second live run: "BK's franchise disclosure sets minimum financial
    // qualifications — roughly $1.5M net worth... Those are their numbers, not
    // mine." It read no disclosure. Saying a figure is not your opinion is a
    // claim about where it came from, and a stronger one than the bare number:
    // the reader stops evaluating it. Someone could restructure their equity
    // around a threshold the model half-remembers.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Do not disclaim your way into authority');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain(
      'a category of constraint can be stated confidently; a specific figure inside it cannot',
    );
  });

  it('does not treat "I do not know" as a reason to ask again', () => {
    // Live: "I don't know, I've never owned a firm like this — you tell me."
    // The right move is to estimate, label it, and draft. Another question
    // costs the player half a minute and gets a worse answer than showing them
    // a number they can correct.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('that is not a reason for another question');
  });

  it('budgets questions against what a turn actually costs', () => {
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Two or three questions, then offer');
  });

  it('ready claims no must-ask fork remains; a guessed fork is a deferred question', () => {
    // The drafting call cannot ask — it must return a complete model — so
    // readyToDraft asserts no consequential, player-owned, unpredictable
    // fork is still open. When the player forces the draft, the fork is
    // guessed, labeled, and written into openNotes AS a question: branch
    // taken, live alternative, what changes if they meant the other.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('no must-ask question remains');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('deferred question, so write it as one');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('if guests swim with real dolphins');
  });

  it('readiness is an offer; depth is the player-paced part', () => {
    // The KFC-inheritance player wants projections after one message; the
    // 256-flavour stress-tester wants forty turns on freezer costs. Both are
    // right, so the model offers when ready, keeps asking while they keep
    // exploring, and a standing "build it" control means nobody is trapped.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('depth is theirs to choose');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('offer to draft');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('standing "build it" control');
  });

  it('pushes toward drafting rather than one more useful question', () => {
    // Four turns in and still interviewing. The register and the challenge loop
    // exist so the interview does not have to be exhaustive.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Draft early and let them push back on real numbers');
  });

  it('spells out that one question means one', () => {
    // Same run: it asked about site format and trade area in one turn, with the
    // second question in a trailing paragraph. The rule needed an example.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('One question means one');
  });
});

describe('the wire schema', () => {
  it('accepts a draft with no seed template — the novel-concept case', () => {
    expect(zConceptDraft.parse(draft()).seedTemplateId).toBeNull();
  });

  it('keeps the turn schema small, which is why the draft is a separate call', () => {
    // Nesting the draft here compiled its whole grammar on every question and
    // the API rejected it outright: "the compiled grammar is too large".
    const turn = zInterviewTurn.parse({
      message: 'Where is it?',
      cta: 'Name the neighbourhood.',
      readyToDraft: false,
    });
    expect(Object.keys(turn)).toEqual(['message', 'cta', 'readyToDraft']);
  });

  it('requires readiness to be stated, not inferred from the prose', () => {
    expect(() => zInterviewTurn.parse({ message: 'Where is it?', cta: 'Say where.' })).toThrow();
  });
});

/**
 * Taking back a message you did not mean to send.
 *
 * A pasted fragment — "re Blend it out and a" — cost fifty-three seconds and
 * put a question nobody asked into the transcript with an answer to it
 * underneath. Every turn after that reasoned against both.
 */
describe('undo', () => {
  const question = (message: string, cta: string): InterviewTurn => ({
    message,
    cta,
    readyToDraft: false,
  });
  const transport = (): ConceptTransport => ({
    turn: async () => ({ turn: question('And where is it?', 'Tell me the town.') }),
    advise: () => Promise.reject(new Error('no advice in this double')),
    adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
    draft: () => Promise.reject(new Error('no draft in this double')),
    usage: EMPTY_USAGE,
  });

  it('removes the exchange entirely, so the model never sees it', async () => {
    const interview = new ConceptInterview({ transport: transport() });
    await interview.send('A cafe in Buffalo.');
    await interview.send('re Blend it out and a');
    expect(interview.transcript).toHaveLength(4);

    expect(interview.undo()).toBe(true);
    expect(interview.transcript).toHaveLength(2);
    expect(interview.transcript.map((m) => m.content).join(' ')).not.toContain('Blend it out');
    // The conversation before it is untouched.
    expect(interview.transcript[0]!.content).toBe('A cafe in Buffalo.');
  });

  it('gives the turn back, so correcting a typo does not cost the interview', async () => {
    const interview = new ConceptInterview({ transport: transport(), maxTurns: 2 });
    await interview.send('A cafe in Buffalo.');
    interview.undo();
    await interview.send('A cafe in Buffalo, 30 seats.');
    const state = await interview.send('Rent is $4,000.');
    // Three sends against a two-turn budget, one of them taken back.
    expect(state.status).not.toBe('EXHAUSTED');
  });

  it('says so when there is nothing to take back', () => {
    expect(new ConceptInterview({ transport: transport() }).undo()).toBe(false);
  });
});

/**
 * Ctrl-C during a call.
 *
 * The only key that did anything while the model was thinking killed the whole
 * setup, so the choice was fifty-three seconds of a wrong answer or losing ten
 * minutes of conversation.
 */
describe('cancelling a call', () => {
  it('leaves the conversation exactly as it was', async () => {
    const interview = new ConceptInterview({
      transport: {
        turn: async () => {
          const error = new Error('Request was aborted.');
          error.name = 'APIUserAbortError';
          throw error;
        },
        advise: () => Promise.reject(new Error('no advice')),
        adjudicate: () => Promise.reject(new Error('no adjudication')),
        draft: () => Promise.reject(new Error('no draft')),
        usage: EMPTY_USAGE,
      },
    });

    await expect(interview.send('something I did not mean to send')).rejects.toThrow(
      CancelledError,
    );
    // The message is out of the transcript, so the next send is not a duplicate
    // and the model never answers a conversation that did not happen.
    expect(interview.transcript).toHaveLength(0);
  });

  it('is never treated as a busy model', () => {
    // Retrying a cancellation is the exact opposite of what was asked for.
    const aborted = new Error('Request was aborted.');
    aborted.name = 'APIUserAbortError';
    expect(isTransient(aborted)).toBe(false);
    expect(isCancellation(aborted)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Staged synthesis
// ---------------------------------------------------------------------------

/**
 * A transport that speaks the staged protocol: one ready turn, then a slice
 * of the fixture per stage. `breakCosts` returns nonsense from the costs
 * stage that many times first, to exercise the scoped retry.
 */
function stagedTransport(d: ConceptDraft, opts: { breakCosts?: number } = {}) {
  const slices: Record<string, unknown> = {
    spine: {
      businessName: d.businessName,
      summary: d.summary,
      legalForm: d.legalForm,
      seedTemplateId: d.seedTemplateId,
      stream: d.stream,
    },
    costs: { costLines: d.costLines },
    capital: { capex: d.capex, workingCapital: d.workingCapital },
    finish: { overheads: d.overheads, openNotes: d.openNotes },
  };
  let costsCalls = 0;
  const calls: { stage: string; last: string }[] = [];
  const transport = {
    calls,
    usage: EMPTY_USAGE,
    turn: async () => ({
      turn: { message: 'That is enough to build against.', cta: 'Drafting it now.', readyToDraft: true },
    }),
    adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
    advise: () => Promise.reject(new Error('no advice in this double')),
    draft: () => Promise.reject(new Error('the one-shot path must not run when the transport is staged')),
    async draftStage(_system: string, messages: readonly InterviewMessage[], stage: string) {
      calls.push({ stage, last: messages[messages.length - 1]!.content });
      if (stage === 'costs') {
        costsCalls += 1;
        if (costsCalls <= (opts.breakCosts ?? 0)) return { costLines: 'not an array at all' };
      }
      return slices[stage];
    },
  };
  return transport as unknown as ConceptTransport & { calls: { stage: string; last: string }[] };
}

describe('staged synthesis', () => {
  it('assembles the draft from four small constrained calls, in order', async () => {
    const d = draft();
    const transport = stagedTransport(d);
    const seen: string[] = [];
    const interview = new ConceptInterview({
      transport,
      onStage: ({ index, total, label }) => seen.push(`${index + 1}/${total} ${label}`),
    });
    const state = await interview.send('build the scoop shop');
    expect(state.status).toBe('DRAFTED');
    if (state.status !== 'DRAFTED') return;
    // The assembled whole is exactly the fixture — stages are .pick()ed from
    // the same schema, so nothing is lost or reshaped in assembly.
    expect(state.draft).toEqual(d);
    expect(transport.calls.map((c) => c.stage)).toEqual(['spine', 'costs', 'capital', 'finish']);
    // Coherence: later stages receive the already-fixed sections verbatim.
    expect(transport.calls[1]!.last).toContain(d.businessName);
    expect(transport.calls[3]!.last).toContain('deferred question');
    expect(seen).toEqual([
      '1/4 the revenue engine',
      '2/4 the cost structure',
      '3/4 what it takes to open',
      '4/4 overheads and open questions',
    ]);
  });

  it('a misshapen section gets one scoped retry, not a full regeneration', async () => {
    const d = draft();
    const transport = stagedTransport(d, { breakCosts: 1 });
    const interview = new ConceptInterview({ transport });
    const state = await interview.send('build it');
    expect(state.status).toBe('DRAFTED');
    const costsCalls = transport.calls.filter((c) => c.stage === 'costs');
    expect(costsCalls).toHaveLength(2);
    expect(costsCalls[1]!.last).toContain('did not match its schema');
    // The other stages ran exactly once — the repair stayed scoped.
    expect(transport.calls.filter((c) => c.stage === 'spine')).toHaveLength(1);
  });

  it('a section wrong twice fails readably, feeding the existing repair loop', async () => {
    const transport = stagedTransport(draft(), { breakCosts: 2 });
    const interview = new ConceptInterview({ transport });
    await expect(interview.send('build it')).rejects.toBeInstanceOf(MalformedDraftError);
  });
});
