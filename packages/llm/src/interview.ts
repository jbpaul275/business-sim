import { assertDraftShape, type ConceptDraft, type DraftParam } from './draft.js';
import { statedFiguresAppendix } from './commitments.js';
import { CONCEPT_INTERVIEW_SYSTEM, templateCatalogue } from './prompt.js';
import { ARCHETYPE_PARAMS, PRICE_KEY } from './toTemplate.js';
import {
  CancelledError,
  isCancellation,
  EMPTY_USAGE,
  TransientError,
  isTransient,
  type ConceptTransport,
  type InterviewMessage,
  type UsageTotal,
} from './client.js';

/**
 * The concept interview — §9.1 Phases 1-2, with the LLM as the input method
 * rather than a picker over twelve templates.
 *
 * The loop is deliberately dumb: it carries the transcript, hands it to the
 * model, and stops when a draft comes back. Everything that decides what the
 * business *is* lives in the prompt; everything that decides whether the model
 * is *usable* lives downstream in `validateBusinessModel`. This file should
 * never grow an opinion about a business.
 */

export interface InterviewOptions {
  transport: ConceptTransport;
  /** Seed templates the model may name. Pass `[]` to force it to synthesise. */
  templates?: readonly { id: string; label: string }[];
  /**
   * Ceiling on model turns. A stuck interview is a bad experience, not a
   * runaway cost, but it is still worth bounding — an interviewer that never
   * commits is a failure mode the player cannot escape from the inside.
   */
  maxTurns?: number;
  /**
   * Fired when the interview stops asking and starts synthesising. The draft
   * is a second call at higher effort and is much the slower of the two, so a
   * caller showing progress should be able to say which is happening.
   */
  onDrafting?: () => void;
}

export type InterviewState =
  | { status: 'ASKING'; message: string; cta: string; transcript: InterviewMessage[] }
  | {
      status: 'DRAFTED';
      message: string;
      cta: string;
      draft: ConceptDraft;
      transcript: InterviewMessage[];
    }
  | { status: 'EXHAUSTED'; message: string; cta: string; transcript: InterviewMessage[] };

/**
 * Words past which a terminal turn stops being a turn and starts being a memo.
 * The prompt asks for roughly fifty; this is the point at which we stop taking
 * its word for it. Not a hard failure — truncating a model's reasoning mid
 * sentence is worse than a long turn — but it is worth surfacing, because a
 * prompt instruction that quietly stops being followed is invisible otherwise.
 */
const VERBOSE_TURN_WORDS = 120;

const wordCount = (text: string): number => text.trim().split(/\s+/).length;

const DEFAULT_MAX_TURNS = 20;

/**
 * Did the player just ask a question rather than answer one?
 *
 * Live: asked how many people per event and at what ticket price, the player
 * said "well to know that I need to know the biggest vessel I can get for $1m"
 * — a perfectly reasonable request for the information needed to answer — and
 * the interview went straight to synthesising the model without a word about
 * the ship. "Two or three questions, then draft" is a budget, and it had
 * quietly become a rule that outranked reading the room.
 *
 * The prompt is where this is really fixed. This is the backstop, and it is
 * deliberately narrow: a question mark, or one of a few phrases that mean "I
 * cannot answer that yet". Vaguer signals like "not sure" are left out, because
 * a guard that fires on "not sure, let's say 450" costs a turn in the flow the
 * player already thinks is too long.
 */
