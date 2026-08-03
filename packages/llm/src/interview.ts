import { zConceptDraft, type ConceptDraft, type DraftParam } from './draft.js';
import { CONCEPT_INTERVIEW_SYSTEM, templateCatalogue } from './prompt.js';
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
}

export type InterviewState =
  | { status: 'ASKING'; message: string; transcript: InterviewMessage[] }
  | { status: 'DRAFTED'; message: string; draft: ConceptDraft; transcript: InterviewMessage[] }
  | { status: 'EXHAUSTED'; message: string; transcript: InterviewMessage[] };

const DEFAULT_MAX_TURNS = 20;

export class ConceptInterview {
  private readonly transport: ConceptTransport;
  private readonly system: string;
  private readonly maxTurns: number;
  private turnsTaken = 0;
  readonly transcript: InterviewMessage[] = [];

  constructor(options: InterviewOptions) {
    this.transport = options.transport;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const templates = options.templates ?? [];
    this.system =
      CONCEPT_INTERVIEW_SYSTEM + (templates.length > 0 ? templateCatalogue(templates) : '');
  }

  /** Feed the player's latest message and get the model's next move. */
  async send(playerMessage: string): Promise<InterviewState> {
    this.transcript.push({ role: 'user', content: playerMessage });

    if (this.turnsTaken >= this.maxTurns) {
      return {
        status: 'EXHAUSTED',
        message:
          `The interview ran to ${this.maxTurns} turns without settling on a model. ` +
          `Starting again with a sharper description of the business usually gets there faster.`,
        transcript: this.transcript,
      };
    }

    const turn = await this.transport.turn(this.system, this.transcript);
    this.turnsTaken += 1;
    this.transcript.push({ role: 'assistant', content: turn.message });

    if (!turn.draft) {
      return { status: 'ASKING', message: turn.message, transcript: this.transcript };
    }

    // Structured output constrains the shape, not the semantics — and the SDK
    // strips bounds it cannot express before generation. Re-parse so the
    // constraints the schema *does* state are actually enforced somewhere.
    const draft = zConceptDraft.parse(turn.draft);
    return { status: 'DRAFTED', message: turn.message, draft, transcript: this.transcript };
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
    for (const p of stream.params) {
      if (p.low > p.high) issues.push(`${where}: parameter '${p.name}' has low above high.`);
    }
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
