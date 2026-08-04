import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  consentNotice,
  consentTier,
  redact,
  sessionIdForFile,
  shareNotice,
  shareRun,
  uploadSession,
  uploadTarget,
} from './upload.js';
import type { JournalEvent } from './journal.js';

/**
 * The thing under test is not the HTTP. It is the redaction.
 *
 * These sessions contain business ideas someone typed in confidence and a
 * model's reasoning about them. Somebody who agrees to help compare two models
 * on cost has not agreed to hand over their business plan, and the only way
 * that distinction survives contact with a growing event schema is if it is a
 * property with a test rather than a convention.
 */

const SECRET = 'a dark-sky telescope ridge with 24 scopes';

const events: JournalEvent[] = [
  { kind: 'session', build: 'abc1234', startedAt: '2026-08-03T10:00:00Z', startCapital: '$5,000,000' },
  {
    kind: 'call',
    call: 'turn',
    provider: 'kimi',
    model: 'kimi-k3',
    effort: 'low',
    ms: 7_400,
    inputTokens: 6_000,
    cachedInputTokens: 5_000,
    outputTokens: 1_100,
    thinkingTokens: 800,
    costUsd: 0.0195,
    ratesKnown: true,
    attempt: 1,
    ok: true,
  },
  { kind: 'turn', index: 0, player: SECRET, message: 'x', cta: 'y', ms: 7_400, thinkingTokens: 800, calls: 1 },
  { kind: 'draft', businessName: SECRET, archetype: 'TRAFFIC', draft: { note: SECRET }, ms: 58_000 },
  { kind: 'fault', round: 1, issues: ['a rate booked as dollars'] },
  { kind: 'asked', question: `how do i grow ${SECRET}`, answered: ['x'] },
  { kind: 'advice_corrected', question: 'how do i grow', figures: ['$412k'] },
  { kind: 'narration', period: 0, headline: `The ridge opened quietly`, narrative: SECRET, ms: 3_000 },
  { kind: 'narration_corrected', period: 0, figures: ['$9k'] },
  { kind: 'commit', committed: true, equity: '$1', termDebt: '$0', openingCash: '$1', monthZero: '$1' },
  { kind: 'quarter', period: 0, revenue: '$1', ebitda: '$0', cash: '$1', events: [] },
  // Actions can carry player-typed names (a clone, a started concept), so they
  // are classified as content and must never ride the metrics tier.
  { kind: 'actions', period: 1, actions: [{ kind: 'START_BUSINESS', name: SECRET }] },
];

describe('consent', () => {
  it('is off unless something explicitly says otherwise', () => {
    expect(consentTier({})).toBe('none');
    expect(consentTier({ BIZSIM_TELEMETRY: '' })).toBe('none');
  });

  it('reads "false" and "0" as no, which a truthiness check would not', () => {
    // Real ways people turn things off. `if (env.X)` would have sent the lot.
    expect(consentTier({ BIZSIM_TELEMETRY: 'false' })).toBe('none');
    expect(consentTier({ BIZSIM_TELEMETRY: '0' })).toBe('none');
    expect(consentTier({ BIZSIM_TELEMETRY: 'off' })).toBe('none');
  });

  it('never infers transcripts from consent to metrics', () => {
    // The distinction the whole design exists to keep available.
    expect(consentTier({ BIZSIM_TELEMETRY: 'on' })).toBe('metrics');
    expect(consentTier({ BIZSIM_TELEMETRY: 'on', BIZSIM_TELEMETRY_TRANSCRIPTS: 'on' })).toBe(
      'transcripts',
    );
    // And transcripts alone is not consent to anything.
    expect(consentTier({ BIZSIM_TELEMETRY_TRANSCRIPTS: 'on' })).toBe('none');
  });

  it('says what leaves the machine, in those terms', () => {
    expect(consentNotice('none')).toBeUndefined();
    expect(consentNotice('metrics')).toContain('No text you typed');
    expect(consentNotice('transcripts')).toContain('everything typed in it');
  });
});

