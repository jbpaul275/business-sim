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
      expectedAnnualRevenue: 480_000,
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

  it('says where every number came from, and does not claim a benchmark', () => {
    // A Detroit ice rink invented over five turns registered BENCHMARK 49,
    // LLM_ESTIMATE 0. Nothing about it had ever been benchmarked — the engine
    // simply defaulted every assumption, which is right for a seed template and
    // a fabrication for a synthetic one. The register asserting published
    // support for numbers that have none is the failure §10 exists to prevent,
    // and it is worse than having no register at all.
    const mapped = draftToTemplate(draft);
    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      scale: mapped.scale,
      equityInjection: 500_000_00n,
      provenanceFor: mapped.provenanceFor,
    });

    const at = (path: string) => model.assumptions.find((a) => a.path === path)?.provenance;

    expect(model.assumptions.filter((a) => a.provenance === 'BENCHMARK')).toEqual([]);

    // The model's own guesses.
    expect(at('streams.s1.params.captureRate')).toBe('LLM_ESTIMATE');
    expect(at('costs.llm_0_consumables_breakage.pctOfRevenue')).toBe('LLM_ESTIMATE');

    // What the player actually told it, which outranks an estimate (§10.3).
    expect(at('streams.s1.params.capacityModel.seats')).toBe('PLAYER_SOURCED');
    expect(at('streams.s1.params.addressableTrafficPerQuarter')).toBe('PLAYER_SOURCED');
    expect(at('costs.llm_2_rent.amountPerQuarter')).toBe('PLAYER_SOURCED');

    // Statutory and spec constants stay CATALOG regardless of who assembled
    // the template: the model is not consulted about FICA or the §3.7 curves.
    expect(at('costs.payrollLoadPct')).toBe('CATALOG');
    expect(at('costs.llm_2_rent.annualEscalatorPct')).toBe('CATALOG');
    expect(at('streams.s1.modifiers.priceElasticity')).toBe('CATALOG');
    expect(at('streams.s1.params.referencePrice')).toBe('CATALOG');

    // Omission-guard lines arrive from the engine, but on a synthetic template
    // it computes them off this draft's own overheads — so they are the
    // model's figures by another route, not comparables.
    expect(at('costs.og_owner_comp.amountPerQuarter')).toBe('LLM_ESTIMATE');
    expect(at('costs.og_utilities.amountPerQuarter')).toBe('LLM_ESTIMATE');
  });

  it('leaves the seed-template default alone when nobody supplies provenance', () => {
    // The guard on the guard. A hand-authored template's figures really are
    // benchmarked, so BENCHMARK stays the default and the override has to be
    // opt-in — otherwise this fix would relabel the seeds as guesses.
    const mapped = draftToTemplate(draft);
    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      scale: mapped.scale,
      equityInjection: 500_000_00n,
    });
    expect(model.assumptions.some((a) => a.provenance === 'BENCHMARK')).toBe(true);
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

  it('builds a UTILIZATION business that actually validates', () => {
    // The recruiting-firm run died on UTILIZATION_WITHOUT_STAFFING, and the
    // cause was the mapper stamping `driver: 'TRANSACTIONS'` on every
    // step-fixed line. §3.8 gives each archetype one binding volume unit, so a
    // recruiting desk billed in transactions could never satisfy the check —
    // no draft, however well formed, could have passed.
    const firm: ConceptDraft = {
      ...draft,
      businessName: 'Permanent placement search firm',
      streams: [
        {
          label: 'Perm search fees',
          archetype: 'UTILIZATION',
          archetypeRationale: 'Output is capped by the searches nine recruiters can work at once.',
          params: [
            { name: 'blendedHourlyRate', value: 190, low: 150, high: 240, sourceNote: 'Fee per hour worked.', provenance: 'LLM_ESTIMATE' },
            { name: 'demandHoursPerQuarter', value: 4_600, low: 3_500, high: 5_500, sourceNote: 'Searches the market will bear.', provenance: 'LLM_ESTIMATE' },
            { name: 'realizationRate', value: 0.78, low: 0.65, high: 0.85, sourceNote: 'Fills over searches taken.', provenance: 'LLM_ESTIMATE' },
          ],
          seasonality: [1.0, 1.05, 0.9, 1.05],
          marketingSpendPerQuarter: 18_000,
          expectedAnnualRevenue: 2_600_000,
        },
      ],
      costLines: [
        {
          label: 'Recruiter desks',
          class: 'STEP_FIXED',
          statementLine: 'LABOR',
          value: 34_000,
          isLabor: true,
          accruable: false,
          capacityPerBlock: 480,
          minimumBlocks: 1,
          sourceNote: 'One producing recruiter, base plus draw.',
          provenance: 'LLM_ESTIMATE',
        },
      ],
    };

    const mapped = draftToTemplate(firm);
    // The line is billed in hours, because the archetype says so.
    expect(mapped.template.costDefaults[0]?.driver).toBe('BILLABLE_HOURS');

    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      scale: mapped.scale,
      equityInjection: 1_000_000_00n,
    });
    const result = validateBusinessModel(model);
    expect(result.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(result.valid).toBe(true);
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
      '', // nothing to argue with
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

  it('lets an underfunded business re-finance instead of throwing the concept away', async () => {
    // The gate used to end the run: five turns of conversation, a drafted
    // business, and then "run `pnpm sim --new` again" over a number the player
    // would happily have changed. Nothing upstream of financing depends on it,
    // so the shortfall is information, not a verdict.
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '3',
      '900000',
      'A place that rents telescopes by the hour on a dark-sky ridge.',
      '24 scopes, about 1400 square feet.',
      '', // nothing to argue with
      '2', // set the funding myself
      '0', // no loan
      '', // revolver
      '1000', // equity — nowhere near month zero
      'y', // yes, try different financing
      '2', // again by hand
      '900000', // an SBA loan that actually covers it
      '', // revolver
      '', // equity
      'y', // commit
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');

      expect(printed).toContain('Not funded yet');
      expect(printed).toContain('The concept is intact');
      // The interview is not re-run, and the concept is not discarded.
      expect(printed.match(/How many scopes/g)?.length).toBe(1);
      expect(result?.committed).toBe(true);
      expect(result?.world.businesses[0]?.cash).toBeGreaterThan(0n);
    } finally {
      log.mockRestore();
    }
  });

  it('lets the player argue with the draft it told them to argue with', async () => {
    // The draft prints "Worth arguing with first" and names the three figures
    // it trusts least — and then went straight to asking for a marketing
    // budget. Offering the three most uncertain numbers in a business and then
    // refusing to discuss them is worse than not offering.
    const revised: ConceptDraft = {
      ...draft,
      businessName: 'Telescope rental, forty scopes',
    };
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
        { message: 'Forty it is — that changes the counter.', cta: 'Here it is again.', readyToDraft: true },
      ],
      [revised],
    );
    const input = scriptedInput([
      '3',
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      'the capture rate is way too low, we get far more foot traffic than that',
      '', // and now leave it alone
      '', // take the proposed funding
      'y', // commit
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');

      // The objection went to the model and came back as a new draft, rather
      // than being swallowed by the next numeric prompt.
      expect(printed).toContain('Forty it is');
      // And the revised draft is what got committed, not the first one.
      expect(printed).toContain('Telescope rental, forty scopes');
      expect(result?.committed).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('warns before the player empties the household into the business', async () => {
    // A live run put $1,000,000 of a $1,000,000 household into the buildout and
    // printed "Household keeps $0.00" as though it were a line item.
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '3',
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '2', // set the funding myself
      '0',
      '',
      '900000', // everything
      'y',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('leaves your household');
      expect(printed).toContain('bankrupt owner');
    } finally {
      log.mockRestore();
    }
  });

  it('stops asking when the player says the financing is not going to work', async () => {
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '3',
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '2', // set the funding myself
      '0',
      '',
      '1000',
      'n', // no — leave it
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(input, { transport })).toBeUndefined();
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Nothing committed');
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
