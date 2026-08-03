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
  MalformedDraftError,
  assertDraftShape,
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

/**
 * What a call cost, so the CLI can show the split rather than guess at it.
 *
 * Thinking is billed at the output rate and is much the larger half here — a
 * turn emits fifty words and thinks for twenty seconds — so a usage figure
 * that omits it understates the bill by an order of magnitude. It is carried
 * separately as well as inside `outputTokens` because the interesting question
 * is which of the two dials to turn.
 */
export interface TurnUsage {
  inputTokens: number;
  /** Input served from the cache, billed at a tenth of the read rate. */
  cachedInputTokens: number;
  outputTokens: number;
  /** Part of `outputTokens`, not additional to it. */
  thinkingTokens: number;
}

/** Usage summed across a whole interview. */
export interface UsageTotal extends TurnUsage {
  calls: number;
}

export const EMPTY_USAGE: UsageTotal = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
};

export function addUsage(total: UsageTotal, next: TurnUsage | undefined): UsageTotal {
  if (!next) return total;
  return {
    calls: total.calls + 1,
    inputTokens: total.inputTokens + next.inputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    thinkingTokens: total.thinkingTokens + next.thinkingTokens,
  };
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
  /**
   * Everything this transport has spent, running.
   *
   * On the transport rather than threaded through return types because the
   * draft call, the retry after a garbled turn and the unconstrained fallback
   * all cost real money and none of them are visible to the interview loop.
   * A meter that misses the retries is a meter that lies in exactly the
   * situation where the number matters.
   */
  readonly usage: UsageTotal;
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
  /** Kept for callers that set one budget; it now sizes the draft. */
  maxTokens?: number;
  /** Output budget for a conversational turn. Thinking is billed against it. */
  turnMaxTokens?: number;
  /**
   * Output budget for synthesis, which needs far more than a turn.
   *
   * Thinking counts against `max_tokens`, so this has to cover the reasoning
   * *and* the draft JSON. At high effort the reasoning alone can be four times
   * the size of the object it is producing.
   */
  draftMaxTokens?: number;
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

/**
 * The call hit its output ceiling before it finished.
 *
 * Thinking is billed against `max_tokens`, so this is nearly always a draft
 * that reasoned for most of its budget and then stopped part-way through a
 * JSON object. It ended a live session with the text "Raise maxTokens or lower
 * effort" — advice addressed to whoever wrote this file, printed to a player
 * who has no way to act on it and had just watched three turns of work vanish.
 *
 * Typed so the draft path can do the obvious thing instead: try again with
 * more room and one step less reasoning to fill it with.
 */
/**
 * The model was momentarily unavailable — overloaded, rate-limited, a 5xx.
 *
 * Separated from every other failure because it is the one that says nothing
 * about the conversation: the same message sent again a moment later usually
 * works. A live session ended on `overloaded_error` two turns into a plastics
 * factory, and the player was told to start over, which is the one response
 * that is definitely wrong.
 */
export class TransientError extends Error {
  constructor(
    override readonly cause: unknown,
    /**
     * Which call failed, because the two recover differently.
     *
     * A failed turn leaves nothing behind — the player's message is rolled
     * back and resending it is clean. A failed *draft* happened after a turn
     * that succeeded and is already in the transcript, so resending the
     * player's message would put it there twice and the model would answer a
     * conversation that did not happen. That one retries the draft alone.
     */
    readonly phase: 'turn' | 'draft' = 'turn',
  ) {
    super('The model is busy right now.');
    this.name = 'TransientError';
  }
}

/** Overloaded, rate-limited, or a server fault — none of them the player's doing. */
export function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 429 || status === 529 || status >= 500) return true;
  }
  return /overloaded_error|rate_limit|api_error|\b(429|502|503|529)\b/i.test(String(error));
}

export class BudgetExhaustedError extends Error {
  constructor(
    readonly budget: number,
    readonly thinkingTokens: number,
  ) {
    super(
      `The model used its whole ${budget.toLocaleString()}-token output budget ` +
        `(${thinkingTokens.toLocaleString()} of it thinking) and stopped part-way through.`,
    );
    this.name = 'BudgetExhaustedError';
  }
}

export class AnthropicConceptTransport implements ConceptTransport {
  private readonly client: Anthropic;
  private readonly turnModel: string;
  private readonly draftModel: string;
  private readonly turnMaxTokens: number;
  private readonly draftMaxTokens: number;
  private readonly turnEffort: Effort;
  private readonly draftEffort: Effort;
  /** How often a response came back empty or corrupted. Surfaced, not swallowed. */
  unusableRetries = 0;
  /** Every call this transport has made, including retries and fallbacks. */
  usage: UsageTotal = EMPTY_USAGE;
  /** How often a draft had to be retried with more room. Surfaced, not hidden. */
  budgetRetries = 0;

