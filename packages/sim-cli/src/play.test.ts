import { describe, expect, it, vi } from 'vitest';
import type { TurnNarration } from '@bizsim/llm';
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

async function transcript(
  lines: readonly string[],
  scenario = 'restaurant',
  // Four quarters is enough for most of these and keeps them fast. Anything
  // with a lead time in it — a clone, a buildout — needs the run to outlive the
  // scoreboard, or the milestone ends it before the decision lands.
  milestonePeriod = 4,
): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await play(scenario, { input: scriptedInput(lines), milestonePeriod });
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

  it('answers "how do I pay off my loan?" with how to pay it off', async () => {
    // Answered with `debt <amount> raises a term loan` — how to borrow, to
    // someone asking how to stop owing. He worked out the rest himself and
    // typed `debt -$400k`.
    const printed = await transcript(['how do I pay off my SBA loan?', 'quit'], 'storage');
    expect(printed).toMatch(/`repay <amount>`/);
    expect(printed).toMatch(/outstanding|You owe/);
    expect(printed).not.toMatch(/raises a term loan/);
  });

  it('pays principal down when told to', async () => {
    const printed = await transcript(['repay 300k', '', 'quit'], 'storage');
    expect(printed).toContain('queued: repay $300,000');
    expect(printed).not.toContain('Unknown command');
  });

  it('clears a facility on `repay all`', async () => {
    const printed = await transcript(['repay all', 'quit'], 'storage');
    expect(printed).toMatch(/queued: repay \$2,/);
  });

  it('refuses a negative amount instead of booking a mirror-image of the action', async () => {
    // `debt -$400k` was accepted, and the ledger grew a facility with -$400,000
    // outstanding, drawn as a $400k outflow, accruing interest on a negative
    // balance — while every articulation assertion still passed.
    const printed = await transcript(['debt -400k', 'quit'], 'storage');
    expect(printed).not.toContain('queued');
    expect(printed).toMatch(/negative `debt` is not the opposite/);
    // And it names the verb he was reaching for.
    expect(printed).toMatch(/`repay <amount>`/);
  });

  it('refuses the same trick on every other money command', async () => {
    for (const [command, expected] of [
      ['draw -50k', /`repay <amount> revolver`/],
      ['inject -50k', /`distribute <amount>`/],
      ['distribute -50k', /`inject <amount>`/],
      ['repay -50k', /`debt <amount>`/],
      ['marketing -5k', /cannot be negative/],
      ['price -20', /more than zero/],
    ] as const) {
      const printed = await transcript([command, 'quit'], 'storage');
      expect(printed, command).toMatch(expected);
      expect(printed, command).not.toContain('queued');
    }
  });

  it('engages with building something new instead of pointing at idle capacity', async () => {
    // "I want to expand the hotel, add a small indoor waterpark" — asked three
    // times, answered three times with "you already have 19 idle". The idle
    // rooms are the reason to build the waterpark, not the argument against it.
    const printed = await transcript(['i want to add an indoor waterpark', 'quit'], 'storage');
    expect(printed).toMatch(/`upgrade <pct> <cost>`/);
    expect(printed).not.toMatch(/sat empty this quarter/);
    // It prices the trade in both directions rather than picking one.
    expect(printed).toMatch(/more volume at today's rate/);
    expect(printed).toMatch(/a quarter instead/);
  });

  it('books the improvement on the player’s own numbers', async () => {
    const printed = await transcript(['upgrade 15% 800k', 'quit'], 'storage');
    expect(printed).toMatch(/queued: \+15% willingness to pay for \$800,000/);
    expect(printed).toMatch(/the improvement opens in two/);
  });

  it('will not invent the number the player has to supply', async () => {
    const printed = await transcript(['upgrade', 'quit'], 'storage');
    expect(printed).toMatch(/needs a claim and a cost/);
    expect(printed).not.toContain('queued');
  });

  it('tells an occupancy business that rooms are not seats', async () => {
    // "You already have 19 idle — more capacity earns nothing until demand
    // catches up" is true of a demand pool fixed at concept lock, and false
    // here: OCCUPANCY demand is units × occupancy, so more units is more
    // demand at the same rate.
    const printed = await transcript(['should we double the room count?', 'quit'], 'storage');
    expect(printed).toMatch(/occupancy is a rate here/);
    expect(printed).not.toMatch(/earns nothing until demand catches up/);
    // And it flags where the model is being generous rather than hiding it.
    expect(printed).toMatch(/generous case/);
  });

  it('says a second property is not in this build, once, instead of answering something else', async () => {
    // "I want to use the cash flow from this one to buy a 256 room property in
    // Des Moines" was answered with "you are at 57.6% of capacity, so the
    // constraint is demand".
    const printed = await transcript(['i want to buy another hotel', 'quit'], 'storage');
    expect(printed).toMatch(/not in this build/);
    expect(printed).not.toMatch(/the constraint is demand/);
  });

  it('does not silently throw away queued decisions when you skip', async () => {
    // `upgrade 15% 800k` then `skip 6` ran six quarters that looked exactly
    // like doing nothing, because skip advanced with an empty action list and
    // the queue was dropped without a word.
    const withUpgrade = await transcript(['upgrade 15% 800k', 'skip 6', 'quit'], 'storage');
    const without = await transcript(['skip 6', 'quit'], 'storage');
    expect(withUpgrade).toMatch(/Running 1 queued decision/);
    // The message is not the fix. The quarters have to actually differ.
    const revenue = (t: string): string[] => t.match(/Revenue\s+\$[\d.]+k/g) ?? [];
    expect(revenue(withUpgrade).length).toBeGreaterThan(1);
    expect(revenue(withUpgrade)).not.toEqual(revenue(without));
  });

  it('lets the household buy and sell, which it never could', async () => {
    // "I want to invest my money in coca cola stock" was answered, eventually,
    // with a refusal. The refusal was right about the product and wrong about
    // the need.
    const printed = await transcript(['quotes', 'buy IDX 200k', '', 'portfolio', 'quit'], 'storage');
    expect(printed).toMatch(/TICKER {2}PRICE/);
    expect(printed).toMatch(/queued: invest \$200,000 in IDX/);
    expect(printed).toMatch(/IDX.*sh.*cost/);
    // The portfolio shows on the turn screen once there is one.
    expect(printed).toMatch(/Portfolio/);
  });

  it('says where the money has to come from', async () => {
    // Company cash cannot buy shares. It has to be distributed first, and taxed
    // on the way, which is both what happens in life and the useful lesson.
    const printed = await transcript(
      ['buy IDX 500k', '', 'buy IDX 500k', '', 'buy IDX 500k', '', 'buy IDX 5m', 'quit'],
      'storage',
    );
    expect(printed).toMatch(/Household cash is|distribute <amount>/);
  });

  it('will not buy a ticker that does not exist', async () => {
    const printed = await transcript(['buy NVDA 100k', 'quit'], 'storage');
    expect(printed).toMatch(/No security called "NVDA"/);
    expect(printed).toMatch(/IDX/);
    expect(printed).not.toContain('queued');
  });

  it('will not sell what is not held', async () => {
    const printed = await transcript(['sell IDX all', 'quit'], 'storage');
    expect(printed).toMatch(/do not hold anything/);
    expect(printed).not.toContain('queued');
  });

  it('scores the whole run against leaving the money alone', async () => {
    // The number the game never had. A business that returned 9% over a decade
    // should have to say so next to what the index did.
    const printed = await transcript(['skip 40', 'quit'], 'storage');
    expect(printed).toMatch(/You started with .* and ended with/);
    expect(printed).toMatch(/The same money in broad market index fund, untouched/);
    expect(printed).toMatch(/beat (it|you) by/);
  });

  it('answers a question about the market with the market', async () => {
    const printed = await transcript(['how does this compare to just buying the index?', 'quit'], 'storage');
    expect(printed).toMatch(/`buy <ticker> <amount>`/);
    expect(printed).toMatch(/scored against leaving your whole starting stake/);
    expect(printed).not.toMatch(/staffed for the building/);
  });

  it('explains a failure instead of ending on a liquidation figure', async () => {
    // §9.4: the post-mortem is mandatory on insolvency. "For a prospective
    // founder, this is the single most valuable output the product can
    // generate — it converts a loss into a specific, checkable claim about the
    // real world." A run used to end with a number and no reason.
    const printed = await transcript(['fire kitchen_labor 5', '', 'skip 40', 'quit']);
    expect(printed).toMatch(/WHAT WOULD HAVE HAD TO BE TRUE/);
    expect(printed).toMatch(/covers\/day to break even/);
    expect(printed).toMatch(/holds everything else at what it actually was/);
  });

  it('answers on demand, which is the half that matters', async () => {
    // A player who can ask this in period 12 can still act on the answer.
    const printed = await transcript(['skip 2', 'postmortem', 'quit'], 'storage');
    expect(printed).toMatch(/What (would have had to be true|it rests on)/);
    expect(printed).toMatch(/to break even/);
  });

  it('takes the question in English too', async () => {
    const printed = await transcript(['skip 2', 'what went wrong?', 'quit'], 'storage');
    expect(printed).toMatch(/to break even/);
    expect(printed).not.toContain('Unknown command');
  });

  it('does not let a bare `why` swallow every why-question', async () => {
    // Making `why` a verb outright routes "why does revenue keep swinging?"
    // into the post-mortem — the exact failure the topic router exists to stop.
    const swing = await transcript(['why does revenue keep swinging?', 'quit'], 'ecommerce');
    expect(swing).toMatch(/seasonal, not a trend/);
    expect(swing).not.toMatch(/to break even/);

    const bare = await transcript(['why', 'quit'], 'ecommerce');
    expect(bare).toMatch(/to break even/);
  });

  it('does not tell a working business what went wrong', async () => {
    const printed = await transcript(['skip 2', 'postmortem', 'quit'], 'cash-crunch');
    expect(printed).toMatch(/What it rests on/);
    expect(printed).toMatch(/clear by/);
  });

  it('prices a marketing rise at the moment it is made', async () => {
    // "Raising marketing spend doesn't seem to increase sales." It did not, and
    // the engine was right not to: past twice the half-saturation point the
    // response curve is flat, and $30k a quarter more bought about two percent
    // of demand. The engine was correct and the screen was silent, which is the
    // worst combination — the player waited two quarters and concluded the
    // lever was broken.
    const printed = await transcript(['marketing 50k', 'quit']);
    expect(printed).toMatch(/more buys about [\d.]+% more demand/);
    expect(printed).toMatch(/half-saturation point of/);
    expect(printed).toMatch(/this lever is close to spent/);
    // Warned, not refused.
    expect(printed).toContain('queued: marketing');
  });

  it('does not call a lever spent because the step was small', async () => {
    // A $1k rise buying 1% is the curve behaving, not a dead lever.
    const printed = await transcript(['marketing 9k', 'quit']);
    expect(printed).toMatch(/more buys about/);
    expect(printed).not.toMatch(/close to spent/);
  });

  it('says marketing does nothing at all where the archetype ignores it', async () => {
    const printed = await transcript(['marketing 50k', 'quit'], 'storage');
    expect(printed).toMatch(/does not move demand for this archetype/);
    expect(printed).toContain('queued: marketing');
  });

  it('opens a second one, and shows both', async () => {
    // "I want to use the cash flow from this one to buy a 256 room property in
    // Des Moines" was answered with "you are at 57.6% of capacity" for most of
    // this project's life.
    const printed = await transcript(
      ['distribute 900k', '', 'clone 900k Rochester', '', '', '', 'businesses', 'quit'],
      'restaurant',
      12,
    );
    expect(printed).toMatch(/queued: open Rochester for \$900,000/);
    expect(printed).toMatch(/Rochester/);
    // Both on the books, with the active one marked.
    expect(printed).toMatch(/1\. Reference Restaurant/);
    expect(printed).toMatch(/2\. Rochester/);
    // And the turn screen says the other one exists without leaving this one.
    expect(printed).toMatch(/Also running/);
    expect(printed).toMatch(/group revenue/);
  });

  it('quotes the buildout before the money moves', async () => {
    const printed = await transcript(
      ['distribute 2m', '', 'clone 2m Rochester 3x', 'quit'],
      'restaurant',
    );
    expect(printed).toMatch(/3× the size/);
    expect(printed).toMatch(/Buildout alone is/);
    expect(printed).toMatch(/Revenue starts two quarters out/);
  });

  it('will not open one the household cannot pay for', async () => {
    const printed = await transcript(['clone 50m Rochester', 'quit'], 'restaurant');
    expect(printed).toMatch(/The household has/);
    expect(printed).toMatch(/`distribute <amount>`/);
    expect(printed).not.toContain('queued: open');
  });

  it('needs a name, because a portfolio of unnamed copies is unusable', async () => {
    const printed = await transcript(['clone 900k', 'quit'], 'restaurant');
    expect(printed).toMatch(/needs a name|needs the money and a name/);
    expect(printed).not.toContain('queued: open');
  });

  it('switches which business the commands are about', async () => {
    const printed = await transcript(
      ['distribute 900k', '', 'clone 900k Rochester', '', '', '', 'switch 2', 'price 50', 'quit'],
      'restaurant',
      12,
    );
    expect(printed).toMatch(/Now looking at Rochester/);
    expect(printed).toMatch(/queued: price/);
  });

  it('sells one, on its own verb', async () => {
    // `sell` belongs to securities. A portfolio needs its own word or the two
    // collide on the one command a player is most likely to get wrong.
    const printed = await transcript(
      ['distribute 900k', '', 'clone 900k Rochester', '', '', '', 'divest 2', 'quit'],
      'restaurant',
      12,
    );
    expect(printed).toMatch(/trailing EBITDA/);
    expect(printed).toMatch(/It closes in two quarters/);
    expect(printed).toMatch(/queued: sell the business/);
  });

  it('keeps playing past the milestone when asked', async () => {
    // Ten years is where the spec stops scoring, not where a business stops.
    const printed = await transcript(['skip 40', 'yes', 'quit'], 'restaurant');
    expect(printed).toMatch(/Ten-year milestone reached/);
    // The question itself is a prompt rather than a printed line, so what is
    // observable is the answer to it.
    expect(printed).toMatch(/Playing on/);
  });

  it('stops at the milestone on a blank line', async () => {
    const printed = await transcript(['skip 40', '', 'quit'], 'restaurant');
    expect(printed).toMatch(/Ten-year milestone reached/);
    expect(printed).not.toMatch(/Playing on/);
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
    expect(printed).toMatch(/of what you are staffed for/);
    expect(printed).toMatch(/staffed for the plan rather than the demand/);
    // Never "the building". The ceiling is active blocks × capacityPerBlock —
    // a staffing number, not a physical one — and calling it a building is how
    // a phone game got told it was at "34.8% of capacity (1,500)".
    expect(printed).not.toMatch(/the building/);
  });

  it('says nothing the ledger does not', async () => {
    // No model, no narration: every figure quoted is one already on screen.
    const printed = await transcript(['skip 2', 'what now?', 'quit']);
    expect(printed).not.toContain('Unknown command');
    expect(printed).not.toMatch(/probably|might want|consider whether/i);
  });
});


