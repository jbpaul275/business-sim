import { describe, expect, it, vi } from 'vitest';
import { play } from './play.js';
import type { LineSource } from './input.js';

/**
 * "What do I do now?"
 *
 * Asked three times in one live session and answered three times with
 * `Unknown command "how". Try \`help\``. The product's whole premise is that
 * you talk to it, and the half where the decisions actually happen was a strict
 * verb parser with no on-ramp at all (§11.4: "natural language is the on-ramp,
 * not the only road").
 *
 * The answer is computed from the last tick rather than narrated by a model, so
 * it can be tested — and so it cannot say anything the ledger does not.
 */

function scriptedInput(lines: readonly string[]): LineSource {
  let i = 0;
  return { next: async () => lines[i++], close: () => {} };
}

async function transcript(lines: readonly string[], scenario = 'restaurant'): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await play(scenario, { input: scriptedInput(lines), milestonePeriod: 4 });
    return log.mock.calls.map((c) => String(c[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('asking what to do', () => {
  it('answers a plain-English question with the state of the business', async () => {
    const printed = await transcript(['what do i do now?', 'quit']);
    expect(printed).not.toContain('Unknown command');
    // Something specific about this business, not a restatement of the verbs.
    expect(printed).toMatch(/capacity|runway|EBITDA|Interest/);
  });

  it('catches the shapes a person actually types, typos included', async () => {
    for (const asked of [
      'how can we cut costs?',
      'hwo can we cut costs or increase revnues?',
      'what should I do',
      'why is cash falling',
      'help me understand this',
    ]) {
      const printed = await transcript([asked, 'quit']);
      expect(printed, asked).not.toContain('Unknown command');
    }
  });

  it('answers a request that does not open with a question word', async () => {
    // "we need to cut costs - give me a breakdown of where the money is
    // currently going" fell through twice, because detection worked from a
    // list of interrogative openings and this one opens with "we". The
    // question is not which sentences look like questions — it is which are
    // commands, and that set is closed.
    for (const asked of [
      'we need to cut costs - give me a breakdown of where the money is going',
      'need to cut costs',
      'give me a breakdown',
      'tell me about the staffing',
      'the rent seems high',
    ]) {
      const printed = await transcript([asked, 'quit']);
      expect(printed, asked).not.toContain('Unknown command');
    }
  });

  it('breaks the costs down, biggest line first', async () => {
    // Asked for twice in one session against a screen that showed EBITDA and
    // two subtotals. The advisor could say staffing was $118k; it could not
    // say which line, or that one of them was a third of everything.
    const printed = await transcript(['costs', 'quit']);
    expect(printed).toContain('WHERE THE MONEY GOES');
    expect(printed).toContain('Kitchen line');
    // Each line says what kind of cost it is, because that is what decides
    // whether it can be cut at all.
    expect(printed).toMatch(/% of revenue/);
    expect(printed).toMatch(/fixed, every quarter/);
    expect(printed).toMatch(/`fire \w+`/);
    // And it names the part a decision can actually reach this quarter.
    expect(printed).toContain('staffing you can change this quarter');
  });

  it('orders the breakdown by size, not by how the engine stores it', async () => {
    // Nobody cuts the software subscription first.
    const printed = await transcript(['costs', 'quit']);
    const body = printed.slice(printed.indexOf('WHERE THE MONEY GOES'));
    expect(body.indexOf('Kitchen line')).toBeLessThan(body.indexOf('Permits & licenses'));
  });

  it('answers the question that was asked, not the same one every time', async () => {
    // A campground owner asked "how much will it cost us to quadruple
    // capacity?", then "raise marketing spend then", then explained his
    // reasoning at length — and got the identical four-line paragraph three
    // times. That is worse than `Unknown command`: it looks like an answer, so
    // he read it, found his question absent, and concluded it was not
    // listening.
    const capacity = await transcript(['can we add more capacity?', 'quit']);
    const marketing = await transcript(['should we raise marketing spend?', 'quit']);
    const price = await transcript(['what about raising prices?', 'quit']);

    expect(capacity).not.toBe(marketing);
    expect(marketing).not.toBe(price);
    // And each one is about what was asked.
    expect(capacity).toMatch(/idle|turned away/);
    expect(marketing).toMatch(/marketing <amount>/);
    expect(price).toMatch(/price \d|price <amount>/);
  });

  it('does the arithmetic on the question rather than restating the levers', async () => {
    // "more sites will not help" is an opinion. "you have 7,021 idle" is a
    // fact, and it is the one that settles it.
    const printed = await transcript(['we gotta add more sites', 'quit']);
    expect(printed).toMatch(/idle/);
    expect(printed).toMatch(/sat empty this quarter/);
  });

  it('explains the seasonal swing instead of leaving it to look like collapse', async () => {
    // Revenue went 5k → 18k → 23k → 13k and nothing ever said the shape was
    // designed rather than emergent.
    // The reference restaurant swings 1.17x and should stay quiet; the DTC
    // brand runs 1.61x, which is where it starts being the most confusing
    // thing on the screen.
    const swingy = await transcript(['why does revenue keep swinging?', 'quit'], 'ecommerce');
    expect(swingy).toMatch(/seasonal, not a trend/);
    expect(swingy).toMatch(/Q\d runs at/);
    const steady = await transcript(['what do i do now?', 'quit']);
    expect(steady).not.toMatch(/seasonal, not a trend/);
  });

  it('offers a way to grow when the market, not the building, is the ceiling', async () => {
    // A plumbing shop reached 82% utilisation with no bench, $395k of cash,
    // and nothing left to do: marketing had saturated, price trades volume for
    // margin, and every capacity lever adds room inside a demand pool fixed at
    // concept lock. "let's add another truck so we can expand into a new city"
    // had no expression in the game, and the advisor kept recommending the
    // lever that had already run out.
    const printed = await transcript(['market 40% 150k', 'quit'], 'services');
    expect(printed).not.toContain('Unknown command');
    expect(printed).toContain('new territory');
    // And it reads as a different decision from adding room.
    expect(printed).toMatch(/the new market opens in two/);
  });

  it('says what does move an archetype that has no territory to open', async () => {
    // A flat refusal teaches nothing. Storage grows by building units.
    const printed = await transcript(['market 40% 150k', 'quit'], 'storage');
    expect(printed).toMatch(/expand <units> <cost>/);
  });

  it('will not take a market expansion without a size and a cost', async () => {
    const printed = await transcript(['market', 'quit'], 'services');
    expect(printed).toMatch(/needs a size and a cost/);
  });

  it('still rejects a mistyped command as a mistyped command', async () => {
    // The guard has to stay narrow enough that a fat-fingered verb is a verb.
    const printed = await transcript(['hier', 'quit']);
    expect(printed).toContain('Unknown command');
    // And points at the way out, which the old message did not.
    expect(printed).toContain('plain English');
  });

  it('names the binding constraint rather than listing every lever', async () => {
    // The seeded restaurant opens well under capacity and loses money, so the
    // honest advice is that demand binds and cutting staff will not fix it.
    const printed = await transcript(['what do i do now?', 'quit']);
    expect(printed).toMatch(/of capacity, so the constraint is demand/);
  });

  it('says nothing the ledger does not', async () => {
    // No model, no narration: every figure quoted is one already on screen.
    const printed = await transcript(['skip 2', 'what now?', 'quit']);
    expect(printed).not.toContain('Unknown command');
    expect(printed).not.toMatch(/probably|might want|consider whether/i);
  });
});
