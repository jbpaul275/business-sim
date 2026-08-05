import { describe, expect, it } from 'vitest';
import { providerKeyVar, type ConceptTransport, type TurnAdvice, type TurnNarration } from '@bizsim/llm';
import { advanceSession, createSession, type GameSession } from './store';
import { askGame, narrateAdvance, parseSuggestion } from './advisor';

/**
 * The turn loop's contract: every quarter ends with data and ONE question —
 * deterministic, so it works keyless — and the conversation in between goes
 * through the same briefing/guard machinery as the CLI advisor.
 */

const adviceOf = (partial: Partial<TurnAdvice> & { reply: string }): TurnAdvice => ({
  suggestedCommands: [],
  orderedCommands: [],
  unresolvable: [],
  confirmationSummary: '',
  ...partial,
});

function scripted(
  advice: TurnAdvice[],
  narration?: TurnNarration,
): ConceptTransport {
  let i = 0;
  return {
    turn: () => Promise.reject(new Error('no interview in this double')),
    adjudicate: () => Promise.reject(new Error('no adjudication in this double')),
    draft: () => Promise.reject(new Error('no draft in this double')),
    advise: async () => {
      const next = advice[i] ?? advice[advice.length - 1];
      i += 1;
      if (!next) throw new Error('scripted advice exhausted');
      return { advice: next } as never;
    },
    ...(narration ? { narrate: async () => narration } : {}),
  } as unknown as ConceptTransport;
}

describe('the eigen question in the web turn loop', () => {
  it('opens the game with a question and asks one more per quarter', () => {
    const session = createSession('storage');
    const opening = session.advisor.filter((e) => e.kind === 'question');
    expect(opening).toHaveLength(1);
    expect(opening[0]!.text).toMatch(/\?$/);
    expect(opening[0]!.fact).toBeTruthy();

    advanceSession(session, [], 0);
    advanceSession(session, [], 0);
    const questions = session.advisor.filter((e) => e.kind === 'question');
    expect(questions).toHaveLength(3);
    // The repetition memory: no axis two quarters running.
    expect(session.askedAxes[1]).not.toBe(session.askedAxes[2]);
  });

  it('a skip still lands exactly one question, for the rendered quarter', () => {
    const session = createSession('storage');
    advanceSession(session, [], 3);
    const questions = session.advisor.filter((e) => e.kind === 'question');
    expect(questions).toHaveLength(2);
    expect(questions[1]!.period).toBe(session.last.statements.period);
  });
});

describe('the end of a run', () => {
  it('a closed business gets the §9.4 postmortem in the feed, and stops trading', () => {
    const session = createSession('storage');
    advanceSession(session, [], 1);
    // Force the closure the engine's crisis ladder reaches on a broken build
    // (the reference scenarios are calibrated to survive, so closure is
    // staged directly — the state is plain data).
    const business = session.world.businesses.find((b) => b.id === session.businessId)!;
    business.status = 'CLOSED';
    advanceSession(session, [], 0);

    const post = session.advisor.find((e) => e.headline === 'What would have had to be true');
    expect(post).toBeDefined();
    expect(post!.text.length).toBeGreaterThan(40);

    // Frozen at the final traded quarter: advancing a corpse changes nothing,
    // so the last real statements stay on screen for the postmortem.
    const period = session.last.statements.period;
    const logLength = session.log.length;
    advanceSession(session, [], 0);
    expect(session.last.statements.period).toBe(period);
    expect(session.log.length).toBe(logLength);
    // And the postmortem posts exactly once.
    expect(
      session.advisor.filter((e) => e.headline === 'What would have had to be true'),
    ).toHaveLength(1);
  });
});

describe('narration over the quarter', () => {
  it('inserts the update before that quarter\'s question — data first', async () => {
    const session = createSession('storage');
    session.transport = scripted([], {
      headline: 'Lease-up carried the quarter.',
      narrative: 'Occupancy is still climbing toward stabilization, and nothing else moved.',
      suggestedQuestions: [],
    });
    advanceSession(session, [], 0);
    await narrateAdvance(session);

    const period = session.last.statements.period;
    const ofQuarter = session.advisor.filter((e) => e.period === period);
    expect(ofQuarter.map((e) => e.kind)).toEqual(['update', 'question']);
    expect(ofQuarter[0]!.headline).toBe('Lease-up carried the quarter.');
    expect(session.events.some((e) => e.kind === 'narration')).toBe(true);
  });

  it('says nothing when there is no transport and no key', async () => {
    await withoutKey(async () => {
      const session = createSession('storage');
      advanceSession(session, [], 0);
      await narrateAdvance(session);
      expect(session.advisor.filter((e) => e.kind === 'update')).toHaveLength(0);
      // The deterministic question is still there — the loop never needs a key.
      expect(session.advisor.filter((e) => e.kind === 'question').length).toBeGreaterThan(1);
    });
  });
});

