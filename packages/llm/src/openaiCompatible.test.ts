import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetExhaustedError,
  CancelledError,
  ConceptRefusedError,
  isCancellation,
  isTransient,
} from './client.js';
import {
  KIMI_DEFAULT_MODEL,
  KimiConceptTransport,
  OpenAICompatibleTransport,
  VENDORS,
} from './openaiCompatible.js';
import { createConceptTransport, providerKeyVar, providerName } from './provider.js';
import { MINIMAL_DRAFT } from './fixtures.js';

/**
 * The Kimi transport — docs/plan/05-provider-migration.md.
 *
 * Stubbed at the SDK seam, like the Anthropic budget tests, because what is
 * worth asserting is the *request*: which model, which effort, whether usage
 * was asked for, whether the adjudication call carried history it must not
 * carry. A live call could not check any of that and would cost money to fail.
 */

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

interface Chunk {
  choices?: {
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** A streamed response, as the SDK hands it over: an async iterable of chunks. */
const streamOf = (chunks: Chunk[]): AsyncIterable<Chunk> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

const textChunks = (text: string, usage?: Chunk['usage']): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ...(usage ? [{ usage }] : []),
];

type Request = Record<string, unknown>;

/** Install a stub in place of the SDK, and record what it was asked for. */
function stub(
  transport: KimiConceptTransport,
  respond: (request: Request, call: number) => Chunk[] | Error,
): Request[] {
  const seen: Request[] = [];
  (transport as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (request: Request) => {
          seen.push(request);
          const result = respond(request, seen.length);
          if (result instanceof Error) throw result;
          return streamOf(result);
        },
      },
    },
  };
  return seen;
}

const TURN = JSON.stringify({
  message: 'A dark-sky ridge changes the draw a lot.',
  cta: 'How many scopes?',
  readyToDraft: false,
});

