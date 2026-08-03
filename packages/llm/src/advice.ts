import { z } from 'zod';

/**
 * A model in the turn loop — spec §11.4/§11.5, under §1.1's hard rule.
 *
 * Setup is a conversation and the game is not. A player who spent five turns
 * describing a hotel then asked "I want to add a small indoor waterpark" three
 * times and got the idle-capacity paragraph three times, because the advisor
 * mid-game is arithmetic and arithmetic has nothing to say about a waterpark.
 * The same player asked to buy a second property in Des Moines and was told his
 * occupancy was 57.6%.
 *
 * So: a model that can talk about the world, wired so that it cannot talk about
 * the ledger. Two mechanisms carry that, and neither is a prompt.
 *
 *  1. **It is handed the numbers.** Every figure it is allowed to quote arrives
 *     in the briefing, already computed by the engine. It has no others.
 *  2. **The reply is checked.** Every money amount in the answer is matched back
 *     against the briefing before the player sees it. An unmatched figure is a
 *     fabrication by definition — the model had no source for it — and the turn
 *     is re-asked once, then dropped in favour of the deterministic answer.
 *
 * §1.1 says the LLM never computes a value that appears in a financial
 * statement. `dependency-cruiser` enforces the import direction; this file is
 * what enforces the direction of the *numbers*, which is the part a boundary
 * rule cannot see.
 */

export const zTurnAdvice = z.object({
  /**
   * What to say. Prose, not a report — the screen above it already carries the
   * statements, and the deterministic findings are already printed.
   */
  reply: z.string(),
  /**
   * Commands the player might run, verbatim, in the game's own syntax.
   *
   * Suggested rather than executed, and validated against the parser before
   * they are shown: a suggestion that does not parse is worse than no
   * suggestion, because the player types it and gets an error from the thing
   * that just recommended it.
   */
  suggestedCommands: z.array(z.string()).default([]),
});
export type TurnAdvice = z.infer<typeof zTurnAdvice>;

/**
 * Everything the model may quote, and the state it is quoting about.
 *
 * `text` is what goes into the prompt. `figures` is the same money, normalised,
 * for the guard to check the reply against — one source, two uses, so a figure
 * cannot be in the briefing for the model and absent for the checker.
 */
