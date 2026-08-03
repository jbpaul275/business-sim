import type { InterviewMessage } from './client.js';

/**
 * What the model has already told the player, made binding.
 *
 * Live, a vending-machine interview: turn 4 quoted "$75-$150/day in a strong
 * location, $25-$50 in a mediocre one"; two turns later the same conversation
 * called the player's $50 "above the $15-$25/day a typical US machine does".
 * Both ranges are defensible in isolation. Stated three hundred words apart by
 * the same voice, they are a contradiction the player has no way to resolve —
 * and the model produced it because its own earlier figures sit in the
 * transcript as prose, and prose in history is weak. Nothing distinguished "a
 * number I committed to" from "a word I happened to use".
 *
 * Same lesson as the draft schema and the advisor briefing: an instruction to
 * be consistent is a paragraph the model can drift past, but the figures
 * themselves, extracted deterministically and handed back at the top of every
 * call, are hard to contradict *by accident* — the only kind of contradiction
 * this targets.
 *
 * Deliberately NOT a hard guard like the advisor's money check. The advisor
 * lives in a closed world — every legal figure is in the briefing — so an
 * unmatched figure is a fabrication by definition. The interview is the
 * opposite: the model is *supposed* to introduce benchmark figures here, and
 * "$75-150 strong location" versus "$15-25 typical machine" differ by a
 * qualifier no regex can adjudicate. So this extracts and re-presents; whether
 * a new figure squares with an old one stays a judgement call, made by the
 * model with both figures in front of it instead of one.
 */

/** Same money shape the advisor guard matches — `$1.1M`, `$47,500`, `$8.2k`. */
const MONEY = /\$\s?-?[\d,]+(?:\.\d+)?\s*(?:[kmb]|bn|million|billion|thousand)?/gi;

/**
 * The sentences in a reply that state money.
 *
 * The sentence, not the token: "$75-$150" on its own is meaningless without
 * "per day in a strong location", and the qualifier is the part a later turn
 * has to stay consistent with. Splitting is rough — terminal punctuation or a
 * line break — which is fine, because a mis-split sentence is still the
 * model's own words and still carries the figure.
 */
export function moneySentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && (s.match(MONEY) ?? []).length > 0);
}

/**
 * Past this many statements, keep the most recent. Recency is the right end to
 * keep: a figure the model explicitly revised is superseded by the revision,
 * and the revision is always the later sentence. In practice an interview that
 * drafts after two or three questions never gets near the cap — it exists so a
 * long argumentative session cannot grow the prompt without bound.
 */
const MAX_STATED = 12;

export const STATED_FIGURES_HEADER = '## Figures you have already stated';

/**
 * The appendix for the next call's system prompt, or '' when the model has not
 * yet stated a figure.
 *
 * Recomputed from the transcript on every call rather than accumulated: the
 * transcript is the single source of truth, so `undo()` — which pops the
 * exchange — retracts the undone turn's figures with no bookkeeping, and a
 * retry after a failed call cannot double-count.
 */
export function statedFiguresAppendix(transcript: readonly InterviewMessage[]): string {
  const sentences: string[] = [];
  const seen = new Set<string>();
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    for (const sentence of moneySentences(message.content)) {
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sentences.push(sentence);
    }
  }
  if (sentences.length === 0) return '';

  const kept = sentences.slice(-MAX_STATED);
  return (
    `\n\n${STATED_FIGURES_HEADER}\n\n` +
    `Earlier in this conversation you told the player:\n\n` +
    kept.map((s) => `- "${s}"`).join('\n') +
    `\n\nThese are your own words and the player is planning against them. Do not state a ` +
    `figure that contradicts one of them as though the earlier one was never said. If new ` +
    `information genuinely changes a figure, revise it openly — name the old number, give the ` +
    `new one, and say what changed. What you must never do is quote a different range for the ` +
    `same quantity and leave the player to notice.`
  );
}
