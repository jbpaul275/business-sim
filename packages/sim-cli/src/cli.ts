#!/usr/bin/env tsx
import { ratio, toCompact, toDisplay, type Money } from '@bizsim/money';
import { tick, type TickResult } from '@bizsim/engine';
import type { WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { play } from './play.js';
import { createConceptTransport, type AdviceTransport } from '@bizsim/llm';
import { conceptPathAvailable } from './concept.js';
import { benchmarkLines } from './portfolio.js';
import { runSetup } from './setup.js';
import { openInput } from './input.js';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { journalDir, listSessions, type Journal } from './journal.js';
import { consentNotice, consentTier, uploadSession, uploadTarget } from './upload.js';
import { summariseFaults } from './faults.js';

/**
 * The headless runner. This is the calibration harness for seed templates and
 * the golden-file generator for the regression suite — two weeks of seed
 * calibration without it is two weeks of clicking.
 */

/**
 * What the recorded sessions say, together.
 *
 * The point of recording is the aggregate, not the individual run: which
 * faults recur, how many conversations reach a committed business, what a
 * session costs. One transcript pasted into a chat answers none of those.
 */
function reportSessions(): void {
  const all = listSessions();
  /**
   * A session where no model was ever called is not a run, it is a fixture.
   *
   * Scripted-transport sessions commit reliably and cost nothing, so leaving
   * them in drags every rate in the table toward "always works, free" — the
   * exact direction that makes a provider comparison meaningless. The suite no
   * longer writes them (see `vitest.setup.ts`), but a working directory that
   * accumulated them before that fix should not have to be deleted to get a
   * readable answer.
   *
   * Counted and reported rather than silently dropped: a filter nobody is told
   * about is indistinguishable from a bug.
   */
  const sessions = all.filter((s) => s.calls > 0);
  const fixtures = all.length - sessions.length;
  if (sessions.length === 0) {
    console.log(
      all.length === 0
        ? `No recorded sessions in ${journalDir()}.`
        : `No sessions with a model call in ${journalDir()} ` +
          `(${all.length} scripted or pre-instrumentation session(s) skipped).`,
    );
    return;
  }

  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const pad = (s: string, n: number): string =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

  // The model is a column, not a footnote. Every other number here is only
  // interpretable against it: a $0.04 session and a $0.31 session say nothing
  // about which is better value until you know what answered them.
  console.log(
    `\n${BOLD}${pad('WHEN', 18)}${pad('BUILD', 9)}${pad('BUSINESS', 26)}${pad('MODEL', 18)}` +
      `${pad('OUTCOME', 12)}${pad('TURNS', 6)}${pad('QTRS', 6)}${pad('WAIT', 7)}COST${RESET}`,
  );
  for (const s of sessions) {
    console.log(
      pad(s.startedAt.slice(0, 16).replace('T', ' '), 18) +
        pad(s.build, 9) +
        pad(s.businessName ?? '—', 26) +
        pad(s.models.join('+') || '—', 18) +
        pad(s.outcome, 12) +
        pad(String(s.turns), 6) +
        pad(String(s.quarters), 6) +
        pad(s.calls > 0 ? `${s.waitedSeconds}s` : '—', 7) +
        (s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : '—'),
    );
  }

  const committed = sessions.filter((s) => s.outcome === 'committed').length;
  const spent = sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0);
  const turns = sessions.reduce((a, s) => a + s.turns, 0);
  console.log(
    `\n${DIM}${sessions.length} sessions · ${committed} committed · ` +
      `${turns} turns · $${spent.toFixed(2)} · ` +
      `${sessions.reduce((a, s) => a + s.transientRetries, 0)} retries after an overload${RESET}`,
  );

  /**
   * The head-to-head, by model — cost, latency and the three quality signals.
   *
   * Cost per *committed* session rather than per session, because a cheap model
   * that gets abandoned half the time is not cheap, it just fails earlier;
   * averaging its abandonments in with its successes is how a worse model wins
   * a spreadsheet. Dividing by the runs that reached a business makes a model
   * pay for its own failures.
   *
   * And cost is only half of it. `retried` counts the attempts beyond the first
   * — an empty turn, a truncated draft, a refused schema — all of which the
   * session paid for twice. `fabricated` counts the times the mid-game advisor
   * quoted money the ledger never produced and had to be re-asked, which is the
   * §1.1 failure and the one nobody can spot by reading the answer.
   *
   * Small-n is stated rather than smoothed over. Three sessions is not a
   * finding, and a table that looks like a result at n=3 will be quoted as one.
   */
  interface ModelRow {
    runs: number;
    committed: number;
    cost: number;
    wait: number;
    calls: number;
    retried: number;
    failed: number;
    asked: number;
    fabricated: number;
    cancelled: number;
  }
  const byModel = new Map<string, ModelRow>();
  for (const s of sessions) {
    if (s.models.length === 0) continue;
    const key = s.models.join('+');
    const row: ModelRow = byModel.get(key) ?? {
      runs: 0, committed: 0, cost: 0, wait: 0, calls: 0,
      retried: 0, failed: 0, asked: 0, fabricated: 0, cancelled: 0,
    };
    row.runs += 1;
    if (s.outcome === 'committed') row.committed += 1;
    row.cost += s.costUsd ?? 0;
    row.wait += s.waitedSeconds;
    row.calls += s.calls;
    row.retried += s.retriedCalls;
    row.failed += s.failedCalls;
    // Narrations join the denominator: the guard sweeps them the same way,
    // and they are most of the model's output in a long run.
    row.asked += s.questionsAsked + s.narrations;
    row.fabricated += s.fabricatedFigures;
    row.cancelled += s.cancelled;
    byModel.set(key, row);
  }
  if (byModel.size > 0) {
    const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
    console.log(`\n${BOLD}HEAD TO HEAD, BY MODEL${RESET}`);
    console.log(
      `${DIM}  ${pad('MODEL', 22)}${pad('RUNS', 6)}${pad('COMMIT', 8)}${pad('$/COMMIT', 10)}` +
        `${pad('WAIT', 8)}${pad('RETRIED', 9)}${pad('FAILED', 8)}FABRICATED${RESET}`,
    );
    for (const [model, r] of [...byModel].sort((a, b) => b[1].runs - a[1].runs)) {
      console.log(
        `  ${pad(model, 22)}${pad(String(r.runs), 6)}` +
          `${pad(pct(r.committed, r.runs), 8)}` +
          `${pad(r.committed > 0 ? `$${(r.cost / r.committed).toFixed(2)}` : '—', 10)}` +
          `${pad(`${Math.round(r.wait / r.runs)}s`, 8)}` +
          `${pad(pct(r.retried, r.calls), 9)}` +
          `${pad(pct(r.failed, r.calls), 8)}` +
          `${pct(r.fabricated, r.asked)} of ${r.asked} answers`,
      );
    }
    const total = [...byModel.values()].reduce((a, r) => a + r.runs, 0);
    if (total < 10) {
      // Said out loud, because a table always looks like a result. Two runs of
      // the same idea differ by more than the model does.
      console.log(
        `\n${DIM}  ${total} run(s). Not a finding — session-to-session variance on the same` +
          ` concept\n  is larger than the gap between two competent models. Run more.${RESET}`,
      );
    }
  }

  // The faults, ranked. This is the number that says which check is
  // miscalibrated, and it is invisible one session at a time.
  const byCategory = new Map<string, number>();
  for (const s of sessions) {
    for (const issue of s.faults) {
      const key = summariseFaults([issue]);
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    }
  }
  if (byCategory.size > 0) {
    console.log(`\n${BOLD}REPAIR ROUNDS BY CAUSE${RESET}`);
    for (const [what, n] of [...byCategory].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(String(n), 5)}${DIM}${what.replace(/^the first draft (came back wrong — )?/, '')}${RESET}`);
    }
  }

  if (fixtures > 0) {
    console.log(
      `\n${DIM}${fixtures} session(s) hidden: no model was called, so there is nothing to ` +
        `compare.\nScripted test runs and anything recorded before per-call logging.${RESET}`,
    );
  }
  console.log(`\n${DIM}Raw events: ${journalDir()}/*.jsonl${RESET}`);
}

/**
 * Send what has been recorded, and say exactly what went.
 *
 * Separate from the game loop on purpose. An upload that happens silently at
 * the end of a session is one nobody can inspect before it leaves; running it
 * as its own command means the first thing anyone does is see the consent
 * notice and the count, with the option to not run it again.
 *
 * Ids are derived from the file path rather than random, so re-running this is
 * idempotent all the way down: the same session uploads to the same primary
 * key, and the insert conflicts away rather than duplicating.
 */
async function uploadRecorded(): Promise<void> {
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const tier = consentTier();
  const notice = consentNotice(tier);

  if (tier === 'none') {
    console.log(
      `Nothing is sent anywhere. Set BIZSIM_TELEMETRY=on for the numbers, and\n` +
        `additionally BIZSIM_TELEMETRY_TRANSCRIPTS=on for the text — see --help.`,
    );
    return;
  }
  if (!uploadTarget()) {
    console.log('No SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set, so there is nowhere to send.');
    return;
  }
  console.log(`\n${notice}\n`);

  let files: string[];
  try {
    files = readdirSync(journalDir())
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(journalDir(), f));
  } catch {
    console.log(`No recorded sessions in ${journalDir()}.`);
    return;
  }

  let sent = 0;
  let calls = 0;
  let transcripts = 0;
  const failures: string[] = [];
  for (const file of files) {
    // A stable id per file: re-running this uploads the same rows to the same
    // keys rather than a second copy of a session already sent.
    const id = sessionId(file);
    try {
      const result = await uploadSession(file, id);
      if (result.uploaded) {
        sent += 1;
        calls += result.calls;
        transcripts += result.transcripts;
      }
    } catch (error) {
      failures.push(`${basename(file)}: ${(error as Error).message}`);
    }
  }

  console.log(
    `${sent} session(s) sent · ${calls} model call(s)` +
      (tier === 'transcripts' ? ` · ${transcripts} transcript row(s)` : ''),
  );
  // Named, not swallowed. A silent partial upload is a corpus with holes in it
  // and no record of where they are.
  for (const f of failures.slice(0, 5)) console.log(`${DIM}  failed — ${f}${RESET}`);
  if (failures.length > 5) console.log(`${DIM}  …and ${failures.length - 5} more${RESET}`);
}

/**
 * A stable, non-identifying id for a session file.
 *
 * FNV-1a over the filename, which already carries an ISO timestamp and a slug,
 * rendered as a UUID. Deliberately not a per-install identifier: a stable id
 * across sessions is a tracking decision, and comparing two models does not
 * need one.
 */
function sessionId(file: string): string {
  const name = basename(file);
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
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

interface Args {
  scenario: string;
  periods: number;
  print: 'statements' | 'summary' | 'events' | 'bands';
  /** Interactive turn loop (§9.1 Phase 5) rather than a batch run. */
  interactive: boolean;
  /** Report on recorded sessions rather than running one. */
  sessions: boolean;
  /** Send recorded sessions to the configured endpoint, if consent allows. */
  upload: boolean;
  /** Full setup — §9.1 Phases 0-4 — then play what you designed. */
  newGame: boolean;
  help: boolean;
}

const USAGE = `sim — business simulator

  pnpm sim --new                                  design a business, then run it
  pnpm sim --play --scenario <name>               skip setup, play a seeded scenario
  pnpm sim --scenario <name> --print bands        batch run, for calibration

Options
  --new                  §9.1 Phases 0-4: capital, concept, scale, financing,
                         assumption review, commit gate — then play it
  --play, --interactive  quarterly turn loop against a seeded scenario
  --scenario <name>      ${Object.keys(SCENARIOS).join(', ')}
                         (default: restaurant)
  --periods <n>          quarters to run (default: 40)
  --print <mode>         summary | statements | bands | events (default: summary)
  --sessions             what past runs did: outcome, turns, faults, cost
  --upload               send recorded sessions to the configured endpoint
  --help, -h             this

Sessions are recorded to .bizsim/sessions as JSONL, one file per run, flushed
per event so a crash keeps everything up to it. BIZSIM_NO_JOURNAL=1 turns it
off; BIZSIM_JOURNAL_DIR moves it.

Nothing leaves this machine unless you say so. Two separate opt-ins, because
they are two different things to agree to:

  BIZSIM_TELEMETRY=on              the numbers — tokens, timings, cost, which
                                   model, whether you committed. No free text.
  BIZSIM_TELEMETRY_TRANSCRIPTS=on  additionally the words: what you typed, the
                                   drafted concept, the model's reasoning.

The second is never implied by the first. Both need SUPABASE_URL and
SUPABASE_PUBLISHABLE_KEY set; without them nothing is sent anywhere.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: 'restaurant',
    periods: 40,
    print: 'summary',
    interactive: false,
    sessions: false,
    upload: false,
    newGame: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--scenario' && value) {
      args.scenario = value;
      i++;
    } else if (arg === '--periods' && value) {
      args.periods = Number(value);
      i++;
    } else if (arg === '--print' && value) {
      args.print = value as Args['print'];
      i++;
    } else if (arg === '--play' || arg === '--interactive') {
      args.interactive = true;
    } else if (arg === '--sessions') {
      args.sessions = true;
    } else if (arg === '--upload') {
      args.upload = true;
    } else if (arg === '--new') {
      args.newGame = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

const pad = (label: string, width = 34): string => label.padEnd(width);
const rpad = (value: string, width = 14): string => value.padStart(width);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function printStatements(result: TickResult): void {
  const { period, consolidated } = result.statements;
  const is = consolidated.incomeStatement;
  const bs = consolidated.balanceSheet;
  const cf = consolidated.cashFlow;

  console.log(`\n═══ Period ${period} (Y${Math.floor(period / 4) + 1} Q${(period % 4) + 1}) ═══`);
  console.log('\nINCOME STATEMENT');
  const lines: [string, Money][] = [
    ['  Revenue', is.revenue],
    ['  Cost of goods sold', -is.costOfGoodsSold],
    ['= Gross profit', is.grossProfit],
    ['  Labor', -is.labor],
    ['  Occupancy', -is.occupancy],
    ['  Marketing', -is.marketing],
    ['  General & administrative', -is.generalAndAdmin],
    ['= EBITDA', is.ebitda],
    ['  Depreciation & amortization', -is.depreciationAndAmortization],
    ['= EBIT', is.ebit],
    ['  Interest expense', -is.interestExpense],
    ['  Gain (loss) on disposal', is.gainOnAssetDisposal],
    ['  Financing & factoring costs', -is.financingCosts],
    ['= Pre-tax income', is.pretaxIncome],
    ['  Income tax expense', -is.incomeTaxExpense],
    ['= NET INCOME', is.netIncome],
  ];
  for (const [label, value] of lines) console.log(pad(label) + rpad(toDisplay(value)));

  console.log('\nBALANCE SHEET');
  const bsLines: [string, Money][] = [
    ['  Cash', bs.cash],
    ['  Accounts receivable', bs.accountsReceivable],
    ['  Retainage receivable', bs.retainageReceivable],
    ['  Inventory', bs.inventory],
    ['  Prepaid expenses', bs.prepaidExpenses],
    ['= Current assets', bs.currentAssets],
    ['  PP&E, gross', bs.ppeGross],
    ['  Less: accumulated depreciation', -bs.accumulatedDepreciation],
    ['= TOTAL ASSETS', bs.totalAssets],
    ['  Accounts payable', bs.accountsPayable],
    ['  Deferred revenue', bs.deferredRevenue],
    ['  Deferred owner comp', bs.deferredOwnerComp],
    ['  Current portion of debt', bs.currentPortionOfDebt],
    ['= Current liabilities', bs.currentLiabilities],
    ['  Long-term debt', bs.longTermDebt],
    ['= TOTAL LIABILITIES', bs.totalLiabilities],
    ['  Contributed capital', bs.contributedCapital],
    ['  Retained earnings', bs.retainedEarnings],
    ['= TOTAL EQUITY', bs.totalEquity],
  ];
  for (const [label, value] of bsLines) console.log(pad(label) + rpad(toDisplay(value)));

  console.log('\nCASH FLOW');
  const cfLines: [string, Money][] = [
    ['  Net income', cf.netIncome],
    ['  Depreciation & amortization', cf.depreciationAndAmortization],
    ['  Deferred taxes', cf.deferredTaxes],
    ['  Gain on disposal', -cf.gainOnAssetDisposal],
    ['  Δ Net working capital', -cf.changeInNetWorkingCapital],
    ['= CASH FROM OPERATIONS', cf.cashFlowFromOperations],
    ['  Capital expenditures', -cf.capitalExpenditures],
    ['  Proceeds from disposals', cf.proceedsFromDisposals],
    ['= CASH FROM INVESTING', cf.cashFlowFromInvesting],
    ['  Debt drawdowns', cf.debtDrawdowns],
    ['  Principal repayments', -cf.debtPrincipalRepayments],
    ['  Origination fees', -cf.debtOriginationFees],
    ['  Owner contributions', cf.ownerContributions],
    ['  Owner distributions', -cf.ownerDistributions],
    ['= CASH FROM FINANCING', cf.cashFlowFromFinancing],
    ['= NET CHANGE IN CASH', cf.netChangeInCash],
    ['  Ending cash', cf.endingCash],
  ];
  for (const [label, value] of cfLines) console.log(pad(label) + rpad(toDisplay(value)));

  const failed = result.assertions.filter((a) => !a.passed);
  console.log(
    `\n${failed.length === 0 ? '✓' : '✗'} ${result.assertions.length} articulation assertions, ` +
      `${failed.length} failed`,
  );
  for (const f of failed) {
    console.log(`  ✗ ${f.name}: expected ${f.expected}, got ${f.actual}`);
  }
}

function printSummaryRow(result: TickResult): void {
  const is = result.statements.consolidated.incomeStatement;
  const bs = result.statements.consolidated.balanceSheet;
  const period = result.statements.period;
  console.log(
    [
      String(period).padStart(3),
      rpad(toCompact(is.revenue), 10),
      rpad(toCompact(is.ebitda), 10),
      rpad(pct(ratio(is.ebitda, is.revenue)), 8),
      rpad(toCompact(is.netIncome), 10),
      rpad(toCompact(bs.cash), 10),
      rpad(toCompact(bs.totalEquity), 11),
      rpad(String(result.assertions.filter((a) => !a.passed).length), 6),
    ].join(''),
  );
}

function printBands(results: TickResult[]): void {
  // §13.3 benchmark plausibility: aggregate over a full year.
  const forYear = (year: number): void => {
    const slice = results.filter(
      (r) => Math.floor(r.statements.period / 4) === year,
    );
    if (slice.length === 0) return;
    const sumOf = (fn: (r: TickResult) => Money): Money =>
      slice.reduce<Money>((acc, r) => acc + fn(r), 0n);
    const revenue = sumOf((r) => r.statements.consolidated.incomeStatement.revenue);
    if (revenue === 0n) return;
    const cogs = sumOf((r) => r.statements.consolidated.incomeStatement.costOfGoodsSold);
    const labor = sumOf((r) => r.statements.consolidated.incomeStatement.labor);
    const occupancy = sumOf((r) => r.statements.consolidated.incomeStatement.occupancy);
    const ebitda = sumOf((r) => r.statements.consolidated.incomeStatement.ebitda);
    console.log(
      `Y${year + 1}  revenue ${rpad(toCompact(revenue), 9)}  ` +
        `food ${rpad(pct(ratio(cogs, revenue)), 7)}  ` +
        `labor ${rpad(pct(ratio(labor, revenue)), 7)}  ` +
        `occupancy ${rpad(pct(ratio(occupancy, revenue)), 7)}  ` +
        `EBITDA ${rpad(pct(ratio(ebitda, revenue)), 7)}`,
    );
  };
  console.log('\nBENCHMARK PLAUSIBILITY (§13.3)');
  for (let year = 0; year < 10; year++) forYear(year);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (!(args.scenario in SCENARIOS)) {
    // Silently falling back to the default scenario makes a typo look like a
    // calibration result, which is the one thing this harness must not do.
    console.error(
      `Unknown scenario '${args.scenario}'. Available: ${Object.keys(SCENARIOS).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  if (args.newGame) {
    const input = await openInput();
    try {
      const setup = await runSetup(input);
      if (setup?.committed) {
        await play(setup.world, {
          input,
          ...(setup.journal ? { journal: setup.journal } : {}),
          ...(turnAdvisor(setup.journal) ? { advisor: turnAdvisor(setup.journal)! } : {}),
        });
      }
      if (setup?.journal?.path) {
        console.log(`\n\x1b[2mSession recorded at ${setup.journal.path}\x1b[0m`);
      }
    } finally {
      input.close();
    }
    return;
  }

  if (args.sessions) {
    reportSessions();
    return;
  }

  if (args.upload) {
    await uploadRecorded();
    return;
  }

  if (args.interactive) {
    await play(args.scenario, { ...(turnAdvisor() ? { advisor: turnAdvisor()! } : {}) });
    return;
  }

  const build = SCENARIOS[args.scenario];
  if (!build) {
    console.error(
      `Unknown scenario "${args.scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`,
    );
    process.exit(1);
  }

  let state: WorldState = build();
  const results: TickResult[] = [];

  console.log(`Scenario: ${args.scenario}  ·  ${args.periods} quarters`);
  const opening = state.businesses[0];
  if (opening) {
    console.log(
      `Opening cash ${toDisplay(opening.cash)}  ·  ` +
        `month-zero outlay ${toDisplay(opening.peakCashNeed)}  ·  ` +
        `household ${toDisplay(state.household.cash)}`,
    );
  }

  if (args.print === 'summary' || args.print === 'bands') {
    console.log(
      '\n' +
        ['  Q', rpad('Revenue', 10), rpad('EBITDA', 10), rpad('margin', 8), rpad('Net inc', 10), rpad('Cash', 10), rpad('Equity', 11), rpad('fails', 6)].join(''),
    );
  }

  let failures = 0;
  for (let i = 0; i < args.periods; i++) {
    let result: TickResult;
    try {
      result = tick(state, [], { throwOnAssertionFailure: false });
    } catch (error) {
      console.error(`\n✗ Engine threw at period ${state.currentPeriod + 1}:`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    results.push(result);
    state = result.state;
    failures += result.assertions.filter((a) => !a.passed).length;

    if (args.print === 'statements') printStatements(result);
    else if (args.print === 'summary' || args.print === 'bands') printSummaryRow(result);
    else if (args.print === 'events') {
      for (const event of result.events) {
        console.log(
          `Q${result.statements.period} [${event.severity}] ${event.kind} ${JSON.stringify(event.detail)}`,
        );
      }
    }
  }

  if (args.print === 'bands') printBands(results);

  const final = results[results.length - 1];
  const business = state.businesses[0];
  console.log('\n─── SUMMARY ───');
  if (business) {
    console.log(`Peak cash need        ${toDisplay(business.peakCashNeed)} (period ${business.peakCashNeedPeriod})`);
    console.log(`Status                ${business.status}`);
  }
  console.log(`Household net worth   ${toDisplay(final?.statements.household.netWorth ?? 0n)}`);
  console.log(`Household cash        ${toDisplay(state.household.cash)}`);
  console.log(
    `Articulation          ${failures === 0 ? '✓ all assertions held at every period' : `✗ ${failures} failures`}`,
  );
  // Every run now carries its own opportunity cost, batch runs included: a
  // calibration sweep that shows a template losing to a passive index over ten
  // years is telling you something about the template.
  console.log('');
  for (const line of benchmarkLines(
    state,
    final?.statements.household.netWorth ?? 0n,
    state.currentPeriod,
  )) {
    console.log(line);
  }
  if (failures > 0) process.exit(1);
}

/**
 * The mid-game model, when there is one.
 *
 * Built once and cached: a new transport per question would make a fresh
 * client, lose the retry state, and split the usage meter into fragments that
 * add up to nothing. Absent when there is no key, which is a supported way to
 * play — the deterministic advisor is the whole game without it.
 *
 * `BIZSIM_NO_TURN_AI=1` turns it off with a key present, which is how the
 * before-and-after of any change to it gets compared.
 */
let advisorInstance: AdviceTransport | undefined;
let advisorResolved = false;
/**
 * The journal arrives after setup, so it is handed in rather than closed over.
 *
 * Advisor calls are the highest-volume call type in a long run — one per
 * question, every quarter — and until now they recorded nothing at all. They
 * are also the best candidate for a cheaper model, which is precisely the
 * decision that needs the numbers.
 */
function turnAdvisor(journal?: Journal): AdviceTransport | undefined {
  if (!advisorResolved) {
    advisorResolved = true;
    advisorInstance =
      conceptPathAvailable() && !process.env['BIZSIM_NO_TURN_AI']
        ? createConceptTransport({
            onCall: (record) => journal?.write({ kind: 'call', ...record }),
          })
        : undefined;
  }
  return advisorInstance;
}

void main();