export interface Briefing {
  text: string;
  /** Every money amount in the briefing, as written. */
  figures: readonly string[];
  /** Commands that exist in this build, for the suggestion list. */
  commands: readonly string[];
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * `$1.1M`, `$47,500`, `$8.2k`, `$0`. Deliberately money only.
 *
 * Bare numbers and percentages are left alone: a model saying "about a third of
 * your revenue" or "roughly 70% occupancy" is reasoning aloud about figures it
 * was given, and flagging that would train the check to be ignored. Money is
 * the class §1.1 is actually about — every value that lands on a statement is
 * denominated — and it is the class a fabrication shows up in.
 */
const MONEY = /\$\s?-?[\d,]+(?:\.\d+)?\s*(?:[kmb]|bn|million|billion|thousand)?/gi;

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

/** Money as a number of dollars, or undefined if it will not parse. */
export function parseMoneyToken(token: string): number | undefined {
  const match = /\$\s?(-?[\d,]+(?:\.\d+)?)\s*([a-z]*)/i.exec(token);
  if (!match) return undefined;
  const base = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return undefined;
  const suffix = (match[2] ?? '').toLowerCase();
  return base * (suffix ? (SCALE[suffix] ?? 1) : 1);
}

/**
 * Money in the reply that the briefing cannot account for.
 *
 * The tolerance is 2%, which covers a model writing "$1.1M" for $1,148,000 —
 * the briefing's own rounding, restated. It is not wide enough to launder an
 * invented figure: a fabricated cost is not within 2% of a real one by
 * accident, and if it is, it is close enough to be harmless.
 *
 * The player's own question counts as a source. "Would a $2M waterpark pay for
 * itself?" has to be answerable without the answer being flagged for repeating
 * the number back. Callers with a running conversation pass the whole exchange
 * as `question` — figures already spoken there trace to a legal origin too.
 */
export function unverifiedFigures(
  reply: string,
  briefing: Briefing,
  question: string,
): string[] {
  const allowed = [...briefing.figures, ...(question.match(MONEY) ?? [])]
    .map(parseMoneyToken)
    .filter((v): v is number => v !== undefined);

  const unverified: string[] = [];
  for (const token of reply.match(MONEY) ?? []) {
    const value = parseMoneyToken(token);
    if (value === undefined) continue;
    // Zero is always sayable: "that costs nothing" is not a claim about the
    // ledger, and `$0` appears in half the briefings anyway.
    if (value === 0) continue;
    const matched = allowed.some(
      (source) => Math.abs(source - value) <= Math.max(Math.abs(source), Math.abs(value)) * 0.02,
    );
    if (!matched) unverified.push(token.trim());
  }
  return [...new Set(unverified)];
}

/** What to send back when a reply quoted money the ledger never produced. */
export const correction = (figures: readonly string[]): string =>
  `Those figures are not in the briefing: ${figures.join(', ')}. You have no source for them, ` +
  `so they cannot go on the screen. Answer again using only the numbers you were given, or ` +
  `without numbers at all — the reasoning is what is wanted, and a sentence with no figure in ` +
  `it is worth more than one with an invented figure in it.`;

// ---------------------------------------------------------------------------
// The system prompt
// ---------------------------------------------------------------------------

export const TURN_ADVISOR_PROMPT = `You are sitting with someone in the middle of running a business in a financial simulator. They have just asked you something. A deterministic engine owns every number; you own everything else.

## The one hard rule

**You never state a money figure that is not in the briefing.** Not an estimate, not a rough order of magnitude, not "probably around $200k". The engine computes what things cost in this world and you do not, and a plausible invented number is worse than no number because the player cannot tell them apart. If you need a figure you were not given, say what it depends on and ask them for it — they are the one looking at the real listing, the real quote, the real market.

The same rule in its general form: you never compute anything that belongs on a financial statement. "What would EBITDA be if I cut the night shift?" is answered by naming the lever and letting them run the quarter, not by doing the arithmetic in your head. The engine will tell them exactly, in ninety seconds, and your estimate would only be something for the real answer to contradict.

Percentages, ratios and counts you were given are yours to reason with. Saying "you are running at about two-thirds of capacity" when the briefing says 68% is restating, not inventing.

## The briefing's cost rates are the model's actual assumptions

Every "Cost rate" line in the briefing is the number the engine really applies, every quarter, verbatim. Never tell the player their own different number is "already baked in" — if they say their margins should run 60-70% and the briefing says the product cost rate is 50% of revenue, then the model disagrees with them, and the honest answer says exactly that and names the fix: the \`assume\` command revises a model assumption, recorded as theirs.

## Think like an operator, not an economist

"We're not making money" is a business problem before it is a pricing problem, and price is one lever on a panel. The build carries most of what a real operator would reach for: price (\`price\`), demand (\`marketing\`, and \`market\` for a new territory), a better product (\`upgrade\`), capacity and staffing (\`expand\`, \`hire\`, \`fire\`), the cost structure and deal terms (\`assume\` — a COGS rate, a landlord or platform share, a cost per unit), and financing (\`debt\`, \`draw\`, \`inject\`). When margins are the complaint, look at the briefing's cost rates before reaching for price: switching suppliers, changing the product mix, or renegotiating a split is often the move an operator makes first, and every one of those is an \`assume\` away.

## New information changes the model

When the player tells you something about their business the model does not carry — "some of our machines sell higher-margin products", "on new sites I'll negotiate a different split" — that is not a debating point, it is a model correction, and recognising it is the most useful thing you do. Name the assumption as the briefing carries it, say what their claim would make it instead — blends and rate arithmetic are yours to do — and give the exact \`assume\` command that records it. A player who has just told you why the model is wrong should leave the exchange holding the command that fixes it.

## The commands in the briefing are the whole game

Suggest only what the briefing lists, and describe each command doing only what its description says. If the player's idea maps to no command, say plainly that it is not modelled in this build, in one sentence, and name the nearest thing that is. Never invent a screen, a quote list, a negotiation flow, or data the game does not have — a confident description of a mechanic that does not exist sends the player to a dead end wearing your authority.

## What you are for

The arithmetic is already on screen, and a deterministic advisor has already printed its findings — you will see them in the briefing. Do not repeat them. You are here for the half that is not arithmetic:

- **Judgement about the world.** Whether a waterpark plausibly lifts a highway hotel. Whether an absentee-owned property has upside an owner-operator could take. What an operator in this trade would actually do next. This is what the player cannot get from the numbers and it is the reason you are in the loop.
- **Turning intent into a move.** "Cut the night shift" is a decision; \`fire front_desk 1\` is how the game hears it. Suggest the commands, do not execute them.
- **Saying when something is not in the game.** A second property in another city is not modelled in this build. Say that plainly and once, then say what is reachable.

## How to answer

Two or three sentences. This is a conversation between decisions, not a report.

When the player proposes something the game can express as a claim — an amenity, a renovation, a new format — the useful reply names the size of the claim they are making and hands them the command: "a waterpark is a bet that people will pay more to stay here; \`upgrade <pct> <cost>\` books it, and the percentage is your estimate of how much more."

When they propose something the game cannot express, say so in one sentence and do not offer a workaround that is really a different decision wearing the same name.

Never flatter a plan. Never say "great idea". If a move looks poor, say why in the same breath as saying how to make it — the decision is theirs and they can see the same numbers you can.`;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface AdviceOutcome {
  reply: string;
  suggestedCommands: string[];
  /** Milliseconds spent, for the same QA line the interview turns carry. */
  ms: number;
  /**
   * Figures the first attempt invented, if any.
   *
   * Kept and surfaced rather than silently corrected. The whole reason the
   * check exists is that nobody can tell a fabricated figure from a real one by
   * reading it, which means nobody can tell how often it happens either — so
   * the count is data, and a rate that climbs is a prompt that has stopped
   * working.
   */
  retriedOn?: string[];
}

export interface AdviceTransport {
  advise(
    system: string,
    messages: readonly { role: 'user' | 'assistant'; content: string }[],
  ): Promise<{ advice: TurnAdvice }>;
}

/**
 * Ask, check, ask once more, then give up in favour of the arithmetic.
 *
 * Giving up is a real outcome and not a failure mode: the deterministic advisor
 * is still on screen and still correct. A model that cannot answer without
 * inventing a number has nothing to add to a screen that already has the
 * numbers on it.
 */
export async function askAdvisor(
  transport: AdviceTransport,
  briefing: Briefing,
  question: string,
  history: readonly { role: 'user' | 'assistant'; content: string }[] = [],
  now: () => number = () => 0,
): Promise<AdviceOutcome | undefined> {
  const started = now();
  const messages = [
    ...history,
    { role: 'user' as const, content: `${briefing.text}\n\nThey asked: ${question}` },
  ];

  /**
   * The conversation is a source, same as the question. Every figure in the
   * history either passed this guard when it was spoken or came from the
   * player, so "as you said, the machines do $150 a day" traces to a legal
   * origin — and a guard that flags the model for quoting the conversation it
   * is in trains everyone to ignore it.
   */
  const sources = [...history.map((m) => m.content), question].join('\n');

  const first = await transport.advise(TURN_ADVISOR_PROMPT, messages);
  const bad = unverifiedFigures(first.advice.reply, briefing, sources);
  if (bad.length === 0) {
    return {
      reply: first.advice.reply,
      suggestedCommands: first.advice.suggestedCommands,
      ms: now() - started,
    };
  }

  const second = await transport.advise(TURN_ADVISOR_PROMPT, [
    ...messages,
    { role: 'assistant' as const, content: first.advice.reply },
    { role: 'user' as const, content: correction(bad) },
  ]);
  if (unverifiedFigures(second.advice.reply, briefing, sources).length > 0) return undefined;

  return {
    reply: second.advice.reply,
    suggestedCommands: second.advice.suggestedCommands,
    ms: now() - started,
    retriedOn: bad,
  };
}
