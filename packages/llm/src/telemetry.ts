/**
 * One record per model call: what answered, what it cost, how long it took.
 *
 * The question this exists to answer is "which model, at which effort, is
 * cheapest for the job it is actually doing" — and that question cannot be
 * answered from a session total. A session total says $0.41 and hides that
 * $0.34 of it was one draft call and the other $0.07 was nineteen turns; it
 * cannot tell you that turns are cheap and drafts are not, which is the entire
 * basis for routing them to different models.
 *
 * What was recorded before this: a per-turn `ms` and `thinkingTokens`, a
 * per-draft `ms`, and one session-level token total with no model attached to
 * it. Advisor calls and adjudications recorded nothing at all. So the journal
 * could not answer "which model produced this run", which makes every quality
 * comparison across a corpus of sessions unattributable — the corpus is the
 * whole point of keeping them.
 *
 * Recorded at the transport, because the transport is the only place that knows
 * all four facts at once: the model it chose, the effort it asked for, the
 * usage that came back, and the wall-clock either side of the call. Anything
 * further up sees a subset and has to guess the rest.
 */

export type CallKind = 'turn' | 'draft' | 'advise' | 'adjudicate';

export interface Rates {
  /** Dollars per million tokens. */
  input: number;
  cachedInput: number;
  output: number;
}

export interface CallRecord {
  /**
   * Which of the four calls this was.
   *
   * Named `call` rather than `kind` because the journal's own discriminant is
   * `kind`, and a record that carried two would lose one of them on the way to
   * disk — silently, and only for this event type.
   */
  call: CallKind;
  provider: string;
  model: string;
  /** The reasoning tier asked for — the dial that moves cost most. */
  effort: string;
  /** Wall clock, which is what the player experiences and the rates do not show. */
  ms: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Part of `outputTokens`, not additional to it. */
  thinkingTokens: number;
  costUsd: number;
  /**
   * False when the model is not in the price list.
   *
   * The tokens and the model id are recorded either way, so a session priced
   * against a stale or missing rate can be repriced later from the journal
   * without replaying anything. That property is worth more than the estimate.
   */
  ratesKnown: boolean;
  /**
   * Which attempt this was, within one logical call. A draft that exhausts its
   * budget and retries is two records — the first one was still billed.
   */
  attempt: number;
  ok: boolean;
  /** The error class, when it failed. Not the message: this is for counting. */
  failure?: string;
}

export type CallSink = (record: CallRecord) => void;

/**
 * Dollars per million tokens, by model — checked August 2026.
 *
 * By model rather than by provider because routing is per call: a session that
 * drafts on one model and answers turns on another has two prices in it, and a
 * provider-level rate would silently average them. This is also the table a
 * routing decision gets made from, so it is the one place a stale number does
 * real damage — the previous version of this lived in `spend.ts` as three
 * environment-variable defaults set to Opus 4.x list rates, which overstated
 * every session by threefold under a comment warning that this was the risk.
 *
 * Matched by prefix, so a dated or pinned id resolves to its family.
 */
export const MODEL_RATES: Record<string, Rates> = {
  // Moonshot / Kimi
  'kimi-k3': { input: 3, cachedInput: 0.3, output: 15 },
  'kimi-k2.6': { input: 0.95, cachedInput: 0.16, output: 4 },
  'kimi-k2.5': { input: 0.6, cachedInput: 0.15, output: 3 },
  // Anthropic
  'claude-opus-5': { input: 5, cachedInput: 0.5, output: 25 },
  'claude-opus-4': { input: 5, cachedInput: 0.5, output: 25 },
  'claude-sonnet-5': { input: 3, cachedInput: 0.3, output: 15 },
  'claude-sonnet-4': { input: 3, cachedInput: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, cachedInput: 0.1, output: 5 },
};

/** The rate for a model, and whether it was actually found. */
export function rateFor(model: string): { rates: Rates; known: boolean } {
  // Longest prefix wins, so `claude-opus-5` is not shadowed by a shorter entry.
  let best: { rates: Rates; length: number } | undefined;
  for (const [prefix, rates] of Object.entries(MODEL_RATES)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { rates, length: prefix.length };
    }
  }
  if (best) return { rates: best.rates, known: true };
  /**
   * An unpriced model is reported at zero and flagged, not guessed at.
   *
   * A guessed rate is a number someone will quote in a pricing conversation
   * without knowing it was invented. A zero with `ratesKnown: false` beside it
   * is visibly missing, and the tokens are on the record either way — so the
   * session can be repriced exactly, later, from the journal.
   */
  return { rates: { input: 0, cachedInput: 0, output: 0 }, known: false };
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function costOf(usage: TokenCounts, rates: Rates): number {
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (fresh * rates.input) / 1_000_000 +
    (usage.cachedInputTokens * rates.cachedInput) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000
  );
}

/** Cost by model id, for a caller that has tokens and a name and nothing else. */
export function costOfModel(usage: TokenCounts, model: string): number {
  return costOf(usage, rateFor(model).rates);
}

export interface CallInput {
  call: CallKind;
  attempt: number;
  provider: string;
  model: string;
  effort: string;
  ms: number;
  usage: TokenCounts & { thinkingTokens: number };
  /** The error class, when the attempt failed. */
  failure?: string;
}

/**
 * Price one attempt and hand it to the sink. Shared by every transport, so a
 * second provider records the same fields in the same units without a second
 * copy of the pricing logic to drift.
 *
 * Never throws. A telemetry bug that ends someone's session is a worse outcome
 * than a missing row, and this runs in a `finally` where a throw would also
 * replace whatever error was already on its way out.
 */
export function emitCall(sink: CallSink | undefined, input: CallInput): void {
  if (!sink) return;
  try {
    const { rates, known } = rateFor(input.model);
    sink({
      call: input.call,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      ms: input.ms,
      ...input.usage,
      costUsd: costOf(input.usage, rates),
      ratesKnown: known,
      attempt: input.attempt,
      ok: input.failure === undefined,
      ...(input.failure ? { failure: input.failure } : {}),
    });
  } catch {
    // Deliberately swallowed — see above.
  }
}

export const ZERO_TOKENS = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
} as const;
