import { describe, expect, it } from 'vitest';
import type { ConceptDraft } from '@bizsim/llm';
import {
  buildabilityIssues,
  capitalIntensityNote,
  projectMatureRevenue,
  revenueRealityIssues,
  staffingRealismIssues,
} from './plausibility.js';
import { fromDisplay } from '@bizsim/money';

/**
 * The McDonald's run, reduced to its arithmetic.
 *
 * The live draft's own open notes said "revenue is anchored to a national
 * average unit volume near $3.5-3.9M". Its traffic and capture figures produce
 * about $1.4M. Every cost line — 4% royalty, 4% advertising, 10% percentage
 * rent, a salaried GM and two department managers — was sized for the $3.5M
 * store, so the player watched a McDonald's franchise lose 30% of revenue every
 * quarter with nothing on screen to suggest the volume, rather than the
 * business, was the problem.
 *
 * The figures below reproduce that gap rather than copying it exactly: they
 * build a store that earns roughly $1.9M against a stated $3.6M.
 */
const mcdonalds = (expectedAnnualRevenue: number): ConceptDraft => ({
  businessName: 'Golden Arches Iowa LLC',
  summary: 'One existing freestanding McDonald’s with a drive-thru in an Iowa metro.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  stream: {
      label: 'Restaurant sales',
      archetype: 'TRAFFIC',
      archetypeRationale: 'Passers-by convert and the kitchen caps throughput.',
      params: [
        { name: 'avgTicket', value: 11.5, low: 9, high: 14, sourceNote: 'Blended check.', provenance: 'LLM_ESTIMATE' },
        { name: 'addressableTrafficPerQuarter', value: 620_000, low: 500_000, high: 800_000, sourceNote: 'Daypart traffic past the site.', provenance: 'LLM_ESTIMATE' },
        { name: 'captureRate', value: 0.055, low: 0.04, high: 0.07, sourceNote: 'Share that turns in.', provenance: 'LLM_ESTIMATE' },
        { name: 'operatingDaysPerQuarter', value: 91, low: 91, high: 91, sourceNote: 'Open daily.', provenance: 'LLM_ESTIMATE' },
        { name: 'seats', value: 70, low: 60, high: 90, sourceNote: 'Dining room.', provenance: 'LLM_ESTIMATE' },
        { name: 'turnsPerDay', value: 9, low: 7, high: 12, sourceNote: 'Drive-thru led.', provenance: 'LLM_ESTIMATE' },
        { name: 'floorAreaSqFt', value: 4_000, low: 3_500, high: 4_500, sourceNote: 'Freestanding store.', provenance: 'LLM_ESTIMATE' },
        { name: 'skuCount', value: 90, low: 70, high: 120, sourceNote: 'Menu items.', provenance: 'LLM_ESTIMATE' },
        { name: 'baselineSkuCount', value: 90, low: 70, high: 120, sourceNote: 'Own baseline.', provenance: 'LLM_ESTIMATE' },
        { name: 'peakConcentration', value: 0.45, low: 0.35, high: 0.55, sourceNote: 'Lunch peak.', provenance: 'LLM_ESTIMATE' },
      ],
      seasonality: [0.95, 1.05, 1.05, 0.95],
      marketingSpendPerQuarter: 9_000,
      expectedAnnualRevenue,
    },
  costLines: [
    {
      label: 'Food & paper',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.31,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Franchise P&L norm.',
      provenance: 'LLM_ESTIMATE',
    },
    {
      label: 'Crew',
      class: 'STEP_FIXED',
      statementLine: 'LABOR',
      value: 46_000,
      isLabor: true,
      accruable: false,
      capacityPerBlock: 40_000,
      minimumBlocks: 1,
      sourceNote: 'A shift team at Iowa wage levels.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  capex: [
    { label: 'Store acquisition', category: 'REAL_PROPERTY', grossCost: 3_500_000, usefulLifeYears: 30, quantity: 1, sourceNote: 'Going concern.' },
  ],
  workingCapital: {
    dsoDays: 0,
    dioDays: 7,
    dpoDays: 21,
    prepaidInsuranceMonths: 3,
    securityDepositMonths: 0,
    customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 120_000,
    utilitiesPerQuarter: 14_000,
    generalLiabilityInsurancePerYear: 18_000,
    propertyInsurancePerYear: 12_000,
    accountingAndLegalPerYear: 20_000,
    softwareAndPosPerYear: 14_000,
    permitsAndLicensesPerYear: 6_000,
    badDebtPctOfRevenue: 0.001,
    repairsPctOfRevenue: 0.02,
    cardProcessingRate: 0.024,
    cardMixPct: 0.85,
    workersCompPct: 0.04,
    offersBenefits: false,
    monthlyRent: 29_000,
    preOpeningPayrollAndTraining: 95_000,
    preOpeningMarketing: 10_000,
    preOpeningPermitsAndLegal: 60_000,
  },
  openNotes: ['Percentage rent is the largest unknown.'],
});

