import { describe, expect, it } from 'vitest';
import { ScriptedTransport, type Adjudication, type ConceptDraft } from '@bizsim/llm';
import { challenge, createSetup, fund, say, undo } from './setup';
import { toSetupView } from './setupView';
import { advanceSession, createSessionFromWorld } from './store';
import { toView } from './view';

/**
 * §9.1 Phases 1–4 through the web state machine, scripted end to end — the
 * same telescope-rental fixture the CLI's setup suite drives, so the two
 * frontends are proven against the same conversation.
 */

// The proven fixture from packages/sim-cli/src/setup.test.ts. Duplicated
// knowingly: importing across package test files couples the suites, and this
// draft's job here is only to be valid.
const draft: ConceptDraft = {
  businessName: 'Telescope rental by the hour',
  summary: 'A shopfront renting telescopes by the hour on a dark-sky ridge.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  stream: {
    label: 'Hourly rentals',
    archetype: 'TRAFFIC',
    archetypeRationale:
      'Visitors arrive and convert at a rate, capped by how many scopes can be staffed out at once.',
    params: [
      { name: 'avgTicket', value: 45, low: 35, high: 60, sourceNote: 'Two-hour session.', provenance: 'LLM_ESTIMATE' },
      { name: 'seats', value: 24, low: 20, high: 30, sourceNote: 'Scopes available.', provenance: 'PLAYER_SOURCED' },
      { name: 'floorAreaSqFt', value: 1_400, low: 1_200, high: 1_600, sourceNote: 'Leased unit.', provenance: 'PLAYER_SOURCED' },
      { name: 'turnsPerDay', value: 3, low: 2, high: 4, sourceNote: 'Evening sessions only.', provenance: 'LLM_ESTIMATE' },
      { name: 'captureRate', value: 0.03, low: 0.02, high: 0.05, sourceNote: 'Estimate; no comparable.', provenance: 'LLM_ESTIMATE' },
      { name: 'addressableTrafficPerQuarter', value: 90_000, low: 70_000, high: 110_000, sourceNote: 'Park gate counts.', provenance: 'PLAYER_SOURCED' },
      { name: 'skuCount', value: 12, low: 8, high: 20, sourceNote: 'Scope models offered.', provenance: 'LLM_ESTIMATE' },
      { name: 'baselineSkuCount', value: 12, low: 8, high: 20, sourceNote: 'Own baseline.', provenance: 'LLM_ESTIMATE' },
      { name: 'operatingDaysPerQuarter', value: 91, low: 80, high: 91, sourceNote: 'Open nightly.', provenance: 'LLM_ESTIMATE' },
      { name: 'peakConcentration', value: 0.5, low: 0.4, high: 0.6, sourceNote: 'Weekend-heavy.', provenance: 'LLM_ESTIMATE' },
    ],
    seasonality: [0.9, 1.0, 1.2, 0.9],
    marketingSpendPerQuarter: 4_000,
    expectedAnnualRevenue: 480_000,
    volumeNoun: 'covers',
  },
  costLines: [
    {
      label: 'Consumables & breakage',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.08,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Eyepiece replacement, charts, damage.',
      provenance: 'LLM_ESTIMATE',
    },
    {
      label: 'Guides',
      class: 'STEP_FIXED',
      statementLine: 'LABOR',
      value: 12_000,
      isLabor: true,
      accruable: false,
      capacityPerBlock: 1_200,
      minimumBlocks: 1,
      sourceNote: 'One guide covers ~13 sessions a night.',
      provenance: 'LLM_ESTIMATE',
    },
    {
      label: 'Rent',
      class: 'FIXED_PERIOD',
      statementLine: 'OCCUPANCY',
      value: 9_000,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: '1,400 sq ft on a ridge road.',
      provenance: 'PLAYER_SOURCED',
    },
  ],
  capex: [
    { label: 'Telescopes', category: 'EQUIPMENT', grossCost: 3_500, usefulLifeYears: 8, quantity: 24, sourceNote: 'Quoted.', provenance: 'PLAYER_SOURCED' },
    { label: 'Buildout', category: 'LEASEHOLD_IMPROVEMENTS', grossCost: 90_000, usefulLifeYears: 15, quantity: 1, sourceNote: 'Contractor estimate.', provenance: 'LLM_ESTIMATE' },
  ],
  workingCapital: {
    dsoDays: 1,
    dioDays: 14,
    dpoDays: 21,
    prepaidInsuranceMonths: 6,
    securityDepositMonths: 2,
    customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 65_000,
    utilitiesPerQuarter: 4_200,
    generalLiabilityInsurancePerYear: 5_000,
    propertyInsurancePerYear: 4_000,
    accountingAndLegalPerYear: 6_000,
    softwareAndPosPerYear: 3_600,
    permitsAndLicensesPerYear: 2_000,
    badDebtPctOfRevenue: 0.005,
    repairsPctOfRevenue: 0.02,
    cardProcessingRate: 0.028,
    cardMixPct: 0.95,
    workersCompPct: 0.035,
    offersBenefits: false,
    monthlyRent: 3_000,
    preOpeningPayrollAndTraining: 12_000,
    preOpeningMarketing: 6_000,
    preOpeningPermitsAndLegal: 8_000,
  },
  openNotes: [
    'Capture rate is a guess — nobody has run an hourly telescope rental here, so there is no rate to borrow.',
  ],
};

