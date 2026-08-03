import { AnthropicConceptTransport, type ConceptTransport } from './client.js';
import { KimiConceptTransport } from './kimi.js';

/**
 * Which model answers, and whether anything can.
 *
 * One place, because the question is asked from four — the setup gate, the CLI,
 * the turn loop's advisor, and the "no key, so answers are the engine's
 * arithmetic alone" line the player actually reads. Those had drifted into
 * checking `ANTHROPIC_API_KEY` by name in three of the four, which is how a
 * provider switch becomes a bug hunt.
 */

export type ProviderName = 'kimi' | 'anthropic';

/** The environment variable each provider's SDK reads. Never a config file. */
export const API_KEY_VAR: Record<ProviderName, string> = {
  kimi: 'MOONSHOT_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const keyFor = (provider: ProviderName): string | undefined =>
  provider === 'kimi'
    ? process.env['MOONSHOT_API_KEY']
    : (process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);

/**
 * The provider to use, resolved rather than hardcoded.
 *
 * `BIZSIM_LLM_PROVIDER` decides when it is set, including when the key for that
 * provider is missing — a forced choice that cannot be honoured should fail
 * visibly at the gate, not silently succeed against the other provider and bill
 * someone for a comparison they did not ask for.
 *
 * Otherwise Kimi wins if its key is present, and Anthropic is the fallback.
 * Both keys can be exported at once, which is what makes an A/B a single
 * variable rather than a shell session.
 */
export function providerName(): ProviderName {
  const forced = process.env['BIZSIM_LLM_PROVIDER']?.trim().toLowerCase();
  if (forced === 'kimi' || forced === 'moonshot') return 'kimi';
  if (forced === 'anthropic' || forced === 'claude') return 'anthropic';
  return keyFor('kimi') ? 'kimi' : keyFor('anthropic') ? 'anthropic' : 'kimi';
}

/** True when the resolved provider has a key and can actually be called. */
export function providerKeyPresent(provider: ProviderName = providerName()): boolean {
  return Boolean(keyFor(provider));
}

/** The variable to export, for the message shown when there is no key. */
export const providerKeyVar = (provider: ProviderName = providerName()): string =>
  API_KEY_VAR[provider];

export function createConceptTransport(
  provider: ProviderName = providerName(),
): ConceptTransport {
  return provider === 'kimi' ? new KimiConceptTransport() : new AnthropicConceptTransport();
}
