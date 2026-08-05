import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CallRecord } from '@bizsim/llm';

/**
 * Every session, on disk, one line at a time.
 *
 * Nothing was recorded before this. A dozen sessions were diagnosed by the
 * player copying a terminal buffer into chat, which works at one a day and not
 * at a hundred — and loses precisely the runs worth having, because a session
 * that crashes is a session whose scrollback ends mid-sentence.
 *
 * Three decisions worth stating:
 *
 * **Append per event, flushed.** Not buffered until exit. The failures that
 * matter here are crashes, and a journal that writes on clean shutdown records
 * only the sessions that did not need recording.
 *
 * **JSONL, local, one file per session.** No service, no daemon, no schema
 * migration. `grep`, `jq` and a for-loop are the analysis tool until there is
 * a reason for a better one, and a directory of newline-delimited JSON is
 * readable by every one of them.
 *
 * **Off by one environment variable.** These files contain business ideas
 * someone typed in confidence, and the model's reasoning about them. They stay
 * on the machine that produced them, out of git, and `BIZSIM_NO_JOURNAL=1`
 * stops the recording entirely.
 */

export type JournalEvent =
  | { kind: 'session'; build: string; startedAt: string; startCapital: string }
  /**
   * One row per model call — the corpus this whole directory exists to build.
   *
   * `call` carries the provider, the model id, the effort tier, wall-clock ms,
   * all four token counts and the cost. Everything else about a session is
   * downstream of those: which model produced this run, what it cost, how long
   * the player waited, and — once there are enough of them — whether a cheaper
   * model reaches the same outcome.
   *
   * Emitted per *attempt*, so a draft that truncated and retried is two rows.
   * The first one was billed, and a corpus that drops it prices the failures at
   * zero, which is exactly backwards: the failures are the expensive ones.
   */
  | ({ kind: 'call' } & CallRecord)
  | {
      kind: 'turn';
      index: number;
      player: string;
      message: string;
      cta: string;
      /** The model's summarised reasoning, when it returned any. */
      reasoning?: string;
      ms: number;
      thinkingTokens: number;
      calls: number;
    }
  | { kind: 'fault'; round: number; issues: string[] }
  /**
   * A draft that parsed as JSON but failed the Zod schema — the repair class
   * the player reads as "it came back incomplete". `detail` names the missing
   * or wrong paths, because the fix is calibration and calibration needs the
   * pattern: on providers without real constrained decoding (Moonshot's
   * json_schema is advisory — a strict grammar cannot emit the double-encoded
   * strings we have seen live), a ~40-required-field draft leans entirely on
   * the model's memory, and which fields it forgets decides whether the cure
   * is a schema default, a prompt line, or a different draft model.
   */
  | { kind: 'draft_rejected'; round: number; detail: string }
  | { kind: 'transient'; phase: string; attempt: number }
  | { kind: 'draft'; businessName: string; archetype: string; draft: unknown; ms: number }
  | { kind: 'objection'; text: string }
  | {
      kind: 'spend';
      calls: number;
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
    }
  | {
      kind: 'commit';
      committed: boolean;
      equity: string;
      termDebt: string;
      openingCash: string;
      monthZero: string;
    }
  | { kind: 'abandoned'; reason: string }
  /** The player stopped a call mid-flight. Worth counting: a rate that climbs
   *  means turns are taking long enough that people give up on them. */
  | { kind: 'cancelled' }
  /**
   * The one number that makes a run's market reproducible. Without it a
   * journal can replay every decision and still disagree about what the index
   * did, which would make the benchmark unauditable.
   */
  | { kind: 'market_seed'; seed: number }
  /**
   * The decisions a quarter ran with, serialised (Money as cents strings).
   *
   * With `market_seed` and the scenario this makes a shared run reproducible —
   * which is what turns a QA report from "the narration felt wrong" into a
   * deterministic replay. Content-classified in the upload deny-list: actions
   * can carry names a player typed (a cloned business, a custom concept), so
   * they travel only under the transcript tier or an explicit per-session share.
   */
  | { kind: 'actions'; period: number; actions: unknown[] }
  | {
      kind: 'quarter';
      period: number;
      revenue: string;
      ebitda: string;
      cash: string;
      occupancy?: number;
      events: string[];
      /** §10.4's delta attribution, one sentence per significant move. */
      attributions?: string[];
    }
  | { kind: 'asked'; question: string; answered: string[] }
  /**
   * What the mid-game model did, when it did not simply answer.
   *
   * `advice_corrected` is the interesting one at scale: it counts the replies
   * that quoted money the ledger never produced and had to be re-asked. Nobody
   * can tell a fabricated figure from a real one by reading it, which means
   * nobody can tell how often it happens either — unless it is written down.
   */
  | { kind: 'advice_corrected'; question: string; figures: string[] }
  | { kind: 'advice_refused'; question: string }
  | { kind: 'advice_failed'; question: string }
  /**
   * §11.4 — a chat instruction translated into staged commands. `unresolvable`
   * carries what could not be translated (ambiguous amounts, moves the build
   * cannot express); its rate is the signal for where the vocabulary or the
   * prompt needs work.
   */
  | { kind: 'actions_translated'; question: string; commands: string[]; unresolvable?: string[] }
  /**
   * §11.5 — the sentence over each quarter. The highest-volume model output in
   * the game, so its correction rate is the fabrication signal with the most
   * statistical power: an advisor answers when asked, a narrator speaks every
   * quarter whether it has something safe to say or not.
   */
  | { kind: 'narration'; period: number; headline: string; narrative: string; ms: number }
  | { kind: 'narration_corrected'; period: number; figures: string[] }
  | { kind: 'narration_failed'; period: number }
  | { kind: 'end'; reason: string };