const ASKS_FOR_INFORMATION =
  /\?|\b(i need to know|i don't know|i dont know|no idea|you tell me|tell me|help me understand|would you|should i|what do you (think|reckon|suggest))\b/i;

export const playerAskedSomething = (text: string): boolean => ASKS_FOR_INFORMATION.test(text);

/**
 * Did the model ask permission and then not wait for it?
 *
 * Live, on a lunar tourism base: "Say go and I'll draft the full model —
 * berths, seat-lease costs, ground crew and consumables — for you to argue
 * with." It then drafted, immediately, without the player saying anything.
 *
 * Asking for consent and acting before it arrives is worse than not asking:
 * the player now believes the question was rhetorical, and next time they will
 * not read the cta. Whatever the model intended, the honest reading of its own
 * sentence is that a turn is owed.
 *
 * Also fixed in the prompt, which is where a model should learn not to write
 * this. This exists so the sentence means what it says regardless.
 */
const ASKS_PERMISSION =
  /\b(say go|shall i|want me to|should i|would you like me to|if that (sounds|works)|let me know|ready when you are)\b/i;

export const modelAskedPermission = (cta: string): boolean => ASKS_PERMISSION.test(cta);

export class ConceptInterview {
  private readonly transport: ConceptTransport;
  private readonly system: string;
  private readonly maxTurns: number;
  private turnsTaken = 0;
  /** Turns that blew the length budget. Read by the CLI, not enforced here. */
  verboseTurns = 0;
  /**
   * The model's summarised reasoning for the latest turn, if it returned any.
   *
   * Kept because it is already paid for: thinking is billed whatever `display`
   * is set to, so discarding the summary buys nothing. `why` in the CLI shows
   * this — no second call, no second turn, no second bill.
   */
  lastReasoning: string | undefined;

  /**
   * How hard the last turn worked, in both currencies.
   *
   * Wall-clock and thinking tokens measure different things and the gap
   * between them is the interesting part: seconds are what the player waits
   * and are hostage to load and network, tokens are what was actually spent
   * reasoning and are what `effort` controls. Shown per turn because the
   * failure worth catching is per turn — a minute of thinking on "where is
   * it?", or three seconds on a question about capital structure.
   */
  lastTurn:
    | { ms: number; thinkingTokens: number; outputTokens: number; calls: number }
    | undefined;

  /** The same, for the draft call, which is much the slower of the two. */
  lastDraft: { ms: number; thinkingTokens: number } | undefined;

  readonly transcript: InterviewMessage[] = [];

  /**
   * Everything the interview has spent, read straight off the transport.
   *
   * Deliberately not accumulated here: the transport makes calls this loop
   * never sees — the retry after a garbled turn, the unconstrained fallback
   * when the draft grammar will not compile — and a meter that misses those
   * lies in exactly the case where the number is worth knowing.
   */
  get usage(): UsageTotal {
    return this.transport.usage ?? EMPTY_USAGE;
  }

  private readonly onDrafting: (() => void) | undefined;

  constructor(options: InterviewOptions) {
    this.transport = options.transport;
    this.onDrafting = options.onDrafting;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const templates = options.templates ?? [];
    this.system =
      CONCEPT_INTERVIEW_SYSTEM + (templates.length > 0 ? templateCatalogue(templates) : '');
  }

  /**
   * The system prompt for the next call: the fixed interview prompt plus every
   * money figure the model has already stated in this conversation, extracted
   * from the transcript and handed back as explicit commitments.
   *
   * Rebuilt per call rather than mutated, because the transcript is the source
   * of truth: `undo()` retracts an undone turn's figures automatically, and a
   * failed call that rolled its message back never committed anything.
   */
  private promptNow(): string {
    return this.system + statedFiguresAppendix(this.transcript);
  }

  /**
   * Synthesise from the transcript as it stands, without a new player message.
   *
   * Exists because a draft that fails on an overloaded model is not the same
   * recovery as a turn that does. The turn before it succeeded and is already
   * in the transcript, so resending the player's message would duplicate it —
   * this replays only the half that failed, and costs one call rather than
   * two.
   */
  async retryDraft(): Promise<ConceptDraft> {
    return this.runDraft();
  }

  private async runDraft(): Promise<ConceptDraft> {
    this.onDrafting?.();
    // A second call, with the draft schema this time. Splitting the two is what
    // keeps each request's decoding grammar inside the API's size limit, and it
    // also stops the model juggling seventeen overhead fields while asking
    // where the shop is.
    //
    // `draft()` returns a draft, not a usage record, so the cost is read as a
    // delta on the transport's running total. That also picks up the
    // unconstrained retry when the draft grammar will not compile, which is a
    // second full call at draft effort and the most expensive thing that
    // happens in a session.
    const startedAt = Date.now();
    const before = this.transport.usage?.thinkingTokens ?? 0;
    let draft;
    try {
      draft = assertDraftShape(await this.transport.draft(this.promptNow(), this.transcript));
    } catch (error) {
      throw isTransient(error) ? new TransientError(error, 'draft') : error;
    }
    this.lastDraft = {
      ms: Date.now() - startedAt,
      thinkingTokens: (this.transport.usage?.thinkingTokens ?? 0) - before,
    };
    return draft;
  }

  /**
   * Take back the last exchange.
   *
   * Someone pasted half a sentence from somewhere else — "re Blend it out and
   * a" — and watched the model spend fifty-three seconds producing "One or two
   * sentences that stay onme's mind." The conversation was then carrying a
   * question nobody asked and an answer to it, and every later turn was
   * reasoning against both.
   *
   * Dropping the pair is the whole fix. The transcript is the conversation, so
   * removing the last two entries makes it as if the message was never sent —
   * which is exactly what the player means by "I didn't mean to send that".
   */
  undo(): boolean {
    if (this.transcript.length === 0) return false;
    if (this.transcript[this.transcript.length - 1]?.role === 'assistant') {
      this.transcript.pop();
    }
    if (this.transcript[this.transcript.length - 1]?.role === 'user') {
      this.transcript.pop();
      // The turn is un-taken as well, or a player who fixes three typos runs
      // out of interview for having corrected himself.
      this.turnsTaken = Math.max(0, this.turnsTaken - 1);
      return true;
    }
    return false;
  }

  /** Feed the player's latest message and get the model's next move. */
  async send(playerMessage: string): Promise<InterviewState> {
    // Same invariant on the way in. An empty player line would be rejected by
    // the API just as readily, and blaming the model for it would be wrong.
    const said = playerMessage.trim();
    if (!said) {
      return {
        status: 'ASKING',
        message: '',
        cta: 'Say something about the business and I will pick it up from there.',
        transcript: this.transcript,
      };
    }
    this.transcript.push({ role: 'user', content: said });

    if (this.turnsTaken >= this.maxTurns) {
      return {
        status: 'EXHAUSTED',
        message:
          `The interview ran to ${this.maxTurns} turns without settling on a model. ` +
          `Starting again with a sharper description of the business usually gets there faster.`,
        cta: 'Run `pnpm sim --new` and lead with what the business actually is.',
        transcript: this.transcript,
      };
    }

    // Wall clock is measured here rather than in the CLI so it covers the
    // transport's own retry after a garbled or empty reply — that retry is a
    // second full call and the player waits for both, so timing only the
    // successful one would report half the wait.
    const startedAt = Date.now();
    const callsBefore = this.transport.usage?.calls ?? 0;
    let turn, reasoning, usage;
    try {
      ({ turn, reasoning, usage } = await this.transport.turn(this.promptNow(), this.transcript));
    } catch (error) {
      // Roll the player's message back out of the transcript before rethrowing.
      // It was pushed above so the call could see it; leaving it there means a
      // retry of the same message sends it twice, and the model answers a
      // conversation that did not happen.
      this.transcript.pop();
      // Cancellation unwinds through the same path a transport failure does,
      // which is what makes it safe: the player's message is already back out
      // of the transcript by the time anyone sees the error.
      if (isCancellation(error)) throw new CancelledError();
      throw isTransient(error) ? new TransientError(error) : error;
    }
    this.lastTurn = {
      ms: Date.now() - startedAt,
      thinkingTokens: usage?.thinkingTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      // More than one means the transport threw a reply away and asked again.
      // Without this, a 58-second turn that was really two calls is
      // indistinguishable from one slow call, and they need opposite fixes.
      calls: Math.max(1, (this.transport.usage?.calls ?? 0) - callsBefore),
    };
    this.lastReasoning = reasoning;
    this.turnsTaken += 1;
    // Never let a whitespace-only turn into the transcript. The API rejects a
    // content block with no non-whitespace text, so an empty reply does not
    // fail where it happens — it fails on the *next* call, with an error about
    // message formatting and no trace of the empty turn that caused it. The
    // transport retries these, but the invariant belongs here too: this is the
    // thing that owns the transcript.
    const spoken = [turn.message, turn.cta].map((t) => t.trim()).filter(Boolean).join('\n\n');
    if (spoken) {
      this.transcript.push({ role: 'assistant', content: spoken });
    }

    if (wordCount(turn.message) > VERBOSE_TURN_WORDS) {
      this.verboseTurns += 1;
    }

    // A question gets an answer before it gets a financial model. Costs no
    // extra call: the model's own message is shown, and only the intention to
    // draft is withheld. Saying "go ahead" clears it, because the player is
    // allowed to decide they have heard enough.
    const holdForAnswer =
      turn.readyToDraft && (playerAskedSomething(said) || modelAskedPermission(turn.cta));

    if (!turn.readyToDraft || holdForAnswer) {
      return {
        status: 'ASKING',
        message: turn.message,
        // When the model asked for permission, its own sentence is the right
        // prompt — replacing it would answer a question the player has not
        // seen. Only a player's unanswered question needs a different ask.
        cta:
          holdForAnswer && !modelAskedPermission(turn.cta)
            ? 'Anything else you need from me before I build it? Say `go ahead` when you are ready.'
            : turn.cta,
        transcript: this.transcript,
      };
    }

    const draft = await this.runDraft();
    return {
      status: 'DRAFTED',
      message: turn.message,
      cta: turn.cta,
      draft,
      transcript: this.transcript,
    };
  }
}

// ---------------------------------------------------------------------------
// Draft → engine input
// ---------------------------------------------------------------------------

/**
 * Fold the wire format's parameter array back into the record the engine's
 * synthesis path expects. Duplicate names are a real possibility from a
 * generative source and silently keeping the last one would produce a model
 * that does not match what the player was shown, so it throws.
 */
export function paramsToRecord(
  params: readonly DraftParam[],
): Record<string, { value: number; range: { low: number; high: number }; sourceNote: string; provenance: DraftParam['provenance'] }> {
  const out: ReturnType<typeof paramsToRecord> = {};
  for (const p of params) {
    if (p.name in out) {
      throw new Error(`Duplicate parameter '${p.name}' in draft — cannot resolve which is meant.`);
    }
    out[p.name] = {
      value: p.value,
      range: { low: p.low, high: p.high },
      sourceNote: p.sourceNote,
      provenance: p.provenance,
    };
  }
  return out;
}

/**
 * Structural problems a draft can have that the schema cannot express, checked
 * before the engine ever sees it.
 *
 * Note what is deliberately *not* here: nothing about whether the business is a
 * good idea, whether a price is high, or whether a capture rate is optimistic.
 * Those are the engine's to model and the challenge loop's to interrogate
 * (D-5). This function only catches drafts that are incoherent as *data*.
 */
export function draftIssues(draft: ConceptDraft): string[] {
  const issues: string[] = [];

  const stream = draft.stream;
  const where = `the revenue stream (${stream.label})`;
  if (stream.seasonality.length !== 4) {
    issues.push(`${where}: seasonality needs exactly 4 quarterly weights.`);
  } else {
    // The engine reads these as multipliers around 1.0; weights that average
    // to something else silently rescale the whole year's revenue.
    const mean = stream.seasonality.reduce((a, b) => a + b, 0) / 4;
    if (Math.abs(mean - 1) > 0.02) {
      issues.push(
        `${where}: seasonality averages ${mean.toFixed(2)}, not 1.0 — that rescales annual ` +
          `revenue rather than redistributing it across quarters.`,
      );
    }
  }
  try {
    paramsToRecord(stream.params);
  } catch (error) {
    issues.push(`${where}: ${(error as Error).message}`);
  }

  // The one parameter with no sensible default. Every archetype prices under
  // a different name and none of them are guessable from the domain — an
  // airline's seat fare is `ratePerUnitPerQuarter` — so say which is missing
  // rather than letting it default to zero and fail validation later.
  const priceKey = PRICE_KEY[stream.archetype];
  const price = stream.params.find((p) => p.name === priceKey);
  if (!price) {
    issues.push(
      `${where}: ${stream.archetype} needs a '${priceKey}' parameter — that is the price ` +
        `the engine reads. Known parameters for this archetype: ` +
        `${ARCHETYPE_PARAMS[stream.archetype].join(', ')}.`,
    );
  } else if (price.value <= 0) {
    issues.push(`${where}: '${priceKey}' is ${price.value}; a stream with no price has no revenue.`);
  }
  for (const p of stream.params) {
    if (p.low > p.high) issues.push(`${where}: parameter '${p.name}' has low above high.`);
  }

  /**
   * A floor that is really a launch plan.
   *
   * A cafe drafted four barista blocks with `minimumBlocks: 4` — a claim that
   * three baristas is physically impossible. Demand arrived at half of
   * capacity, the player tried to cut every quarter, and was refused every
   * quarter while 19.5% emergency debt compounded. The player could not see
   * the floor had ever been set, so the business simply became unfixable.
   *
   * One is a real floor. More than one is a claim worth making explicitly.
   */
  /**
   * A ceiling nobody pays for.
   *
   * A phone-game draft came back with `Customer support (part-time)` as a
   * STEP_FIXED line at $0 a block supporting 1,500 subscribers, and the turn
   * screen dutifully reported "522 subscribers · 34.8% of capacity (1,500)" —
   * a wall across a business sold through an app store, where the only thing
   * standing between the player and the next million subscribers was a block
   * they could have hired for nothing.
   *
   * A block that costs nothing is not a constraint, and pretending it is one
   * is worse than omitting it: the player sees a number that looks like market
   * size and plans against it. Two honest readings exist and the model has to
   * pick one — the owner does this job, in which case there is no separate
   * line, or someone is paid to do it, in which case say what they cost.
   */
  for (const line of draft.costLines) {
    if (line.class === 'STEP_FIXED' && line.value <= 0) {
      issues.push(
        `'${line.label}' is a STEP_FIXED block costing ${line.value} a quarter, which puts a ` +
          `ceiling of ${line.capacityPerBlock ?? 0} on the business that costs nothing to lift. ` +
          `Either the owner does this work at small scale — in which case drop the line entirely, ` +
          `since their time is already in owner comp — or somebody is paid for it, in which case ` +
          `give the block its real quarterly cost.`,
      );
    }
    if (line.class === 'STEP_FIXED' && (line.minimumBlocks ?? 0) > 1) {
      issues.push(
        `'${line.label}' has a minimum of ${line.minimumBlocks} blocks, which says the business ` +
          `cannot run with fewer — not that it plans to open with that many. Unless a permit or a ` +
          `safety rule genuinely requires it, set the minimum to 0 or 1 and let opening headcount ` +
          `come from capacityPerBlock; otherwise the player can never cut this line in a downturn.`,
      );
    }
  }

  // §3.8: a UTILIZATION stream's capacity comes from staffed blocks, so it
  // needs a STEP_FIXED labour line or it has no ceiling at all. Caught here
  // rather than at the commit gate, where UTILIZATION_WITHOUT_STAFFING arrives
  // after the whole draft has been built and shown.
  const needsStaffing = stream.archetype === 'UTILIZATION';
  const hasStaffedBlocks = draft.costLines.some(
    (c) => c.class === 'STEP_FIXED' && c.isLabor && (c.capacityPerBlock ?? 0) > 0,
  );
  if (needsStaffing && !hasStaffedBlocks) {
    issues.push(
      'A UTILIZATION business bills hours against staffed capacity, so it needs a STEP_FIXED ' +
        'labour line with isLabor true and a capacityPerBlock — the billable hours one ' +
        'person covers per quarter. Without it the model has no ceiling on what it can sell.',
    );
  }

  for (const [i, line] of draft.costLines.entries()) {
    const where = `costLines[${i}] (${line.label})`;
    // The unit confusion that produced a contractor hiring 200 crews: a rate
    // read as dollars, or dollars read as a rate. A VARIABLE_REVENUE line is a
    // fraction of revenue and cannot exceed 1.
    if (line.class === 'VARIABLE_REVENUE' && (line.value < 0 || line.value > 1)) {
      issues.push(
        `${where}: VARIABLE_REVENUE is a fraction of revenue, so ${line.value} is not a rate. ` +
          `If this is a dollar amount it belongs in FIXED_PERIOD or VARIABLE_ACTIVITY.`,
      );
    }
    if (line.class === 'STEP_FIXED' && (line.capacityPerBlock ?? 0) <= 0) {
      issues.push(
        `${where}: a STEP_FIXED line needs capacityPerBlock — how much volume one block covers.`,
      );
    }
  }

  return issues;
}
