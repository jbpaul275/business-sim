import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
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

export interface ConceptTransport {
  /** One conversational turn: a question, or a signal that it can now draft. */
  turn(system: string, messages: readonly InterviewMessage[]): Promise<InterviewTurn>;
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

/** True for the "compiled grammar is too large" 400, which has a workaround. */
function isGrammarTooLarge(error: unknown): boolean {
  return (
    error instanceof Anthropic.BadRequestError &&
    /compiled grammar is too large/i.test(error.message)
  );
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

  private async complete(
    system: string,
    messages: readonly InterviewMessage[],
    schema: Record<string, unknown> | undefined,
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      output_config: {
        ...(schema ? { format: { type: 'json_schema' as const, schema } } : {}),
        effort: this.effort,
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
    return text;
  }

  async turn(system: string, messages: readonly InterviewMessage[]): Promise<InterviewTurn> {
    // Structured outputs constrain generation against the schema, so this
    // should always hold — but "should" is doing load-bearing work in a
    // sentence about generated JSON.
    return zInterviewTurn.parse(JSON.parse(await this.complete(system, messages, TURN_SCHEMA)));
  }

  async draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft> {
    const asked: InterviewMessage[] = [...messages, { role: 'user', content: DRAFT_AS_PROSE }];
    let text: string;
    try {
      text = await this.complete(system, asked, DRAFT_SCHEMA);
    } catch (error) {
      if (!isGrammarTooLarge(error)) throw error;
      // The draft schema is close to whatever the grammar ceiling is, and where
      // exactly it sits is not something this package can know. Degrading to an
      // unconstrained call keeps the feature working: the schema is still in
      // the prompt and the result is still parsed with Zod, so the guarantee
      // weakens from "cannot be malformed" to "cannot pass unnoticed".
      text = await this.complete(
        `${system}\n\n## Draft schema\n\n${JSON.stringify(DRAFT_SCHEMA)}`,
        asked,
        undefined,
      );
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
  ) {}

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

  async draft(system: string, messages: readonly InterviewMessage[]): Promise<ConceptDraft> {
    this.seen.push({ system, messages: [...messages] });
    const next = this.drafts[0];
    if (!next) throw new Error('ScriptedTransport has no draft to return.');
    return next;
  }
}
