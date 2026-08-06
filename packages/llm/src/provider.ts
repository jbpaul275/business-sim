import { AnthropicConceptTransport, type ConceptTransport } from './client.js';
import { OpenAICompatibleTransport, VENDORS } from './openaiCompatible.js';
import type { CallSink } from './telemetry.js';

/**
 * Which model answers, and whether anything can.
 *
 * One place, because the question is asked from four — the setup gate, the CLI,
 * the turn loop's advisor, and the "no key, so answers are the engine's
 * arithmetic alone" line the player actually reads. Those had drifted into
 * checking `ANTHROPIC_API_KEY` by name in three of the four, which is how a
 * provider switch becomes a bug hunt.
 *
 * Anthropic is its own transport because its wire format is its own. Everything
 * else — Moonshot, DeepSeek, Groq, OpenRouter, Google's compatibility endpoint
 * — is a row in `VENDORS` and shares one transport, so trying a new vendor is
 * two environment variables rather than a week of work.
 */

/** Every vendor that can be selected: the OpenAI-compatible table, plus Anthropic. */
export type ProviderName = 'anthropic' | (string & {});

/** The environment variable a provider's key lives in. Never a config file. */
export function providerKeyVar(provider: ProviderName = providerName()): string {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  return VENDORS[provider]?.apiKeyVar ?? 'BIZSIM_API_KEY';
}

const keyFor = (provider: ProviderName): string | undefined =>
  provider === 'anthropic'
    ? (process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'])
    : process.env[providerKeyVar(provider)];

/**
 * Every environment variable that could make a call possible.
 *
 * Exists for the tests that must prove the no-key path: hiding only the
 * resolved provider's key does not hide the capability, because resolution
 * simply falls through to the next provider with a key. On a developer machine
 * with two keys exported that turned "refuses politely when no key exists" into
 * a live billable call against whichever provider was second in the preference
 * order — the exact thing the helper was written to prevent.
 */
export function providerKeyVars(): string[] {
  return [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'BIZSIM_API_KEY',
    ...Object.values(VENDORS).map((v) => v.apiKeyVar),
  ];
}

/**
 * Preference order when nothing is forced.
 *
 * Cheapest-plausible first, because the whole point of the routing work is that
 * model cost is the binding constraint on the price this can carry. A machine
 * with several keys exported gets the cheap one unless it says otherwise, and
 * `BIZSIM_LLM_PROVIDER` is how it says otherwise.
 */
const PREFERENCE: readonly ProviderName[] = [
  'kimi',
  'deepseek',
  'gemini',
  'groq',
  'together',
  'openrouter',
  'openai',
  'anthropic',
];

/**
 * The provider to use, resolved rather than hardcoded.
 *
 * A forced choice is honoured even when its key is missing: a provider someone
 * named explicitly and cannot be given should fail visibly at the gate, not
 * silently succeed against a different one and bill them for a comparison they
 * did not ask for.
 */
export function providerName(): ProviderName {
  const forced = process.env['BIZSIM_LLM_PROVIDER']?.trim().toLowerCase();
  if (forced) {
    if (forced === 'claude') return 'anthropic';
    if (forced === 'moonshot') return 'kimi';
    return forced;
  }
  return PREFERENCE.find((p) => keyFor(p)) ?? 'kimi';
}

/** True when the resolved provider has a key and can actually be called. */
export function providerKeyPresent(provider: ProviderName = providerName()): boolean {
  return Boolean(keyFor(provider));
}

export interface TransportOptions {
  /**
   * Called once per model call. The same sink whichever provider is resolved,
   * which is the point: a per-call record that changed shape with the provider
   * could not be compared across them, and comparing across them is the reason
   * it is recorded.
   */
  onCall?: CallSink;
}

export function createConceptTransport(
  options: TransportOptions = {},
  provider: ProviderName = providerName(),
): ConceptTransport {
  if (provider === 'anthropic') return new AnthropicConceptTransport(options);
  return new OpenAICompatibleTransport({ ...options, vendor: provider });
}