describe('choosing a provider', () => {
  it('prefers Kimi when its key is present', () => {
    process.env['MOONSHOT_API_KEY'] = 'sk-test';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    delete process.env['BIZSIM_LLM_PROVIDER'];
    expect(providerName()).toBe('kimi');
    expect(providerKeyVar()).toBe('MOONSHOT_API_KEY');
    expect(createConceptTransport()).toBeInstanceOf(OpenAICompatibleTransport);
  });

  it('falls back to Anthropic when only that key is set, rather than failing', () => {
    // The migration must not break a machine that has not been given a Kimi
    // key yet. Both keys can be exported at once, which is what makes an A/B a
    // single variable rather than a shell session.
    delete process.env['MOONSHOT_API_KEY'];
    delete process.env['BIZSIM_LLM_PROVIDER'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    expect(providerName()).toBe('anthropic');
    expect(providerKeyVar()).toBe('ANTHROPIC_API_KEY');
  });

  it('reaches any vendor in the table, not a hardcoded two', () => {
    /**
     * The infrastructure claim. Model cost is the binding constraint on what
     * this can be sold for, and the cheapest model that can do a job is not
     * something anyone reasons their way to — it has to be measured, one vendor
     * at a time. A transport per vendor would have made that a week of work
     * each and it would never have happened.
     */
    delete process.env['MOONSHOT_API_KEY'];
    process.env['BIZSIM_LLM_PROVIDER'] = 'deepseek';
    process.env['DEEPSEEK_API_KEY'] = 'sk-ds';
    process.env['BIZSIM_MODEL'] = 'deepseek-chat';
    expect(providerName()).toBe('deepseek');
    expect(providerKeyVar()).toBe('DEEPSEEK_API_KEY');
    const t = createConceptTransport() as unknown as { vendor: string; client: { baseURL: string } };
    expect(t.vendor).toBe('deepseek');
    expect(t.client.baseURL).toBe(VENDORS['deepseek']!.baseURL);
  });

  it('refuses a vendor with no default model rather than guessing one', () => {
    // A catalogue that turns over monthly gets no default. A stale id baked in
    // here is a 404 on a Tuesday, in front of a player, for no benefit.
    delete process.env['BIZSIM_MODEL'];
    expect(() => new OpenAICompatibleTransport({ vendor: 'groq', apiKey: 'x' })).toThrow(
      /BIZSIM_MODEL/,
    );
  });

  it('omits reasoning_effort for a vendor that does not take it', async () => {
    // Sending an unrecognised parameter is a 400 on some of these and silently
    // ignored on others, and neither is a thing to discover live.
    const t = new OpenAICompatibleTransport({
      vendor: 'groq',
      apiKey: 'x',
      model: 'some-groq-model',
    });
    const seen = stub(t, () => textChunks(TURN));
    await t.turn('system', [{ role: 'user', content: 'x' }]);
    expect(seen[0]!['reasoning_effort']).toBeUndefined();
  });

  it('honours a forced provider even when that key is missing', () => {
    // A forced choice that cannot be honoured should fail visibly at the gate,
    // not silently succeed against the other provider and bill someone for a
    // comparison they did not ask for.
    delete process.env['MOONSHOT_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    process.env['BIZSIM_LLM_PROVIDER'] = 'kimi';
    expect(providerName()).toBe('kimi');
    expect(providerKeyVar()).toBe('MOONSHOT_API_KEY');
  });
});

describe('the Kimi transport', () => {
  const transport = (): KimiConceptTransport => new KimiConceptTransport({ apiKey: 'sk-test' });

  it('never omits reasoning_effort, because the API default is the dearest tier', () => {
    // K3 defaults `reasoning_effort` to `max`. Leaving it unset would put the
    // most expensive setting on the most expensive dial on every call made by
    // a migration whose entire purpose was cost.
    const t = transport();
    const seen = stub(t, () => textChunks(TURN));
    return t.turn('system', [{ role: 'user', content: 'A telescope rental.' }]).then(() => {
      expect(seen[0]!['reasoning_effort']).toBeDefined();
      expect(seen[0]!['model']).toBe(KIMI_DEFAULT_MODEL);
    });
  });

  it('collapses five effort tiers onto K3s three, downward', async () => {
    // `medium` is the interview turn's setting and it goes to `low`, because
    // K3's floor is not Anthropic's floor: the model reasons at every tier.
    const t = new KimiConceptTransport({ apiKey: 'sk-test', turnEffort: 'medium' });
    const seen = stub(t, () => textChunks(TURN));
    await t.turn('system', [{ role: 'user', content: 'x' }]);
    expect(seen[0]!['reasoning_effort']).toBe('low');

    const hard = new KimiConceptTransport({ apiKey: 'sk-test', draftEffort: 'max' });
    const hardSeen = stub(hard, () => textChunks(JSON.stringify(MINIMAL_DRAFT)));
    await hard.draft('system', [{ role: 'user', content: 'x' }]);
    expect(hardSeen[0]!['reasoning_effort']).toBe('max');
  });

  it('asks for usage on the stream, or the meter reports a free session', async () => {
    const t = transport();
    const seen = stub(t, () =>
      textChunks(TURN, {
        prompt_tokens: 5_400,
        completion_tokens: 900,
        prompt_tokens_details: { cached_tokens: 5_100 },
        completion_tokens_details: { reasoning_tokens: 700 },
      }),
    );
    await t.turn('system', [{ role: 'user', content: 'x' }]);

    expect(seen[0]!['stream']).toBe(true);
    expect(seen[0]!['stream_options']).toEqual({ include_usage: true });
    expect(t.usage).toEqual({
      calls: 1,
      inputTokens: 5_400,
      cachedInputTokens: 5_100,
      outputTokens: 900,
      thinkingTokens: 700,
    });
  });

  it('puts the system prompt first, where the automatic cache reads it', async () => {
    const t = transport();
    const seen = stub(t, () => textChunks(TURN));
    await t.turn('PROMPT', [{ role: 'user', content: 'A telescope rental.' }]);
    const messages = seen[0]!['messages'] as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'PROMPT' });
    expect(messages[1]).toEqual({ role: 'user', content: 'A telescope rental.' });
  });

  it('keeps the reasoning, so `why` needs no second call', async () => {
    const t = transport();
    stub(t, () => [
      { choices: [{ delta: { reasoning_content: 'Dark sky means destination, not footfall.' } }] },
      { choices: [{ delta: { content: TURN } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const result = await t.turn('system', [{ role: 'user', content: 'x' }]);
    expect(result.reasoning).toContain('destination');
  });

  it('says there is no reasoning rather than inventing one', async () => {
    // Reasoning arrives as a Kimi extension field. If a model stops emitting
    // it, the turn is still fine and `why` should say so.
    const t = transport();
    stub(t, () => textChunks(TURN));
    const result = await t.turn('system', [{ role: 'user', content: 'x' }]);
    expect(result.reasoning).toBeUndefined();
    expect(result.turn.cta).toBe('How many scopes?');
  });

  it('sends the adjudication with no history at all — §11.3', async () => {
    // Rapport is what produces capitulation. The transport is the thing that
    // could accidentally supply the thread, so this is where it is enforced.
    const t = transport();
    const seen = stub(t, () =>
      textChunks(
        JSON.stringify({
          ruling: 'CONCEDE',
          newValue: 22_000,
          newProvenance: 'PLAYER_SOURCED',
          reasoning: 'A quoted listing beats a range.',
          clarifyingQuestion: null,
          secondOrderEffect: null,
        }),
      ),
    );
    await t.adjudicate('system', 'The freezer is $22,000, here is the invoice.');
    const messages = seen[0]!['messages'] as { role: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('user');
  });

  it('turns a truncated draft into a retry with more room and less reasoning', async () => {
    const t = new KimiConceptTransport({ apiKey: 'sk-test', draftEffort: 'high' });
    const seen = stub(t, (_request, call) =>
      call === 1
        ? [
            { choices: [{ delta: { content: '{"businessName"' }, finish_reason: 'length' }] },
            { usage: { prompt_tokens: 7_000, completion_tokens: 32_000 } },
          ]
        : textChunks(JSON.stringify(MINIMAL_DRAFT), {
            prompt_tokens: 7_000,
            completion_tokens: 3_000,
          }),
    );

    await t.draft('system', [{ role: 'user', content: 'A hemp brand.' }]);

    expect(seen).toHaveLength(2);
    expect(seen[1]!['max_tokens'] as number).toBeGreaterThan(seen[0]!['max_tokens'] as number);
    expect(seen[0]!['reasoning_effort']).toBe('high');
    expect(seen[1]!['reasoning_effort']).toBe('low');
    expect(t.budgetRetries).toBe(1);
    // The truncated call generated — and was billed for — every token it
    // produced. A meter that skips the expensive failures is useless.
    expect(t.usage.calls).toBe(2);
    expect(t.usage.outputTokens).toBe(35_000);
  });

  it('raises the budget error rather than returning half an object', async () => {
    const t = transport();
    stub(t, () => [{ choices: [{ delta: { content: '{"a"' }, finish_reason: 'length' }] }]);
    await expect(t.turn('system', [{ role: 'user', content: 'x' }])).rejects.toThrow(
      BudgetExhaustedError,
    );
  });

  it('reads a content filter as the refusal it is', async () => {
    // There is no `stop_reason: "refusal"` here. The OpenAI-shaped equivalent
    // reaches the same place, and the player is owed that sentence rather than
    // a parse error two frames later.
    const t = transport();
    stub(t, () => [{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }]);
    await expect(t.turn('system', [{ role: 'user', content: 'x' }])).rejects.toThrow(
      ConceptRefusedError,
    );
  });

  it('falls back to the prompt when a model will not take a schema', async () => {
    /**
     * The §4.1 risk, made survivable. K2.x offers JSON *mode* rather than
     * schema-constrained decoding and rejects `response_format.json_schema`
     * outright. Degrading weakens the guarantee from "cannot be malformed" to
     * "cannot pass unnoticed" — the schema is still in the prompt, and
     * `assertDraftShape` still runs — rather than ending the session.
     */
    const t = transport();
    const seen = stub(t, (_request, call) =>
      call === 1
        ? new OpenAI.BadRequestError(
            400,
            undefined,
            'Invalid parameter: response_format.json_schema is not supported by this model',
            new Headers(),
          )
        : textChunks(JSON.stringify(MINIMAL_DRAFT)),
    );

    const draft = await t.draft('system', [{ role: 'user', content: 'A hemp brand.' }]);
    expect(draft.businessName).toBe('Hemp brand');
    expect(seen).toHaveLength(2);
    expect(seen[0]!['response_format']).toBeDefined();
    expect(seen[1]!['response_format']).toBeUndefined();
    // The schema still went, in the only place left to put it.
    expect(seen[1]!['messages']).toBeDefined();
    const system = (seen[1]!['messages'] as { content: string }[])[0]!.content;
    expect(system).toContain('Draft schema');
  });

  it('does not treat every 400 as a schema problem', async () => {
    // Degrading on any bad request would silently drop constrained decoding
    // whenever something else was wrong with the call.
    const t = transport();
    stub(t, () => new OpenAI.BadRequestError(400, undefined, 'context length exceeded', new Headers()));
    await expect(t.draft('system', [{ role: 'user', content: 'x' }])).rejects.toThrow(
      /context length/,
    );
  });

  it('converts an aborted request into a cancellation, so nothing retries it', async () => {
    // The SDK's abort error carries no `name`, so `isCancellation` cannot see
    // it unaided — and a Ctrl-C that falls through to the transient path gets
    // the stopped call retried five times.
    const abort = new OpenAI.APIUserAbortError();
    expect(isCancellation(abort)).toBe(false);

    const t = transport();
    stub(t, () => abort);
    const error = await t.turn('system', [{ role: 'user', content: 'x' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
    expect(isCancellation(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
  });

  it('retries a rate limit from either SDK, without importing either', async () => {
    // `isTransient` reads the status structurally so a second provider gets the
    // same retry behaviour. A 400 is the caller's fault and must not retry.
    expect(isTransient(new OpenAI.APIError(429, undefined, 'rate limited', new Headers()))).toBe(true);
    expect(isTransient(new OpenAI.APIError(503, undefined, 'unavailable', new Headers()))).toBe(true);
    expect(isTransient(new OpenAI.BadRequestError(400, undefined, 'bad schema', new Headers()))).toBe(false);
    expect(isTransient(new OpenAI.APIConnectionError({ message: 'socket hang up' }))).toBe(true);
  });
});
