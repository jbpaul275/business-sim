import { readFileSync } from 'node:fs';
import type { JournalEvent } from './journal.js';

/**
 * Sending a session somewhere, if and only if someone said it could go.
 *
 * These files contain business ideas typed in confidence and a model's
 * reasoning about them. Nothing here runs unless an environment variable says
 * so, and there are two of them because there are two different things to
 * agree to:
 *
 *   BIZSIM_TELEMETRY=on             the numbers — tokens, latency, cost, model,
 *                                   outcome. No free text of any kind.
 *   BIZSIM_TELEMETRY_TRANSCRIPTS=on additionally the words: what was typed, what
 *                                   was drafted, what the model reasoned.
 *
 * The second is never implied by the first. Someone who agrees to help compare
 * two models on cost has not agreed to hand over their business plan, and a
 * single flag covering both would make that distinction unavailable.
 *
 * Everything here is best-effort and silent. A failed upload must not interrupt
 * a game, must not print a stack trace over someone's ledger, and must not
 * retry hard enough to be noticed — the recording is for us, the session is for
 * them.
 */

export type ConsentTier = 'none' | 'metrics' | 'transcripts';

/**
 * What was actually agreed to.
 *
 * Read strictly. Anything other than an explicit affirmative is `none`,
 * including an empty string, `0`, and the variable being set to the literal
 * word `false` — which is a real way people try to turn things off, and a
 * truthiness check would have turned it on.
 */
export function consentTier(env: NodeJS.ProcessEnv = process.env): ConsentTier {
  const on = (v: string | undefined): boolean =>
    v !== undefined && ['on', '1', 'true', 'yes'].includes(v.trim().toLowerCase());
  if (!on(env['BIZSIM_TELEMETRY'])) return 'none';
  return on(env['BIZSIM_TELEMETRY_TRANSCRIPTS']) ? 'transcripts' : 'metrics';
}

export interface SessionRow {
  id: string;
  build: string;
  started_at: string;
  ended_at: string | null;
  outcome: string;
  archetype: string | null;
  start_capital: string | null;
  turns: number;
  quarters: number;
  repair_rounds: number;
  questions_asked: number;
  narrations: number;
  fabricated_figures: number;
  cancelled: number;
}

export interface CallRow {
  session_id: string;
  seq: number;
  call: string;
  provider: string;
  model: string;
  effort: string;
  ms: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cost_usd: number;
  rates_known: boolean;
  attempt: number;
  ok: boolean;
  failure: string | null;
}

export interface TranscriptRow {
  session_id: string;
  seq: number;
  kind: string;
  payload: unknown;
}

export interface Payload {
  session: SessionRow;
  calls: CallRow[];
  transcripts: TranscriptRow[];
}

/**
 * Which journal events carry words someone wrote or a model produced.
 *
 * An allow-list of *safe* kinds would be the wrong shape: a new event kind
 * added later would default to uploadable, and the first one that carried text
 * would leak silently. This is a deny-list of the kinds that carry content, and
 * `redact` treats an unrecognised kind as content too — so the failure mode of
 * forgetting to classify something is that it is withheld.
 */
const CONTENT_KINDS = new Set([
  'turn', // the player's message, the model's reply, its reasoning
  'draft', // the entire concept, in the player's own framing
  'objection', // what they argued with
  'asked', // mid-game questions, in their words
  'advice_corrected',
  'advice_refused',
  'advice_failed',
  // The narration is a model's paragraph about the player's business — content
  // as surely as the draft is. The failure kinds carry the offending figures.
  'narration',
  'narration_corrected',
  'narration_failed',
  // Actions can carry names the player typed (a cloned business, a started
  // concept). The replay value lives in the transcript tier with the words.
  'actions',
]);

/** Kinds that carry no free text and are safe under the metrics tier. */
const METRIC_KINDS = new Set([
  'session',
  'call',
  'fault',
  'transient',
  'spend',
  'commit',
  'abandoned',
  'cancelled',
  'market_seed',
  'quarter',
  'end',
]);

/**
 * A session, split into what each tier may send.
 *
 * `id` is supplied rather than derived: it is a per-session random identifier
 * with nothing behind it. Deliberately not a per-install id — a stable
 * identifier across sessions is a tracking decision, and it is not one this
 * needs in order to compare two models.
 */
