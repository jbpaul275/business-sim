import { fromDisplay, ratio, toCompact, toDisplay } from '@bizsim/money';
import { tick, type TickResult } from '@bizsim/engine';
import type { Action, Business, CrisisRemedy, EngineEvent, WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { openInput, parseMoney, type LineSource } from './input.js';

/**
 * The interactive turn loop — spec §9.1 Phase 5, without the LLM.
 *
 * §11.4 is explicit that "a structured UI must exist alongside" natural
 * language: "natural language is the on-ramp, not the only road." This is that
 * road. The full action catalog and its lead times already exist and are
 * tested; until now nothing had ever driven them from a human decision, which
 * means nothing had tested whether the DECISIONS are interesting — a thing no
 * property test can tell you.
 *
 * Deliberately no narrator. Every line below is engine output: computed
 * metrics and emitted events, never prose about them. When TurnNarration lands
 * in M5 it explains this screen; it does not replace it.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

/**
 * What a unit of volume is called, per archetype (§3.8 gives each exactly one
 * binding volume unit). "31,197" alone is a number; "31,197 transactions" is a
 * fact about a restaurant.
 */
const VOLUME_UNIT: Record<string, string> = {
  TRAFFIC: 'transactions',
  UTILIZATION: 'billable hours',
  UNITS_CAC: 'orders',
  SUBSCRIPTION: 'subscribers',
  OCCUPANCY: 'units occupied',
  PROJECT_BACKLOG: 'contracts delivered',
};
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const pad = (s: string, n: number): string => s.padEnd(n);
const rpad = (s: string, n: number): string => s.padStart(n);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const severityColour = (s: EngineEvent['severity']): string =>
  s === 'CRITICAL' ? RED : s === 'WARNING' ? YELLOW : DIM;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTurn(result: TickResult, business: Business): void {
  const period = result.statements.period;
  const entry = result.statements.byBusiness[business.id];
  const year = Math.floor(period / 4) + 1;
  const quarter = (period % 4) + 1;

  console.log(
    `\n${BOLD}═══ Period ${period} · Year ${year} Q${quarter} · ${business.name} ═══${RESET}`,
  );

  if (!entry) {
    console.log(`${RED}  ${business.status}. No statements this period.${RESET}`);
    return;
  }

  const is = entry.incomeStatement;
  const bs = entry.balanceSheet;
  const m = entry.derivedMetrics;

  const cashColour = bs.cash < fromDisplay(25_000) ? RED : GREEN;
  const runway = m.cashRunwayQuarters;
  const runwayText = Number.isFinite(runway) ? `${runway.toFixed(1)}q` : '∞';

  const row = (
    leftLabel: string,
    leftValue: string,
    extra: string,
    rightLabel: string,
    rightValue: string,
    colour = '',
  ): string =>
    `  ${pad(leftLabel, 16)}${rpad(leftValue, 11)} ${rpad(extra, 7)}   ` +
    `${pad(rightLabel, 12)}${colour}${rpad(rightValue, 11)}${colour ? RESET : ''}`;

  console.log(row('Revenue', toCompact(is.revenue), '', 'Cash', toCompact(bs.cash), cashColour));
  console.log(
    row('EBITDA', toCompact(is.ebitda), pct(ratio(is.ebitda, is.revenue)), 'Runway', runwayText),
  );
  console.log(row('Net income', toCompact(is.netIncome), '', 'Equity', toCompact(bs.totalEquity)));
  console.log(
    `${DIM}${row('Peak cash need', toCompact(m.peakCashNeed), '', 'Household', toCompact(result.statements.household.endingCash))}${RESET}`,
  );

  /**
   * Volume, and how close it is to the ceiling.
   *
   * This used to print "demand 31,197 · served 31,197" every quarter, which is
   * two numbers saying one thing: served equals demand by construction right up
   * until the period it does not. The player learns nothing from the equality
   * and cannot see the wall coming.
   *
   * What is actually worth knowing is the headroom — 71% of capacity is a
   * different business from 98% — so the two numbers collapse to one whenever
   * they agree, and the ceiling takes the space they were wasting.
   */
  for (const s of m.streamMetrics) {
    const volume = `${Math.round(s.realizedVolume).toLocaleString()} ${VOLUME_UNIT[s.archetype] ?? 'units'}`;
    let detail: string;
    if (s.lostDemand > 0.5) {
      detail =
        `${YELLOW}at capacity · turned away ` +
        `${Math.round(s.lostDemand).toLocaleString()} of ${Math.round(s.demandVolume).toLocaleString()}${RESET}`;
    } else if (s.capacityVolume !== undefined && s.capacityVolume > 0) {
      const used = ratio(fromDisplay(s.realizedVolume), fromDisplay(s.capacityVolume));
      detail = `${DIM}${pct(used)} of capacity (${Math.round(s.capacityVolume).toLocaleString()})${RESET}`;
    } else {
      // Not a hedge: several archetypes genuinely have no ceiling, and saying
      // so is more honest than implying an unstated one.
      detail = `${DIM}nothing capping volume${RESET}`;
    }
    console.log(`\n  ${DIM}${s.label}${RESET}  ${volume} · ${detail}`);
    if (s.occupancy !== undefined) console.log(`  ${DIM}occupancy ${pct(s.occupancy)}${RESET}`);
    if (s.realizedUtilization !== undefined) {
      console.log(`  ${DIM}utilisation ${pct(s.realizedUtilization)} · bench ${Math.round(s.benchStress ?? 0)}h${RESET}`);
    }
    if (s.backlogCoverageQuarters !== undefined) {
      console.log(`  ${DIM}backlog coverage ${s.backlogCoverageQuarters.toFixed(1)}q${RESET}`);
    }
  }

  // Staffing. blocksNeeded comes from UNCONSTRAINED demand (§4.3), so the gap
  // shown here is real even while capacity is binding.
  const needed = new Map<string, number>();
  for (const e of result.events) {
    if (e.kind === 'CAPACITY_CONSTRAINED' && e.detail.blocksNeeded !== undefined) {
      needed.set(String(e.detail.line), Number(e.detail.blocksNeeded));
    }
  }
  if (business.costs.stepFixed.length > 0) console.log('');
  for (const cost of business.costs.stepFixed) {
    const need = needed.get(cost.label);
    const gap =
      need !== undefined && need > cost.currentBlocks
        ? `${YELLOW}  needs ${need}${RESET}`
        : '';
    const pending = cost.pendingBlocks > 0 ? `${DIM} (+${cost.pendingBlocks} arriving)${RESET}` : '';
    console.log(
      `  ${DIM}${pad(cost.label, 20)}${RESET}${cost.currentBlocks} blocks${pending}${gap}` +
        `  ${DIM}${toCompact(cost.blockCostPerQuarter)}/block${RESET}`,
    );
  }

  for (const debt of business.debts) {
    const limit = debt.revolverLimit;
    const detail =
      limit !== undefined
        ? `${toCompact(debt.outstandingPrincipal)} drawn of ${toCompact(limit)}`
        : `${toCompact(debt.outstandingPrincipal)} outstanding`;
    console.log(`  ${DIM}${pad(debt.label, 20)}${RESET}${detail} ${DIM}@ ${pct(debt.annualRate)}${RESET}`);
  }

  const notable = result.events.filter((e) => e.severity !== 'INFO');
  for (const e of notable) {
    const detail = Object.entries(e.detail)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`  ${severityColour(e.severity)}▸ ${e.kind}  ${detail}${RESET}`);
  }

  const failed = result.assertions.filter((a) => !a.passed);
  if (failed.length > 0) {
    console.log(`  ${RED}✗ ${failed.length} ARTICULATION FAILURES — this is an engine bug${RESET}`);
    for (const f of failed) console.log(`    ${RED}${f.name}: expected ${f.expected}, got ${f.actual}${RESET}`);
  }
}

