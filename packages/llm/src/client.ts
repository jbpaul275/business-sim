import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { looksGarbled } from './garbled.js';

/**
 * A turn that cannot be shown or replayed.
 *
 * Two ways this happens, both seen live. The model returns text that is
 * corrupted — doubled, or two answers interleaved. Or it returns nothing at
 * all: valid JSON, schema-clean, empty strings. The second is the more
 * dangerous, because an empty assistant turn cannot go back into the
 * transcript — the API rejects a whitespace-only content block — so one empty
 * response ends the conversation two turns later with an error about message
 * formatting.
 */
const isUnusable = (turn: { message: string; cta: string }): boolean =>
  turn.message.trim().length === 0 ||
  turn.cta.trim().length === 0 ||
  looksGarbled(turn.message) ||
  looksGarbled(turn.cta);
import {
  zConceptDraft,
  zInterviewTurn,
  type ConceptDraft,
  type InterviewTurn,
} from './draft.js';

/**
 * The seam between the interview and the model.
 *
 * It exists so the interview loop, the prompt and the mapping can be tested
 * without a key and without a network — the parts most likely to break are the
 * deterministic ones, and they should not need an API call to exercise. The
 * scripted transport below is what the tests run against.
 *
 * Two calls rather than one: `turn` for the conversation, `draft` for the
 * synthesis. Structured outputs compile a decoding grammar per request, and a
 * single schema carrying both blew the size limit outright — see `zInterviewTurn`.
 */

export interface InterviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What a call cost, so the CLI can show the split rather than guess at it. */
export interface TurnUsage {
  thinkingTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  turn: InterviewTurn;
  /**
   * The model's reasoning, summarised.
   *
   * Thinking happens and is billed whatever `display` is set to, and the default
   * throws it away. Asking for the summary costs nothing extra and it arrives in
   * the response we are already making — so "why did you say that?" needs no
   * second call, no second turn and no second bill.
   *
   * It is a summary. The raw chain of thought is never returned on any model,
   * so this is the most that can honestly be shown.
   */
  reasoning?: string;
  usage?: TurnUsage;
}

export interface ConceptTransport {
  /** One conversational turn: a question, or a signal that it can now draft. */
  turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult>;
  /** Synthesise the full concept. Called once the interview says it is ready. */
  draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft>;
}

/**
 * The SDK ships a `zodOutputFormat` helper, but it is typed against Zod 4 and
 * the rest of this monorepo is on Zod 3. Splitting Zod versions across packages
 * to gain one helper is a bad trade — schemas cross package boundaries here —
 * so schemas are converted to plain JSON Schema and handed to
 * `output_config.format` directly, then parsed with the same Zod 3 schema every
 * other package already uses.
 */