export function redact(events: readonly JournalEvent[], id: string, tier: ConsentTier): Payload {
  const session = events.find((e) => e.kind === 'session');
  const draft = events.find((e) => e.kind === 'draft');
  const commit = events.find((e) => e.kind === 'commit');
  const abandoned = events.find((e) => e.kind === 'abandoned');
  const end = events.find((e) => e.kind === 'end');
  const calls = events.filter((e) => e.kind === 'call');

  const row: SessionRow = {
    id,
    build: session?.build ?? 'unknown',
    started_at: session?.startedAt ?? new Date(0).toISOString(),
    ended_at: end ? ((end as { at?: string }).at ?? null) : null,
    outcome: commit?.committed ? 'committed' : abandoned ? 'abandoned' : 'unfinished',
    // The archetype is the analytic dimension and is one of six fixed strings.
    // The business *name* is free text and stays in the transcript tier.
    archetype: draft?.archetype ?? null,
    start_capital: session?.startCapital ?? null,
    turns: events.filter((e) => e.kind === 'turn').length,
    quarters: events.filter((e) => e.kind === 'quarter').length,
    repair_rounds: events.filter((e) => e.kind === 'fault').length,
    questions_asked: events.filter((e) => e.kind === 'asked').length,
    narrations: events.filter((e) => e.kind === 'narration').length,
    fabricated_figures: events.filter(
      (e) => e.kind === 'advice_corrected' || e.kind === 'narration_corrected',
    ).length,
    cancelled: events.filter((e) => e.kind === 'cancelled').length,
  };

  const callRows: CallRow[] = calls.map((c, seq) => ({
    session_id: id,
    seq,
    call: c.call,
    provider: c.provider,
    model: c.model,
    effort: c.effort,
    ms: c.ms,
    input_tokens: c.inputTokens,
    cached_input_tokens: c.cachedInputTokens,
    output_tokens: c.outputTokens,
    thinking_tokens: c.thinkingTokens,
    cost_usd: c.costUsd,
    rates_known: c.ratesKnown,
    attempt: c.attempt,
    ok: c.ok,
    failure: c.failure ?? null,
  }));

  if (tier !== 'transcripts') return { session: row, calls: callRows, transcripts: [] };

  const transcripts: TranscriptRow[] = [];
  for (const [i, e] of events.entries()) {
    // Content, or anything this file does not recognise. An unclassified kind
    // is treated as content on purpose: forgetting to classify something should
    // withhold it, not publish it.
    if (CONTENT_KINDS.has(e.kind) || !METRIC_KINDS.has(e.kind)) {
      transcripts.push({ session_id: id, seq: i, kind: e.kind, payload: e });
    }
  }
  return { session: row, calls: callRows, transcripts };
}

/** Parse a journal file, tolerating the half-written last line a crash leaves. */
export function readEvents(file: string): JournalEvent[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalEvent];
      } catch {
        return [];
      }
    });
}

export interface UploadTarget {
  url: string;
  key: string;
}

/**
 * Where to send it, or nothing.
 *
 * No default endpoint. A build with no `SUPABASE_URL` set uploads nowhere,
 * which is the right behaviour for a checkout someone cloned to read the code.
 */
export function uploadTarget(env: NodeJS.ProcessEnv = process.env): UploadTarget | undefined {
  const url = env['SUPABASE_URL']?.replace(/\/+$/, '');
  const key = env['SUPABASE_PUBLISHABLE_KEY'] ?? env['SUPABASE_ANON_KEY'];
  return url && key ? { url, key } : undefined;
}

type Fetcher = typeof globalThis.fetch;

