import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { zInterviewTurn, type InterviewTurn } from './draft.js';

/**
 * The SDK ships a `zodOutputFormat` helper, but it is typed against Zod 4 and
 * the rest of this monorepo is on Zod 3. Splitting Zod versions across packages
 * to gain one helper is a bad trade — schemas cross package boundaries here —
 * so the schema is converted to plain JSON Schema and handed to
 * `output_config.format` directly, and the response is parsed with the same Zod
 * 3 schema that every other package already uses.
 */
const TURN_SCHEMA = zodToJsonSchema(zInterviewTurn, {
  // Structured outputs require `additionalProperties: false` on every object
  // and reject `$ref`, so the schema has to be emitted inline.
  $refStrategy: 'none',
}) as Record<string, unknown>;

/**
 * The seam between the interview and the model.
 *
 * It exists so the interview loop, the prompt and the mapping can be tested
 * without a key and without a network — the parts most likely to break are the
 * deterministic ones, and they should not need an API call to exercise. The
 * scripted transport below is what the tests run against.
 */

export interface InterviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConceptTransport {
  /**
   * One turn. Returns the model's question, or its finished draft.
   * Implementations must return a value matching `zInterviewTurn`; the caller
   * does not re-validate on the happy path.
   */
  turn(system: string, messages: readonly InterviewMessage[]): Promise<InterviewTurn>;
}

export interface AnthropicTransportOptions {
  apiKey?: string;
  /** Defaults to Claude Opus 5 — the interview is the hardest reasoning here. */
  model?: string;
  maxTokens?: number;
  /**
   * Thinking is on by default on this model, and `maxTokens` caps thinking plus
   * response together, so the budget is sized for both.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class AnthropicConceptTransport implements ConceptTransport {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: NonNullable<AnthropicTransportOptions['effort']>;

  constructor(options: AnthropicTransportOptions = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY from the environment,
    // which is where it should live — never in the repo, never in a committed
    // config file.
    this.client = options.apiKey
      ? new Anthropic({ apiKey: options.apiKey })
      : new Anthropic();
    this.model = options.model ?? 'claude-opus-5';
    this.maxTokens = options.maxTokens ?? 16_000;
    this.effort = options.effort ?? 'high';
  }

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<InterviewTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      output_config: {
        format: { type: 'json_schema', schema: TURN_SCHEMA },
        effort: this.effort,
      },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    // A refusal is a successful HTTP response with an empty content array, so
    // reading the parse result without checking would surface as a confusing
    // null rather than as what it is.
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
    // Structured outputs constrain generation against the schema, so this
    // should always hold — but "should" is doing load-bearing work in a
    // sentence about generated JSON, and a bad draft must not reach the engine.
    return zInterviewTurn.parse(JSON.parse(text));
  }
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
 * A transport that replays a fixed sequence of turns. The tests' whole view of
 * the model — which is deliberate: what is worth testing here is the loop, the
 * validation and the mapping into the engine's shape, none of which should
 * depend on a live call.
 */
export class ScriptedTransport implements ConceptTransport {
  private index = 0;
  readonly seen: { system: string; messages: InterviewMessage[] }[] = [];

  constructor(private readonly turns: readonly InterviewTurn[]) {}

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<InterviewTurn> {
    this.seen.push({ system, messages: [...messages] });
    const next = this.turns[this.index];
    if (!next) {
      throw new Error(
        `ScriptedTransport exhausted after ${this.turns.length} turns — the loop asked for more than the script provides.`,
      );
    }
    this.index += 1;
    return next;
  }
}
