import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicConceptTransport,
  ConceptInterview,
  TransientError,
  isTransient,
} from './index.js';

/**
 * A plastics factory died two turns in:
 *
 *   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 *   Nothing was committed. Run `pnpm sim --new` to start again.
 *
 * Overload says nothing about the conversation. Telling someone to describe
 * their business again from the top is the one response that is definitely
 * wrong, and the transcript was sitting intact in memory the whole time.
 */

describe('the model being busy', () => {
  it('recognises the shapes that mean "try again", not "you did something wrong"', () => {
    expect(isTransient(new Error('{"type":"error","error":{"type":"overloaded_error"}}'))).toBe(true);
    expect(isTransient(new Error('rate_limit_error'))).toBe(true);
    expect(isTransient(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).toBe(true);
  });

  it('does not swallow a fault that retrying will not fix', () => {
    // A bad key or a malformed request fails identically forever; retrying it
    // wastes the player's time and hides the real cause.
    expect(isTransient(new Error('invalid_request_error: bad schema'))).toBe(false);
    expect(isTransient(new Error('authentication_error'))).toBe(false);
    expect(isTransient(new Error('The compiled grammar is too large'))).toBe(false);
  });

  it('retries more than the SDK default, because giving up costs the conversation', () => {
    const t = new AnthropicConceptTransport({ apiKey: 'test' }) as unknown as {
      client: { maxRetries: number };
    };
    expect(t.client.maxRetries).toBeGreaterThan(2);
  });

  it('rolls the unanswered message back out of the transcript', async () => {
    // The player's message is pushed before the call so the model can see it.
    // Leaving it there on failure means a retry sends it twice, and the model
    // answers a conversation that did not happen.
    let fail = true;
    const interview = new ConceptInterview({
      transport: {
        turn: async () => {
          if (fail) {
            fail = false;
            throw new Error('{"type":"error","error":{"type":"overloaded_error"}}');
          }
          return { turn: { message: 'Ohio works.', cta: 'How many lines?', readyToDraft: false } };
        },
        draft: async () => {
          throw new Error('not reached');
        },
        usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      },
    });

    await expect(interview.send('20k sf plant in Ohio')).rejects.toBeInstanceOf(TransientError);
    expect(interview.transcript).toHaveLength(0);

    // And the same message goes again cleanly.
    const state = await interview.send('20k sf plant in Ohio');
    expect(state.status).toBe('ASKING');
    expect(interview.transcript.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('asking for a number', () => {
  it('tells the model to offer the range it would otherwise assume', async () => {
    const { CONCEPT_INTERVIEW_SYSTEM } = await import('./prompt.js');
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('Never ask for a number without offering the range');
    // The worked example is the live one: a building size asked with no band.
    expect(CONCEPT_INTERVIEW_SYSTEM).toContain('thermoforming');
  });
});