describe('what the metrics tier sends', () => {
  it('carries no text the player or the model wrote', () => {
    /**
     * The load-bearing assertion. Serialised whole and searched, rather than
     * checked field by field, because a field-by-field check only covers the
     * fields someone remembered — and the failure this guards against is
     * exactly the one nobody remembered.
     */
    const payload = redact(events, 'sess-1', 'metrics');
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload.transcripts).toEqual([]);
  });

  it('still carries everything a cost comparison needs', () => {
    const { session, calls } = redact(events, 'sess-1', 'metrics');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'kimi-k3',
      provider: 'kimi',
      call: 'turn',
      cost_usd: 0.0195,
      ms: 7_400,
      input_tokens: 6_000,
      rates_known: true,
    });
    expect(session.outcome).toBe('committed');
    expect(session.repair_rounds).toBe(1);
    expect(session.narrations).toBe(1);
    expect(session.fabricated_figures).toBe(2);
    expect(session.questions_asked).toBe(1);
  });

  it('sends the archetype but not the business name', () => {
    // The archetype is one of six fixed strings and is the analytic dimension.
    // The name is something a person wrote, and it goes in the other tier.
    const { session } = redact(events, 'sess-1', 'metrics');
    expect(session.archetype).toBe('TRAFFIC');
    expect(JSON.stringify(session)).not.toContain(SECRET);
  });
});

describe('what the transcript tier sends', () => {
  it('carries the words, once consent covers them', () => {
    const payload = redact(events, 'sess-1', 'transcripts');
    expect(JSON.stringify(payload.transcripts)).toContain(SECRET);
    // Every content event, and no metric ones duplicated into it.
    expect(payload.transcripts.map((t) => t.kind).sort()).toEqual(
      ['actions', 'advice_corrected', 'asked', 'draft', 'narration', 'narration_corrected', 'turn'].sort(),
    );
  });

  it('withholds an event kind nobody has classified yet', () => {
    /**
     * The schema grows with the game. An allow-list of safe kinds would default
     * a new kind to uploadable, and the first one carrying text would leak
     * silently. Unclassified is treated as content, so forgetting to classify
     * something withholds it rather than publishing it.
     */
    const future = [
      ...events,
      { kind: 'confession', text: SECRET } as unknown as JournalEvent,
    ];
    expect(JSON.stringify(redact(future, 'sess-1', 'metrics'))).not.toContain(SECRET);
    expect(redact(future, 'sess-1', 'transcripts').transcripts.map((t) => t.kind)).toContain(
      'confession',
    );
  });
});

