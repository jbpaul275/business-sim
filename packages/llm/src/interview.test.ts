import { describe, expect, it } from 'vitest';
import { ScriptedTransport } from './client.js';
import { ConceptInterview, draftIssues, paramsToRecord } from './interview.js';
import { CONCEPT_INTERVIEW_SYSTEM } from './prompt.js';
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
  streams: [
    {
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
    },
  ],
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

describe('paramsToRecord', () => {
  it('folds the wire array into the record the engine expects', () => {
    const record = paramsToRecord(draft().streams[0]!.params);
    expect(record['avgTicket']).toEqual({
      value: 9,
      range: { low: 7, high: 12 },
      sourceNote: 'Two scoops plus a topping at metro prices.',
      provenance: 'LLM_ESTIMATE',
    });
  });

  it('refuses to silently pick a winner among duplicates', () => {
    const p = draft().streams[0]!.params[0]!;
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
      streams: [
        {
          ...draft().streams[0]!,
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
      ],
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
      streams: [{ ...draft().streams[0]!, seasonality: [1.5, 1.5, 1.5, 1.5] }],
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

  it('catches a model with nothing driving revenue', () => {
    expect(draftIssues(draft({ streams: [] }))[0]).toContain('No revenue stream');
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
