import OpenAI from 'openai';
import { zTurnAdvice } from './advice.js';
import { zAdjudication, type Adjudication } from './challenge.js';
import {
  BudgetExhaustedError,
  CancelledError,
  ConceptRefusedError,
  EMPTY_USAGE,
  UnusableResponseError,
  addUsage,
  type AdviceResult,
  type ConceptTransport,
  type Effort,
  type InterviewMessage,
  type TurnResult,
  type TurnUsage,
  type UsageTotal,
} from './client.js';
import { ZERO_TOKENS, emitCall, type CallKind, type CallSink } from './telemetry.js';
import {
  MalformedDraftError,
  assertDraftShape,
  zInterviewTurn,
  type ConceptDraft,
} from './draft.js';
import {
  ADJUDICATION_SCHEMA,
  ADVICE_SCHEMA,
  DRAFT_AS_PROSE,
  DRAFT_SCHEMA,
  TURN_SCHEMA,
  isUnusable,
  stripFence,
} from './wire.js';

/**
 * The same four calls, against anything that speaks the OpenAI wire format.
 *
 * Built for Kimi and then generalised, because generalising it cost three
 * constants. Moonshot, DeepSeek, Groq, Together, Fireworks, OpenRouter and
 * Google's compatibility endpoint all accept the same request; what differs
 * between them is a base URL, the name of an environment variable and a default
 * model. Those are data, and they live in `VENDORS` below.
 *
 * That matters because model cost is the binding constraint on what this can be
 * sold for, and the cheapest model that can do a job is not a thing anyone can
 * reason their way to — it has to be measured, one vendor at a time, against
 * the same session. A transport per vendor would have made that a week of work
 * each and it would never have happened.
 *
 * The differences from the Anthropic transport are real but few, and each is
 * commented where it bites:
 *
 *   - structured outputs arrive as `response_format.json_schema` rather than
 *     `output_config.format`, and only some models enforce the schema (§4.1);
 *   - reasoning is a top-level `reasoning_effort` and comes back as
 *     `reasoning_content` deltas rather than typed thinking blocks;
 *   - a refusal is `finish_reason: 'content_filter'`, not a `stop_reason`;
 *   - prompt caching is automatic on most of them, with nothing to declare.
 */

export interface VendorSpec {
  /** Where the OpenAI-compatible endpoint lives. */
  baseURL: string;
  /** The environment variable holding the key. Never a config file. */
  apiKeyVar: string;
  /**
   * The model used when nothing else says. Empty where naming one would be a
   * guess — a vendor whose catalogue turns over monthly gets no default rather
   * than a stale id that 404s on a Tuesday.
   */
  defaultModel: string;
  /**
   * Whether this vendor takes `reasoning_effort`.
   *
   * Sending it where it is not understood is a 400, and omitting it where it is
   * understood can silently select the dearest tier — K3 defaults to `max`. So
   * it is stated per vendor rather than assumed either way.
   */
  reasoningEffort: boolean;
}

/**
 * The vendors this can talk to. Data, not code — adding one is a row.
 *
 * Base URLs only. Deliberately no rate figures here: those live in
 * `telemetry.ts` keyed by model, because the price is a property of the model
 * and not of the endpoint it happens to be served from — the same Kimi weights
 * cost different amounts through Moonshot and through OpenRouter.
 */
export const VENDORS: Record<string, VendorSpec> = {
  kimi: {
    baseURL: 'https://api.moonshot.ai/v1',
    apiKeyVar: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
    reasoningEffort: true,
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyVar: 'DEEPSEEK_API_KEY',
    defaultModel: '',
    reasoningEffort: true,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyVar: 'OPENROUTER_API_KEY',
    defaultModel: '',
    reasoningEffort: true,
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyVar: 'GROQ_API_KEY',
    defaultModel: '',
    reasoningEffort: false,
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    apiKeyVar: 'TOGETHER_API_KEY',
    defaultModel: '',
    reasoningEffort: false,
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyVar: 'GEMINI_API_KEY',
    defaultModel: '',
    reasoningEffort: true,
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    apiKeyVar: 'OPENAI_API_KEY',
    defaultModel: '',
    reasoningEffort: true,
  },
};

export const KIMI_BASE_URL = VENDORS['kimi']!.baseURL;
export const KIMI_DEFAULT_MODEL = VENDORS['kimi']!.defaultModel;

/**
 * Five effort tiers collapsed onto the three these vendors offer, downward.
 *
 * `medium` is the interview turn's setting and it goes to `low`, because K3's
 * floor is not Anthropic's floor: the model reasons at every tier, so the cheap
 * tier still buys the domain judgement the turn exists for.
 *
 * The default when the field is omitted is `max` on K3 — the most expensive
 * setting on the most expensive dial. It is never omitted for a vendor that
 * takes it.
 */