const jsonSchemaFor = (schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> =>
  // Structured outputs require `additionalProperties: false` on every object
  // and reject `$ref`, so the schema has to be emitted inline.
  zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;

const TURN_SCHEMA = jsonSchemaFor(zInterviewTurn);
const DRAFT_SCHEMA = jsonSchemaFor(zConceptDraft);

/**
 * The draft asked for as prose, for the fallback path. Constrained decoding is
 * the better mechanism when it is available; this is what we send when the
 * grammar will not compile.
 */
const DRAFT_AS_PROSE =
  'Emit the complete concept draft now, as a single JSON object and nothing ' +
  'else — no prose before or after, no markdown fence. It must match the ' +
  'schema you were given exactly, including every required field.';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicTransportOptions {
  apiKey?: string;
  /** Defaults to Claude Opus 5 — the interview is the hardest reasoning here. */
  model?: string;
  /**
   * Model for a conversational turn, when it should differ from the draft.
   *
   * There are two dials, not one, and they are independent: `effort` governs
   * how much thinking happens, this governs what does the thinking. Splitting
   * them makes the obvious cost question — can a smaller model run the
   * interview? — something to measure rather than argue about:
   *
   *   BIZSIM_TURN_MODEL=claude-haiku-4-5-20251001 pnpm sim --new
   *
   * Both default to the same model deliberately. The turn is where the domain
   * judgement lives — that $1M at scrap parity buys a 400-700 berth ferry, that
   * the tenders and not the berths are the real capacity — and that judgement
   * is the product. A turn that asks the wrong question wastes far more of the
   * player's time than it saves in latency.
   */
  turnModel?: string;
  /** Model for synthesis. Splitting one draft across seventeen overhead fields
   * and six archetypes is the hardest single call this makes. */
  draftModel?: string;
  maxTokens?: number;
  /**
   * Effort for a conversational turn. Lower than the draft on purpose: effort
   * is the latency dial, and asking "how many rooms?" does not warrant the same
   * depth as synthesising a whole financial model. One setting for both meant
   * every question cost draft-grade thinking, which is most of why a turn took
   * the better part of a minute.
   *
   * `medium` rather than `low` because the domain judgement is the point — the
   * Capitol view-ring constraint, the slenderness premium — and that comes from
   * thinking, not from length.
   */
  turnEffort?: Effort;
  /** Effort for synthesis, where the reasoning genuinely is hard. */
  draftEffort?: Effort;
}

const envEffort = (name: string, fallback: Effort): Effort => {
  const raw = process.env[name];
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max'
    ? raw
    : fallback;
};

/** True for the "compiled grammar is too large" 400, which has a workaround. */
function isGrammarTooLarge(error: unknown): boolean {
  return (
    error instanceof Anthropic.BadRequestError &&
    /compiled grammar is too large/i.test(error.message)
  );
}

export class AnthropicConceptTransport implements ConceptTransport {
  private readonly client: Anthropic;
  private readonly turnModel: string;
  private readonly draftModel: string;
  private readonly maxTokens: number;
  private readonly turnEffort: Effort;
  private readonly draftEffort: Effort;
  /** How often a response came back empty or corrupted. Surfaced, not swallowed. */
  unusableRetries = 0;

  constructor(options: AnthropicTransportOptions = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY from the environment,
    // which is where it should live — never in the repo, never in a committed
    // config file.
    this.client = options.apiKey
      ? new Anthropic({ apiKey: options.apiKey })
      : new Anthropic();
    const model = options.model ?? process.env['BIZSIM_MODEL'] ?? 'claude-opus-5';
    this.turnModel = options.turnModel ?? process.env['BIZSIM_TURN_MODEL'] ?? model;
    this.draftModel = options.draftModel ?? process.env['BIZSIM_DRAFT_MODEL'] ?? model;
    this.maxTokens = options.maxTokens ?? 16_000;
    // Overridable without a rebuild, so the speed/quality trade can be tuned
    // by whoever is actually waiting on it.
    this.turnEffort = options.turnEffort ?? envEffort('BIZSIM_TURN_EFFORT', 'medium');
    this.draftEffort = options.draftEffort ?? envEffort('BIZSIM_DRAFT_EFFORT', 'high');
  }

  private async complete(
    system: string,
    messages: readonly InterviewMessage[],
    schema: Record<string, unknown> | undefined,
    effort: Effort,
    model: string,
  ): Promise<{ text: string; reasoning?: string; usage: TurnUsage }> {
    const response = await this.client.messages.create({
      model,
      max_tokens: this.maxTokens,
      system,
      // Thinking is on by default on this model and billed either way; the
      // default `display` of "omitted" just discards the summary. Asking for it
      // is free and it is what makes `why` possible without a second call.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        ...(schema ? { format: { type: 'json_schema' as const, schema } } : {}),
        effort,
      },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    // A refusal is a successful HTTP response with an empty content array, so
    // reading the result without checking would surface as a confusing null
    // rather than as what it is.
    if (response.stop_reason === 'refusal') {
      throw new ConceptRefusedError(response.stop_details?.explanation ?? undefined);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        'The model ran out of output budget mid-draft. Raise maxTokens or lower effort.',
      );
    }
    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error(`No text content in response (stop_reason: ${response.stop_reason}).`);
    }
    const reasoning = response.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .filter((t) => t.trim().length > 0)
      .join('\n\n');

    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      usage: {
        thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult> {
    let attempt = await this.complete(system, messages, TURN_SCHEMA, this.turnEffort, this.turnModel);
    // Structured outputs constrain generation against the schema, so this
    // should always hold — but "should" is doing load-bearing work in a
    // sentence about generated JSON.
    let turn = zInterviewTurn.parse(JSON.parse(attempt.text));

    // A response can be schema-valid and still be unusable — corrupted, or
    // simply empty. Nothing here can fix either; declining it and asking again
    // is cheap. The retry usually works: in the live case the model had its
    // question ready in the thinking summary and just failed to emit it.
    if (isUnusable(turn)) {
      this.unusableRetries += 1;
      attempt = await this.complete(system, messages, TURN_SCHEMA, this.turnEffort, this.turnModel);
      turn = zInterviewTurn.parse(JSON.parse(attempt.text));
      if (isUnusable(turn)) {
        throw new UnusableResponseError(turn.message.trim().length === 0 ? 'empty' : 'garbled');
      }
    }

    return {
      turn,
      ...(attempt.reasoning ? { reasoning: attempt.reasoning } : {}),
      usage: attempt.usage,
    };
  }

  async draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft> {
    const asked: InterviewMessage[] = [...messages, { role: 'user', content: DRAFT_AS_PROSE }];
    let text: string;
    try {
      text = (await this.complete(system, asked, DRAFT_SCHEMA, this.draftEffort, this.draftModel)).text;
    } catch (error) {
      if (!isGrammarTooLarge(error)) throw error;
      // The draft schema is close to whatever the grammar ceiling is, and where
      // exactly it sits is not something this package can know. Degrading to an
      // unconstrained call keeps the feature working: the schema is still in
      // the prompt and the result is still parsed with Zod, so the guarantee
      // weakens from "cannot be malformed" to "cannot pass unnoticed".
      text = (
        await this.complete(
          `${system}\n\n## Draft schema\n\n${JSON.stringify(DRAFT_SCHEMA)}`,
          asked,
          undefined,
          this.draftEffort,
          this.draftModel,
        )
      ).text;
    }
    return zConceptDraft.parse(JSON.parse(stripFence(text)));
  }
}

/** Unconstrained generation likes markdown fences; constrained never emits one. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

/**
 * The model's safety classifiers declined. Distinct from a validation failure
 * so the CLI can tell the player what actually happened — and distinct from the
 * interviewer declining a *concept*, which D-5 forbids and which this is not.
 */
export class ConceptRefusedError extends Error {
  constructor(explanation?: string) {
    super(
      explanation
        ? `The model declined this request: ${explanation}`
        : 'The model declined this request.',
    );
    this.name = 'ConceptRefusedError';
  }
}

/**
 * The model returned nothing usable twice running. Named so the CLI can say
 * what happened rather than showing the mess, or blaming the description.
 */
export class UnusableResponseError extends Error {
  constructor(readonly kind: 'empty' | 'garbled') {
    super(
      kind === 'empty'
        ? 'The model returned an empty reply twice in a row. This is a generation ' +
          'fault, not a problem with what you described.'
        : 'The model returned garbled text twice in a row (tokens doubled, or two ' +
          'answers interleaved). This is a generation fault, not a problem with ' +
          'what you described.',
    );
    this.name = 'UnusableResponseError';
  }
}

/**
 * A transport that replays fixed responses. The tests' whole view of the model
 * — which is deliberate: what is worth testing here is the loop, the validation
 * and the mapping into the engine's shape, none of which should depend on a
 * live call.
 */
export class ScriptedTransport implements ConceptTransport {
  private index = 0;
  readonly seen: { system: string; messages: InterviewMessage[] }[] = [];

  constructor(
    private readonly turns: readonly InterviewTurn[],
    private readonly drafts: readonly ConceptDraft[] = [],
    private readonly reasoning: readonly string[] = [],
  ) {}

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult> {
    this.seen.push({ system, messages: [...messages] });
    const next = this.turns[this.index];
    if (!next) {
      throw new Error(
        `ScriptedTransport exhausted after ${this.turns.length} turns — the loop asked for more than the script provides.`,
      );
    }
    const why = this.reasoning[this.index];
    this.index += 1;
    return { turn: next, ...(why ? { reasoning: why } : {}) };
  }

  async draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft> {
    this.seen.push({ system, messages: [...messages] });
    const next = this.drafts[0];
    if (!next) throw new Error('ScriptedTransport has no draft to return.');
    return next;
  }
}