function scripted(rulings: Adjudication[] = []) {
  return new ScriptedTransport(
    [
      {
        message: 'A dark-sky ridge changes the draw a lot.',
        cta: 'How many scopes, and how big is the unit?',
        readyToDraft: false,
      },
      { message: "That's enough to build against.", cta: 'Drafting it now.', readyToDraft: true },
    ],
    [draft],
    [],
    [],
    rulings,
  );
}

describe('the web setup state machine', () => {
  it('walks describe → interview → draft → funding → review → committed game', async () => {
    const session = createSetup(500_000, scripted());

    await say(session, 'telescope rentals by the hour on a dark-sky ridge');
    expect(session.phase).toBe('INTERVIEW');
    expect(session.chat.at(-1)?.cta).toContain('scopes');

    await say(session, '24 scopes in a 1,400 sq ft unit');
    expect(session.phase).toBe('FUNDING');
    expect(session.concept?.draft.businessName).toBe('Telescope rental by the hour');
    expect(session.proposal).toBeDefined();

    const outcome = fund(session, { proposed: true });
    expect(outcome.ok).toBe(true);
    expect(session.phase).toBe('REVIEW');
    expect(session.candidate!.openingCash).toBeGreaterThanOrEqual(0n);

    const view = toSetupView(session);
    expect(view.review!.register.length).toBeGreaterThan(10);
    expect(view.review!.arguable.length).toBeGreaterThan(0);
    expect(view.draft!.openNotes[0]).toContain('Capture rate');

    // Commit: the world opens as a game session carrying the setup journal.
    const game = createSessionFromWorld(
      session.candidate!.world,
      session.candidate!.model.businessName,
      session.events,
    );
    const gameView = toView(game);
    expect(gameView.businessName).toBe('Telescope rental by the hour');
    expect(game.events.some((e) => e.kind === 'draft')).toBe(true);
    expect(game.events.some((e) => e.kind === 'market_seed')).toBe(true);
  });

  it('adjudicates a challenge and writes the ruling through to the model', async () => {
    const session = createSetup(500_000, scripted([
      {
        ruling: 'CONCEDE',
        newValue: 2_500,
        newProvenance: 'PLAYER_SOURCED',
        reasoning: 'Used Dobsonians at that price are common on the secondary market.',
        clarifyingQuestion: null,
        secondOrderEffect: 'Depreciation drops with the gross cost.',
      },
    ]));
    await say(session, 'telescope rentals');
    await say(session, '24 scopes, 1,400 sq ft');
    fund(session, { proposed: true });
    expect(session.phase).toBe('REVIEW');

    const model = session.candidate!.model;
    const target = model.assumptions.find((a) => a.label.toLowerCase().includes('telescope'));
    expect(target, 'expected a telescope capex assumption').toBeDefined();

    const result = await challenge(session, target!.id, '2500', 'used Dobsonians on Cloudy Nights');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ruling).toBe('CONCEDE');
    expect(result.applied).toBe(true);
    expect(result.provenance).toBe('PLAYER_SOURCED');
    // Write-through: the model's own capex moved, not just the register row.
    expect(target!.value).toBe(250_000n);
    expect(target!.challengeHistory).toHaveLength(1);
  });

  it('a bare assertion clamps to the range edge without a model call', async () => {
    // No rulings scripted: the adjudication transport throws, and `adjudicate`
    // falls back to the offline path — rule 1 still clamps.
    const session = createSetup(500_000, scripted());
    await say(session, 'telescope rentals');
    await say(session, '24 scopes, 1,400 sq ft');
    fund(session, { proposed: true });

    const model = session.candidate!.model;
    const ticket = model.assumptions.find((a) => a.label.toLowerCase().includes('ticket'));
    expect(ticket).toBeDefined();
    // A bare 90 lands at the top of the registered range and goes no further.
    const rangeTop = ticket!.range.high;
    const result = await challenge(session, ticket!.id, '90', '');
    if ('error' in result) throw new Error(result.error);
    expect(result.applied).toBe(true);
    expect(Number(ticket!.value) / 100).toBeCloseTo(
      typeof rangeTop === 'bigint' ? Number(rangeTop) / 100 : rangeTop,
      2,
    );
    expect(ticket!.provenance).toBe('PLAYER_ASSUMED');
  });

  it('a template seed rides the first message as a stated preference', async () => {
    /**
     * A template SEEDS the conversation, never replaces it. The player who
     * clicked "Coffee shop" still says what the business actually is; the
     * choice reaches the model as a sentence in the first message, so the
     * fit judgement stays the model's (D-5) and the transcript stays honest.
     */
    const transport = scripted();
    const session = createSetup(500_000, transport, {
      scenario: 'coffee',
      templateId: 'coffee_shop',
      label: 'Coffee shop',
    });
    expect(session.chat[0]!.text).toContain('Coffee shop');
    expect(session.chat[0]!.text).toContain('make it yours');

    await say(session, 'a slow-bar espresso place by the university');
    const first = transport.seen[0]!.messages.at(-1)!.content;
    expect(first).toContain('a slow-bar espresso place');
    expect(first).toContain('coffee_shop');
    // The visible chat carries only what the player typed.
    expect(session.chat.find((c) => c.who === 'you')!.text).toBe(
      'a slow-bar espresso place by the university',
    );

    // The seed is a preference for the FIRST message only — later turns are
    // the conversation itself.
    await say(session, 'twelve seats, no food program');
    const second = transport.seen.at(-1)!.messages.at(-1)!.content;
    expect(second).not.toContain('coffee_shop');
  });

  it('undo takes back the last exchange in chat and transcript alike', async () => {
    const session = createSetup(500_000, scripted());
    await say(session, 'telescope rentals');
    const before = session.chat.length;
    expect(undo(session)).toBe(true);
    expect(session.chat.length).toBeLessThan(before);
    expect(session.chat.at(-1)?.who).not.toBe('you');
  });

  it('the in-game assume lever adjusts an assumption on the next tick', () => {
    const setup = createSetup(500_000, scripted());
    return say(setup, 'telescope rentals')
      .then(() => say(setup, '24 scopes, 1,400 sq ft'))
      .then(() => {
        fund(setup, { proposed: true });
        const game = createSessionFromWorld(setup.candidate!.world, 'test', setup.events);
        const business = game.world.businesses[0]!;
        const capture = Object.values(business.assumptions.byId).find((a) =>
          a.label.toLowerCase().includes('capture'),
        );
        expect(capture).toBeDefined();
        advanceSession(game, [
          { kind: 'ADJUST_ASSUMPTION', assumptionId: capture!.id, newValue: 0.04 },
        ]);
        const after = game.world.businesses.find((b) => b.id === game.businessId)!;
        expect(after.assumptions.byId[capture!.id]!.value).toBe(0.04);
        expect(after.assumptions.byId[capture!.id]!.provenance).toBe('PLAYER_ASSUMED');
      });
  });
});
