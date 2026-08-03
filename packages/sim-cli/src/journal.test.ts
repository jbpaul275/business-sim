import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions, openJournal, readSession } from './journal.js';

/**
 * "are we logging these conversations somewhere? at scale we'll want some
 * systemic way to examine them."
 *
 * Nothing was. A dozen sessions were diagnosed by pasting a terminal buffer
 * into chat, which works at one a day and loses exactly the runs worth having
 * — a session that crashes is a session whose scrollback ends mid-sentence.
 */

let dir: string;
const env = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bizsim-journal-'));
  process.env['BIZSIM_JOURNAL_DIR'] = dir;
  delete process.env['BIZSIM_NO_JOURNAL'];
});

afterEach(() => {
  process.env = { ...env };
  rmSync(dir, { recursive: true, force: true });
});

describe('recording a session', () => {
  it('flushes each event as it happens, not at the end', () => {
    // The failures worth recording are crashes. A journal that writes on clean
    // shutdown records only the sessions that did not need recording.
    const journal = openJournal('scoop-shop');
    journal.write({ kind: 'session', build: 'abc1234', startedAt: '2026-01-01T00:00:00Z', startCapital: '$1,000,000' });
    journal.write({ kind: 'turn', index: 0, player: 'an ice cream shop', message: 'Where?', cta: 'Which town?', ms: 4200, thinkingTokens: 19, calls: 1 });

    // Read it back mid-session, with no close() having been called.
    const lines = readFileSync(journal.path!, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('session');
    expect(JSON.parse(lines[1]!).player).toBe('an ice cream shop');
  });

  it('stamps every event with a time, so a slow turn is visible after the fact', () => {
    const journal = openJournal('x');
    journal.write({ kind: 'end', reason: 'quit' });
    expect(JSON.parse(readFileSync(journal.path!, 'utf8').trim()).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records nothing when told not to', () => {
    // These files contain business ideas someone typed in confidence.
    process.env['BIZSIM_NO_JOURNAL'] = '1';
    const journal = openJournal('private');
    journal.write({ kind: 'end', reason: 'quit' });
    expect(journal.path).toBeUndefined();
    expect(listSessions(dir)).toEqual([]);
  });

  it('never lets a journal failure reach the player', () => {
    // A read-only filesystem, a full disk, a missing permission — the
    // recording is for us and the session is for them.
    // A file where a directory should be — ENOTDIR, which is the same shape
    // of failure as a read-only mount without depending on one existing.
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    process.env['BIZSIM_JOURNAL_DIR'] = join(blocked, 'sessions');
    const journal = openJournal('doomed');
    expect(journal.path).toBeUndefined();
    expect(() => journal.write({ kind: 'end', reason: 'quit' })).not.toThrow();
  });
});

describe('reading sessions back', () => {
  const write = (name: string, events: unknown[]): void =>
    writeFileSync(join(dir, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  it('summarises what happened, including how it ended', () => {
    write('2026-01-01-a.jsonl', [
      { kind: 'session', build: 'abc1234', startedAt: '2026-01-01T10:00:00Z' },
      { kind: 'turn', index: 0, player: 'a campground', message: 'x', cta: 'y', ms: 1, thinkingTokens: 0, calls: 1 },
      { kind: 'draft', businessName: '320-Acre TN Campground', archetype: 'OCCUPANCY', draft: {}, ms: 58_000 },
      { kind: 'call', call: 'turn', provider: 'kimi', model: 'kimi-k3', effort: 'low', ms: 4_000, inputTokens: 6_000, cachedInputTokens: 5_000, outputTokens: 1_100, thinkingTokens: 800, costUsd: 0.0195, ratesKnown: true, attempt: 1, ok: true },
      { kind: 'call', call: 'draft', provider: 'kimi', model: 'kimi-k3', effort: 'high', ms: 58_000, inputTokens: 9_000, cachedInputTokens: 8_000, outputTokens: 12_000, thinkingTokens: 9_000, costUsd: 0.1854, ratesKnown: true, attempt: 1, ok: true },
      { kind: 'commit', committed: true, equity: '$1,000,000', termDebt: '$3,383', openingCash: '$18,691', monthZero: '$984,691' },
      { kind: 'quarter', period: 0, revenue: '$5,200', ebitda: '-$25,600', cash: '$321', events: ['CASH_CRISIS'] },
      { kind: 'quarter', period: 1, revenue: '$18,300', ebitda: '-$14,900', cash: '$1,200', events: [] },
    ]);

    const [s] = listSessions(dir);
    expect(s!.businessName).toBe('320-Acre TN Campground');
    expect(s!.outcome).toBe('committed');
    expect(s!.turns).toBe(1);
    expect(s!.quarters).toBe(2);
    expect(s!.build).toBe('abc1234');
    expect(s!.costUsd).toBeCloseTo(0.2049, 6);
    // The three facts a quality-versus-cost comparison across sessions needs,
    // and which the old session-level `spend` total could not supply.
    expect(s!.models).toEqual(['kimi-k3']);
    expect(s!.calls).toBe(2);
    expect(s!.waitedSeconds).toBe(62);
  });

  it('counts the quality signals, which cost alone cannot settle', () => {
    /**
     * A model is only cheaper if it does the job. `fabricatedFigures` is the
     * one that matters most: every time the advisor quoted money the ledger
     * never produced and had to be re-asked. §1.1 forbids the model computing
     * anything that lands on a statement, and nobody can tell a fabricated
     * figure from a real one by reading it — so a model that does this more
     * often is worse in the way hardest to notice and most expensive to miss.
     */
    write('2026-02-01-q.jsonl', [
      { kind: 'session', build: 'q', startedAt: '2026-02-01T10:00:00Z' },
      { kind: 'call', call: 'draft', provider: 'kimi', model: 'kimi-k3', effort: 'high', ms: 40_000, inputTokens: 9_000, cachedInputTokens: 8_000, outputTokens: 30_000, thinkingTokens: 28_000, costUsd: 0.45, ratesKnown: true, attempt: 1, ok: false, failure: 'BudgetExhaustedError' },
      { kind: 'call', call: 'draft', provider: 'kimi', model: 'kimi-k3', effort: 'low', ms: 52_000, inputTokens: 9_000, cachedInputTokens: 8_000, outputTokens: 12_000, thinkingTokens: 9_000, costUsd: 0.19, ratesKnown: true, attempt: 2, ok: true },
      { kind: 'asked', question: 'how do i grow', answered: ['x'] },
      { kind: 'asked', question: 'should i raise price', answered: ['x'] },
      { kind: 'advice_corrected', question: 'how do i grow', figures: ['$412k'] },
      { kind: 'cancelled' },
    ]);
    const s = listSessions(dir).find((x) => x.build === 'q')!;
    expect(s.retriedCalls).toBe(1);
    expect(s.failedCalls).toBe(1);
    expect(s.questionsAsked).toBe(2);
    expect(s.fabricatedFigures).toBe(1);
    expect(s.cancelled).toBe(1);
    // The truncated attempt is priced in. It was billed, and a comparison that
    // drops it makes the model that truncates look like the cheap one.
    expect(s.costUsd).toBeCloseTo(0.64, 6);
  });

  it('reports no cost for a session recorded before per-call pricing', () => {
    // Rather than pricing it against today's rates and presenting a guess about
    // an unknown model as a measurement.
    write('2025-12-01-old.jsonl', [
      { kind: 'session', build: 'old', startedAt: '2025-12-01T10:00:00Z' },
      { kind: 'spend', calls: 6, inputTokens: 45_800, outputTokens: 8_800, thinkingTokens: 0 },
    ]);
    const s = listSessions(dir).find((x) => x.build === 'old');
    expect(s!.costUsd).toBeUndefined();
    expect(s!.models).toEqual([]);
  });

  it('survives the half-written last line a crash leaves behind', () => {
    // This is the normal shape of the sessions worth reading, not an edge case.
    writeFileSync(
      join(dir, 'crashed.jsonl'),
      '{"kind":"session","build":"abc1234","startedAt":"2026-01-01T10:00:00Z"}\n' +
        '{"kind":"turn","index":0,"player":"a bank","message":"x","cta":"y","ms":1,"thinkingTokens":0,"calls":1}\n' +
        '{"kind":"draft","businessNam',
    );
    const s = readSession(join(dir, 'crashed.jsonl'));
    expect(s.turns).toBe(1);
    expect(s.outcome).toBe('unfinished');
  });

  it('counts repair rounds and overload retries, which is the point at scale', () => {
    // One session says nothing about whether a check is miscalibrated. Fifty
    // sessions with the same fault at the top of the list say it plainly.
    write('a.jsonl', [
      { kind: 'session', build: 'a', startedAt: '2026-01-01T10:00:00Z' },
      { kind: 'fault', round: 1, issues: ['2 revenue streams, and only the first is modelled'] },
      { kind: 'transient', phase: 'turn', attempt: 1 },
      { kind: 'abandoned', reason: 'lender declined' },
    ]);
    const [s] = listSessions(dir);
    expect(s!.faults).toHaveLength(1);
    expect(s!.transientRetries).toBe(1);
    expect(s!.outcome).toBe('abandoned');
    expect(s!.reason).toBe('lender declined');
  });

  it('returns nothing rather than throwing when there is no journal directory', () => {
    expect(listSessions(join(dir, 'never-created'))).toEqual([]);
  });
});