  constructor(options: AnthropicTransportOptions = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY from the environment,
    // which is where it should live — never in the repo, never in a committed
    // config file.
    /**
     * More retries than the SDK's default of two.
     *
     * A live session died on `overloaded_error` two turns in — a transient
     * capacity signal, retried twice, exhausted, and the whole conversation
     * went with it. Retrying is free when it works and the alternative is
     * asking someone to describe their plastics factory again from the top.
     * The SDK backs off between attempts, so five is seconds of waiting rather
     * than a hammer.
     */
    const retries = Number(process.env['BIZSIM_MAX_RETRIES']);
    const maxRetries = Number.isFinite(retries) && retries >= 0 ? retries : 5;
    this.client = options.apiKey
      ? new Anthropic({ apiKey: options.apiKey, maxRetries })
      : new Anthropic({ maxRetries });
    const model = options.model ?? process.env['BIZSIM_MODEL'] ?? 'claude-opus-5';
    this.turnModel = options.turnModel ?? process.env['BIZSIM_TURN_MODEL'] ?? model;
    this.draftModel = options.draftModel ?? process.env['BIZSIM_DRAFT_MODEL'] ?? model;
    // Two budgets, because they are two different jobs. A single 16,000 for
    // both is what ended a live session three turns in: `thinking` is billed
    // against max_tokens, so a high-effort draft that reasons for 13k tokens
    // has 3k left for a JSON object with seventeen overhead fields in it, and
    // stops mid-object. A conversational turn never needs a tenth of this.
    const budget = (name: string, fallback: number): number => {
      const raw = Number(process.env[name]);
      return Number.isFinite(raw) && raw > 0 ? raw : fallback;
    };
    this.turnMaxTokens = options.turnMaxTokens ?? budget('BIZSIM_TURN_MAX_TOKENS', 8_000);
    this.draftMaxTokens =
      options.draftMaxTokens ?? options.maxTokens ?? budget('BIZSIM_DRAFT_MAX_TOKENS', 32_000);
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
    maxTokens: number,
  ): Promise<{ text: string; reasoning?: string; usage: TurnUsage }> {
    /**
     * Streamed, always.
     *
     * The SDK refuses a non-streaming request whose `max_tokens` implies a
     * generation that could exceed ten minutes:
     *
     *   Streaming is required for operations that may take longer than 10 minutes.
     *
     * Raising the draft budget to 32,000 to stop drafts truncating mid-object
     * walked straight into that ceiling and ended a session on the turn after
     * the player said "yes". The two constraints are in direct tension — a
     * budget large enough to finish the draft is a budget large enough to
     * require streaming — and streaming resolves it rather than trading one
     * failure for the other.
     *
     * `finalMessage()` assembles the same Message the non-streaming call
     * returned, with the same `stop_reason` and `usage`, so nothing below here
     * changes. Nothing is rendered incrementally: the turn is JSON and half a
     * JSON object on screen is worse than a spinner.
     */
    const response = await this.client.messages.stream({
      model,
      max_tokens: maxTokens,
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
    }).finalMessage();

    // Recorded before anything can throw. A call that ran out of budget still
    // generated — and still billed — every token it produced, and a meter that
    // only counts successful calls understates the expensive failures by
    // exactly the amount that makes them worth knowing about.
    const spent: TurnUsage = {
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
    };
    this.usage = addUsage(this.usage, spent);

    // A refusal is a successful HTTP response with an empty content array, so
    // reading the result without checking would surface as a confusing null
    // rather than as what it is.
    if (response.stop_reason === 'refusal') {
      throw new ConceptRefusedError(response.stop_details?.explanation ?? undefined);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new BudgetExhaustedError(maxTokens, spent.thinkingTokens);
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
      usage: spent,
    };
  }

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult> {
    let attempt = await this.complete(system, messages, TURN_SCHEMA, this.turnEffort, this.turnModel, this.turnMaxTokens);
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
      attempt = await this.complete(system, messages, TURN_SCHEMA, this.turnEffort, this.turnModel, this.turnMaxTokens);
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

  /**
   * Effort to fall back to when the budget ran out.
   *
   * Down one step, not to the floor: the draft is the hardest reasoning in the
   * session and the failure was space, not capability. Dropping straight to
   * `low` would answer "you thought too long" with "so stop thinking", which
   * produces a cheap draft that then fails the checks and costs two more calls.
   */
  private static readonly ONE_STEP_DOWN: Record<Effort, Effort> = {
    max: 'xhigh',
    xhigh: 'high',
    high: 'medium',
    medium: 'low',
    low: 'low',
  };

  async draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft> {
    const asked: InterviewMessage[] = [...messages, { role: 'user', content: DRAFT_AS_PROSE }];
    let text: string;
    try {
      text = (await this.complete(system, asked, DRAFT_SCHEMA, this.draftEffort, this.draftModel, this.draftMaxTokens)).text;
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        // Thinking is billed against the output ceiling, so a draft that
        // reasoned for most of its budget has nothing left for the object it
        // was reasoning about. Both halves of that get fixed: more room, and
        // one step less reasoning to fill it with. Three turns of a live
        // session died here rather than taking the obvious second try.
        this.budgetRetries += 1;
        text = (
          await this.complete(
            system,
            asked,
            DRAFT_SCHEMA,
            AnthropicConceptTransport.ONE_STEP_DOWN[this.draftEffort],
            this.draftModel,
            Math.round(this.draftMaxTokens * 1.5),
          )
        ).text;
      } else {
        if (!isGrammarTooLarge(error)) throw error;
        // The draft schema is close to whatever the grammar ceiling is, and
        // where exactly it sits is not something this package can know.
        // Degrading to an unconstrained call keeps the feature working: the
        // schema is still in the prompt and the result is still parsed with
        // Zod, so the guarantee weakens from "cannot be malformed" to "cannot
        // pass unnoticed".
        text = (
          await this.complete(
            `${system}\n\n## Draft schema\n\n${JSON.stringify(DRAFT_SCHEMA)}`,
            asked,
            undefined,
            this.draftEffort,
            this.draftModel,
            this.draftMaxTokens,
          )
        ).text;
      }
    }
    let json: unknown;
    try {
      json = JSON.parse(stripFence(text));
    } catch {
      throw new MalformedDraftError('it was not valid JSON');
    }
    return assertDraftShape(json);
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
  /** Nothing was spent; a scripted run makes no calls. */
  readonly usage: UsageTotal = EMPTY_USAGE;

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