const HELP = `
${BOLD}Commands${RESET} — enter as many as you like, then a blank line to run the quarter.

  ${BOLD}price${RESET} 45              set the price (avg ticket / rate / ARPU, per archetype)
  ${BOLD}marketing${RESET} 12k         set marketing spend per quarter
  ${BOLD}hire${RESET} <line> [n]       add step blocks  ${DIM}— cost lands NOW, capacity NEXT quarter${RESET}
  ${BOLD}fire${RESET} <line> [n]       remove blocks    ${DIM}— severance lands now${RESET}
  ${BOLD}debt${RESET} 200k [quarters]  raise an SBA 7(a) ${DIM}— fee now, proceeds next quarter${RESET}
  ${BOLD}draw${RESET} 50k              draw on the revolver
  ${BOLD}inject${RESET} 50k            household → business
  ${BOLD}distribute${RESET} 20k        business → household
  ${BOLD}expand${RESET} 20 150k        add capacity (seats/units) for a buildout cost ${DIM}— +2 quarters${RESET}
  ${BOLD}policy${RESET} revolver,inject,defer,emergency,insolvency
                        reorder the cash-crisis ladder (§9.4)

  ${BOLD}skip${RESET} <n>              run n quarters with no actions
  ${BOLD}lines${RESET}                 list step-fixed cost line ids
  ${BOLD}help${RESET} · ${BOLD}quit${RESET}
`;

const REMEDY_ALIASES: Record<string, CrisisRemedy> = {
  revolver: 'REVOLVER',
  inject: 'HOUSEHOLD_INJECTION',
  household: 'HOUSEHOLD_INJECTION',
  factor: 'FACTOR_AR',
  defer: 'DEFER_OWNER_COMP',
  emergency: 'EMERGENCY_DEBT',
  leaseback: 'SALE_LEASEBACK',
  insolvency: 'INSOLVENCY',
};

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

