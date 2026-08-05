import { z } from 'zod';
import type { DeltaAttribution } from '@bizsim/schemas';
import { correction, unverifiedFigures, type Briefing } from './advice.js';

/**
 * `TurnNarration` — §11.5. Explains what happened; performs no arithmetic.
 *
 * The quarterly screen is engine output: statements, events, deterministic
 * findings. All of it correct, none of it prose — and the play-test note that
 * produced this file was that the feedback is "barely human readable… largely
 * the AI talking to itself." The gap is not information, it is reading: the
 * screen says revenue, EBITDA and four events, and nothing says "the seasonal
 * dip did this, the hire you made last quarter starts paying off next".
 *
 * Same §1.1 machinery as the advisor, because it is the same risk with more
 * exposure: this call runs every quarter rather than on request, so a
 * fabrication rate that would be occasional in Q&A becomes a certainty here.
 * The briefing is everything it may know; every money figure in what it says is
 * checked back against the briefing; a narration that cannot pass the check
 * twice is dropped in favour of silence — the screen above it is already
 * correct, and correct-but-terse beats fluent-but-wrong.
 */

export const zTurnNarration = z.object({
  /**
   * One plain sentence. Not clickbait, not a verdict — the thing that changed.
   * "Revenue held while the new hire ate the margin" is a headline;
   * "A challenging quarter!" is noise.
   */
  headline: z.string(),
  /**
   * Two to four sentences on why the quarter came out the way it did. Causal
   * claims must map to an event or figure in the briefing — §11.5 forbids
   * invented mechanisms as firmly as §1.1 forbids invented numbers.
   */
  narrative: z.string(),
  /**
   * Questions worth asking next, in the player's position. §11.5's
   * `suggestedQuestions` — they feed the advisor, which is already wired to
   * answer them.
   */
  suggestedQuestions: z.array(z.string()).default([]),
});
export type TurnNarration = z.infer<typeof zTurnNarration>;

export interface NarrationTransport {
  /**
   * One quarter, narrated. A single message and no history — a narration that
   * remembers earlier quarters starts writing a story arc, and a story arc is
   * a temptation to make this quarter fit it.
   */
  narrate(system: string, input: string): Promise<TurnNarration>;
}

export const NARRATION_PROMPT = `You are narrating one quarter of a business simulation. A deterministic engine computed everything on the player's screen; your job is the sentence over the top of it — what changed, and why.

## The one hard rule

**You never state a money figure that is not in the briefing.** The engine computes what things cost in this world and you do not. If a figure you want is not there, write around it — "the margin narrowed" needs no dollar amount. This is the same rule in general form: you never compute anything that belongs on a financial statement.

## What §11.5 requires of you

- **Lead with what changed and why.** Compare this quarter to the last one where the briefing shows both. If nothing moved, say that in one sentence — a flat quarter is a finding, not a failure to find something.
- **Every causal claim maps to an event or a figure you were given.** The briefing lists this quarter's events. "The revolver draw is why cash held" is legal if the draw is listed; "customers loved the new menu" is an invented mechanism and is not.
- **The "Why … moved" lines are the engine's own attribution (§10.4)** — each significant move already decomposed into its drivers, with the assumption's provenance tag. When you explain a move, explain THOSE mechanisms. Naming a driver the attribution does not list is inventing one.
- **Do not restate the numbers — explain them.** The statements are already on screen, and the deterministic findings are marked in the briefing as already shown. Repeating either wastes the only thing you add.
- **Direct and unsentimental.** Not a cheerleader, not a doomsayer. No "great quarter!", no dread. The player is making decisions with real attention and deserves a straight read.

## Open on the player's bet

When the input lists what the player did this quarter, the first thing you resolve is that bet: what they changed, and what happened to the thing they changed it about. "You bet a second crew would clear the turned-away demand; it did, and the extra volume covered the payroll" is the shape — the decision, then the verdict, in the same breath. The verdict comes from the events and attribution lines like every other claim, and it is a read on the outcome, not a judgement of the decision. When the input lists no moves, there is no bet — narrate the quarter as it is and do not invent one.

## Shape

A one-sentence headline: the thing that changed, plainly. Two to four sentences of narrative. Up to two suggested questions the player might ask next — questions about judgement, not arithmetic the engine already printed.`;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface NarrationOutcome {
  narration: TurnNarration;
  ms: number;
  /** Figures the first attempt invented — kept as data, same as the advisor. */
  retriedOn?: string[];
  /**
   * §11.5's `attributions`, attached verbatim from the engine rather than
   * emitted by the model. The spec puts the field on the narration output;
   * this build computes it in `attributeQuarter` (§10.4) and passes it
   * through, because a model asked to produce assumption IDs and provenance
   * tags would be invited to invent exactly the mechanisms §11.5 forbids.
   * The model sees the same attributions as briefing lines and may explain
   * them; it may not mint them.
   */
  attributions?: readonly DeltaAttribution[];
}

/**
 * Narrate, check, narrate once more, then stay silent.
 *
 * Silence is a real outcome. The screen above is complete and correct without
 * this; a narration that needs two chances and still invents a figure has
 * nothing to add to it. Same contract as `askAdvisor`, for the same reason —
 * nobody can tell a fabricated figure from a real one by reading it.
 */
/**
 * What the player staged for the quarter being narrated, plus the question
 * they were answering when they staged it. This is what turns the narration
 * from a weather report into a verdict: each quarter is a bet the player
 * placed on purpose, and the paragraph over the results should open by
 * resolving it. Dave the Diver's loop, in financial form — each half of the
 * game is bait for the other.
 */
export interface NarrationBet {
  /** The eigen question that was on the table, verbatim. */
  question?: string | undefined;
  /** The moves they staged, player-readable ("price to $6.50"). */
  moves: readonly string[];
}

export async function narrateQuarter(
  transport: NarrationTransport,
  briefing: Briefing,
  now: () => number = () => 0,
  attributions?: readonly DeltaAttribution[],
  bet?: NarrationBet,
): Promise<NarrationOutcome | undefined> {
  const started = now();
  const betText =
    bet && bet.moves.length > 0
      ? `\n\nThe player's bet this quarter${
          bet.question ? ` — the question on the table was: "${bet.question}"` : ''
        }. What they did:\n${bet.moves.map((m) => `- ${m}`).join('\n')}`
      : '';
  const input = `${briefing.text}${betText}\n\nNarrate the quarter that just ended.`;
  // The bet is a legal source for the guard, same as a player's question in
  // chat: "your move to $6.50" restates the player's own number, and flagging
  // the narration for quoting the bet it was asked to resolve would train
  // everyone to ignore the guard.
  const sources = bet ? [bet.question ?? '', ...bet.moves].join('\n') : '';
  const attach: Pick<NarrationOutcome, 'attributions'> =
    attributions && attributions.length > 0 ? { attributions } : {};

  const first = await transport.narrate(NARRATION_PROMPT, input);
  const bad = unverifiedFigures(spoken(first), briefing, sources);
  if (bad.length === 0) return { narration: first, ms: now() - started, ...attach };

  const second = await transport.narrate(
    NARRATION_PROMPT,
    `${input}\n\nYour previous attempt said:\n${spoken(first)}\n\n${correction(bad)}`,
  );
  if (unverifiedFigures(spoken(second), briefing, sources).length > 0) return undefined;

  return { narration: second, ms: now() - started, retriedOn: bad, ...attach };
}

/** Everything the player would see, as one string for the guard to sweep. */
const spoken = (n: TurnNarration): string =>
  [n.headline, n.narrative, ...n.suggestedQuestions].join('\n');