describe('does the draft build the business the draft says it is building', () => {
  it('catches a model that states one revenue and drafts another', () => {
    const issues = revenueRealityIssues(mcdonalds(3_600_000));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('3,600,000');
    // It says which way, and by how much, because "check your numbers" is not
    // something a model can act on.
    expect(issues[0]).toContain('far below');
    expect(issues[0]).toMatch(/off by 0\.\d+x/);
  });

  it('says nothing when the drafted volume reaches the stated revenue', () => {
    // Same business, same parameters — only the claim changes. If the check
    // fired on this too it would be measuring nothing.
    const projection = projectMatureRevenue(mcdonalds(3_600_000));
    expect(projection).toBeDefined();
    const actual = Number(projection!.matureAnnualRevenue) / 100;
    expect(revenueRealityIssues(mcdonalds(actual))).toEqual([]);
  });

  it('leaves a bold claim alone and only catches self-contradiction', () => {
    // D-5: the check has no opinion about whether the business is any good.
    // Within the band, a wildly optimistic capture rate passes untouched — that
    // is the challenge loop's job, not this file's.
    const projection = projectMatureRevenue(mcdonalds(1))!;
    const actual = Number(projection.matureAnnualRevenue) / 100;
    expect(revenueRealityIssues(mcdonalds(actual * 0.7))).toEqual([]);
    expect(revenueRealityIssues(mcdonalds(actual * 1.5))).toEqual([]);
    expect(revenueRealityIssues(mcdonalds(actual * 0.3))).toHaveLength(1);
    expect(revenueRealityIssues(mcdonalds(actual * 4))).toHaveLength(1);
  });

  it('stays quiet when the draft never stated a figure to check against', () => {
    const draft = mcdonalds(0);
    expect(projectMatureRevenue(draft)).toBeUndefined();
    expect(revenueRealityIssues(draft)).toEqual([]);
  });

  it('reads revenue from the engine rather than recomputing it', () => {
    // The projection has to be the same arithmetic the player will see, or it
    // is checking a model nobody runs. A drafted business with real seasonality
    // and a ramp should land somewhere sane rather than at zero.
    const p = projectMatureRevenue(mcdonalds(3_600_000))!;
    expect(p.matureAnnualRevenue).toBeGreaterThan(0n);
    expect(p.ratio).toBeGreaterThan(0);
    expect(p.ratio).toBeLessThan(TOO_LOW_FOR_TEST);
  });
});

/** The threshold the module uses, restated so the test fails if it moves. */
const TOO_LOW_FOR_TEST = 0.6;

describe('the validator runs while there is still someone to tell', () => {
  it('catches a footprint fault at the draft, not at the commit gate', () => {
    // An offshore rave ship drafted 700 guests into 2,000 square feet. The
    // engine caught it exactly as designed — and caught it after the player had
    // answered five financing questions and put in a million dollars, at which
    // point the run ended and took the conversation with it.
    const overcrowded = mcdonalds(3_600_000);
    const params = overcrowded.stream.params;
    params.find((p) => p.name === 'seats')!.value = 700;
    params.find((p) => p.name === 'floorAreaSqFt')!.value = 2_000;

    const issues = buildabilityIssues(overcrowded);
    expect(issues.some((i) => i.startsWith('CAPACITY_EXCEEDS_FOOTPRINT'))).toBe(true);
    // The engine's message already says what would have to be true, and it goes
    // back to the model verbatim rather than being paraphrased into advice.
    expect(issues.join(' ')).toContain('700 seats will not fit');
  });

  it('says nothing about a draft the engine is happy with', () => {
    expect(buildabilityIssues(mcdonalds(3_600_000))).toEqual([]);
  });

  it('reports a draft that cannot be assembled at all rather than throwing', () => {
    const noStream = { ...mcdonalds(3_600_000), stream: undefined } as unknown as ConceptDraft;
    const issues = buildabilityIssues(noStream);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('could not be assembled');
  });

  it('never reports a financing problem — that is the player\'s question, later', () => {
    // Built with a billion dollars behind it on purpose. A draft flagged here
    // for being underfunded would send the model off correcting the wrong
    // thing, and would hide whatever the real fault was.
    const expensive = mcdonalds(3_600_000);
    expensive.capex[0]!.grossCost = 400_000_000;
    expect(buildabilityIssues(expensive)).toEqual([]);
  });
});