describe('the conversation', () => {
  it('answers through the money guard and turns suggestions into staged moves', async () => {
    const session = createSession('storage');
    session.transport = scripted([
      adviceOf({
        reply: 'Occupancy is the lever here; marketing is how you buy it faster.',
        suggestedCommands: ['marketing 25000', 'expand 100 500000'],
      }),
    ]);
    const outcome = await askGame(session, 'What should I focus on first?');
    expect(outcome.ok).toBe(true);

    const chat = session.advisor.filter((e) => e.kind === 'chat');
    expect(chat).toHaveLength(2);
    expect(chat[0]!.who).toBe('you');
    expect(chat[1]!.who).toBe('advisor');
    // Both suggestions now map to web levers and become chips.
    expect(chat[1]!.suggested).toEqual([
      { command: 'marketing 25000', stage: { type: 'marketing', value: 25000 } },
      { command: 'expand 100 500000', stage: { type: 'expand', units: 100, cost: 500_000 } },
    ]);
  });

  it("translates the player's own orders into confirmable staged moves", async () => {
    // §11.4 in the feed: what the player instructed stages on their confirm,
    // what could not be translated is shown rather than guessed at — including
    // an ordered command this build cannot express.
    const session = createSession('storage');
    session.transport = scripted([
      adviceOf({
        reply: 'Staged for you to confirm; price needs a number.',
        orderedCommands: ['marketing 25000', 'buy the moon 5'],
        unresolvable: ['how much is "a bit" more on price?'],
        confirmationSummary: 'Marketing to $25,000 a quarter from the next run.',
      }),
    ]);
    const outcome = await askGame(session, 'set marketing to $25k, buy the moon, raise price a bit');
    expect(outcome.ok).toBe(true);
    const last = session.advisor.at(-1)!;
    expect(last.ordered).toEqual([
      { command: 'marketing 25000', stage: { type: 'marketing', value: 25_000 } },
    ]);
    expect(last.orderedSummary).toContain('$25,000');
    expect(last.unresolvable?.some((u) => u.includes('buy the moon'))).toBe(true);
    expect(last.unresolvable?.some((u) => u.includes('a bit'))).toBe(true);
    expect(session.events.some((e) => e.kind === 'actions_translated')).toBe(true);
  });

  it('replaces an answer that invents money with the honest refusal', async () => {
    const invented: TurnAdvice = adviceOf({
      reply: 'A renovation would cost about $87,654,321 and pay back fast.',
    });
    const session = createSession('storage');
    session.transport = scripted([invented, invented]);
    const outcome = await askGame(session, 'Should I renovate?');
    expect(outcome.ok).toBe(true);
    const last = session.advisor.at(-1)!;
    expect(last.who).toBe('advisor');
    expect(last.text).toContain('without making up a number');
    expect(session.events.some((e) => e.kind === 'advice_refused')).toBe(true);
  });

  it('refuses politely when no key and no transport exist', async () => {
    await withoutKey(async () => {
      const session = createSession('storage');
      const outcome = await askGame(session, 'hello?');
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('key');
    });
  });
});

/** Runs a case with the provider key hidden, so no test can go live. */
async function withoutKey(run: () => Promise<void>): Promise<void> {
  const keyVar = providerKeyVar();
  const prev = process.env[keyVar];
  delete process.env[keyVar];
  try {
    await run();
  } finally {
    if (prev !== undefined) process.env[keyVar] = prev;
  }
}

describe('parseSuggestion', () => {
  const business = (): GameSession['world']['businesses'][number] =>
    createSession('storage').world.businesses[0]!;

  it('parses the web levers and rejects everything else', () => {
    const b = business();
    expect(parseSuggestion('price 95', b)).toEqual({
      command: 'price 95',
      stage: { type: 'price', value: 95 },
    });
    expect(parseSuggestion('marketing $12,000', b)).toEqual({
      command: 'marketing $12,000',
      stage: { type: 'marketing', value: 12000 },
    });
    const line = b.costs.stepFixed[0];
    if (line) {
      expect(parseSuggestion(`hire ${line.id} 2`, b)).toEqual({
        command: `hire ${line.id} 2`,
        stage: { type: 'staff', costId: line.id, delta: 2 },
      });
    }
    expect(parseSuggestion('clone 250000 second-site', b)).toBeUndefined();
    expect(parseSuggestion('assume not_a_real_id 0.4', b)).toBeUndefined();
    expect(parseSuggestion('price minus-forty', b)).toBeUndefined();
  });

  it('parses the growth and money verbs, gated by what the business has', () => {
    const b = business();
    expect(parseSuggestion('expand 40 200000', b)).toEqual({
      command: 'expand 40 200000',
      stage: { type: 'expand', units: 40, cost: 200_000 },
    });
    expect(parseSuggestion('upgrade 15% 250000', b)).toEqual({
      command: 'upgrade 15% 250000',
      stage: { type: 'upgrade', pct: 15, cost: 250_000 },
    });
    // Storage is OCCUPANCY — no territory to open.
    expect(parseSuggestion('market 40% 150000', b)).toBeUndefined();
    expect(parseSuggestion('debt 300000 20', b)).toEqual({
      command: 'debt 300000 20',
      stage: { type: 'debt', amount: 300_000, quarters: 20 },
    });
    expect(parseSuggestion('inject 50000', b)).toEqual({
      command: 'inject 50000',
      stage: { type: 'inject', amount: 50_000 },
    });
    expect(parseSuggestion('distribute 25000', b)).toEqual({
      command: 'distribute 25000',
      stage: { type: 'distribute', amount: 25_000 },
    });
    // An upgrade that more than doubles willingness to pay is a different business.
    expect(parseSuggestion('upgrade 400% 100000', b)).toBeUndefined();
  });

  it('validates assume ids against the actual register', () => {
    const b = business();
    const id = Object.keys(b.assumptions.byId)[0]!;
    expect(parseSuggestion(`assume ${id} 0.35`, b)).toEqual({
      command: `assume ${id} 0.35`,
      stage: { type: 'assume', assumptionId: id, value: '0.35' },
    });
  });
});
