import { describe, expect, it } from 'vitest';
import { costOf, rateFor, type CallRecord } from '@bizsim/llm';
import { spendLine, totalSpend } from './spend.js';

/**
 * The question that produced this file was "roughly how much is each of these
 * ideation sessions costing?", and the honest answer at the time was that
 * nothing measured it. The question that produced this version is "which model
 * is cheapest for the job", and a session total cannot answer it — so what is
 * tested here is that the split survives: per call type, per model, including
 * the attempts that failed.
 */

const call = (over: Partial<CallRecord> = {}): CallRecord => {
  const base = {
    call: 'turn' as const,
    provider: 'kimi',
    model: 'kimi-k3',
    effort: 'low',
    ms: 4_000,
    inputTokens: 6_000,
    cachedInputTokens: 5_000,
    outputTokens: 1_200,
    thinkingTokens: 950,
    attempt: 1,
    ok: true,
    ...over,
  };
  const { rates, known } = rateFor(base.model);
  return { ...base, costUsd: costOf(base, rates), ratesKnown: known };
};

/** Roughly one observed session: five turns and a draft. */
const session: CallRecord[] = [
  call(),
  call(),
  call(),
  call(),
  call(),
  call({ call: 'draft', effort: 'high', ms: 74_000, outputTokens: 18_000, thinkingTokens: 14_000 }),
];

describe('what a session cost', () => {
  it('bills thinking at the output rate, because that is where the money is', () => {
    const inputOnly = totalSpend([call({ outputTokens: 0, thinkingTokens: 0 })]).costUsd;
    const visible = totalSpend([call({ outputTokens: 250, thinkingTokens: 0 })]).costUsd - inputOnly;
    const withThinking = totalSpend([call()]).costUsd - inputOnly;
    // 1,200 output tokens against 250, so the output half is 4.8× the size.
    expect(withThinking).toBeCloseTo(visible * (1_200 / 250), 6);
  });

  it('counts cached input at the cache rate', () => {
    // The ~5,100-token system prompt goes out on every call, so whether it is
    // cached is most of the difference between the input halves of two
    // otherwise identical sessions.
    const cold = totalSpend([call({ cachedInputTokens: 0 })]).costUsd;
    const warm = totalSpend([call({ cachedInputTokens: 5_000 })]).costUsd;
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeGreaterThan(0);
  });

  it('prices each call by its own model rather than averaging the session', () => {
    /**
     * The reason this moved off a session total. A run that answers turns on a
     * cheap model and drafts on an expensive one has two prices in it, and one
     * blended rate makes both of them wrong — in the direction that hides
     * whether the routing was worth doing.
     */
    const mixed = totalSpend([
      call({ model: 'kimi-k2.6' }),
      call({ call: 'draft', model: 'claude-opus-5', provider: 'anthropic' }),
    ]);
    const cheapOnly = totalSpend([call({ model: 'kimi-k2.6' })]).costUsd;
    const dearOnly = totalSpend([
      call({ call: 'draft', model: 'claude-opus-5', provider: 'anthropic' }),
    ]).costUsd;
    expect(mixed.costUsd).toBeCloseTo(cheapOnly + dearOnly, 10);
    expect(dearOnly).toBeGreaterThan(cheapOnly * 5);
    expect(mixed.models).toEqual(['kimi-k2.6', 'claude-opus-5']);
  });

  it('splits by call type, which is what a routing decision needs', () => {
    const s = totalSpend(session);
    expect(s.byKind.turn.calls).toBe(5);
    expect(s.byKind.draft.calls).toBe(1);
    // The shape the whole argument rests on: one draft outweighs five turns.
    expect(s.byKind.draft.costUsd).toBeGreaterThan(s.byKind.turn.costUsd);
    expect(s.byKind.adjudicate.calls).toBe(0);
  });

  it('gives narration its own bucket rather than lumping it into Q&A', () => {
    // One per quarter played makes it the volume leader in a long run, and a
    // routing decision about it needs its cost separated from the advisor's.
    const s = totalSpend([call({ call: 'narrate', ms: 3_000 }), call({ call: 'advise' })]);
    expect(s.byKind.narrate.calls).toBe(1);
    expect(s.byKind.advise.calls).toBe(1);
    expect(s.byKind.narrate.ms).toBe(3_000);
  });

  it('keeps the wall clock, which the rates do not show', () => {
    // Latency is the half of a routing decision that a price list cannot price.
    // A model that is half the cost and four times the wait is not cheaper.
    expect(totalSpend(session).ms).toBe(5 * 4_000 + 74_000);
  });

  it('counts a failed attempt, because it was still billed', () => {
    const truncated = call({ call: 'draft', ok: false, failure: 'BudgetExhaustedError' });
    const s = totalSpend([truncated, call({ call: 'draft' })]);
    expect(s.calls).toBe(2);
    expect(s.costUsd).toBeGreaterThan(totalSpend([call({ call: 'draft' })]).costUsd);
  });

  it('flags an unpriced model instead of reporting it as free', () => {
    // A guessed rate is a number someone quotes in a pricing conversation
    // without knowing it was invented. Zero and visibly missing is safer, and
    // the tokens are on the record either way so it can be repriced later.
    const s = totalSpend([call({ model: 'some-new-model-v9' })]);
    expect(s.unpriced).toBe(1);
    expect(s.costUsd).toBe(0);
    expect(spendLine([call({ model: 'some-new-model-v9' })])).toContain('unpriced model');
  });

  it('names the models, because a cost with no model cannot be compared', () => {
    const line = spendLine(session)!;
    expect(line).toContain('6 model calls');
    expect(line).toContain('kimi-k3');
    expect(line).toMatch(/\$\d+\.\d\d/);
    expect(line).toContain('s waiting');
    // The share that was thinking is the actionable half: it is the number
    // that says whether `effort` or the prompt is the dial to turn.
    expect(line).toMatch(/\d+% of output was thinking/);
  });

  it('says nothing when no call was made', () => {
    // A scripted run, or a template-picker session with no model at all.
    expect(spendLine([])).toBeUndefined();
  });
});
