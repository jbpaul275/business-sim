import { fromDisplay, mulRate, ratio, toCompact, toDisplay, type Money } from '@bizsim/money';
import { tick, type TickResult } from '@bizsim/engine';
import type { Action, Business, CrisisRemedy, EngineEvent, WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { openInput, parseMoney, parseNumber, type LineSource } from './input.js';
import { rule } from './ui.js';
import type { Journal } from './journal.js';
import { describeEvent } from './events.js';

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

// Truncating is the point, not an accident: "Bath attendants and front desk"
// ran straight into its block count with no space between them, because
// padEnd on an over-long string returns it unchanged.
const pad = (s: string, n: number): string =>
  s.length > n - 1 ? `${s.slice(0, n - 2)}… ` : s.padEnd(n);
const rpad = (s: string, n: number): string => s.padStart(n);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * What an action will do, in the units the player typed it in.
 *
 * `[1 queued]` says a thing happened without saying which. Someone typed
 * `marketing $5`, meaning `$5k`, and found out two quarters later when
 * revenue had fallen — a typo the confirmation could have caught for free.
 */
function describeAction(a: Action): string {
  switch (a.kind) {
    case 'SET_PRICE':
      return `price → ${toDisplay(a.newPrice, { showCents: false })}`;
    case 'SET_MARKETING_SPEND':
      return `marketing → ${toDisplay(a.amountPerQuarter, { showCents: false })} a quarter`;
    case 'ADD_STEP_BLOCK':
      return `hire ${a.blocks} × ${a.costId}`;
    case 'REMOVE_STEP_BLOCK':
      return `fire ${a.blocks} × ${a.costId}`;
    case 'RAISE_DEBT':
      return `borrow ${toDisplay(a.spec.requestedPrincipal, { showCents: false })}`;
    case 'DRAW_REVOLVER':
      return `draw ${toDisplay(a.amount, { showCents: false })} on the revolver`;
    case 'INJECT_CAPITAL':
      return `put in ${toDisplay(a.amount, { showCents: false })} of your own`;
    case 'DISTRIBUTE':
      return `take out ${toDisplay(a.amount, { showCents: false })}`;
    case 'EXPAND_CAPACITY': {
      // More room and more market ride the same action; they are not the same
      // decision and must not read identically in the confirmation.
      const market =
        a.spec.deltaDemandHoursPerQuarter !== undefined ||
        a.spec.deltaAddressableTrafficPerQuarter !== undefined;
      return `${market ? 'new territory' : 'more capacity'} for ${toDisplay(a.spec.buildoutCost, { showCents: false })}`;
    }
    case 'SET_CRISIS_POLICY':
      return `crisis order → ${a.policy.join(', ')}`;
    default:
      return a.kind;
  }
}

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
    `\n${rule(`Period ${period} · Year ${year} Q${quarter} · ${business.name}`)}`,
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
      `  ${DIM}${pad(cost.label, 22)}${RESET}${cost.currentBlocks} blocks${pending}${gap}` +
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
  if (notable.length > 0) console.log('');
  for (const e of notable) {
    console.log(`  ${severityColour(e.severity)}▸ ${describeEvent(e)}${RESET}`);
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
  ${BOLD}market${RESET} 40% 150k       open a new territory: more demand, not more room ${DIM}— +2 quarters${RESET}
  ${BOLD}policy${RESET} revolver,inject,defer,emergency,insolvency
                        reorder the cash-crisis ladder (§9.4)

  ${BOLD}skip${RESET} <n>              run n quarters with no actions
  ${BOLD}costs${RESET}                 where the money goes, biggest line first
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

/**
 * "What do I do now?"
 *
 * Asked three times in one live session — `what do i do now?`, `how can we cut
 * costs?`, `hwo can we cut costs or increase revnues?` — and answered three
 * times with `Unknown command "how". Try \`help\``. The whole premise of the
 * product is that you talk to it, and then the half where the decisions
 * actually happen is a strict verb parser. §11.4: "natural language is the
 * on-ramp, not the only road" — there was no on-ramp here at all.
 *
 * This is not narration and it does not call a model. Every line is read off
 * the last tick: the levers that exist, ordered by what this quarter's numbers
 * say is binding. A player who asks what to do is owed the state of their own
 * business, not a list of verbs they have already seen.
 */
/**
 * What the player actually asked about.
 *
 * The advisor used to print the same four-line diagnosis whatever was typed. A
 * campground owner asked "how much will it cost us to quadruple capacity?",
 * then "raise marketing spend then", then explained his reasoning at length —
 * and got the identical paragraph three times. That is worse than the
 * `Unknown command` it replaced: it looks like an answer, so the player reads
 * it, finds their question absent, and concludes the tool is not listening.
 */
type Topic = 'capacity' | 'price' | 'marketing' | 'staff' | 'debt' | 'seasonality' | 'general';

function topicOf(question: string): Topic {
  const q = question.toLowerCase();
  if (/\b(expand|more sites|more seats|capacity|bigger|quadruple|double|scale)\b/.test(q)) return 'capacity';
  if (/\b(price|prices|pricing|charge|rate|raise prices)\b/.test(q)) return 'price';
  if (/\b(marketing|advertis|promote|reach|awareness)\b/.test(q)) return 'marketing';
  if (/\b(staff|labou?r|payroll|hire|fire|crew|employee|cut costs|costs)\b/.test(q)) return 'staff';
  if (/\b(debt|borrow|loan|revolver|financ|raise money|invest)\b/.test(q)) return 'debt';
  if (/\b(season|swing|winter|summer|why.*(quarter|drop|fall))\b/.test(q)) return 'seasonality';
  return 'general';
}

/**
 * "What do I do now?"
 *
 * Asked three times in one live session — `what do i do now?`, `how can we cut
 * costs?`, `hwo can we cut costs or increase revnues?` — and answered three
 * times with `Unknown command "how". Try \`help\``. The whole premise of the
 * product is that you talk to it, and then the half where the decisions
 * actually happen is a strict verb parser. §11.4: "natural language is the
 * on-ramp, not the only road" — there was no on-ramp here at all.
 *
 * This is not narration and it does not call a model. Every line is read off
 * the last tick. What it says is chosen by what was asked; the full diagnosis
 * is the answer to a general question, not the answer to every question.
 */
function advise(business: Business, result: TickResult, question = ''): string[] {
  const entry = result.statements.byBusiness[business.id];
  if (!entry) return ['No statements yet — run a quarter first.'];
  const is = entry.incomeStatement;
  const m = entry.derivedMetrics;
  const stream = m.streamMetrics[0];
  const topic = topicOf(question);
  const out: string[] = [];

  const used =
    stream?.capacityVolume !== undefined && stream.capacityVolume > 0
      ? stream.realizedVolume / stream.capacityVolume
      : undefined;
  const fixed = business.costs.fixedPeriod.reduce<Money>((a, c) => a + c.amountPerQuarter, 0n);
  const blocks = business.costs.stepFixed.reduce<Money>(
    (a, c) => a + c.blockCostPerQuarter * BigInt(c.currentBlocks),
    0n,
  );

  // ── Topic answers ────────────────────────────────────────────────────────
  // Each one answers the question that was asked, with this quarter's numbers
  // in it. The arithmetic is the point: "more sites will not help" is an
  // opinion, and "you have 15 empty ones" is a fact.

  if (topic === 'capacity' && used !== undefined && stream) {
    const idle = Math.round(stream.capacityVolume! - stream.realizedVolume);
    // Bench hours are the truth for a UTILIZATION shop, not gross capacity. A
    // plumbing business at 82% of *gross* hours with zero bench was told it
    // had "186 idle — 17.9% sat empty", which is what target utilisation looks
    // like when nobody is idle at all. Nobody bills 100% of paid hours.
    const genuinelyIdle = stream.benchStress === undefined || stream.benchStress > 1;
    if (stream.lostDemand > 0.5) {
      out.push(
        `Worth doing: you turned away ${Math.round(stream.lostDemand).toLocaleString()} this quarter. ` +
          `\`expand <units> <cost>\` adds capacity, and it lands two quarters out, not now.`,
      );
    } else if (genuinelyIdle && used < 0.8) {
      out.push(
        `You already have ${idle.toLocaleString()} idle — ${pct(1 - used)} of what you built ` +
          `sat empty this quarter. More capacity costs money now and earns nothing until demand ` +
          `catches up; \`marketing\` and \`price\` are what move demand.`,
      );
    } else {
      // Full, or as near as this archetype ever gets. More capacity inside the
      // same market only helps if there is unmet demand for it to meet, and
      // there is not — so the honest answer is the other kind of growth.
      out.push(
        `You are effectively full — ${pct(used)} of capacity with` +
          `${stream.benchStress !== undefined ? ` ${Math.round(stream.benchStress)}h of bench` : ' no slack'}. ` +
          `Adding capacity inside the same market gives you more idle, not more revenue. ` +
          `\`market <pct> <cost>\` opens a new territory — more demand to serve, two quarters out.`,
      );
    }
  }

  if (topic === 'price') {
    const p = business.streams[0]?.params;
    const price =
      p && 'avgTicket' in p ? p.avgTicket
      : p && 'ratePerUnitPerQuarter' in p ? p.ratePerUnitPerQuarter
      : undefined;
    out.push(
      price !== undefined
        ? `\`price ${Math.round(Number(price) / 100)}\` sets it. Elasticity is modelled: a 10% rise ` +
            `loses roughly 12% of volume, so it helps only while you have empty capacity to lose.`
        : `\`price <amount>\` sets it. Elasticity is modelled, so a rise trades volume for margin.`,
    );
  }

  if (topic === 'marketing') {
    const spend = business.streams[0]?.marketingSpendPerQuarter ?? 0n;
    const half = business.streams[0]?.modifiers.halfSaturationSpend ?? 0n;
    // Past twice the half-saturation point, more spend is close to free money
    // thrown away — and repeating "response saturates" to someone who has
    // already tripled their budget and seen nothing is not advice.
    const tapped = half > 0n && spend > half * 2n;
    out.push(
      tapped
        ? `You are at ${toCompact(spend)} a quarter against a half-saturation point of ` +
            `${toCompact(half)} — this lever is spent, which is why the last raise did nothing. ` +
            `Growth from here is a bigger market (\`market <pct> <cost>\`) or a higher price, not more spend.`
        : `\`marketing <amount>\` — you are at ${toCompact(spend)} a quarter. Response saturates: ` +
            `each extra dollar buys less than the last, and it moves demand rather than capacity.`,
    );
  }

  if (topic === 'staff') {
    out.push(
      `Staffing is ${toCompact(blocks)} a quarter across ${business.costs.stepFixed.length} lines; ` +
        `fixed costs are ${toCompact(fixed)} and cannot be cut this quarter. ` +
        `\`costs\` lists every line by size, \`lines\` gives the ids \`fire\` takes.`,
    );

    /**
     * "how many people can we fire without hurting service quality?"
     *
     * Answerable, and answered with a restatement of the totals. The engine
     * knows what each block carries and what volume actually turned up; the
     * subtraction is exactly the work a player cannot do from the screen and
     * the sim can do exactly.
     */
    if (stream) {
      for (const line of business.costs.stepFixed) {
        const per = Number(line.capacity?.capacityPerBlock ?? 0);
        if (per <= 0) continue;
        const needed = Math.ceil(stream.demandVolume / per);
        const floor = Math.max(line.minimumBlocks ?? 0, needed);
        const spare = line.currentBlocks - floor;
        out.push(
          spare > 0
            ? `${line.label}: ${line.currentBlocks} blocks carrying ${Math.round(stream.demandVolume).toLocaleString()} ` +
                `of demand at ${per.toLocaleString()} each — ${spare} could go and still cover it, ` +
                `saving ${toCompact(line.blockCostPerQuarter * BigInt(spare))} a quarter.`
            : `${line.label}: ${line.currentBlocks} blocks is what this quarter's volume needs. ` +
                `Cutting here turns customers away rather than saving money.`,
        );
      }
    }
  }

  if (topic === 'debt') {
    out.push(
      is.ebitda < 0n
        ? `Borrowing funds losses, it does not end them: at ${toCompact(is.ebitda)} of EBITDA every ` +
            `quarter, more debt buys time and raises the interest you pay for it. ` +
            `\`debt <amount>\` and \`draw <amount>\` both work; neither changes the trajectory.`
        : `\`debt <amount>\` raises a term loan, \`draw\` uses the revolver. At ` +
            `${toCompact(is.ebitda)} of EBITDA you can service some of it.`,
    );
  }

  // Seasonality, which explains most of what looks like chaos on the screen.
  // A campground owner watched revenue go 5k → 18k → 23k → 13k and was never
  // told the shape was designed rather than emergent.
  const season = business.streams[0]?.seasonality;
  if (season && season.length === 4) {
    const high = Math.max(...season);
    const low = Math.min(...season);
    // 1.5x between best and worst quarter. The reference restaurant runs 1.17
    // and should stay quiet; a DTC brand runs 1.61 and a campground far more,
    // and in both of those the swing is the single most confusing thing on the
    // screen for the first year.
    if (high / Math.max(low, 0.01) > 1.5 && (topic === 'seasonality' || topic === 'general')) {
      const bestQuarter = season.indexOf(high) + 1;
      const worstQuarter = season.indexOf(low) + 1;
      out.push(
        `The swing is seasonal, not a trend: Q${bestQuarter} runs at ${high.toFixed(2)}x an average ` +
          `quarter and Q${worstQuarter} at ${low.toFixed(2)}x. A year of this business is one good ` +
          `season carrying two thin ones, so judge it on four quarters, never on one.`,
      );
    }
  }

  // ── The general diagnosis, when nothing specific was asked ───────────────
  if (topic === 'general' || out.length === 0) {
    const runway = m.cashRunwayQuarters;
    if (Number.isFinite(runway) && runway < 2) {
      out.push(
        `Cash is the binding problem: ${runway.toFixed(1)} quarters of runway. ` +
          `\`draw\` on the revolver or \`inject\` from the household buys time; neither fixes it.`,
      );
    }
    if (used !== undefined && stream) {
      if (stream.lostDemand > 0.5) {
        out.push(
          `You are turning away ${Math.round(stream.lostDemand).toLocaleString()} of demand. ` +
            `\`expand\` or \`hire\` converts that into revenue; \`price\` up captures it without spending.`,
        );
      } else if (used < 0.6) {
        out.push(
          `You are at ${pct(used)} of capacity, so the constraint is demand, not the building. ` +
            `\`marketing\` and \`price\` move volume; cutting staff you have already paid for does not.`,
        );
      }
    }
    if (is.revenue > 0n && is.grossProfit <= 0n) {
      out.push(
        `Every sale loses money before a single fixed cost: variable costs exceed revenue. ` +
          `Volume makes this worse, not better — \`price\` is the only lever that helps.`,
      );
    }
    if (is.ebitda < 0n && is.revenue > 0n) {
      out.push(
        `EBITDA is ${toCompact(is.ebitda)} on ${toCompact(is.revenue)} of revenue. ` +
          `Fixed costs are ${toCompact(fixed)} a quarter and staffing is ${toCompact(blocks)}, ` +
          `and only the second is reachable this quarter. \`costs\` breaks it down line by line.`,
      );
    }
    if (is.interestExpense > 0n && is.ebitda < is.interestExpense) {
      out.push(
        `Interest alone is ${toCompact(is.interestExpense)} a quarter against ${toCompact(is.ebitda)} ` +
          `of EBITDA. Borrowing more raises that number rather than solving it.`,
      );
    }
  }

  if (out.length === 0) {
    out.push(
      `Nothing is obviously binding this quarter. \`price\`, \`marketing\`, \`hire\` and ` +
        `\`expand\` are the levers; \`skip 4\` runs a year if you want to see the trend first.`,
    );
  }
  return out;
}

/**
 * Every verb the parser knows. The list is closed; English is not.
 *
 * Detection used to work the other way round — a list of interrogative
 * openings — and "we need to cut costs, give me a breakdown of where the money
 * is going" fell straight through it, twice, because it opens with "we". The
 * question is not which sentences look like questions. It is which sentences
 * are commands, and that set is exactly this.
 */
const VERBS = new Set([
  '', 'help', 'quit', 'exit', 'lines', 'costs', 'skip', 'price', 'marketing',
  'hire', 'fire', 'debt', 'draw', 'inject', 'distribute', 'expand', 'market', 'policy',
]);

/**
 * Anything that is not a command, and is more than one word, is a question.
 *
 * The asymmetry is deliberate and it is the whole design: treating a mistyped
 * verb as a question costs one paragraph of genuinely relevant state, and
 * treating a question as a mistyped verb costs the player the belief that they
 * can talk to this. A single unrecognised word is still a typo — `hier` is not
 * a sentence — so the one-word case keeps its error.
 */
function looksLikeAQuestion(line: string, verb: string): boolean {
  if (VERBS.has(verb.toLowerCase())) return false;
  return /\?/.test(line) || line.trim().split(/\s+/).length > 1;
}

/**
 * Where the money actually goes, biggest first.
 *
 * Asked for twice in one session — "give me a breakdown of where the money is
 * currently going" — against a screen that reported EBITDA and two subtotals
 * and nothing else. The advisor could say staffing was $100k a quarter; it
 * could not say which line, or that a single one of them was half of it.
 *
 * Read off the last statement, so every figure is one the ledger already
 * computed. Sorted by size because that is the order the decisions come in:
 * nobody cuts the software subscription first.
 */
function renderCosts(business: Business, result: TickResult): void {
  const entry = result.statements.byBusiness[business.id];
  if (!entry) {
    console.log(`  ${DIM}No statements yet — run a quarter first.${RESET}`);
    return;
  }
  const is = entry.incomeStatement;

  const lines: { label: string; amount: Money; note: string }[] = [
    ...business.costs.variableWithRevenue.map((c) => ({
      label: c.label,
      amount: mulRate(is.revenue, c.pctOfRevenue),
      note: `${pct(c.pctOfRevenue)} of revenue`,
    })),
    ...business.costs.stepFixed.map((c) => ({
      label: c.label,
      amount: c.blockCostPerQuarter * BigInt(c.currentBlocks),
      note: `${c.currentBlocks} × ${toCompact(c.blockCostPerQuarter)} — \`fire ${c.id}\``,
    })),
    ...business.costs.fixedPeriod.map((c) => ({
      label: c.label,
      amount: c.amountPerQuarter,
      note: 'fixed, every quarter',
    })),
  ].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));

  const total = lines.reduce<Money>((a, l) => a + l.amount, 0n);
  console.log(`\n  ${BOLD}${pad('WHERE THE MONEY GOES', 30)}${rpad('per quarter', 12)}${RESET}`);
  for (const l of lines) {
    if (l.amount === 0n) continue;
    const share = total > 0n ? ratio(l.amount, total) : 0;
    console.log(
      `  ${pad(l.label, 30)}${rpad(toCompact(l.amount), 12)}  ${DIM}${rpad(pct(share), 6)}  ${l.note}${RESET}`,
    );
  }
  console.log(`  ${BOLD}${pad('TOTAL', 30)}${rpad(toCompact(total), 12)}${RESET}`);
  console.log(
    `  ${DIM}${pad('against revenue of', 30)}${rpad(toCompact(is.revenue), 12)}${RESET}`,
  );
  // The step-fixed lines are the only ones a decision can reach this quarter.
  // Saying which is the difference between a table and an answer.
  const reachable = business.costs.stepFixed.reduce<Money>(
    (a, c) => a + c.blockCostPerQuarter * BigInt(c.currentBlocks),
    0n,
  );
  console.log(
    `  ${DIM}${toCompact(reachable)} of that is staffing you can change this quarter with` +
      ` \`fire\`; the rest is contracted or scales with revenue.${RESET}`,
  );
}

