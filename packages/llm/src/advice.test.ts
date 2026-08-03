import { describe, expect, it } from 'vitest';
import {
  askAdvisor,
  parseMoneyToken,
  unverifiedFigures,
  type AdviceTransport,
  type Briefing,
  type TurnAdvice,
} from './advice.js';

/**
 * The guard between a model and a ledger.
 *
 * §1.1: the LLM never computes a value that appears in a financial statement.
 * `dependency-cruiser` enforces that the LLM package cannot import the engine,
 * which stops the code path. Nothing stops the model simply making a number up
 * in prose — and a plausible invented figure is indistinguishable from a real
 * one to the person reading it, which is exactly what makes it dangerous.
 *
 * So every money amount in a reply is matched back against the briefing before
 * the player sees it. These tests are about whether that check can be fooled.
 */

const briefing: Briefing = {
  text: 'Revenue this quarter: $362.0k\nEBITDA: $202.6k\nCash: $741.9k',
  figures: ['$362.0k', '$202.6k', '$741.9k'],
  commands: ['price', 'marketing', 'fire', 'upgrade'],
};

describe('reading money out of prose', () => {
  it('handles the forms a model actually writes', () => {
    expect(parseMoneyToken('$1,148,000')).toBe(1_148_000);
    expect(parseMoneyToken('$1.1M')).toBe(1_100_000);
    expect(parseMoneyToken('$8.2k')).toBe(8_200);
    expect(parseMoneyToken('$0')).toBe(0);
    expect(parseMoneyToken('$2 million')).toBe(2_000_000);
    expect(parseMoneyToken('$-50k')).toBe(-50_000);
  });
});

describe('what the briefing can account for', () => {
  it('passes a reply that only quotes what it was given', () => {
    const reply = 'At $202.6k of EBITDA on $362.0k of revenue you have room to act.';
    expect(unverifiedFigures(reply, briefing, '')).toEqual([]);
  });

  it('passes the same figure restated in a rounder form', () => {
    // The briefing itself rounds — `toCompact` writes $1.1M for $1,148,000 —
    // so a model restating a number in its own words must not be flagged for
    // agreeing with the screen.
    expect(unverifiedFigures('about $203k of EBITDA', briefing, '')).toEqual([]);
    expect(unverifiedFigures('roughly $360k of revenue', briefing, '')).toEqual([]);
  });

  it('catches the figure nobody computed', () => {
    // The failure this exists for: a number that sounds exactly like the others.
    const reply = 'A waterpark like that runs about $850k to build, so two years of EBITDA.';
    expect(unverifiedFigures(reply, briefing, '')).toEqual(['$850k']);
  });

  it('does not let a near miss through as a rounding', () => {
    // $250k against $202.6k is 23% out. If the tolerance let that pass, the
    // check would be decorative.
    expect(unverifiedFigures('EBITDA of $250k', briefing, '')).toEqual(['$250k']);
  });

  it('treats the player’s own numbers as a source', () => {
    // "Would a $2M waterpark pay for itself?" has to be answerable without the
    // answer being flagged for repeating the question back.
    const question = 'would a $2M waterpark pay for itself?';
    expect(unverifiedFigures('A $2M build against $202.6k a quarter is ten years.', briefing, question)).toEqual(
      [],
    );
  });

  it('leaves percentages and counts alone', () => {
    // Flagging "about two-thirds of capacity" would train the check to be
    // ignored, and it is not the class §1.1 is about.
    const reply = 'You are at 68% occupancy across 64 rooms, so about a third sits empty.';
    expect(unverifiedFigures(reply, briefing, '')).toEqual([]);
  });

  it('says nothing about zero', () => {
    expect(unverifiedFigures('that costs you $0 to try', briefing, '')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

function transportOf(...replies: TurnAdvice[]): AdviceTransport & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async advise() {
      const next = replies[calls];
      calls += 1;
      if (!next) throw new Error('scripted transport exhausted');
      return { advice: next };
    },
  };
}

const advice = (reply: string, suggestedCommands: string[] = []): TurnAdvice => ({
  reply,
  suggestedCommands,
});

describe('asking, checking, and giving up', () => {
  it('returns a clean answer on the first call', async () => {
    const transport = transportOf(advice('Rate is your lever, not marketing.', ['price 90']));
    const outcome = await askAdvisor(transport, briefing, 'what should I do?');
    expect(outcome?.reply).toMatch(/Rate is your lever/);
    expect(outcome?.suggestedCommands).toEqual(['price 90']);
    expect(transport.calls).toBe(1);
    expect(outcome?.retriedOn).toBeUndefined();
  });

  it('re-asks once when a figure was invented, and says which', async () => {
    const transport = transportOf(
      advice('A waterpark runs about $850k.'),
      advice('A waterpark is a bet that guests will pay more; you supply the cost.'),
    );
    const outcome = await askAdvisor(transport, briefing, 'should I build a waterpark?');
    expect(transport.calls).toBe(2);
    expect(outcome?.reply).toMatch(/bet that guests will pay more/);
    // Recorded rather than silently corrected: a rate that climbs is a prompt
    // that has stopped working, and nobody can see that unless it is counted.
    expect(outcome?.retriedOn).toEqual(['$850k']);
  });

  it('gives up rather than printing a number it cannot source', async () => {
    const transport = transportOf(
      advice('A waterpark runs about $850k.'),
      advice('Call it $900k then.'),
    );
    const outcome = await askAdvisor(transport, briefing, 'should I build a waterpark?');
    expect(transport.calls).toBe(2);
    // Undefined, not a scrubbed reply. The deterministic advisor is already on
    // screen and is still correct; a model that cannot answer without inventing
    // a figure has nothing to add to a screen that already has the numbers.
    expect(outcome).toBeUndefined();
  });

  it('puts the briefing and the question in the same message', async () => {
    let seen = '';
    const transport: AdviceTransport = {
      async advise(_system, messages) {
        seen = messages.map((m) => m.content).join('\n');
        return { advice: advice('Noted.') };
      },
    };
    await askAdvisor(transport, briefing, 'how is occupancy?');
    expect(seen).toContain('Revenue this quarter: $362.0k');
    expect(seen).toContain('how is occupancy?');
  });
});
