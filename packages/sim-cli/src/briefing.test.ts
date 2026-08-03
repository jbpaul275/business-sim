import { describe, expect, it, vi } from 'vitest';
import { tick } from '@bizsim/engine';
import { unverifiedFigures, type AdviceTransport, type TurnAdvice } from '@bizsim/llm';
import { SCENARIOS } from './scenarios.js';
import { buildBriefing } from './briefing.js';
import { play } from './play.js';
import type { LineSource } from './input.js';

/**
 * What the model is allowed to know, and what happens when it misbehaves.
 *
 * The briefing is the safety mechanism, and it is a data structure rather than
 * an instruction: the model cannot quote a figure the engine did not compute
 * because it is never shown one. These tests are about whether that holds and
 * whether the game survives the model failing in each of the ways it can.
 */

function briefed() {
  const state = SCENARIOS['storage']!();
  const result = tick(state, [], { throwOnAssertionFailure: true });
  const business = result.state.businesses[0]!;
  return {
    briefing: buildBriefing(result.state, business, result, ['You are at 37% of capacity.'], [
      'price',
      'marketing',
      'fire',
    ]),
    business,
  };
}

describe('the briefing', () => {
  it('carries the figures a question about this business would need', () => {
    const { briefing } = briefed();
    for (const label of [
      'Revenue this quarter',
      'EBITDA',
      'Cash in the business',
      'Break-even revenue',
      'Occupancy',
      'Price',
      'Household cash',
    ]) {
      expect(briefing.text, label).toContain(label);
    }
    // Staffing by id, because "cut costs" is meaningless without knowing which
    // lines exist and what a command would have to name.
    expect(briefing.text).toMatch(/Staffing — .* \(id \w+\)/);
  });

  it('carries the variable cost rates, which are the model’s actual assumptions', () => {
    // A vending operator was told his "50-70% margins are already baked into
    // the model" while the model carried a flat 50% product cost the advisor
    // had never been shown. A model that cannot see an assumption cannot be
    // honest about it.
    const { briefing } = briefed();
    expect(briefing.text).toMatch(/Cost rate — .+: .*% of revenue, a model assumption/);
    // And the honest answer is actionable: the assumption id is right there.
    expect(briefing.text).toMatch(/`assume \w+ <pct>` revises it/);
  });

  it('lists what the deterministic advisor already said, so it is not repeated', () => {
    const { briefing } = briefed();
    expect(briefing.text).toContain('do not repeat these');
    expect(briefing.text).toContain('You are at 37% of capacity.');
  });

  it('is the only source the guard will accept', () => {
    // The two halves have to agree: every money figure in the prompt must be in
    // `figures`, or the checker would reject the model for quoting the screen.
    const { briefing } = briefed();
    const quoted = briefing.text.match(/\$[\d,.]+[kmb]?/gi) ?? [];
    expect(quoted.length).toBeGreaterThan(5);
    const reply = `Revenue is ${quoted[0]} and cash is ${quoted[1]}.`;
    expect(unverifiedFigures(reply, briefing, '')).toEqual([]);
  });

  it('renders the commands as a closed list, not a bag of verbs', () => {
    // Handed only names, the model guessed at semantics — and told a vending
    // operator that `quotes` would list new business sites with machine counts.
    const { briefing } = briefed();
    expect(briefing.text).toContain('ONLY levers in this build');
    expect(briefing.text).toContain('- price');
    expect(briefing.text).toContain('not modelled');
  });

  it('does not contain the engine’s state, only its output', () => {
    // Nothing structural: no ids the player never sees, no raw cents, no object
    // dumps. A model that can see the state can compute against it.
    const { briefing } = briefed();
    expect(briefing.text).not.toMatch(/\{|\}|\[object/);
    expect(briefing.text).not.toMatch(/\b\d{7,}\b/);
  });
});

// ---------------------------------------------------------------------------

function scriptedInput(lines: readonly string[]): LineSource {
  let i = 0;
  return { next: async () => lines[i++], close: () => {} };
}

const advice = (reply: string, suggestedCommands: string[] = []): TurnAdvice => ({
  reply,
  suggestedCommands,
});

async function transcript(
  lines: readonly string[],
  advisor?: AdviceTransport,
): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await play('storage', {
      input: scriptedInput(lines),
      milestonePeriod: 4,
      ...(advisor ? { advisor } : {}),
    });
    return log.mock.calls.map((c) => String(c[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('a model in the turn loop', () => {
  it('answers alongside the arithmetic rather than instead of it', async () => {
    const advisor: AdviceTransport = {
      async advise() {
        return {
          advice: advice(
            'A waterpark is a bet that guests will pay more to stay; the percentage is yours.',
            ['upgrade 15% 800k'],
          ),
        };
      },
    };
    const printed = await transcript(['i want to add a waterpark', 'quit'], advisor);
    // Both halves: the deterministic finding and the model's judgement.
    expect(printed).toMatch(/`upgrade <pct> <cost>`/);
    expect(printed).toMatch(/bet that guests will pay more/);
    expect(printed).toMatch(/`upgrade 15% 800k`/);
  });

  it('drops a suggested command that does not exist', async () => {
    // A command that does not parse, coming from the thing that just
    // recommended it, is worse than no suggestion at all.
    const advisor: AdviceTransport = {
      async advise() {
        return { advice: advice('Try this.', ['teleport 3', 'price 400']) };
      },
    };
    const printed = await transcript(['what now?', 'quit'], advisor);
    expect(printed).toContain('`price 400`');
    expect(printed).not.toContain('teleport');
  });

  it('remembers the conversation across questions and quarter boundaries', async () => {
    // The vending session: the player explained that some machines sold
    // higher-margin products — new information — and the very next question
    // was answered by an amnesiac, because history was always passed as [].
    // The account a player gives of their own business is not a quarterly
    // figure; it must survive the quarter running.
    const calls: string[][] = [];
    const advisor: AdviceTransport = {
      async advise(_system, messages) {
        calls.push(messages.map((m) => m.content));
        return { advice: advice('Noted — the split is the lever to look at.') };
      },
    };
    await transcript(
      [
        'our landlord split should be on margin, not revenue',
        '',
        'so what do we change first?',
        'quit',
      ],
      advisor,
    );
    expect(calls).toHaveLength(2);
    const second = calls[1]!.join('\n');
    expect(second).toContain('landlord split should be on margin');
    expect(second).toContain('the split is the lever');
  });

  it('tells the model what each command actually does', async () => {
    // The advisor once told a player `quotes` would list new business sites
    // with machine counts and costs — a screen that has never existed. A model
    // that knows only a command's name describes the command the player
    // wishes existed.
    let briefingText = '';
    const advisor: AdviceTransport = {
      async advise(_system, messages) {
        briefingText = messages.at(-1)?.content ?? '';
        return { advice: advice('Noted.') };
      },
    };
    await transcript(['can I renegotiate my landlord deal?', 'quit'], advisor);
    expect(briefingText).toContain('renegotiated deal terms are recorded');
    expect(briefingText).toContain('Nothing here lists business sites');
    expect(briefingText).toContain('ONLY levers in this build');
  });

  it('says nothing extra when the model invents a figure twice', async () => {
    const advisor: AdviceTransport = {
      async advise() {
        return { advice: advice('Housekeeping alone is about $450k a quarter.') };
      },
    };
    const printed = await transcript(['what should I cut?', 'quit'], advisor);
    // The deterministic answer survives; the fabrication never reaches the
    // player, and nothing apologises at them about it.
    expect(printed).not.toContain('$450k');
    expect(printed).toMatch(/capacity|EBITDA|staffing/);
  });

  it('survives the model failing outright', async () => {
    const advisor: AdviceTransport = {
      async advise() {
        throw new Error('overloaded_error');
      },
    };
    const printed = await transcript(['what should I do?', 'quit'], advisor);
    expect(printed).not.toContain('overloaded_error');
    expect(printed).toMatch(/capacity|EBITDA|staffing/);
  });

  it('plays exactly as before with no model at all', async () => {
    const without = await transcript(['what should I do?', 'quit']);
    expect(without).not.toContain('Unknown command');
    expect(without).toMatch(/capacity|EBITDA|staffing/);
  });
});