describe('capital in the ground against what it earns', () => {
  it('says so when opening costs many years of revenue', () => {
    // A 320-acre Tennessee campground: $960,000 into the ground, $98,000 of
    // mature revenue. The model said exactly this in its own open notes and
    // then it scrolled away behind month zero, the funding screen and the
    // register. The player committed, bled for three years, and concluded he
    // was bad at business. He was not.
    const draft = mcdonalds(3_600_000);
    const note = capitalIntensityNote(draft, fromDisplay(20_000_000));
    expect(note).toBeDefined();
    expect(note).toMatch(/years of revenue to get the doors open/);
    expect(note).toContain('20,000,000');
  });

  it('stays quiet for a business that opens for well under its revenue', () => {
    // Restaurants and shops open for a fraction of a year's revenue; a hotel
    // or a marina runs three to five and is a perfectly normal business. Only
    // the far end is worth a sentence.
    expect(capitalIntensityNote(mcdonalds(3_600_000), fromDisplay(500_000))).toBeUndefined();
  });

  it('is a sentence, not a veto', () => {
    // D-5: a bad business is the player's to build. This has to read as
    // information at the moment of the decision, not as a refusal.
    const note = capitalIntensityNote(mcdonalds(3_600_000), fromDisplay(20_000_000))!;
    expect(note).toMatch(/can be exactly right/);
    expect(note).not.toMatch(/cannot|refus|too (big|expensive)|will fail/i);
  });

  it('says nothing when there is no projection to measure against', () => {
    expect(capitalIntensityNote(mcdonalds(0), fromDisplay(20_000_000))).toBeUndefined();
  });
});

/**
 * Staffing that never has to grow.
 *
 * A Buffalo brewpub reached $4.4M a year — 370 covers a day — on five staffing
 * blocks and an owner, and never once needed a sixth. Labour landed at 8% of
 * revenue where full-service food runs 30-35%, and the single most consequential
 * decision in an operating business never came up.
 *
 * The engine is not wrong and cannot be: §4.3 makes blocks a player decision
 * and only forces one when demand exceeds what the blocks support. If a block
 * supports everything, nothing is ever forced. The claim that needs checking
 * belongs to the draft.
 */
describe('staffing that never has to grow', () => {
  /** The same store, with the crew block sized so one covers everything. */
  const withCrewCapacity = (capacityPerBlock: number, blockCost = 46_000): ConceptDraft => {
    const draft = mcdonalds(1_900_000);
    return {
      ...draft,
      costLines: draft.costLines.map((line) =>
        line.label === 'Crew' ? { ...line, capacityPerBlock, value: blockCost } : line,
      ),
    };
  };

  it('flags a business whose labour never crosses a block boundary', () => {
    // One crew block covering a million transactions a quarter: the number the
    // brewpub had, in the shape a draft actually writes it.
    const issues = staffingRealismIssues(withCrewCapacity(1_000_000, 12_000));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/% of revenue/);
    expect(issues[0]).toMatch(/covers all/);
    // It names the mechanism, because that is the part the model can fix.
    expect(issues[0]).toMatch(/Crew at 1,000,000 per block/);
    // And it is a warning about a claim, not a verdict about the business.
    expect(issues[0]).toMatch(/really is that light and the sourceNote should say why/);
  });

  it('says nothing about a business staffed like its trade', () => {
    // 40,000 transactions per block at $46k: several blocks at maturity and
    // labour in a normal band. This is the seeded store and it must stay quiet.
    expect(staffingRealismIssues(mcdonalds(1_900_000))).toEqual([]);
  });

  it('does not fire on a genuinely light business, only an impossible one', () => {
    // The threshold is far below any real trade's band on purpose: it catches
    // the failure, not a difference of opinion about how lean a shop can run.
    const lean = staffingRealismIssues(withCrewCapacity(120_000, 46_000));
    for (const issue of lean) expect(issue).toMatch(/% of revenue/);
    // Whatever it decides, it decides from the run rather than from the draft's
    // own claim about itself.
    expect(staffingRealismIssues(withCrewCapacity(40_000, 46_000))).toEqual([]);
  });
});
