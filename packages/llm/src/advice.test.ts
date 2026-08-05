import { describe, expect, it } from 'vitest';
import {
  askAdvisor,
  parseMoneyToken,
  unverifiedFigures,
  TURN_ADVISOR_PROMPT,
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

  it('does not read "$30,000 marketing" as thirty billion', () => {
    // The suffix must stop at word boundaries: the "m" of "marketing" is not
    // "million". The unguarded regex flagged a reply for restating its own
    // source, which is a retry burned on a parsing artifact.
    expect(unverifiedFigures('a $30,000 marketing push', briefing, 'marketing to $30,000')).toEqual(
      [],
    );
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

const advice = (
  reply: string,
  suggestedCommands: string[] = [],
  extra: Partial<TurnAdvice> = {},
): TurnAdvice => ({
  reply,
  suggestedCommands,
  orderedCommands: [],
  unresolvable: [],
  confirmationSummary: '',
  ...extra,
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

  it('hands the model the conversation so far', async () => {
    // The vending session: "some of our machines sell higher-margin products"
    // was new information, and the very next question was answered by an
    // amnesiac because the history was always passed as [].
    let seen: string[] = [];
    const transport: AdviceTransport = {
      async advise(_system, messages) {
        seen = messages.map((m) => m.content);
        return { advice: advice('Noted.') };
      },
    };
    await askAdvisor(transport, briefing, 'so what do we change first?', [
      { role: 'user', content: 'our coffee machines run higher margins than the packaged goods' },
      { role: 'assistant', content: 'Then the flat product-cost rate is understating them.' },
    ]);
    expect(seen[0]).toContain('higher margins than the packaged goods');
    expect(seen[1]).toContain('understating');
    expect(seen[2]).toContain('so what do we change first?');
  });

  it('treats figures already spoken in the conversation as sourced', async () => {
    // Every figure in the history either passed this guard when it was said or
    // came from the player. Flagging the model for quoting the conversation it
    // is in would train everyone to ignore the guard.
    const transport = transportOf(
      advice('You said the machines do $150 a day; the briefing has nothing near that, so test it.'),
    );
    const outcome = await askAdvisor(transport, briefing, 'what should I do?', [
      { role: 'user', content: 'my best machines do $150 a day' },
      { role: 'assistant', content: 'Placement is doing the work there.' },
    ]);
    // One call — the $150 was not flagged as a fabrication.
    expect(transport.calls).toBe(1);
    expect(outcome?.reply).toContain('$150');
    expect(outcome?.retriedOn).toBeUndefined();
  });
});

describe('translating orders (§11.4)', () => {
  it('passes the translation through beside the reply', async () => {
    const transport = transportOf(
      advice('Staged for you to confirm.', [], {
        orderedCommands: ['price 6.50', 'hire barista 1'],
        unresolvable: ['how much is "a bit" more marketing?'],
        confirmationSummary: 'Price to $6.50 now; the hire costs money this quarter and adds capacity next.',
      }),
    );
    const outcome = await askAdvisor(transport, briefing, 'price to $6.50, hire a barista, and bump marketing a bit');
    expect(outcome?.orderedCommands).toEqual(['price 6.50', 'hire barista 1']);
    expect(outcome?.unresolvable).toEqual(['how much is "a bit" more marketing?']);
    expect(outcome?.confirmationSummary).toContain('capacity next');
  });

  it('holds the confirmation summary to the same money guard as the reply', async () => {
    // The summary goes on screen exactly like the reply. A summary quoting a
    // cost the briefing never produced is the same fabrication in a nicer box.
    const transport = transportOf(
      advice('Staged.', [], {
        orderedCommands: ['hire barista 1'],
        confirmationSummary: 'The hire adds about $850k a quarter.',
      }),
      advice('Staged.', [], {
        orderedCommands: ['hire barista 1'],
        confirmationSummary: 'The hire adds cost this quarter and capacity next.',
      }),
    );
    const outcome = await askAdvisor(transport, briefing, 'hire a barista');
    expect(transport.calls).toBe(2);
    expect(outcome?.retriedOn).toEqual(['$850k']);
    expect(outcome?.confirmationSummary).toContain('capacity next');
  });
});

describe('the advisor prompt frames a business, not a pricing exercise', () => {
  /**
   * The Genki session, condensed: "we're not making any money" was met with
   * price as the only lever, a claim that the player's margins were "already
   * baked in", and a confident description of a `quotes` screen that does not
   * exist. Coarse checks — they cannot prove behaviour, but they fail loudly
   * if someone edits the load-bearing rules away.
   */
  it('names the whole lever panel, not just price', () => {
    expect(TURN_ADVISOR_PROMPT).toContain('Think like an operator, not an economist');
    for (const lever of ['`assume`', '`market`', '`upgrade`', '`fire`']) {
      expect(TURN_ADVISOR_PROMPT, lever).toContain(lever);
    }
  });

  it('treats player information as a model correction, not a debating point', () => {
    expect(TURN_ADVISOR_PROMPT).toContain('New information changes the model');
    expect(TURN_ADVISOR_PROMPT).toContain('it is a model correction');
  });

  it('forbids inventing game mechanics', () => {
    expect(TURN_ADVISOR_PROMPT).toContain('The commands in the briefing are the whole game');
    expect(TURN_ADVISOR_PROMPT).toContain('Never invent a screen, a quote list, a negotiation flow');
  });

  it('forbids claiming a player’s different number is already reflected', () => {
    expect(TURN_ADVISOR_PROMPT).toContain('already baked in');
  });

  it('separates orders from suggestions and forbids guessing amounts (§11.4)', () => {
    expect(TURN_ADVISOR_PROMPT).toContain('When they give an order, translate it');
    expect(TURN_ADVISOR_PROMPT).toContain(
      'Never put anything in `orderedCommands` the player did not express',
    );
    expect(TURN_ADVISOR_PROMPT).toContain('An ambiguous amount goes in `unresolvable`, never guessed');
    expect(TURN_ADVISOR_PROMPT).toContain('The player confirms before anything applies');
  });
});
