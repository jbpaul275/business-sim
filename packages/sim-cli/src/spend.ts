import type { UsageTotal } from '@bizsim/llm';

/**
 * What a session actually cost.
 *
 * The question "roughly how much is each of these ideation sessions costing?"
 * had no answer here: the transport captured usage and nothing read it, so the
 * only available reply was arithmetic on an estimate of thinking tokens, which
 * are the largest and least predictable term. Measuring is cheap — the numbers
 * arrive in every response already — and an estimate of the dominant term is
 * not a number, it is a hope.
 *
 * Thinking is billed at the output rate and is much the larger half of the
 * bill. A turn emits about fifty words and thinks for twenty seconds; a draft
 * emits a few thousand tokens of JSON and thinks for over a minute. Any
 * accounting that quotes visible output understates the bill by roughly an
 * order of magnitude, which is why `thinkingTokens` is broken out rather than
 * folded silently into the total.
 */

/**
 * Dollars per million tokens.
 *
 * These are set from the environment rather than hardcoded, because a price
 * baked into a binary is a price that goes stale silently and then quotes a
 * confident wrong number for a year. The defaults are Opus-class list rates
 * and are the least trustworthy thing in this file — check them against
 * current pricing before quoting the output of this meter to anyone.
 */
const rate = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export interface Rates {
  input: number;
  cachedInput: number;
  output: number;
}

export const rates = (): Rates => ({
  input: rate('BIZSIM_PRICE_INPUT', 15),
  // Cache reads bill at a tenth of the input rate. The system prompt is ~5,100
  // tokens and goes out on every call, so whether it is cached is most of the
  // difference between the input halves of two otherwise identical sessions.
  cachedInput: rate('BIZSIM_PRICE_CACHED_INPUT', 1.5),
  output: rate('BIZSIM_PRICE_OUTPUT', 75),
});

export function costOf(usage: UsageTotal, r: Rates = rates()): number {
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (fresh * r.input) / 1_000_000 +
    (usage.cachedInputTokens * r.cachedInput) / 1_000_000 +
    (usage.outputTokens * r.output) / 1_000_000
  );
}

const k = (n: number): string => (n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

/**
 * One line, printed once, after the concept is settled.
 *
 * Not a running total per turn: a number that ticks up while someone is
 * deciding what to build changes what they build, and this is a design tool
 * before it is a budget.
 */
export function spendLine(usage: UsageTotal): string | undefined {
  if (usage.calls === 0) return undefined;
  const dollars = costOf(usage);
  const thinking = usage.outputTokens > 0
    ? ` · ${Math.round((usage.thinkingTokens / usage.outputTokens) * 100)}% of output was thinking`
    : '';
  return (
    `${usage.calls} model calls · ${k(usage.inputTokens)} in, ${k(usage.outputTokens)} out` +
    ` · about $${dollars.toFixed(2)}${thinking}`
  );
}
