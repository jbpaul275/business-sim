import { describe, expect, it } from 'vitest';
import { AnthropicConceptTransport, BudgetExhaustedError } from './client.js';

/**
 * A live session died three turns in with:
 *
 *   The interview could not continue: The model ran out of output budget
 *   mid-draft. Raise maxTokens or lower effort.
 *
 * Two faults in one line. The advice is addressed to whoever wrote the client,
 * not to the player reading it — and the situation it describes is one the
 * client can simply fix by trying again with more room.
 *
 * The cause is that thinking is billed against `max_tokens`. One budget of
 * 16,000 covered both a conversational turn, which needs a fraction of it, and
 * a high-effort draft, whose reasoning alone can be several times the size of
 * the JSON object it is reasoning about.
 */

const env = { ...process.env };

describe('running out of output budget', () => {
  it('sizes the draft far above a turn, because they are different jobs', () => {
    const t = new AnthropicConceptTransport({ apiKey: 'test' }) as unknown as {
      turnMaxTokens: number;
      draftMaxTokens: number;
    };
    expect(t.draftMaxTokens).toBeGreaterThan(t.turnMaxTokens * 3);
    // And enough that a draft's reasoning and its JSON both fit.
    expect(t.draftMaxTokens).toBeGreaterThanOrEqual(32_000);
  });

  it('takes both budgets from the environment', () => {
    process.env['BIZSIM_TURN_MAX_TOKENS'] = '2000';
    process.env['BIZSIM_DRAFT_MAX_TOKENS'] = '50000';
    try {
      const t = new AnthropicConceptTransport({ apiKey: 'test' }) as unknown as {
        turnMaxTokens: number;
        draftMaxTokens: number;
      };
      expect(t.turnMaxTokens).toBe(2_000);
      expect(t.draftMaxTokens).toBe(50_000);
    } finally {
      process.env = { ...env };
    }
  });

  it('lets a single maxTokens size the draft, for callers that set one', () => {
    const t = new AnthropicConceptTransport({ apiKey: 'test', maxTokens: 20_000 }) as unknown as {
      draftMaxTokens: number;
    };
    expect(t.draftMaxTokens).toBe(20_000);
  });

  it('says what was spent and on what, in a sentence a person can read', () => {
    const error = new BudgetExhaustedError(16_000, 13_400);
    expect(error.message).toContain('16,000');
    expect(error.message).toContain('13,400');
    // Not "raise maxTokens" — that is a note to the author, not the player.
    expect(error.message).not.toMatch(/maxTokens|effort/);
  });

  it('retries with more room and less reasoning, instead of ending the session', async () => {
    // The claim that matters. Stubbed at the SDK seam so the retry is
    // observable: what was asked for the second time is the whole point.
    const calls: { max_tokens: number; effort: string }[] = [];
    const transport = new AnthropicConceptTransport({ apiKey: 'test', draftEffort: 'high' });
    (transport as unknown as { client: unknown }).client = {
      messages: {
        create: async (req: { max_tokens: number; output_config: { effort: string } }) => {
          calls.push({ max_tokens: req.max_tokens, effort: req.output_config.effort });
          const usage = { input_tokens: 7_000, output_tokens: req.max_tokens };
          if (calls.length === 1) {
            return { stop_reason: 'max_tokens', content: [], usage };
          }
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(MINIMAL_DRAFT) }],
            usage: { ...usage, output_tokens: 3_000 },
          };
        },
      },
    };

    await transport.draft('system', [{ role: 'user', content: 'A hemp brand, DTC and wholesale.' }]);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.max_tokens).toBeGreaterThan(calls[0]!.max_tokens);
    expect(calls[0]!.effort).toBe('high');
    expect(calls[1]!.effort).toBe('medium');
    expect(transport.budgetRetries).toBe(1);
    // And the truncated call is still counted: it generated every token it was
    // billed for, and a meter that skips the expensive failures is useless.
    expect(transport.usage.calls).toBe(2);
    expect(transport.usage.outputTokens).toBeGreaterThan(30_000);
  });

  it('steps effort down by one rather than to the floor', () => {
    // The draft is the hardest reasoning in the session and the failure was
    // space, not capability. Dropping to `low` answers "you thought too long"
    // with "so stop thinking", and produces a cheap draft that fails the
    // checks and costs two more calls.
    const map = (AnthropicConceptTransport as unknown as {
      ONE_STEP_DOWN: Record<string, string>;
    }).ONE_STEP_DOWN;
    expect(map['high']).toBe('medium');
    expect(map['max']).toBe('xhigh');
    expect(map['low']).toBe('low');
  });
});

/** The smallest thing `zConceptDraft` accepts, so the retry has something to return. */
const MINIMAL_DRAFT = {
  businessName: 'Hemp brand',
  summary: 'DTC and wholesale.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  streams: [
    {
      label: 'Direct sales',
      archetype: 'UNITS_CAC',
      archetypeRationale: 'Units sold, each acquired at a cost.',
      params: [
        { name: 'avgOrderValue', value: 60, low: 45, high: 80, sourceNote: 'Basket.', provenance: 'LLM_ESTIMATE' },
      ],
      seasonality: [1, 1, 1, 1],
      marketingSpendPerQuarter: 40_000,
      expectedAnnualRevenue: 2_000_000,
    },
  ],
  costLines: [
    {
      label: 'Product cost',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.34,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Distillate, hardware, packaging.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  capex: [
    { label: 'Fill line', category: 'EQUIPMENT', grossCost: 180_000, usefulLifeYears: 7, quantity: 1, sourceNote: 'Quoted.' },
  ],
  workingCapital: {
    dsoDays: 21, dioDays: 45, dpoDays: 30,
    prepaidInsuranceMonths: 6, securityDepositMonths: 2, customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 90_000, utilitiesPerQuarter: 6_000,
    generalLiabilityInsurancePerYear: 24_000, propertyInsurancePerYear: 6_000,
    accountingAndLegalPerYear: 40_000, softwareAndPosPerYear: 18_000,
    permitsAndLicensesPerYear: 12_000, badDebtPctOfRevenue: 0.01,
    repairsPctOfRevenue: 0.01, cardProcessingRate: 0.045, cardMixPct: 0.95,
    workersCompPct: 0.03, offersBenefits: false, monthlyRent: 9_000,
    preOpeningPayrollAndTraining: 40_000, preOpeningMarketing: 60_000,
    preOpeningPermitsAndLegal: 45_000,
  },
  openNotes: ['Payment processing is the go/no-go item.'],
};