/**
 * §11.5 — the narration over each quarter. What is tested is the wiring, not
 * the prose: it prints when the model behaves, stays silent when the guard
 * fires twice, and runs once per pause rather than once per skipped quarter.
 */
describe('narrating the quarter', () => {
  const CLEAN: TurnNarration = {
    headline: 'A quiet quarter with the ramp still climbing.',
    narrative: 'Demand rose with the ramp and nothing structural moved.',
    suggestedQuestions: ['is the staffing right for next quarter?'],
  };

  const advisorWith = (replies: TurnNarration[]) => {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      advise: async () => ({ advice: { reply: 'x', suggestedCommands: [] } }),
      narrate: async (_system: string, input: string) => {
        calls.push(input);
        const next = replies[i] ?? replies[replies.length - 1]!;
        i += 1;
        return next;
      },
    };
  };

  const narrated = async (
    lines: readonly string[],
    advisor: ReturnType<typeof advisorWith>,
  ): Promise<string> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await play('restaurant', { input: scriptedInput(lines), milestonePeriod: 4, advisor });
      return log.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      log.mockRestore();
    }
  };

  it('prints the headline and narrative over the quarter screen', async () => {
    const printed = await narrated(['quit'], advisorWith([CLEAN]));
    expect(printed).toContain('A quiet quarter with the ramp still climbing.');
    expect(printed).toContain('nothing structural moved');
    expect(printed).toContain('worth asking');
  });

  it('narrates once per pause, not once per skipped quarter', async () => {
    // `skip 4` is one pause: the player reads one screen, so they get one
    // paragraph. Narrating all four would be four model calls nobody reads.
    const advisor = advisorWith([CLEAN]);
    await narrated(['skip 2', 'quit'], advisor);
    // Once for the opening render, once after the skip.
    expect(advisor.calls.length).toBe(2);
  });

  it('hands the model last quarter and the events, or it cannot narrate change', async () => {
    const advisor = advisorWith([CLEAN]);
    await narrated(['', 'quit'], advisor);
    // The second narration (after one played quarter) carries the prior one.
    expect(advisor.calls[1]).toContain('Last quarter revenue');
    expect(advisor.calls[1]).toMatch(/Event \d+ this quarter|deterministic advisor found nothing/);
  });

  it('prefers silence to a narration that keeps inventing figures', async () => {
    const fabricating: TurnNarration = {
      headline: 'Costs hit $999k this quarter.',
      narrative: 'Spending $999k was the story.',
      suggestedQuestions: [],
    };
    const printed = await narrated(['quit'], advisorWith([fabricating, fabricating]));
    expect(printed).not.toContain('$999k');
  });
});
