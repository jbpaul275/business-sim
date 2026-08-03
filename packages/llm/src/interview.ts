import { zConceptDraft, type ConceptDraft, type DraftParam } from './draft.js';
import { CONCEPT_INTERVIEW_SYSTEM, templateCatalogue } from './prompt.js';
import { ARCHETYPE_PARAMS, PRICE_KEY } from './toTemplate.js';
import type { ConceptTransport, InterviewMessage } from './client.js';

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
  readonly transcript: InterviewMessage[] = [];

  private readonly onDrafting: (() => void) | undefined;

  constructor(options: InterviewOptions) {
    this.transport = options.transport;
    this.onDrafting = options.onDrafting;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const templates = options.templates ?? [];
    this.system =
      CONCEPT_INTERVIEW_SYSTEM + (templates.length > 0 ? templateCatalogue(templates) : '');
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

    const { turn, reasoning } = await this.transport.turn(this.system, this.transcript);
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

    if (!turn.readyToDraft) {
      return {
        status: 'ASKING',
        message: turn.message,
        cta: turn.cta,
        transcript: this.transcript,
      };
    }

    this.onDrafting?.();
    // A second call, with the draft schema this time. Splitting the two is what
    // keeps each request's decoding grammar inside the API's size limit, and it
    // also stops the model juggling seventeen overhead fields while asking
    // where the shop is.
    const draft = zConceptDraft.parse(await this.transport.draft(this.system, this.transcript));
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

  if (draft.streams.length === 0) {
    issues.push('No revenue stream: the model has nothing to drive revenue from.');
  }

  for (const [i, stream] of draft.streams.entries()) {
    const where = `streams[${i}] (${stream.label})`;
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
  }

  // §3.8: a UTILIZATION stream's capacity comes from staffed blocks, so it
  // needs a STEP_FIXED labour line or it has no ceiling at all. Caught here
  // rather than at the commit gate, where UTILIZATION_WITHOUT_STAFFING arrives
  // after the whole draft has been built and shown.
  const needsStaffing = draft.streams.some((s) => s.archetype === 'UTILIZATION');
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
