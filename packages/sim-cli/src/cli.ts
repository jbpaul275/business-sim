#!/usr/bin/env tsx
import { ratio, toCompact, toDisplay, type Money } from '@bizsim/money';
import { tick, type TickResult } from '@bizsim/engine';
import type { WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { play } from './play.js';
import { runSetup } from './setup.js';
import { openInput } from './input.js';

/**
 * The headless runner. This is the calibration harness for seed templates and
 * the golden-file generator for the regression suite — two weeks of seed
 * calibration without it is two weeks of clicking.
 */

interface Args {
  scenario: string;
  periods: number;
  print: 'statements' | 'summary' | 'events' | 'bands';
  /** Interactive turn loop (§9.1 Phase 5) rather than a batch run. */
  interactive: boolean;
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
  --help, -h             this
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: 'restaurant',
    periods: 40,
    print: 'summary',
    interactive: false,
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
      if (setup?.committed) await play(setup.world, { input });
    } finally {
      input.close();
    }
    return;
  }

  if (args.interactive) {
    await play(args.scenario);
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
  if (failures > 0) process.exit(1);
}

void main();
