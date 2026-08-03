import { describe, expect, it, vi } from 'vitest';
import { EMPTY_USAGE, ScriptedTransport, draftToTemplate, type ConceptDraft } from '@bizsim/llm';
import { buildModelFromTemplate, validateBusinessModel } from '@bizsim/engine';
import { isThin, runSetup } from './setup.js';
import { START_CAPITAL, FREEPLAY_CAPITAL_CAP } from '@bizsim/schemas';
import { clampFreeplay } from '@bizsim/engine';
import { fromDisplay } from '@bizsim/money';
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
  stream: {
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
      stream: {
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
      '4', // custom starting capital
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
      '4', // custom
      '900000',
      'A place that rents telescopes by the hour on a dark-sky ridge.',
      '24 scopes, about 1400 square feet.',
      '', // nothing to argue with
      '2', // set the funding myself
      '0', // no loan
      '', // revolver
      '50000', // equity — enough to be lent to, nowhere near month zero
      'y', // yes, try different financing
      '2', // again by hand
      '0', // still no loan
      '', // revolver
      '700000', // and this time enough of his own to open
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

  it('repairs a malformed draft instead of ending the run over it', async () => {
    // Three missing `provenance` fields on a nine-parameter soft-serve truck
    // ended a session that had taken four turns to get there. Everything else
    // that goes wrong with a draft already goes back to the model; this was
    // the one that did not, for no reason but that it failed a different check.
    const broken = { ...draft, stream: { label: 'Only a label' } };
    let asked = 0;
    const transport = {
      turn: async () => ({
        turn: { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
      }),
      advise: () => Promise.reject(new Error('no advice in this double')),
      draft: async () => {
        asked += 1;
        return (asked === 1 ? broken : draft) as ConceptDraft;
      },
      usage: EMPTY_USAGE,
    };
    const input = scriptedInput([
      '4', // custom
      '900000',
      'A soft-serve truck in San Antonio.',
      '', // nothing to argue with
      '', // take the proposed funding
      'y', // commit
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(asked).toBe(2);
      expect(result?.committed).toBe(true);
      // And the player is told something is being fixed, not what — the
      // schema paths are the model's homework.
      expect(printed).toContain('came back incomplete');
      expect(printed).not.toContain('provenance');
    } finally {
      log.mockRestore();
    }
  });

  it('never proposes a loan its own lender will refuse', async () => {
    // The screen offered "$40,000 of your own plus a $113,925 SBA 7(a)" and
    // the lender declined it one screen later — $113,925 against $61,800 of
    // collateral. Recommending a plan and then refusing it teaches the player
    // that the numbers on offer are not real.
    const transport = new ScriptedTransport(
      [
        { message: 'Downtown Dayton is walkable.', cta: 'What is a typical ticket?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '1', // $100,000 — tight enough that the ceiling binds
      'A small ice cream shop in downtown Dayton.',
      'About $6 a head.',
      '', // nothing to argue with
      '', // take whatever it proposes
      'y',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      // Whatever it proposed, it is not something the underwriter rejects.
      expect(printed).not.toContain('The lender declined');
      // Either it committed, or it said honestly that the build is too big for
      // the money — never that the plan it just recommended is unfinanceable.
      expect(result === undefined || result.committed).toBeTruthy();
    } finally {
      log.mockRestore();
    }
  });

  it('warns when the opening cash will not carry the first quarter', async () => {
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '4', // custom
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '2', // fund it myself
      '0',
      '',
      '230000', // just enough to open, nowhere near enough to trade
      'y',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/That is thin/);
      // Both numbers, and the one that matters: how long it lasts.
      expect(printed).toMatch(/takes \$[\d,]+ out before revenue/);
      expect(printed).toMatch(/quarters of room/);
    } finally {
      log.mockRestore();
    }
  });

  it('does not offer a plan that leaves the build unfunded', async () => {
    // A Nevada solar farm was offered "$1,000,000 of your own plus a
    // $3,000,000 SBA 7(a)" against a $5.19M opening cost, chose it, and was
    // refused one screen later — short by $1.192M. The proposal already
    // respected the lending ceiling; it did not notice that the capped plan
    // could not cover opening, and say so before the choice.
    const transport = new ScriptedTransport(
      [
        { message: 'Nevada is good solar.', cta: 'How big?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '4', // custom
      '60000', // against a build far larger than that
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      'n', // and do not try again
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/still \$[\d,]+ short/);
      // And it names the only two ways out, one of which the screen now asks for.
      expect(printed).toMatch(/tax credit, a grant, a partner/);
    } finally {
      log.mockRestore();
    }
  });

  it('carries outside capital into the deal without charging the household', async () => {
    // The line the solar farm had nowhere to put: its drafted stack was
    // sponsor equity plus a transferred ITC plus debt, and only two of the
    // three reached the funding screen.
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '4', // custom
      '300000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '',
      '2', // set the funding myself
      '0', // no loan
      '', // revolver
      '300000', // everything I have
      '400000', // and a grant on top
      'y',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/comes from outside the deal/);
      // It is somebody's money, and the screen says so.
      expect(printed).toMatch(/dilutes what the business is worth to you/);
      expect(result?.committed).toBe(true);
      expect(result?.world.businesses[0]?.balances.contributedCapital).toBe(fromDisplay(700_000));
    } finally {
      log.mockRestore();
    }
  });

  it('lets the lender decline, instead of granting whatever is asked for', async () => {
    // A live run answered a $203,902 shortfall with a $4M SBA and a $4M
    // revolver against $140,000 of equity, and got all of it. `underwrite` has
    // always been in the engine — 10% owner injection, collateral coverage —
    // and setup never consulted it for the one loan that matters most.
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '4', // custom
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '2', // set the funding myself
      '5000000', // five million against a $174,000 buildout
      '',
      '10000',
      'n', // and leave it there
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(input, { transport })).toBeUndefined();
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('The lender declined');
      // The reason is the engine's own, with the arithmetic in it.
      expect(printed).toMatch(/collateral coverage|10% minimum/);
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
      '4', // custom
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

  it('puts every dollar of starting capital on the table', async () => {
    // There used to be a $60,000 living reserve. The reasoning was sound —
    // §2.3 draws living expenses from household cash — and the feature was
    // still wrong: it took 60% of a $100,000 start off the table before the
    // player had made a decision, then explained why their ice cream shop was
    // unfundable. Personal solvency is a different game from this one.
    const transport = new ScriptedTransport(
      [
        { message: 'Dark skies change the draw.', cta: 'How many scopes?', readyToDraft: false },
        { message: 'Enough to build against.', cta: 'Press enter.', readyToDraft: true },
      ],
      [draft],
    );
    const input = scriptedInput([
      '4', // custom
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '', // take the proposed funding
      'y', // commit
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runSetup(input, { transport });
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('all of it');
      expect(printed).not.toContain('to live on');
      expect(printed).not.toContain('bankrupt owner');
      expect(result?.committed).toBe(true);
      // And the draw is off with it: half the decision — no reserve against a
      // household that still bleeds — is worse than either whole one.
      expect(result?.world.household.annualLivingExpenses).toBe(0n);
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
      '4', // custom
      '900000',
      'A telescope rental place on a ridge.',
      '24 scopes.',
      '', // nothing to argue with
      '2', // set the funding myself
      '0',
      '',
      '1000',
      '', // no outside capital either
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

describe('what counts as a thin opening', () => {
  it('catches the cafe the flat threshold missed', () => {
    // $50,952 of opening cash against a first quarter that took $148,000 out.
    // Nine hundred dollars over a $50,000 line, so the old rule said nothing
    // at all — while the business had about ten days of room.
    expect(isThin(fromDisplay(50_952), fromDisplay(148_200))).toBe(true);
    // The rule it replaced, restated, so the difference is visible.
    expect(fromDisplay(50_952) < fromDisplay(50_000)).toBe(false);
  });

  it('leaves alone a small business that is genuinely well funded', () => {
    // $50,000 is three weeks for a cafe and most of a year for a food truck.
    // A flat threshold cannot tell those apart; this one does not need to.
    expect(isThin(fromDisplay(45_000), fromDisplay(12_000))).toBe(false);
    expect(fromDisplay(45_000) < fromDisplay(50_000)).toBe(true);
  });

  it('wants more than exactly one quarter of room', () => {
    // Funded to exactly the first quarter opens the second on the revolver,
    // and the second is usually worse because the ramp has not arrived.
    expect(isThin(fromDisplay(100_000), fromDisplay(100_000))).toBe(true);
    expect(isThin(fromDisplay(200_000), fromDisplay(100_000))).toBe(false);
  });

  it('says nothing about a business that does not burn in its first quarter', () => {
    expect(isThin(0n, 0n)).toBe(false);
  });
});

describe('the starting tiers', () => {
  it('offers four, an order of magnitude apart', () => {
    // These were $100,000 and $1,000,000. The low tier could not fund anything
    // a player actually described — a cafe, a pawn shop and a campground all
    // cleared it before the doors opened — so the only outcome available there
    // was a refusal at the gate. A starting amount that cannot start anything
    // is not a difficulty setting.
    expect(START_CAPITAL.LOW).toBe(fromDisplay(500_000));
    expect(START_CAPITAL.MID).toBe(fromDisplay(5_000_000));
    expect(START_CAPITAL.HIGH).toBe(fromDisplay(50_000_000));
    // The spread is what makes them different games rather than different
    // amounts.
    expect(START_CAPITAL.MID / START_CAPITAL.LOW).toBe(10n);
    expect(START_CAPITAL.HIGH / START_CAPITAL.MID).toBe(10n);
  });

  it('still caps free play at a billion', () => {
    expect(clampFreeplay(fromDisplay(5_000_000_000))).toBe(FREEPLAY_CAPITAL_CAP);
    expect(clampFreeplay(fromDisplay(250_000_000))).toBe(fromDisplay(250_000_000));
  });
});