const REASONING_EFFORT: Record<Effort, 'low' | 'high' | 'max'> = {
  low: 'low',
  medium: 'low',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

export interface OpenAICompatibleOptions {
  /** Which row of `VENDORS` to use. Defaults to Kimi. */
  vendor?: string;
  apiKey?: string;
  /** Override for a proxy, a region, or a vendor not in the table. */
  baseURL?: string;
  model?: string;
  turnModel?: string;
  draftModel?: string;
  maxTokens?: number;
  turnMaxTokens?: number;
  draftMaxTokens?: number;
  turnEffort?: Effort;
  draftEffort?: Effort;
  adviceEffort?: Effort;
  adviceMaxTokens?: number;
  /** Called once per model call, including retries and fallbacks. */
  onCall?: CallSink;
}

const envEffort = (name: string, fallback: Effort): Effort => {
  const raw = process.env[name];
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max'
    ? raw
    : fallback;
};

const budget = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * A chunk, plus the fields Moonshot adds to it.
 *
 * `reasoning_content` is not in the OpenAI types because it is not an OpenAI
 * field. Read defensively rather than asserted: if a model stops emitting it,
 * `why` should say there is no reasoning to show, not throw on the turn that
 * was otherwise fine.
 */
interface ReasoningDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

export class OpenAICompatibleTransport implements ConceptTransport {
  private readonly client: OpenAI;
  private readonly vendor: string;
  private readonly spec: VendorSpec;
  private readonly turnModel: string;
  private readonly draftModel: string;
  private readonly turnMaxTokens: number;
  private readonly draftMaxTokens: number;
  private readonly turnEffort: Effort;
  private readonly draftEffort: Effort;
  private readonly adviceEffort: Effort;
  private readonly adviceMaxTokens: number;
  private readonly onCall: CallSink | undefined;
  /** How often a response came back empty or corrupted. Surfaced, not swallowed. */
  unusableRetries = 0;
  /** How often a draft had to be retried with more room. Surfaced, not hidden. */
  budgetRetries = 0;
  /** Every call this transport has made, including retries and fallbacks. */
  usage: UsageTotal = EMPTY_USAGE;
  private inFlight: AbortController | undefined;

  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  constructor(options: OpenAICompatibleOptions = {}) {
    const retries = Number(process.env['BIZSIM_MAX_RETRIES']);
    const maxRetries = Number.isFinite(retries) && retries >= 0 ? retries : 5;
    this.vendor = options.vendor ?? 'kimi';
    const spec = VENDORS[this.vendor];
    if (!spec) {
      throw new Error(
        `Unknown vendor "${this.vendor}". Known: ${Object.keys(VENDORS).join(', ')}. ` +
          `A vendor not in the table can still be used by passing baseURL directly.`,
      );
    }
    this.spec = spec;
    // The key resolves from the vendor's own variable, which is where it should
    // live — never in the repo, never in a committed config file. Read here
    // rather than left to the SDK, which looks for OPENAI_API_KEY and would
    // find the wrong key or none.
    const apiKey = options.apiKey ?? process.env[spec.apiKeyVar] ?? '';
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL ?? process.env['BIZSIM_BASE_URL'] ?? spec.baseURL,
      maxRetries,
    });

    const model = options.model ?? process.env['BIZSIM_MODEL'] ?? spec.defaultModel;
    if (!model) {
      throw new Error(
        `No model set for vendor "${this.vendor}", and it has no default. ` +
          `Set BIZSIM_MODEL — a default here would be a guess at a catalogue that changes monthly.`,
      );
    }
    this.turnModel = options.turnModel ?? process.env['BIZSIM_TURN_MODEL'] ?? model;
    this.draftModel = options.draftModel ?? process.env['BIZSIM_DRAFT_MODEL'] ?? model;
    this.turnMaxTokens = options.turnMaxTokens ?? budget('BIZSIM_TURN_MAX_TOKENS', 8_000);
    this.draftMaxTokens =
      options.draftMaxTokens ?? options.maxTokens ?? budget('BIZSIM_DRAFT_MAX_TOKENS', 32_000);
    this.turnEffort = options.turnEffort ?? envEffort('BIZSIM_TURN_EFFORT', 'medium');
    this.adviceEffort = options.adviceEffort ?? envEffort('BIZSIM_ADVICE_EFFORT', 'low');
    this.adviceMaxTokens = options.adviceMaxTokens ?? budget('BIZSIM_ADVICE_MAX_TOKENS', 4_000);
    this.draftEffort = options.draftEffort ?? envEffort('BIZSIM_DRAFT_EFFORT', 'high');
    this.onCall = options.onCall;
  }

  describe(): string {
    return this.turnModel === this.draftModel
      ? `${this.vendor} · ${this.turnModel}`
      : `${this.vendor} · ${this.turnModel} (turns), ${this.draftModel} (draft)`;
  }

  private async complete(
    kind: CallKind,
    attempt: number,
    system: string,
    messages: readonly InterviewMessage[],
    schema: Record<string, unknown> | undefined,
    effort: Effort,
    model: string,
    maxTokens: number,
  ): Promise<{ text: string; reasoning?: string; usage: TurnUsage }> {
    this.inFlight = new AbortController();

    /**
     * Timed and priced whatever happens, including when it throws.
     *
     * A refusal, a truncated draft and a rate limit all cost wall-clock the
     * player waited through, and the first two cost tokens as well. Emitting
     * only on the success path would make the journal's per-call latencies
     * systematically optimistic, because the failures are the slow ones.
     */
    const startedAt = Date.now();
    let usage: TurnUsage = { ...ZERO_TOKENS };
    let failure: string | undefined;
    try {
      return await this.exchange(
        system,
        messages,
        schema,
        effort,
        model,
        maxTokens,
        (spent) => {
          usage = spent;
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.name : 'Error';
      throw error;
    } finally {
      emitCall(this.onCall, {
        call: kind,
        attempt,
        provider: this.vendor,
        model,
        effort: this.spec.reasoningEffort ? REASONING_EFFORT[effort] : 'n/a',
        ms: Date.now() - startedAt,
        usage,
        ...(failure ? { failure } : {}),
      });
    }
  }

  /**
   * The call itself, split out so the timing and pricing above it read as one
   * thing. `take` hands the usage back the moment it is known, which is before
   * the `finish_reason` checks can throw — a truncated draft was still billed.
   */
  private async exchange(
    system: string,
    messages: readonly InterviewMessage[],
    schema: Record<string, unknown> | undefined,
    effort: Effort,
    model: string,
    maxTokens: number,
    take: (usage: TurnUsage) => void,
  ): Promise<{ text: string; reasoning?: string; usage: TurnUsage }> {
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          // Omitted entirely where the vendor does not understand it: an
          // unrecognised parameter is a 400 on some of these and silently
          // ignored on others, and neither is a thing to find out live.
          ...(this.spec.reasoningEffort
            ? { reasoning_effort: REASONING_EFFORT[effort] }
            : {}),
          messages: [
            // A system role rather than a top-level `system` field. Moonshot
            // caches on the request prefix automatically, and the ~5,100-token
            // prompt sitting first in every call is exactly the prefix that
            // gets cached — so there is nothing to declare and no
            // `cache_control` breakpoint to place.
            { role: 'system' as const, content: system },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          ...(schema
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: { name: 'result', strict: true, schema },
                },
              }
            : {}),
          stream: true as const,
          // Without this the usage object never arrives on a streamed
          // response, and the meter silently reports a free session.
          stream_options: { include_usage: true },
        },
        // Set by `complete` immediately before this runs, so a Ctrl-C reaches
        // the request that is actually in flight.
        { signal: this.inFlight?.signal },
      );
    } catch (error) {
      throw asCancellation(error);
    }

    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: TurnUsage = { ...ZERO_TOKENS };

    try {
      for await (const chunk of stream) {
        // The usage chunk carries no choices at all, so this is optional in
        // fact and not defensively: reading it as an array is a crash on the
        // last chunk of every successful call.
        const choice = chunk.choices?.[0];
        const delta = choice?.delta as ReasoningDelta | undefined;
        if (delta?.content) text += delta.content;
        const think = delta?.reasoning_content ?? delta?.reasoning;
        if (think) reasoning += think;
        if (choice?.finish_reason) finish = choice.finish_reason;
        // The usage chunk arrives last and carries no choices.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens,
            // Reasoning bills as ordinary output on Kimi at the same rate, so
            // this is a breakdown of `outputTokens` rather than an addition to
            // it — exactly as `thinkingTokens` is on the Anthropic side.
            thinkingTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }
      }
    } catch (error) {
      throw asCancellation(error);
    }

    // Recorded before anything below can throw. A call that ran out of budget
    // still generated — and still billed — every token it produced, and a meter
    // that only counts successful calls understates the expensive failures by
    // exactly the amount that makes them worth knowing about.
    this.usage = addUsage(this.usage, usage);
    take(usage);

    // There is no `stop_reason: 'refusal'` here. The OpenAI-shaped equivalent
    // is a content filter, which is a different mechanism reaching the same
    // place: the model declined, and the player is owed that sentence rather
    // than a parse error two frames later.
    if (finish === 'content_filter') throw new ConceptRefusedError();
    if (finish === 'length') throw new BudgetExhaustedError(maxTokens, usage.thinkingTokens);
    if (text.trim().length === 0) {
      throw new Error(`No text content in response (finish_reason: ${finish ?? 'none'}).`);
    }

    return {
      text,
      ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
      usage,
    };
  }

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<TurnResult> {
    let attempt = await this.complete(
      'turn',
      1,
      system,
      messages,
      TURN_SCHEMA,
      this.turnEffort,
      this.turnModel,
      this.turnMaxTokens,
    );
    let turn = zInterviewTurn.parse(JSON.parse(stripFence(attempt.text)));

    if (isUnusable(turn)) {
      this.unusableRetries += 1;
      attempt = await this.complete(
        'turn',
        2,
        system,
        messages,
        TURN_SCHEMA,
        this.turnEffort,
        this.turnModel,
        this.turnMaxTokens,
      );
      turn = zInterviewTurn.parse(JSON.parse(stripFence(attempt.text)));
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

  async advise(system: string, messages: readonly InterviewMessage[]): Promise<AdviceResult> {
    const attempt = await this.complete(
      'advise',
      1,
      system,
      messages,
      ADVICE_SCHEMA,
      this.adviceEffort,
      this.turnModel,
      this.adviceMaxTokens,
    );
    return {
      advice: zTurnAdvice.parse(JSON.parse(stripFence(attempt.text))),
      usage: attempt.usage,
    };
  }

  /**
   * One disagreement, settled in isolation — §11.3.
   *
   * A single user message and no history, for the same reason as the Anthropic
   * transport: the spec is explicit that this call must not see the
   * conversational thread, because rapport is what produces capitulation. The
   * isolation is enforced in the transport because the transport is the thing
   * that could accidentally supply the thread.
   */
  async adjudicate(system: string, input: string): Promise<Adjudication> {
    const attempt = await this.complete(
      'adjudicate',
      1,
      system,
      [{ role: 'user', content: input }],
      ADJUDICATION_SCHEMA,
      this.turnEffort,
      this.turnModel,
      this.turnMaxTokens,
    );
    return zAdjudication.parse(JSON.parse(stripFence(attempt.text)));
  }

  /**
   * Effort to fall back to when the budget ran out. Down one step, not to the
   * floor — the failure was space, not capability.
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
      text = (
        await this.complete(
          'draft',
          1,
          system,
          asked,
          DRAFT_SCHEMA,
          this.draftEffort,
          this.draftModel,
          this.draftMaxTokens,
        )
      ).text;
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        this.budgetRetries += 1;
        text = (
          await this.complete(
            'draft',
            2,
            system,
            asked,
            DRAFT_SCHEMA,
            OpenAICompatibleTransport.ONE_STEP_DOWN[this.draftEffort],
            this.draftModel,
            Math.round(this.draftMaxTokens * 1.5),
          )
        ).text;
      } else {
        /**
         * The schema was refused, so ask for it in the prompt instead.
         *
         * The Anthropic transport has the same shape for the same reason — its
         * trigger is "compiled grammar is too large" — but here it covers a
         * wider case: a Kimi model that offers JSON *mode* and not schema
         * enforcement rejects `response_format.json_schema` outright. Degrading
         * keeps the feature working, and weakens the guarantee from "cannot be
         * malformed" to "cannot pass unnoticed": the schema is still in the
         * prompt, and `assertDraftShape` and `draftIssues` still run.
         */
        if (!isSchemaUnsupported(error)) throw error;
        text = (
          await this.complete(
            'draft',
            2,
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

/**
 * The SDK's abort error carries no `name`, so `isCancellation` cannot see it.
 *
 * Left unconverted, a Ctrl-C would fall through to the transient path and the
 * call the player just stopped would be retried five times — the exact
 * behaviour the cancel work existed to remove.
 */
function asCancellation(error: unknown): unknown {
  return error instanceof OpenAI.APIUserAbortError ? new CancelledError() : error;
}

/**
 * A named alias, because "Kimi" is what this is configured as by default and
 * a name that says so reads better at the call site than one that says HTTP.
 */
export class KimiConceptTransport extends OpenAICompatibleTransport {
  constructor(options: Omit<OpenAICompatibleOptions, 'vendor'> = {}) {
    super({ ...options, vendor: 'kimi' });
  }
}

/** A 400 that means "this model will not take a schema", not "your schema is wrong". */
function isSchemaUnsupported(error: unknown): boolean {
  if (!(error instanceof OpenAI.BadRequestError)) return false;
  return /json_schema|response_format|structured output|schema/i.test(error.message);
}