function parseCommand(
  line: string,
  business: Business,
  result: TickResult,
  journal?: Journal,
): ParseResult {
  const [verb = '', ...rest] = line.trim().split(/\s+/);
  const streamId = business.streams[0]?.id ?? 's1';
  const none: ParseResult = { actions: [] };
  const fail = (m: string): ParseResult => ({ actions: [], message: `${RED}${m}${RESET}` });

  /**
   * An empty token used to match everything, because every string starts with
   * "". A player typed a bare `fire`, meaning "help me decide", and the game
   * queued a redundancy against whichever line happened to be first.
   */
  const findLine = (token: string): string | undefined =>
    token.trim() === ''
      ? undefined
      : business.costs.stepFixed.find(
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

    case 'costs':
      renderCosts(business, result);
      return none;

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
      const firing = verb.toLowerCase() === 'fire';
      const lines = business.costs.stepFixed;
      const first = rest[0] ?? '';

      // `fire 2` means two blocks when there is only one line to take them
      // from. It used to be read as a line id, fail to match, and be refused
      // as "Unknown cost line 2" — which is true and unhelpful.
      const countOnly = /^\d+$/.test(first.trim());
      const costId =
        countOnly && lines.length === 1 ? lines[0]!.id : findLine(first);
      if (!costId) {
        return fail(
          lines.length === 0
            ? 'There are no step-fixed lines to change.'
            : `Which line? ${lines.map((c) => c.id).join(', ')} — or \`lines\` for the labels.`,
        );
      }
      const blocks = Number(countOnly && lines.length === 1 ? first : (rest[1] ?? 1));
      if (!Number.isInteger(blocks) || blocks < 1) return fail('Block count must be a positive whole number.');

      /**
       * Refuse it now, not in three months.
       *
       * The engine rejects a cut below a line's minimum blocks — correctly —
       * but it does so when the quarter runs. A player fired a barista, was
       * told `[1 queued]`, ran the quarter, and only then read "already at its
       * minimum block count". A decision that cannot happen should fail while
       * they can still make a different one.
       */
      if (firing) {
        const line = lines.find((c) => c.id === costId)!;
        const floor = line.minimumBlocks ?? 0;
        if (line.currentBlocks - blocks < floor) {
          return fail(
            line.currentBlocks <= floor
              ? `${line.label} is already at its minimum of ${floor} blocks — this line cannot go lower.`
              : `${line.label} has ${line.currentBlocks} blocks and a minimum of ${floor}: ` +
                  `you can drop at most ${line.currentBlocks - floor}.`,
          );
        }
      }

      return {
        actions: [
          firing
            ? { kind: 'REMOVE_STEP_BLOCK', costId, blocks }
            : { kind: 'ADD_STEP_BLOCK', costId, blocks },
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

    /**
     * A second territory: more market, not more room inside the one you have.
     *
     * "let's add another truck so we can expand into a new city" and "I want
     * to buy two more trucks and add service all over central OH" had no
     * expression in the game. Every capacity lever adds seats or units inside
     * a demand pool fixed at concept lock, and marketing saturates — so a
     * profitable shop at 82% utilisation with $395k in the bank was simply
     * finished, and the advisor kept recommending the lever that had run out.
     */
    case 'market': {
      const pct = parseNumber((rest[0] ?? '').replace('%', ''));
      const cost = parseMoney(rest[1] ?? '');
      if (pct === undefined || pct <= 0 || cost === undefined) {
        return fail('market needs a size and a cost: `market 40% 150k` — 40% more market, $150k to open it.');
      }
      const p = business.streams[0]?.params;
      if (!p) return fail('No stream to expand.');
      if (p.kind === 'UTILIZATION') {
        return {
          actions: [
            {
              kind: 'EXPAND_CAPACITY',
              businessId: business.id,
              spec: {
                streamId,
                buildoutCost: cost,
                deltaDemandHoursPerQuarter: p.demandHoursPerQuarter * (pct / 100),
              },
            },
          ],
        };
      }
      if (p.kind === 'TRAFFIC') {
        return {
          actions: [
            {
              kind: 'EXPAND_CAPACITY',
              businessId: business.id,
              spec: {
                streamId,
                buildoutCost: cost,
                deltaAddressableTrafficPerQuarter:
                  p.addressableTrafficPerQuarter * (pct / 100),
              },
            },
          ],
        };
      }
      // Saying which lever does move this archetype beats a flat refusal.
      return fail(
        p.kind === 'OCCUPANCY'
          ? 'An occupancy business grows by building units — `expand <units> <cost>`.'
          : p.kind === 'PROJECT_BACKLOG'
            ? 'A contractor grows by bidding more and delivering more — `expand` raises execution capacity.'
            : 'This archetype grows through acquisition spend rather than territory — `marketing <amount>`.',
      );
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
      if (looksLikeAQuestion(line, verb)) {
        const answered = advise(business, result, line);
        for (const said of answered) console.log(`  ${DIM}${said}${RESET}`);
        journal?.write({ kind: 'asked', question: line, answered });
        console.log(`  ${DIM}\`help\` lists every command.${RESET}`);
        return none;
      }
      return fail(`Unknown command "${verb}". Try \`help\`, or ask what to do in plain English.`);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export async function play(
  source: string | WorldState,
  options: { input?: LineSource; milestonePeriod?: number; journal?: Journal } = {},
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

  /**
   * Every quarter, recorded as it happens.
   *
   * The interesting question across many sessions is not what a business
   * looked like at commit — it is what happened next, and how long it took to
   * go wrong. That only exists if it is written down each period rather than
   * summarised at the end, because the sessions worth reading are the ones
   * that end abruptly.
   */
  const record = (result: TickResult): void => {
    const entry = result.statements.byBusiness[businessId];
    if (!entry) return;
    options.journal?.write({
      kind: 'quarter',
      period: result.statements.period,
      revenue: toDisplay(entry.incomeStatement.revenue),
      ebitda: toDisplay(entry.incomeStatement.ebitda),
      cash: toDisplay(entry.balanceSheet.cash),
      ...(entry.derivedMetrics.streamMetrics[0]?.occupancy !== undefined
        ? { occupancy: entry.derivedMetrics.streamMetrics[0].occupancy }
        : {}),
      events: result.events.filter((e) => e.severity !== 'INFO').map((e) => e.kind),
    });
  };

  // Run period 0 so there is something to look at before the first decision.
  let last = advance([]);
  record(last);
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
        const parsed = parseCommand(line, business, last, options.journal);
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
          // Say what was queued, not just that something was. A player who
          // typed `marketing $5` meaning `$5k` had no way to notice until the
          // quarter came back with less revenue than the one before it.
          console.log(`  ${DIM}queued: ${parsed.actions.map(describeAction).join(', ')}${RESET}`);
          // Name the asymmetry out loud, as §11.4 requires of any confirmation.
          for (const a of parsed.actions) {
            if (a.kind === 'ADD_STEP_BLOCK') {
              console.log(`  ${YELLOW}cost starts this quarter; capacity arrives next quarter${RESET}`);
            }
            if (a.kind === 'RAISE_DEBT') {
              console.log(`  ${YELLOW}origination fee this quarter; proceeds arrive next quarter${RESET}`);
            }
            if (a.kind === 'EXPAND_CAPACITY') {
              const market =
                a.spec.deltaDemandHoursPerQuarter !== undefined ||
                a.spec.deltaAddressableTrafficPerQuarter !== undefined;
              console.log(
                `  ${YELLOW}buildout spread over two quarters; ` +
                  `${market ? 'the new market opens' : 'capacity arrives'} in two${RESET}`,
              );
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
          record(last);
          const b = state.businesses.find((x) => x.id === businessId)!;
          if (b.status === 'CLOSED') break;
        }
      } else {
        last = advance(queued);
        record(last);
      }

      renderTurn(last, state.businesses.find((b) => b.id === businessId)!);
    }
  } finally {
    if (!options.input) input.close();
  }
}
