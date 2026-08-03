import type { CallKind, CallRecord } from '@bizsim/llm';

/**
 * What a session actually cost, from the calls that made it.
 *
 * This used to price a session-level token total against one rate list, which
 * was fine while every call went to the same model and stopped being fine the
 * moment routing existed: a run that drafts on one model and answers turns on
 * another has two prices in it, and a single rate silently averages them.
 *
 * So the arithmetic moved to where the model id is — `@bizsim/llm/telemetry`
 * prices each call as it happens — and this file adds up what came back. There
 * is one price list in the codebase now, and it is the one the routing decision
 * is made from.
 *
 * Thinking is billed at the output rate and is much the larger half of the
 * bill. A turn emits about fifty words and thinks for twenty seconds; a draft
 * emits a few thousand tokens of JSON and thinks for over a minute. Any
 * accounting that quotes visible output understates the bill by roughly an
 * order of magnitude, which is why `thinkingTokens` is broken out rather than
 * folded silently into the total.
 */

export interface Spend {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number;
  /** Milliseconds of wall clock the player spent waiting on a model. */
  ms: number;
  /** Calls whose model was not in the price list, so `costUsd` is short. */
  unpriced: number;
  /** Cost and count by call type — the split a routing decision needs. */
  byKind: Record<CallKind, { calls: number; costUsd: number; ms: number }>;
  /** Every model that answered, in first-seen order. */
  models: string[];
}

const emptyKind = (): Record<CallKind, { calls: number; costUsd: number; ms: number }> => ({
  turn: { calls: 0, costUsd: 0, ms: 0 },
  draft: { calls: 0, costUsd: 0, ms: 0 },
  advise: { calls: 0, costUsd: 0, ms: 0 },
  adjudicate: { calls: 0, costUsd: 0, ms: 0 },
  // One per quarter played, so over a long run this is the volume leader —
  // which is exactly why it is not folded into `advise`.
  narrate: { calls: 0, costUsd: 0, ms: 0 },
});

export function totalSpend(records: readonly CallRecord[]): Spend {
  const spend: Spend = {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
    ms: 0,
    unpriced: 0,
    byKind: emptyKind(),
    models: [],
  };
  for (const r of records) {
    spend.calls += 1;
    spend.inputTokens += r.inputTokens;
    spend.cachedInputTokens += r.cachedInputTokens;
    spend.outputTokens += r.outputTokens;
    spend.thinkingTokens += r.thinkingTokens;
    spend.costUsd += r.costUsd;
    spend.ms += r.ms;
    if (!r.ratesKnown) spend.unpriced += 1;
    const bucket = spend.byKind[r.call];
    bucket.calls += 1;
    bucket.costUsd += r.costUsd;
    bucket.ms += r.ms;
    if (!spend.models.includes(r.model)) spend.models.push(r.model);
  }
  return spend;
}

const k = (n: number): string => (n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

/**
 * One line, printed once, after the concept is settled.
 *
 * Not a running total per turn: a number that ticks up while someone is
 * deciding what to build changes what they build, and this is a design tool
 * before it is a budget.
 *
 * The model is named because it is the variable under test. A cost figure with
 * no model attached cannot be compared to the next one, and comparing them is
 * the entire reason this is printed.
 */
export function spendLine(records: readonly CallRecord[]): string | undefined {
  const s = totalSpend(records);
  if (s.calls === 0) return undefined;
  const thinking =
    s.outputTokens > 0
      ? ` · ${Math.round((s.thinkingTokens / s.outputTokens) * 100)}% of output was thinking`
      : '';
  // Named honestly rather than dropped: a total missing some of its calls looks
  // exactly like a cheap session, which is the one misreading that matters.
  const missing = s.unpriced > 0 ? ` · ${s.unpriced} call(s) on an unpriced model, not counted` : '';
  return (
    `${s.calls} model calls to ${s.models.join(', ')} · ` +
    `${k(s.inputTokens)} in, ${k(s.outputTokens)} out · about $${s.costUsd.toFixed(2)}` +
    ` · ${(s.ms / 1000).toFixed(0)}s waiting${thinking}${missing}`
  );
}