async function insert(
  target: UploadTarget,
  table: string,
  rows: readonly unknown[],
  fetcher: Fetcher,
): Promise<void> {
  if (rows.length === 0) return;
  const response = await fetcher(`${target.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: target.key,
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
      // Idempotent by construction: the primary keys are client-generated, so a
      // retry after a half-failed batch conflicts away rather than duplicating.
      // `return=minimal` also means the response carries no rows — the policies
      // grant insert and nothing else, and asking for the row back would 401.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    throw new Error(`${table}: ${response.status} ${await response.text().catch(() => '')}`);
  }
}

export interface UploadResult {
  uploaded: boolean;
  tier: ConsentTier;
  calls: number;
  transcripts: number;
  /** Why not, when it did not happen. For a local log line, never for the player. */
  skipped?: string;
}

/**
 * Send one session. Best-effort, and silent either way.
 *
 * Ordering matters: `sessions` first, because `calls` and `transcripts` carry a
 * foreign key to it. A partial upload leaves a session row with fewer children
 * than it should have, which is visible in the data and fixable by re-running
 * `--upload`; the reverse would be orphan rows the database would reject.
 */
export async function uploadSession(
  file: string,
  id: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: Fetcher;
  } = {},
): Promise<UploadResult> {
  const env = options.env ?? process.env;
  const tier = consentTier(env);
  if (tier === 'none') {
    return { uploaded: false, tier, calls: 0, transcripts: 0, skipped: 'no consent given' };
  }
  const target = uploadTarget(env);
  if (!target) {
    return { uploaded: false, tier, calls: 0, transcripts: 0, skipped: 'no SUPABASE_URL set' };
  }

  const payload = redact(readEvents(file), id, tier);
  const fetcher = options.fetcher ?? globalThis.fetch;
  await insert(target, 'sessions', [payload.session], fetcher);
  await insert(target, 'calls', payload.calls, fetcher);
  await insert(target, 'transcripts', payload.transcripts, fetcher);

  return {
    uploaded: true,
    tier,
    calls: payload.calls.length,
    transcripts: payload.transcripts.length,
  };
}

// ---------------------------------------------------------------------------
// The per-session QA share — the third consent surface
// ---------------------------------------------------------------------------

export interface FeedbackRow {
  session_id: string;
  note: string;
  build: string;
}

export interface ShareResult {
  shared: boolean;
  /** The id the player quotes to have the run deleted. */
  reference?: string;
  transcripts: number;
  skipped?: string;
}

/**
 * Send ONE run to QA, because the player just said so.
 *
 * This deliberately ignores the ambient consent tiers: the player who opted
 * out of standing collection is exactly the player whose bug reports we
 * otherwise never see, and their explicit "share this run" at the exit prompt
 * IS the consent — narrower, fresher and better-informed than any standing
 * flag, because they can see everything the run contains. The transcript tier
 * is forced on for this one session; nothing here widens any future session.
 *
 * What still applies: the target. No `SUPABASE_URL`, no upload, no default
 * endpoint — same as the ambient path.
 */
export async function shareRun(
  events: readonly JournalEvent[],
  id: string,
  note: string,
  options: { env?: NodeJS.ProcessEnv; fetcher?: Fetcher } = {},
): Promise<ShareResult> {
  const target = uploadTarget(options.env ?? process.env);
  if (!target) return { shared: false, transcripts: 0, skipped: 'no SUPABASE_URL set' };

  const payload = redact(events, id, 'transcripts');
  const feedback: FeedbackRow = {
    session_id: id,
    note: note.trim(),
    build: payload.session.build,
  };

  const fetcher = options.fetcher ?? globalThis.fetch;
  await insert(target, 'sessions', [payload.session], fetcher);
  await insert(target, 'calls', payload.calls, fetcher);
  await insert(target, 'transcripts', payload.transcripts, fetcher);
  await insert(target, 'feedback', [feedback], fetcher);

  return { shared: true, reference: id, transcripts: payload.transcripts.length };
}

/**
 * What the player approves, in the terms of what actually leaves the machine.
 * Shown before the share, every time — this consent is per-run, so the notice
 * is too.
 */
export function shareNotice(): string {
  return (
    'If you approve, the full record of THIS run is shared with the QA team: ' +
    'everything you typed in it, what the model drafted and said back, every ' +
    'decision and every quarter. Nothing outside this run is sent, and this ' +
    'does not opt you into anything for future sessions. You get a reference ' +
    'id afterwards — quote it to have the run deleted.'
  );
}

/**
 * A stable session id from a journal filename: same file, same id, so a
 * re-share conflicts away instead of duplicating, and the ambient upload and
 * the QA share of the same run land on the same primary key.
 */
export function sessionIdForFile(name: string): string {
  let h = 0x811c9dc5;
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < name.length; j++) {
      h ^= name.charCodeAt(j) + i;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes.push(h & 0xff);
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  // Rendered v4-style so tooling that validates UUID versions accepts it.
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * What the player is told, once, before anything is sent.
 *
 * Said in the terms of what actually leaves the machine rather than in the
 * language of a privacy policy. Someone who reads this and is surprised by what
 * arrives in the database has been misled, which is the only failure mode that
 * matters here.
 */
export function consentNotice(tier: ConsentTier): string | undefined {
  if (tier === 'none') return undefined;
  return tier === 'metrics'
    ? 'Telemetry is on: this session sends token counts, timings, costs, the model ' +
        'used and whether you committed. No text you typed, and nothing the model wrote.'
    : 'Telemetry is on, including transcripts: this session sends the numbers above ' +
        'AND everything typed in it — your description, the drafted concept, and the ' +
        "model's reasoning. Unset BIZSIM_TELEMETRY_TRANSCRIPTS to send numbers only.";
}
