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

  it('does not pick a line for you when you did not name one', async () => {
    // A bare `fire` queued a redundancy against whichever line happened to be
    // first, because every string starts with the empty string and `findLine`
    // matched on prefix. The player meant "help me decide".
    const printed = await transcript(['fire', 'quit'], 'understaffed');
    expect(printed).toMatch(/Which line\?/);
    expect(printed).not.toContain('queued:');
  });

  it('refuses a cut that cannot happen now, not three months from now', async () => {
    // The engine rejects a cut below a line's minimum — correctly — but does
    // it when the quarter runs. A player fired a barista, was told `[1
    // queued]`, ran the quarter, and only then read "already at its minimum
    // block count".
    const printed = await transcript(['fire kitchen 99', 'quit'], 'understaffed');
    expect(printed).toMatch(/minimum/);
    expect(printed).not.toContain('queued:');
  });

  it('answers how many can go, with the arithmetic', async () => {
    // "how many people can we fire without hurting service quality?" is
    // answerable — the engine knows what each block carries and what volume
    // turned up — and was answered with a restatement of the totals.
    const printed = await transcript(['how many can we fire?', 'quit'], 'restaurant');
    expect(printed).toMatch(/blocks carrying|is what this quarter's volume needs/);
  });

  it('names overstaffing as the lever, instead of denying it is one', async () => {
    // "cutting staff you have already paid for does not help" was said to a
    // cafe carrying four barista blocks against demand needing two, where
    // cutting was the single most useful thing available. Idle capacity does
    // not mean the cost structure is right-sized; it usually means the
    // opposite.
    const printed = await transcript(['how can we raise revenues?', 'quit']);
    expect(printed).toMatch(/blocks this quarter's volume does not need/);
    expect(printed).toMatch(/`fire \w+ \d+`/);
    expect(printed).not.toMatch(/cutting staff you have already paid for does not/);
  });

  it('prices a cut that goes below demand, and makes it anyway', async () => {
    // "I'm fine with warnings: if you cut kitchen staff you'll need to cut the
    // hours fresh food is available. Cutting staff should probably hurt
    // revenues — but since I'm going broke at full staffing, that's what I
    // gotta do."
    //
    // The engine already models the consequence: a line below what demand
    // needs becomes the binding constraint. What was missing is the price tag
    // at the moment of the decision — and it must stay a warning, because
    // going broke slowly is the worse outcome and only the player can weigh
    // that.
    const printed = await transcript(['fire kitchen_labor 5', 'quit']);
    expect(printed).toMatch(/below what demand needs/);
    expect(printed).toMatch(/customers a quarter turned away/);
    expect(printed).toMatch(/of revenue, to save .* of pay/);
    // Warned, not refused.
    expect(printed).toContain('queued: fire 5');
  });

  it('says nothing when the cut comes out of slack', async () => {
    // A warning that fires on a cut with no consequence is noise, and teaches
    // the player to skip the one that matters.
    const printed = await transcript(['fire kitchen_labor 1', 'quit']);
    expect(printed).toContain('queued: fire 1');
    expect(printed).not.toMatch(/below what demand needs/);
  });

  it('prices the trade rather than delivering a verdict on it', async () => {
    // "Cutting here turns customers away rather than saving money" was a
    // judgement it had not checked. Both numbers, and the player decides.
    const printed = await transcript(['how many can we fire?', 'quit'], 'understaffed');
    expect(printed).toMatch(/Each one you cut turns away about [\d,]+ customers/);
    expect(printed).toMatch(/of revenue against .* of pay/);
  });

  it('answers the question the occupancy archetype is named after', async () => {
    // "how can we get occupancy up?" — asked of a hotel running at 68% of its
    // keys, answered with "Nothing is obviously binding this quarter", because
    // the word `occupancy` appeared in none of the topic patterns and the
    // question fell through to the general diagnosis.
    const printed = await transcript(['how can we get occupancy up?', 'quit'], 'storage');
    expect(printed).not.toMatch(/Nothing is obviously binding/);
    expect(printed).toMatch(/of 620 units/);
    // The ceiling, which is the actual answer: stabilized occupancy, and the
    // one lever that moves it.
    expect(printed).toMatch(/tops out near/);
    expect(printed).toMatch(/stabilized occupancy/);
  });

  it('says marketing does nothing when the model gives it nothing to do', async () => {
    // §3.0.2 exempts OCCUPANCY from the marketing multiplier: the spend is
    // expensed and demand never reads it. A hotel owner at $18k a quarter was
    // told his spend had "saturated" — an explanation of a curve the engine
    // does not evaluate for this archetype, and the reason he kept paying it.
    const printed = await transcript(['should we raise marketing spend?', 'quit'], 'storage');
    expect(printed).toMatch(/does not move this archetype/);
    expect(printed).toMatch(/`marketing 0`/);
    expect(printed).not.toMatch(/half-saturation/);
    // And it is named as a simplification rather than a fact about hotels.
    expect(printed).toMatch(/simplification/);
  });

  it('quotes the price in the units the player is thinking in', async () => {
    // `price 8213` is what the engine stores and what the command takes. It is
    // also incomprehensible to someone who has spent the session thinking in a
    // nightly rate, and nothing on screen connected the two.
    const printed = await transcript(['what about raising prices?', 'quit'], 'storage');
    expect(printed).toMatch(/per unit per quarter/);
    expect(printed).toMatch(/a month/);
  });

  it('computes the optimal price instead of restating that elasticity exists', async () => {
    // "what's the optimal price?" was answered with the same elasticity
    // paragraph the player had already read twice, which never contained a
    // price. Either a price or the finding that there is not one — never a
    // description of the mechanism.
    const printed = await transcript(['what is the optimal price?', 'quit'], 'storage');
    expect(printed).toMatch(/Contribution (peaks at|barely moves)|nothing to win here/);
  });

  it('routes a question by what it leads with, not by rule order', async () => {
    // "how could we support higher prices when we're only at 68% occupancy as
    // is?" is a pricing question that mentions occupancy. "what's our occupancy
    // rate?" is an occupancy question that mentions a rate. A fixed rule order
    // gets one of them wrong whichever way it is written; where the subject
    // appears is the better signal, because the thing being asked about leads.
    const priced = await transcript(
      ['how could we support higher prices when we are only at 20% occupancy?', 'quit'],
      'storage',
    );
    expect(priced).toMatch(/per unit per quarter/);
    expect(priced).not.toMatch(/tops out near/);

    const filled = await transcript(['what is our occupancy rate?', 'quit'], 'storage');
    expect(filled).toMatch(/tops out near/);
    expect(filled).not.toMatch(/per unit per quarter/);
  });

  it('does not answer two different questions with the same paragraph', async () => {
    // "woah so we're probably overspending on marketing" got the marketing
    // paragraph the player had just been shown, verbatim; "what's the optimal
    // price?" got the price paragraph, verbatim. Repeating an answer word for
    // word says the second thing you typed was not read.
    const printed = await transcript(
      ['should we raise marketing spend?', 'so we are overspending on marketing?', 'quit'],
      'storage',
    );
    const lines = printed.split('\n').filter((l) => l.includes('does not move this archetype'));
    expect(lines.length).toBe(1);
  });

  it('says so plainly when it has genuinely run out of new things to say', async () => {
    const printed = await transcript(
      [
        'should we raise marketing spend?',
        'so we are overspending on marketing?',
        'what about the marketing budget?',
        'marketing though?',
        'quit',
      ],
      'storage',
    );
    expect(printed).toMatch(/Same answer as last time/);
  });

  it('still rejects a mistyped command as a mistyped command', async () => {
    // The guard has to stay narrow enough that a fat-fingered verb is a verb.
    const printed = await transcript(['hier', 'quit']);
    expect(printed).toContain('Unknown command');
    // And points at the way out, which the old message did not.
    expect(printed).toContain('plain English');
  });

  it('names the binding constraint rather than listing every lever', async () => {
    // The seeded restaurant opens well under capacity and loses money. Demand
    // is short — and it is also carrying staff the volume does not need, which
    // is the half the player controls this quarter.
    const printed = await transcript(['what do i do now?', 'quit']);
    expect(printed).toMatch(/of capacity/);
    expect(printed).toMatch(/staffed for the building rather than the demand/);
  });

  it('says nothing the ledger does not', async () => {
    // No model, no narration: every figure quoted is one already on screen.
    const printed = await transcript(['skip 2', 'what now?', 'quit']);
    expect(printed).not.toContain('Unknown command');
    expect(printed).not.toMatch(/probably|might want|consider whether/i);
  });
});
