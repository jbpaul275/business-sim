import { afterEach, describe, expect, it } from 'vitest';
import type { UsageTotal } from '@bizsim/llm';
import { costOf, rates, spendLine } from './spend.js';

/**
 * The question that produced this file was "roughly how much is each of these
 * ideation sessions costing?", and the honest answer at the time was that
 * nothing measured it. What is tested here is that the meter counts the term
 * that dominates — thinking, billed at the output rate — and that the rates it
 * multiplies by can be corrected without a rebuild.
 */

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

/** Roughly one observed session: five turns and a draft. */
const session: UsageTotal = {
  calls: 6,
  inputTokens: 38_000,
  cachedInputTokens: 0,
  outputTokens: 21_000,
  thinkingTokens: 17_000,
};

describe('what a session cost', () => {
  it('bills thinking at the output rate, because that is where the money is', () => {
    // 17k of the 21k output tokens are thinking. Comparing the output halves
    // rather than the totals, because input is a constant floor under both and
    // would flatter a meter that got this wrong.
    const inputOnly = costOf({ ...session, outputTokens: 0 });
    const visible = costOf({ ...session, outputTokens: 4_000 }) - inputOnly;
    const withThinking = costOf(session) - inputOnly;
    expect(withThinking).toBeCloseTo(visible * (21 / 4), 6);
    // And it really is the larger half of the bill.
    expect(withThinking).toBeGreaterThan(inputOnly * 2);
  });

  it('counts cached input at the cache rate', () => {
    // The ~5,100-token system prompt goes out on every call, so whether it is
    // cached is most of the difference between the input halves of two
    // otherwise identical sessions.
    const cold = costOf(session);
    const warm = costOf({ ...session, cachedInputTokens: 30_000 });
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeGreaterThan(0);
  });

  it('takes its rates from the environment, so a stale price can be corrected', () => {
    // A price baked into a binary goes stale silently and then quotes a
    // confident wrong number for a year.
    process.env['BIZSIM_PRICE_INPUT'] = '3';
    process.env['BIZSIM_PRICE_OUTPUT'] = '15';
    expect(rates()).toMatchObject({ input: 3, output: 15 });
    expect(costOf(session)).toBeCloseTo((38_000 * 3 + 21_000 * 15) / 1_000_000, 6);
  });

  it('ignores a rate that is not a positive number', () => {
    for (const bad of ['', 'free', '-4', '0', 'NaN']) {
      process.env['BIZSIM_PRICE_OUTPUT'] = bad;
      expect(rates('kimi').output, bad).toBe(15);
    }
  });

  it('defaults to the resolved provider rather than one hardcoded price list', () => {
    // The defaults were $15/$1.50/$75 — Opus 4.x rates — which overstated an
    // Opus 5 session threefold under a comment warning that this was the risk.
    // Following the provider is what stops that recurring after a switch.
    delete process.env['BIZSIM_PRICE_INPUT'];
    delete process.env['BIZSIM_PRICE_CACHED_INPUT'];
    delete process.env['BIZSIM_PRICE_OUTPUT'];
    expect(rates('kimi')).toEqual({ input: 3, cachedInput: 0.3, output: 15 });
    expect(rates('anthropic')).toEqual({ input: 5, cachedInput: 0.5, output: 25 });
  });

  it('reports the split rather than one opaque figure', () => {
    const line = spendLine(session)!;
    expect(line).toContain('6 model calls');
    expect(line).toContain('38.0k in');
    expect(line).toContain('21.0k out');
    expect(line).toMatch(/\$\d+\.\d\d/);
    // The share that was thinking is the actionable half: it is the number
    // that says whether `effort` or the prompt is the dial to turn.
    expect(line).toContain('81% of output was thinking');
  });

  it('says nothing when no call was made', () => {
    // A scripted run, or a template-picker session with no model at all.
    expect(
      spendLine({
        calls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      }),
    ).toBeUndefined();
  });
});
