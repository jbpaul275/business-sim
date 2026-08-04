import { describe, expect, it } from 'vitest';
import { ScriptedTransport, type Adjudication, type ConceptDraft } from '@bizsim/llm';
import { advanceSession, createSession, forgetSessions, getSession } from './store';
import { forgetSetups, getSetup, say } from './setup';
import { createSetup, fund } from './setup';
import { toView } from './view';
import { toSetupView } from './setupView';

/**
 * The restart seam. Web sessions lived only in memory, so every dev-server
 * restart silently ended every run and destroyed every unshared journal —
 * including the one play-test run whose evidence mattered most. These tests
 * walk the actual failure: build a session, forget the in-memory map (that
 * IS the restart), and get the same session back from disk.
 */

describe('game sessions survive a restart', () => {
  it('round-trips a played session through disk, bigints and all', () => {
    const original = createSession('storage');
    advanceSession(original, [], 2);
    const before = JSON.stringify(toView(original));

    forgetSessions();
    const revived = getSession(original.id);
    expect(revived).toBeDefined();
    expect(JSON.stringify(toView(revived!))).toBe(before);

    // The revived session is fully playable, not a display shell: the world's
    // Money bigints came back as bigints or this tick would throw.
    advanceSession(revived!, [], 0);
    expect(revived!.last.statements.period).toBe(original.last.statements.period + 1);
    // And the journal — the QA share's payload — survived intact.
    expect(revived!.events.some((e) => e.kind === 'market_seed')).toBe(true);
  });

  it('a session that never existed is still a miss', () => {
    forgetSessions();
    expect(getSession('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});

describe('setup sessions survive a restart', () => {
  it('rehydrates the conversation and the review, and the flow continues', async () => {
    // The same telescope fixture the setup suite drives.
    const { draft, rulings } = fixtures();
    const transport = new ScriptedTransport(
      [
        { message: 'A ridge changes the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Drafting.', readyToDraft: true },
      ],
      [draft],
      [],
      [],
      rulings,
    );
    const original = createSetup(500_000, transport);
    await say(original, 'telescope rentals by the hour on a dark-sky ridge');
    await say(original, '24 scopes in a 1,400 sq ft unit');
    fund(original, { proposed: true });
    expect(original.phase).toBe('REVIEW');
    const before = JSON.stringify(toSetupView(original));

    forgetSetups();
    // The restart: rehydrate with an injected transport (tests have no key).
    const revived = getSetup(original.id, transport);
    expect(revived).toBeDefined();
    expect(JSON.stringify(toSetupView(revived!))).toBe(before);

    // The interview transcript came back — the conversation, not a shell.
    expect(revived!.interview.transcript.length).toBe(original.interview.transcript.length);
    expect(revived!.turns).toBe(2);
    // And the candidate world's bigints revived: commit-path math still runs.
    expect(revived!.candidate!.openingCash).toBeGreaterThanOrEqual(0n);
  });
});

/** Minimal valid telescope fixture, duplicated knowingly from setup.test.ts. */
function fixtures(): { draft: ConceptDraft; rulings: Adjudication[] } {
  const draft: ConceptDraft = {
    businessName: 'Telescope rental by the hour',
    summary: 'A shopfront renting telescopes by the hour on a dark-sky ridge.',
    legalForm: 'LLC_PASSTHROUGH',
    seedTemplateId: null,
    stream: {
      label: 'Hourly rentals',
      archetype: 'TRAFFIC',
      archetypeRationale: 'Visitors arrive and convert at a rate.',
      params: [
        { name: 'avgTicket', value: 45, low: 35, high: 60, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'seats', value: 24, low: 20, high: 30, sourceNote: 'test note', provenance: 'PLAYER_SOURCED' },
        { name: 'floorAreaSqFt', value: 1_400, low: 1_200, high: 1_600, sourceNote: 'test note', provenance: 'PLAYER_SOURCED' },
        { name: 'turnsPerDay', value: 3, low: 2, high: 4, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'captureRate', value: 0.03, low: 0.02, high: 0.05, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'addressableTrafficPerQuarter', value: 90_000, low: 70_000, high: 110_000, sourceNote: 'test note', provenance: 'PLAYER_SOURCED' },
        { name: 'skuCount', value: 12, low: 8, high: 20, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'baselineSkuCount', value: 12, low: 8, high: 20, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'operatingDaysPerQuarter', value: 91, low: 80, high: 91, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
        { name: 'peakConcentration', value: 0.5, low: 0.4, high: 0.6, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
      ],
      seasonality: [0.9, 1.0, 1.2, 0.9],
      marketingSpendPerQuarter: 4_000,
      expectedAnnualRevenue: 480_000,
      volumeNoun: 'covers',
    },
    costLines: [
      { label: 'Consumables & breakage', class: 'VARIABLE_REVENUE', statementLine: 'COGS', value: 0.08, isLabor: false, accruable: true, capacityPerBlock: null, minimumBlocks: null, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
      { label: 'Guides', class: 'STEP_FIXED', statementLine: 'LABOR', value: 12_000, isLabor: true, accruable: false, capacityPerBlock: 1_200, minimumBlocks: 1, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
      { label: 'Rent', class: 'FIXED_PERIOD', statementLine: 'OCCUPANCY', value: 9_000, isLabor: false, accruable: true, capacityPerBlock: null, minimumBlocks: null, sourceNote: 'test note', provenance: 'PLAYER_SOURCED' },
    ],
    capex: [
      { label: 'Telescopes', category: 'EQUIPMENT', grossCost: 3_500, usefulLifeYears: 8, quantity: 24, sourceNote: 'test note', provenance: 'PLAYER_SOURCED' },
      { label: 'Buildout', category: 'LEASEHOLD_IMPROVEMENTS', grossCost: 90_000, usefulLifeYears: 15, quantity: 1, sourceNote: 'test note', provenance: 'LLM_ESTIMATE' },
    ],
    workingCapital: { dsoDays: 1, dioDays: 14, dpoDays: 21, prepaidInsuranceMonths: 6, securityDepositMonths: 2, customerDepositPct: 0 },
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
    openNotes: ['Capture rate is a guess.'],
  };
  return { draft, rulings: [] };
}