interface ParseResult {
  actions: Action[];
  skip?: number;
  quit?: boolean;
  message?: string;
}

function parseCommand(line: string, business: Business): ParseResult {
  const [verb = '', ...rest] = line.trim().split(/\s+/);
  const streamId = business.streams[0]?.id ?? 's1';
  const none: ParseResult = { actions: [] };
  const fail = (m: string): ParseResult => ({ actions: [], message: `${RED}${m}${RESET}` });

  const findLine = (token: string): string | undefined =>
    business.costs.stepFixed.find(
      (c) => c.id === token || c.label.toLowerCase().startsWith(token.toLowerCase()),
    )?.id;

  switch (verb.toLowerCase()) {
    case '':
      return none;

    case 'help':
      console.log(HELP);
      return none;

    case 'quit':
    case 'exit':
      return { actions: [], quit: true };

    case 'lines':
      for (const c of business.costs.stepFixed) {
        console.log(`  ${pad(c.id, 22)}${DIM}${c.label} · ${c.currentBlocks} blocks${RESET}`);
      }
      return none;

    case 'skip': {
      const n = Number(rest[0] ?? 1);
      if (!Number.isInteger(n) || n < 1) return fail('skip needs a positive whole number of quarters.');
      return { actions: [], skip: n };
    }

    case 'price': {
      const value = parseMoney(rest[0] ?? '');
      if (value === undefined) return fail('price needs an amount, e.g. `price 45`.');
      return { actions: [{ kind: 'SET_PRICE', streamId, newPrice: value }] };
    }

    case 'marketing': {
      const value = parseMoney(rest[0] ?? '');
      if (value === undefined) return fail('marketing needs an amount, e.g. `marketing 12k`.');
      return { actions: [{ kind: 'SET_MARKETING_SPEND', streamId, amountPerQuarter: value }] };
    }

    case 'hire':
    case 'fire': {
      const costId = findLine(rest[0] ?? '');
      if (!costId) return fail(`Unknown cost line "${rest[0] ?? ''}". Try \`lines\`.`);
      const blocks = Number(rest[1] ?? 1);
      if (!Number.isInteger(blocks) || blocks < 1) return fail('Block count must be a positive whole number.');
      return {
        actions: [
          verb.toLowerCase() === 'hire'
            ? { kind: 'ADD_STEP_BLOCK', costId, blocks }
            : { kind: 'REMOVE_STEP_BLOCK', costId, blocks },
        ],
      };
    }

    case 'debt': {
      const principal = parseMoney(rest[0] ?? '');
      if (principal === undefined) return fail('debt needs an amount, e.g. `debt 200k`.');
      const termQuarters = Number(rest[1] ?? 40);
      if (!Number.isInteger(termQuarters) || termQuarters < 1) return fail('Term must be a whole number of quarters.');
      return {
        actions: [
          {
            kind: 'RAISE_DEBT',
            businessId: business.id,
            spec: { kind: 'SBA_7A', requestedPrincipal: principal, termQuarters, personalGuarantee: true },
          },
        ],
      };
    }

    case 'draw': {
      const amount = parseMoney(rest[0] ?? '');
      if (amount === undefined) return fail('draw needs an amount.');
      const revolver = business.debts.find((d) => d.kind === 'REVOLVER');
      if (!revolver) return fail('This business has no revolver.');
      return { actions: [{ kind: 'DRAW_REVOLVER', debtId: revolver.id, amount }] };
    }

    case 'inject': {
      const amount = parseMoney(rest[0] ?? '');
      if (amount === undefined) return fail('inject needs an amount.');
      return { actions: [{ kind: 'INJECT_CAPITAL', businessId: business.id, amount }] };
    }

    case 'distribute': {
      const amount = parseMoney(rest[0] ?? '');
      if (amount === undefined) return fail('distribute needs an amount.');
      return { actions: [{ kind: 'DISTRIBUTE', businessId: business.id, amount }] };
    }

    case 'expand': {
      const delta = Number(rest[0]);
      const cost = parseMoney(rest[1] ?? '');
      if (!Number.isFinite(delta) || delta <= 0 || cost === undefined) {
        return fail('expand needs a unit count and a buildout cost, e.g. `expand 20 150k`.');
      }
      const kind = business.streams[0]?.params.kind;
      return {
        actions: [
          {
            kind: 'EXPAND_CAPACITY',
            businessId: business.id,
            spec: {
              streamId,
              buildoutCost: cost,
              ...(kind === 'OCCUPANCY' ? { deltaUnits: delta } : { deltaSeats: delta }),
            },
          },
        ],
      };
    }

    case 'policy': {
      const tokens = (rest[0] ?? '').split(',').filter(Boolean);
      const policy: CrisisRemedy[] = [];
      for (const t of tokens) {
        const remedy = REMEDY_ALIASES[t.toLowerCase()];
        if (!remedy) return fail(`Unknown remedy "${t}". Options: ${Object.keys(REMEDY_ALIASES).join(', ')}`);
        policy.push(remedy);
      }
      if (policy.length === 0) return fail('policy needs a comma-separated list.');
      return { actions: [{ kind: 'SET_CRISIS_POLICY', policy }] };
    }

    default:
      return fail(`Unknown command "${verb}". Try \`help\`.`);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export async function play(
  source: string | WorldState,
  options: { input?: LineSource; milestonePeriod?: number } = {},
): Promise<void> {
  const milestonePeriod = options.milestonePeriod ?? 39;

  let state: WorldState;
  if (typeof source === 'string') {
    const build = SCENARIOS[source];
    if (!build) {
      console.error(`Unknown scenario "${source}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(1);
    }
    state = build();
  } else {
    state = source;
  }
  const businessId = state.businesses[0]?.id;
  if (!businessId) {
    console.error('Scenario has no business.');
    process.exit(1);
  }

  console.log(
    `\n${DIM}Opening cash ${toDisplay(state.businesses[0]!.cash)} · ` +
      `month-zero outlay ${toDisplay(state.businesses[0]!.peakCashNeed)} · ` +
      `household ${toDisplay(state.household.cash)}${RESET}`,
  );
  console.log(`${DIM}\`help\` for commands. Blank line runs the quarter.${RESET}`);

  const input = options.input ?? (await openInput());

  const advance = (actions: Action[]): TickResult => {
    const result = tick(state, actions, { throwOnAssertionFailure: false });
    state = result.state;
    return result;
  };

  // Run period 0 so there is something to look at before the first decision.
  let last = advance([]);
  renderTurn(last, state.businesses.find((b) => b.id === businessId)!);

  try {
    while (true) {
      const business = state.businesses.find((b) => b.id === businessId)!;

      if (business.status === 'CLOSED') {
        console.log(`\n${RED}${BOLD}${business.name} is insolvent and closed.${RESET}`);
        console.log(
          `Household net worth ${toDisplay(last.statements.household.netWorth)} · ` +
            `peak cash need was ${toDisplay(business.peakCashNeed)}`,
        );
        break;
      }
      if (state.currentPeriod >= milestonePeriod) {
        console.log(`\n${BOLD}${GREEN}Ten-year milestone reached.${RESET}`);
        console.log(
          `Household net worth ${toDisplay(last.statements.household.netWorth)} · ` +
            `peak cash need ${toDisplay(business.peakCashNeed)} at period ${business.peakCashNeedPeriod}`,
        );
        break;
      }

      const queued: Action[] = [];
      let quit = false;
      let skip = 0;

      while (true) {
        const prompt = queued.length > 0 ? `${DIM}[${queued.length} queued]${RESET} > ` : '> ';
        const line = await input.next(prompt);
        if (line === undefined) {
          console.log(`\n${DIM}End of input — stopping at period ${state.currentPeriod}.${RESET}`);
          quit = true;
          break;
        }
        const parsed = parseCommand(line, business);
        if (parsed.message) console.log(parsed.message);
        if (parsed.quit) {
          quit = true;
          break;
        }
        if (parsed.skip) {
          skip = parsed.skip;
          break;
        }
        if (parsed.actions.length > 0) {
          queued.push(...parsed.actions);
          // Name the asymmetry out loud, as §11.4 requires of any confirmation.
          for (const a of parsed.actions) {
            if (a.kind === 'ADD_STEP_BLOCK') {
              console.log(`  ${YELLOW}cost starts this quarter; capacity arrives next quarter${RESET}`);
            }
            if (a.kind === 'RAISE_DEBT') {
              console.log(`  ${YELLOW}origination fee this quarter; proceeds arrive next quarter${RESET}`);
            }
            if (a.kind === 'EXPAND_CAPACITY') {
              console.log(`  ${YELLOW}buildout spread over two quarters; capacity arrives in two${RESET}`);
            }
          }
          continue;
        }
        if (line.trim() === '') break;
      }

      if (quit) break;

      if (skip > 0) {
        for (let i = 0; i < skip && state.currentPeriod < milestonePeriod; i++) {
          last = advance([]);
          const b = state.businesses.find((x) => x.id === businessId)!;
          if (b.status === 'CLOSED') break;
        }
      } else {
        last = advance(queued);
      }

      renderTurn(last, state.businesses.find((b) => b.id === businessId)!);
    }
  } finally {
    if (!options.input) input.close();
  }
}
