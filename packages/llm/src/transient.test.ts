import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicConceptTransport,
  ConceptInterview,
  TransientError,
  isTransient,
  type ConceptDraft,
} from './index.js';

/**
 * A plastics factory died two turns in:
 *
 *   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 *   Nothing was committed. Run `pnpm sim --new` to start again.
 *
 * Overload says nothing about the conversation. Telling someone to describe
 * their business again from the top is the one response that is definitely
 * wrong, and the transcript was sitting intact in memory the whole time.
 */

describe('the model being busy', () => {
  it('recognises the shapes that mean "try again", not "you did something wrong"', () => {
    expect(isTransient(new Error('{"type":"error","error":{"type":"overloaded_error"}}'))).toBe(true);
    expect(isTransient(new Error('rate_limit_error'))).toBe(true);
    expect(isTransient(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).toBe(true);
  });

  it('does not swallow a fault that retrying will not fix', () => {
    // A bad key or a malformed request fails identically forever; retrying it
    // wastes the player's time and hides the real cause.
    expect(isTransient(new Error('invalid_request_error: bad schema'))).toBe(false);
    expect(isTransient(new Error('authentication_error'))).toBe(false);
    expect(isTransient(new Error('The compiled grammar is too large'))).toBe(false);
  });

  it('retries more than the SDK default, because giving up costs the conversation', () => {
    const t = new AnthropicConceptTransport({ apiKey: 'test' }) as unknown as {
      client: { maxRetries: number };
    };
    expect(t.client.maxRetries).toBeGreaterThan(2);
  });

  it('rolls the unanswered message back out of the transcript', async () => {
    // The player's message is pushed before the call so the model can see it.
    // Leaving it there on failure means a retry sends it twice, and the model
    // answers a conversation that did not happen.
    let fail = true;
    const interview = new ConceptInterview({
      transport: {
        turn: async () => {
          if (fail) {
            fail = false;
            throw new Error('{"type":"error","error":{"type":"overloaded_error"}}');
          }
          return { turn: { message: 'Ohio works.', cta: 'How many lines?', readyToDraft: false } };
        },
        advise: () => Promise.reject(new Error('no advice in this double')),
        adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
        draft: async () => {
          throw new Error('not reached');
        },
        usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      },
    });

    await expect(interview.send('20k sf plant in Ohio')).rejects.toBeInstanceOf(TransientError);
    expect(interview.transcript).toHaveLength(0);

    // And the same message goes again cleanly.
    const state = await interview.send('20k sf plant in Ohio');
    expect(state.status).toBe('ASKING');
    expect(interview.transcript.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('a draft that fails on a busy model', () => {
  it('does not replay the player message, because the turn already landed', async () => {
    // The bug in the first version of this fix. A failed *draft* happens after
    // a turn that succeeded and is already in the transcript, so resending the
    // player's message puts it there twice and the model answers a
    // conversation that did not happen.
    let drafts = 0;
    const interview = new ConceptInterview({
      transport: {
        turn: async () => ({
          turn: { message: 'Enough to build against.', cta: 'Building it now.', readyToDraft: true },
        }),
        advise: () => Promise.reject(new Error('no advice in this double')),
        adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
        draft: async () => {
          drafts += 1;
          if (drafts === 1) throw new Error('{"type":"error","error":{"type":"overloaded_error"}}');
          return DRAFT;
        },
        usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      },
    });

    const failure = await interview.send('A digital bank in Mexico.').catch((e) => e);
    expect(failure).toBeInstanceOf(TransientError);
    expect(failure.phase).toBe('draft');

    // The conversation up to the draft is intact: one player message, one
    // reply. Nothing was rolled back, because nothing needed to be.
    expect(interview.transcript.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(interview.transcript.filter((m) => m.role === 'assistant')).toHaveLength(1);

    // And the retry redoes only the half that failed.
    const draft = await interview.retryDraft();
    expect(draft.businessName).toBe('Digital bank');
    expect(drafts).toBe(2);
    expect(interview.transcript.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('marks a failed turn as a turn, so the player message is rolled back', async () => {
    const interview = new ConceptInterview({
      transport: {
        turn: async () => {
          throw new Error('{"type":"error","error":{"type":"overloaded_error"}}');
        },
        advise: () => Promise.reject(new Error('no advice in this double')),
        adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
        draft: async () => DRAFT,
        usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      },
    });
    const failure = await interview.send('A digital bank in Mexico.').catch((e) => e);
    expect(failure.phase).toBe('turn');
    expect(interview.transcript).toHaveLength(0);
  });
});

describe('asking for a number', () => {
  it('tells the model to offer the range it would otherwise assume', async () => {
    const { CONCEPT_INTERVIEW_SYSTEM } = await import('./prompt.js');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Never ask for a number without offering the range');
    // The worked example is the live one: a building size asked with no band.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('thermoforming');
  });
});

/** The smallest draft `zConceptDraft` accepts, for the retry to return. */
const DRAFT: ConceptDraft = {
  businessName: 'Digital bank',
  summary: 'A digital-first bank in Mexico.',
  legalForm: 'C_CORP',
  seedTemplateId: null,
  stream: {
    label: 'Accounts',
    archetype: 'SUBSCRIPTION',
    archetypeRationale: 'Recurring accounts with churn.',
    params: [
      { name: 'arpuPerQuarter', value: 42, low: 30, high: 60, sourceNote: 'Interchange plus fees.', provenance: 'LLM_ESTIMATE' },
    ],
    seasonality: [1, 1, 1, 1],
    marketingSpendPerQuarter: 400_000,
    expectedAnnualRevenue: 40_000_000,
    volumeNoun: 'subscribers',
  },
  costLines: [
    {
      label: 'Card scheme and processing',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.22,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Scheme fees and processor.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  capex: [
    { label: 'Core banking platform', category: 'EQUIPMENT', grossCost: 4_000_000, usefulLifeYears: 7, quantity: 1, sourceNote: 'Licence and build.', provenance: 'LLM_ESTIMATE' },
  ],
  workingCapital: {
    dsoDays: 2, dioDays: 0, dpoDays: 30,
    prepaidInsuranceMonths: 6, securityDepositMonths: 2, customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 300_000, utilitiesPerQuarter: 40_000,
    generalLiabilityInsurancePerYear: 250_000, propertyInsurancePerYear: 40_000,
    accountingAndLegalPerYear: 1_200_000, softwareAndPosPerYear: 900_000,
    permitsAndLicensesPerYear: 600_000, badDebtPctOfRevenue: 0.02,
    repairsPctOfRevenue: 0.002, cardProcessingRate: 0.01, cardMixPct: 1,
    workersCompPct: 0.02, offersBenefits: true, monthlyRent: 90_000,
    preOpeningPayrollAndTraining: 3_000_000, preOpeningMarketing: 2_000_000,
    preOpeningPermitsAndLegal: 4_000_000,
  },
  openNotes: ['The IFPE licence is the whole timeline.'],
};
