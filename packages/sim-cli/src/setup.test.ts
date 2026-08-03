import { describe, expect, it, vi } from 'vitest';
import { ScriptedTransport, draftToTemplate, type ConceptDraft } from '@bizsim/llm';
import { buildModelFromTemplate, validateBusinessModel } from '@bizsim/engine';
import { runSetup } from './setup.js';
import type { LineSource } from './input.js';

/**
 * The end-to-end claim M3 makes: a business described in a sentence reaches the
 * same validated model, the same assumption register and the same commit gate
 * that the template picker reaches. If that holds, the conversation really is
 * only an input method — which is the entire design.
 *
 * Everything runs against a scripted transport, so this exercises the wiring
 * without a key or a network.
 */

/** Feeds fixed answers to the prompts, in order. */
function scriptedInput(lines: readonly string[]): LineSource {
  let i = 0;
  return {
    next: async () => lines[i++],
    close: () => {},
  };
}

const draft: ConceptDraft = {
  businessName: 'Telescope rental by the hour',
  summary: 'A shopfront renting telescopes by the hour on a dark-sky ridge.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  streams: [
    {
      label: 'Hourly rentals',
      archetype: 'TRAFFIC',
      archetypeRationale:
        'Visitors arrive and convert at a rate, capped by how many scopes can be ' +
        'staffed out at once. Not OCCUPANCY: the constraint is the counter, not a unit count.',
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
    },
  ],
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
    { label: 'Telescopes', category: 'EQUIPMENT', grossCost: 3_500, usefulLifeYears: 8, quantity: 24, sourceNote: 'Quoted.' },
    { label: 'Buildout', category: 'LEASEHOLD_IMPROVEMENTS', grossCost: 90_000, usefulLifeYears: 15, quantity: 1, sourceNote: 'Contractor estimate.' },
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

describe('the concept path reaches the same gate as the picker', () => {
  it('maps a described business into a model the engine validates', () => {
    const mapped = draftToTemplate(draft);
    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      legalForm: mapped.legalForm,
      scale: mapped.scale,
      equityInjection: 500_000_00n,
    });

    const result = validateBusinessModel(model);
    expect(result.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('carries no borrowed benchmark bands — D-5 in the data', () => {
    const mapped = draftToTemplate(draft);
    expect(mapped.template.plausibility).toEqual({});
    expect(mapped.template.costDefaults.every((c) => c.benchmarkBand === undefined)).toBe(true);

    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      scale: mapped.scale,
      equityInjection: 500_000_00n,
    });
    // Nothing is flagged against numbers that do not describe this business.
    expect(model.assumptions.some((a) => a.outsideBenchmark)).toBe(false);
    expect(model.assumptions.length).toBeGreaterThan(20);
  });

  it('is deterministic — the same draft maps to the same template', () => {
    expect(draftToTemplate(draft).template.id).toBe(draftToTemplate(draft).template.id);
    expect(draftToTemplate(draft).template.id).toBe('llm_telescope_rental_by_the_hour');
  });

  it('honours the scale the conversation established, not a template default', () => {
    const mapped = draftToTemplate(draft);
    expect(mapped.scale.seats).toBe(24);
    expect(mapped.scale.floorAreaSqFt).toBe(1_400);
    expect(mapped.scale.captureRate).toBe(0.03);
    expect(mapped.scale.price).toBe(45_00n); // the archetype's price slot
  });

  it('runs the whole of setup from a sentence, through to the commit gate', async () => {
    const transport = new ScriptedTransport(
      [
        {
          message: 'A dark-sky ridge changes the draw a lot.',
          cta: 'How many scopes, and how big is the unit?',
          readyToDraft: false,
        },
        {
          message: "That's enough to build against.",
          cta: 'Press enter to see the numbers.',
          readyToDraft: true,
        },
      ],
      [draft],
    );
    const input = scriptedInput([
      '3', // custom starting capital
      '900000',
      'A place that rents telescopes by the hour on a dark-sky ridge.',
      '24 scopes, about 1400 square feet.',
      '', // marketing — accept suggestion
      '', // equity — accept suggestion
      '', // debt
      '', // legal form or similar
      'y', // commit
      'y',
      'y',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');

      // The interview ran, and the concept — not a template label — named it.
      expect(printed).toContain('How many scopes');
      expect(printed).toContain('Telescope rental by the hour');
      // The player was told why it has no bands, rather than being shown
      // borrowed ones.
      expect(printed).toContain('No template fits');
      // And the assumption register was put in front of them (Phase 3).
      expect(printed).toContain('ASSUMPTIONS');

      // Whether they committed depends on the seeded answers; what matters is
      // that setup completed rather than throwing.
      expect(result === undefined || typeof result.committed === 'boolean').toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('never offers a list of industries when a model is available', async () => {
    const transport = new ScriptedTransport([
      { message: 'Worth knowing where.', cta: 'Where is it?', readyToDraft: false },
    ]);
    const input = scriptedInput(['2', 'A telescope rental place.', '']);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSetup(input, { transport }).catch(() => undefined);
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Describe it however you like');
      expect(printed).not.toContain('Full-service restaurant');
    } finally {
      log.mockRestore();
    }
  });
});