export interface Journal {
  write(event: JournalEvent): void;
  /** Where it went, for telling the player once at the end. */
  readonly path: string | undefined;
}

/**
 * A quarter's decisions as a journal event, Money rendered as cents strings
 * (`"1234500c"`). JSON.stringify throws on bigint, and dollars-as-number would
 * round; a cents string survives the round trip exactly, which is what makes
 * the record replay-grade rather than merely descriptive.
 */
export const journalActions = (period: number, actions: readonly unknown[]): JournalEvent => ({
  kind: 'actions',
  period,
  actions: JSON.parse(
    JSON.stringify(actions, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value.toString()}c` : value,
    ),
  ) as unknown[],
});

const NO_JOURNAL: Journal = { write: () => {}, path: undefined };

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

export function journalDir(): string {
  return process.env['BIZSIM_JOURNAL_DIR'] ?? join(process.cwd(), '.bizsim', 'sessions');
}

/**
 * Opens a journal for this run, or a silent one.
 *
 * Never throws. A read-only filesystem, a full disk or a missing permission
 * must not stop someone playing the game — the recording is for us, and the
 * session is for them.
 */
export function openJournal(name = 'run'): Journal {
  if (process.env['BIZSIM_NO_JOURNAL']) return NO_JOURNAL;
  try {
    const dir = journalDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `${stamp}-${slug(name)}.jsonl`);
    return {
      path,
      write(event) {
        try {
          appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
        } catch {
          // A journal that crashes the game is worse than no journal.
        }
      },
    };
  } catch {
    return NO_JOURNAL;
  }
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

export interface SessionSummary {
  file: string;
  build: string;
  startedAt: string;
  businessName: string | undefined;
  turns: number;
  /** Repair rounds, which is the number worth watching across many sessions. */
  faults: string[];
  transientRetries: number;
  costUsd: number | undefined;
  /** Every model that answered in this session, in first-seen order. */
  models: string[];
  /** Model calls made, including the attempts that failed. */
  calls: number;
  /** Seconds of wall clock the player spent waiting on a model. */
  waitedSeconds: number;
  outcome: 'committed' | 'abandoned' | 'unfinished';
  quarters: number;
  /** Why it ended, when it ended badly. */
  reason: string | undefined;

  /**
   * The quality side of the comparison, which cost alone cannot settle.
   *
   * A model is only cheaper if it does the job. Each of these is a failure the
   * player either saw or was protected from, counted rather than remembered:
   *
   * `retriedCalls` — attempts beyond the first. On a turn that means the reply
   * came back empty or garbled; on a draft it means the budget ran out or the
   * model refused the schema. Either way the session paid twice.
   *
   * `failedCalls` — attempts that threw. Refusals, exhausted budgets, transport
   * faults.
   *
   * `fabricatedFigures` — the one that matters most. Every time the mid-game
   * advisor quoted money the ledger never produced and had to be re-asked. §1.1
   * forbids the model computing anything that lands on a statement, and nobody
   * can tell a fabricated figure from a real one by reading it — so a model
   * that does this more often is worse in the way that is hardest to notice and
   * most expensive to be wrong about.
   *
   * `questionsAsked` is the denominator for that rate.
   */
  retriedCalls: number;
  failedCalls: number;
  questionsAsked: number;
  /** Quarters the model narrated — the other denominator for the fabrication rate. */
  narrations: number;
  fabricatedFigures: number;
  /** Times the player stopped a reply mid-flight — a proxy for "too slow". */
  cancelled: number;
}

export function readSession(file: string): SessionSummary {
  const events: JournalEvent[] = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalEvent];
      } catch {
        // A half-written last line is exactly what a crash leaves behind, and
        // it is not a reason to refuse the rest of the session.
        return [];
      }
    });

  const session = events.find((e) => e.kind === 'session');
  const draft = events.find((e) => e.kind === 'draft');
  const commit = events.find((e) => e.kind === 'commit');
  const abandoned = events.find((e) => e.kind === 'abandoned');
  /**
   * Priced from the per-call records, which carry the model that produced them.
   *
   * The previous version multiplied a session token total by $15 and $75 —
   * hardcoded Opus 4.x list rates, duplicated here on purpose so a script
   * reading the journal needed nothing else. The duplication was the point and
   * it was also the bug: those rates went stale, nothing noticed, and every
   * cost figure `--sessions` has ever printed was roughly threefold high.
   *
   * Now the price is computed once, at the call, against the model that
   * actually answered — and written into the record. Reading it back is
   * addition. Sessions recorded before this carry no call records and report
   * no cost, which is the honest answer for a run whose model was never noted.
   */
  const calls = events.filter((e) => e.kind === 'call');
  const models: string[] = [];
  for (const c of calls) if (!models.includes(c.model)) models.push(c.model);

  return {
    file,
    build: session?.build ?? 'unknown',
    startedAt: session?.startedAt ?? '',
    businessName: draft?.businessName,
    turns: events.filter((e) => e.kind === 'turn').length,
    faults: events.filter((e) => e.kind === 'fault').flatMap((e) => e.issues),
    transientRetries: events.filter((e) => e.kind === 'transient').length,
    costUsd: calls.length > 0 ? calls.reduce((sum, c) => sum + c.costUsd, 0) : undefined,
    models,
    calls: calls.length,
    waitedSeconds: Math.round(calls.reduce((sum, c) => sum + c.ms, 0) / 1000),
    outcome: commit?.committed ? 'committed' : abandoned ? 'abandoned' : 'unfinished',
    quarters: events.filter((e) => e.kind === 'quarter').length,
    reason: abandoned?.reason,
    retriedCalls: calls.filter((c) => c.attempt > 1).length,
    failedCalls: calls.filter((c) => !c.ok).length,
    questionsAsked: events.filter((e) => e.kind === 'asked').length,
    narrations: events.filter((e) => e.kind === 'narration').length,
    // Both kinds of §1.1 correction, because they are the same failure caught
    // by the same guard — money the ledger never produced, re-asked.
    fabricatedFigures: events.filter(
      (e) => e.kind === 'advice_corrected' || e.kind === 'narration_corrected',
    ).length,
    cancelled: events.filter((e) => e.kind === 'cancelled').length,
  };
}

export function listSessions(dir = journalDir()): SessionSummary[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => readSession(join(dir, f)));
  } catch {
    return [];
  }
}