describe('sending it', () => {
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bizsim-upload-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  };

  it('does nothing at all without consent', async () => {
    let called = false;
    const result = await uploadSession(file(), 'sess-1', {
      env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k' },
      fetcher: (async () => {
        called = true;
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toContain('consent');
  });

  it('does nothing when no endpoint is configured', async () => {
    // A checkout someone cloned to read the code uploads nowhere. There is no
    // default endpoint on purpose.
    expect(uploadTarget({})).toBeUndefined();
    const result = await uploadSession(file(), 'sess-1', { env: { BIZSIM_TELEMETRY: 'on' } });
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toContain('SUPABASE_URL');
  });

  it('inserts sessions before their children, and asks for no rows back', async () => {
    const seen: { table: string; rows: unknown[]; prefer: string }[] = [];
    await uploadSession(file(), 'sess-1', {
      env: {
        BIZSIM_TELEMETRY: 'on',
        SUPABASE_URL: 'https://x.supabase.co/',
        SUPABASE_PUBLISHABLE_KEY: 'k',
      },
      fetcher: (async (url: string, init: RequestInit) => {
        seen.push({
          table: url.split('/').pop()!,
          rows: JSON.parse(init.body as string),
          prefer: (init.headers as Record<string, string>)['Prefer']!,
        });
        return new Response('', { status: 201 });
      }) as unknown as typeof fetch,
    });

    // `calls` carries a foreign key to `sessions`, so the reverse order would
    // be rejected outright.
    expect(seen.map((s) => s.table)).toEqual(['bizsim_sessions', 'bizsim_calls']);
    // No transcripts request at all under the metrics tier — not an empty one.
    expect(seen.some((s) => s.table === 'bizsim_transcripts')).toBe(false);
    // Retry-safe, and asking for nothing back: the policies grant insert and
    // nothing else, so requesting the row would 401.
    expect(seen[0]!.prefer).toContain('ignore-duplicates');
    expect(seen[0]!.prefer).toContain('return=minimal');
  });

  it('surfaces a rejected insert rather than reporting success', async () => {
    await expect(
      uploadSession(file(), 'sess-1', {
        env: {
          BIZSIM_TELEMETRY: 'on',
          SUPABASE_URL: 'https://x.supabase.co',
          SUPABASE_PUBLISHABLE_KEY: 'k',
        },
        fetcher: (async () =>
          new Response('permission denied', { status: 401 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('the per-session QA share', () => {
  const target = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k' };

  const capture = () => {
    const seen: { table: string; rows: unknown[] }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ table: url.split('/').pop()!, rows: JSON.parse(init.body as string) });
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    return { seen, fetcher };
  };

  it('shares one run on explicit approval, with ambient consent fully off', async () => {
    /**
     * The design point. The player who declined standing collection is exactly
     * the player whose bug reports we otherwise never see — their "share this
     * run" at the exit prompt IS the consent, and it needs no env flag.
     */
    const { seen, fetcher } = capture();
    const result = await shareRun(events, 'sess-1', 'the freezer price was insane', {
      env: { ...target, BIZSIM_TELEMETRY: 'off' },
      fetcher,
    });
    expect(result.shared).toBe(true);
    expect(result.reference).toBe('sess-1');
    // Transcript tier forced for this run: the words go, because that is what
    // was approved.
    expect(seen.map((s) => s.table)).toEqual(['bizsim_sessions', 'bizsim_calls', 'bizsim_transcripts', 'bizsim_feedback']);
    expect(JSON.stringify(seen.find((s) => s.table === 'bizsim_transcripts')!.rows)).toContain(SECRET);
  });

  it('carries the note to the feedback table and nowhere else', async () => {
    const { seen, fetcher } = capture();
    await shareRun(events, 'sess-1', '  the challenge loop capitulated  ', {
      env: target,
      fetcher,
    });
    const feedback = seen.find((s) => s.table === 'bizsim_feedback')!.rows[0] as {
      session_id: string;
      note: string;
      build: string;
    };
    expect(feedback).toEqual({
      session_id: 'sess-1',
      note: 'the challenge loop capitulated',
      build: 'abc1234',
    });
    for (const { table, rows } of seen) {
      if (table !== 'bizsim_feedback') {
        expect(JSON.stringify(rows), table).not.toContain('capitulated');
      }
    }
  });

  it('still refuses to send anywhere without an endpoint', async () => {
    // Explicit consent to share is not a place to send it. No default endpoint,
    // same as the ambient path.
    let called = false;
    const result = await shareRun(events, 'sess-1', 'note', {
      env: { BIZSIM_TELEMETRY: 'on', BIZSIM_TELEMETRY_TRANSCRIPTS: 'on' },
      fetcher: (async () => {
        called = true;
        return new Response('', { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(result.shared).toBe(false);
    expect(called).toBe(false);
    expect(result.skipped).toContain('SUPABASE_URL');
  });

  it('says what a share sends, per run, with the deletion handle named', () => {
    const notice = shareNotice();
    expect(notice).toContain('THIS run');
    expect(notice).toContain('future sessions');
    expect(notice).toContain('reference');
  });

  it('derives the same id the ambient upload uses, so both land on one key', () => {
    const id = sessionIdForFile('2026-08-04-run.jsonl');
    expect(id).toBe(sessionIdForFile('2026-08-04-run.jsonl'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(sessionIdForFile('2026-08-05-run.jsonl'));
  });
});
