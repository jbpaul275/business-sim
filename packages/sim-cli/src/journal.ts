import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  | {
      kind: 'quarter';
      period: number;
      revenue: string;
      ebitda: string;
      cash: string;
      occupancy?: number;
      events: string[];
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
  | { kind: 'end'; reason: string };

export interface Journal {
  write(event: JournalEvent): void;
  /** Where it went, for telling the player once at the end. */
  readonly path: string | undefined;
}

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
  outcome: 'committed' | 'abandoned' | 'unfinished';
  quarters: number;
  /** Why it ended, when it ended badly. */
  reason: string | undefined;
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
  const spend = events.find((e) => e.kind === 'spend');

  return {
    file,
    build: session?.build ?? 'unknown',
    startedAt: session?.startedAt ?? '',
    businessName: draft?.businessName,
    turns: events.filter((e) => e.kind === 'turn').length,
    faults: events.filter((e) => e.kind === 'fault').flatMap((e) => e.issues),
    transientRetries: events.filter((e) => e.kind === 'transient').length,
    costUsd: spend ? estimateCost(spend) : undefined,
    outcome: commit?.committed ? 'committed' : abandoned ? 'abandoned' : 'unfinished',
    quarters: events.filter((e) => e.kind === 'quarter').length,
    reason: abandoned?.reason,
  };
}

/** Deliberately duplicated from `spend.ts` rather than imported: the journal
 * must stay readable by a script that knows nothing about the rest of this. */
function estimateCost(s: { inputTokens: number; outputTokens: number }): number {
  return (s.inputTokens * 15) / 1_000_000 + (s.outputTokens * 75) / 1_000_000;
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
