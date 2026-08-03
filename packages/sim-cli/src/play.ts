import { fromDisplay, mulRate, ratio, toCompact, toDisplay, type Money } from '@bizsim/money';
import {
  marketingMovesDemand,
  marketingMultiplier,
  maturityRamp,
  priceEffect,
  streamPrice,
  tick,
  type TickResult,
} from '@bizsim/engine';
import {
  deviationLabel,
  type Action,
  type Assumption,
  type Business,
  type CrisisRemedy,
  type EngineEvent,
  type WorldState,
} from '@bizsim/schemas';
import { benchmarkSecurity, getSecurity, listSecurities } from '@bizsim/seeds';
import { priceOptimum, priceUnits, type PriceOptimum } from './pricing.js';
import { benchmarkLines, portfolioLines, positions, quoteLines } from './portfolio.js';
import { postmortem, runPoint, type RunPoint } from './postmortem.js';
import {
  askAdvisor,
  narrateQuarter,
  providerKeyVar,
  type AdviceTransport,
  type NarrationTransport,
} from '@bizsim/llm';
import { cloneOutlay, saleValue } from '@bizsim/engine';
import { buildBriefing } from './briefing.js';
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
    case 'REPAY_DEBT':
      return `repay ${toDisplay(a.amount, { showCents: false })} of principal`;
    case 'BUY_SECURITY':
      return `invest ${toDisplay(a.amount, { showCents: false })} in ${a.ticker}`;
    case 'SELL_SECURITY':
      return `sell ${a.shares.toFixed(0)} shares of ${a.ticker}`;
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
      const better = a.spec.qualityUpliftPct !== undefined;
      const what =
        better ? `+${Math.round((a.spec.qualityUpliftPct ?? 0) * 100)}% willingness to pay`
        : market ? 'new territory'
        : 'more capacity';
      return `${what} for ${toDisplay(a.spec.buildoutCost, { showCents: false })}`;
    }
    case 'START_BUSINESS':
      return a.clone
        ? `open ${a.clone.name} for ${toDisplay(a.clone.equity, { showCents: false })}`
        : 'start a business';
    case 'SELL_BUSINESS':
      return `sell the business at ${a.multipleOfEbitda ?? DEFAULT_MULTIPLE}× EBITDA`;
    case 'SET_CRISIS_POLICY':
      return `crisis order → ${a.policy.join(', ')}`;
    case 'ADJUST_ASSUMPTION': {
      const value =
        typeof a.newValue === 'bigint'
          ? toDisplay(a.newValue, { showCents: false })
          : a.newValue <= 1
            ? `${(a.newValue * 100).toFixed(1)}%`
            : String(a.newValue);
      return `assumption ${a.assumptionId} → ${value}`;
    }
    default:
      return a.kind;
  }
}

const severityColour = (s: EngineEvent['severity']): string =>
  s === 'CRITICAL' ? RED : s === 'WARNING' ? YELLOW : DIM;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTurn(result: TickResult, business: Business, world?: WorldState): void {
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
    const volume =
      `${Math.round(s.realizedVolume).toLocaleString()} ` +
      `${business.streams.find((x) => x.id === s.streamId)?.volumeNoun ?? VOLUME_UNIT[s.archetype] ?? 'units'}`;
    let detail: string;
    if (s.lostDemand > 0.5) {
      detail =
        `${YELLOW}at capacity · turned away ` +
        `${Math.round(s.lostDemand).toLocaleString()} of ${Math.round(s.demandVolume).toLocaleString()}${RESET}`;
    } else if (s.capacityVolume !== undefined && s.capacityVolume > 0) {
      /**
       * Named as staffing, because that is the only thing it ever was.
       *
       * `capacityVolume` is active blocks × capacityPerBlock — a number that
       * moves the quarter you hire. Printing it as "34.8% of capacity (1,500)"
       * made it read as the size of the market, and on a phone game sold
       * through an app store that reading is simply false: there is no ceiling
       * on subscribers at 1,500, or at 1,500,000. What is true is that the
       * people currently on payroll cover 1,500 of them, which is a hiring
       * trigger and not a wall.
       */
      const used = ratio(fromDisplay(s.realizedVolume), fromDisplay(s.capacityVolume));
      detail = `${DIM}staffed for ${Math.round(s.capacityVolume).toLocaleString()} (${pct(used)} used)${RESET}`;
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

  // The portfolio only takes space on screen once there is one. A player who
  // never buys anything should never see a line about it.
  const hh = result.statements.household;
  if (hh.securitiesValue > 0n) {
    console.log(
      `\n  ${DIM}${pad('Portfolio', 22)}${RESET}${toCompact(hh.securitiesValue)}` +
        `${hh.dividendsReceived > 0n ? ` ${DIM}· ${toCompact(hh.dividendsReceived)} of dividends this quarter${RESET}` : ''}`,
    );
  }

  /**
   * The rest of the portfolio, one line, only once there is one.
   *
   * A player running four businesses needs to know the other three exist
   * without leaving the screen for the one they are working on.
   */
  const others = (world?.businesses ?? []).filter(
    (b) => b.id !== business.id && b.status !== 'SOLD' && b.status !== 'CLOSED',
  );
  if (others.length > 0) {
    const consolidated = result.statements.consolidated.incomeStatement;
    console.log(
      `\n  ${DIM}${pad('Also running', 22)}${RESET}` +
        `${others.map((b) => b.name).join(', ')}` +
        `  ${DIM}· group revenue ${toCompact(consolidated.revenue)}, EBITDA ${toCompact(consolidated.ebitda)}${RESET}`,
    );
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
  ${BOLD}repay${RESET} 100k [facility]  pay principal down early ${DIM}— \`repay all\` clears it${RESET}
  ${BOLD}draw${RESET} 50k              draw on the revolver
  ${BOLD}inject${RESET} 50k            household → business
  ${BOLD}distribute${RESET} 20k        business → household
  ${BOLD}expand${RESET} 20 150k        add capacity for what it costs to build ${DIM}— +2 quarters${RESET}
  ${BOLD}market${RESET} 40% 150k       open a new territory: more demand, not more room ${DIM}— +2 quarters${RESET}
  ${BOLD}upgrade${RESET} 15% 800k      build something better: +15% to what a customer will pay ${DIM}— +2 quarters${RESET}
  ${BOLD}assume${RESET} a12 35% [why]   revise a model assumption ${DIM}— a COGS rate, a cost per unit — \`assumptions\` lists them${RESET}
  ${BOLD}policy${RESET} revolver,inject,defer,emergency,insolvency
                        reorder the cash-crisis ladder (§9.4)

  ${BOLD}buy${RESET} IDX 500k         put household cash into a security ${DIM}— \`quotes\` lists them${RESET}
  ${BOLD}sell${RESET} IDX all         sell a position, or a dollar amount of one
  ${BOLD}quotes${RESET} · ${BOLD}portfolio${RESET}     the catalog, and what you hold

  ${BOLD}clone${RESET} 900k <name>     open a second one ${DIM}— \`3x\` for a bigger site, +2 quarters${RESET}
  ${BOLD}divest${RESET} <n> [multiple]  sell a business ${DIM}— trailing EBITDA × 4 by default${RESET}
  ${BOLD}businesses${RESET} · ${BOLD}switch${RESET} <n>   the portfolio, and which one you are running

  ${BOLD}skip${RESET} <n>              run n quarters with no actions
  ${BOLD}postmortem${RESET}            what would have had to be true ${DIM}— any time, not just at the end${RESET}
  ${BOLD}costs${RESET}                 where the money goes, biggest line first
  ${BOLD}lines${RESET}                 list step-fixed cost line ids
  ${BOLD}assumptions${RESET}           every number the model rests on, and how to argue with one
  ${BOLD}help${RESET} · ${BOLD}quit${RESET}
`;

/** Matches the engine's own default, so the quote and the sale agree. */
const DEFAULT_MULTIPLE = 4;

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
  /** Set by `switch`: which business the next commands are about. */
  activate?: string;
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
type Topic =
  | 'postmortem'
  | 'invest'
  | 'capacity'
  | 'product'
  | 'secondSite'
  | 'demand'
  | 'price'
  | 'marketing'
  | 'staff'
  | 'debt'
  | 'seasonality'
  | 'general';

/**
 * Earliest keyword wins, not first rule in the list.
 *
 * "how could we support higher prices when we're only at 68% occupancy as is?"
 * is a pricing question that mentions occupancy; "what's our occupancy rate?"
 * is an occupancy question that mentions a rate. A fixed rule order gets one of
 * them wrong whichever way it is written. Where the subject appears in the
 * sentence is a better signal than which regex the author happened to put
 * first, because the thing being asked about almost always leads.
 *
 * `occupancy` was in none of these until a hotel owner asked how to raise it
 * and got "Nothing is obviously binding this quarter" — on the one metric the
 * archetype is named after.
 */
const TOPIC_PATTERNS: [Topic, RegExp][] = [
  /**
   * "What went wrong?" — §9.4's post-mortem, reached in the words a player
   * actually uses rather than only through a command they have to know exists.
   */
  [
    'postmortem',
    /\b(what went wrong|went wrong|what killed|why did (it|this|we)|what happened|post-?mortem|would have had to be true|where did (it|we) go wrong)\b/,
  ],
  /**
   * The other thing money can do.
   *
   * Ahead of `debt`, which owns "invest" in the sense of putting money into
   * the business. A player asking about the stock market is asking the
   * opposite question — what happens if the money does not go in.
   */
  [
    'invest',
    /\b(stock|stocks|shares|equities|index|s&p|etf|bonds?|t-?bills?|portfolio|dividend\w*|market returns?|passive|wall street)\b/,
  ],
  /**
   * Buying a second one, which this build cannot do.
   *
   * "I want to use the cash flow from this one to buy a 256 room property in
   * Des Moines" was answered with "you are at 57.6% of capacity, so the
   * constraint is demand". Multi-business is M7 and START_BUSINESS is stubbed
   * in the engine; the honest answer is that, said once, rather than an answer
   * to a question nobody asked.
   */
  [
    'secondSite',
    /\b(another (hotel|property|location|site|store|shop|business)|second (hotel|property|location|site|store)|buy a\b.*\b(hotel|property|building|business)|new market|another market|acquire|acquisition|portfolio)\b/,
  ],
  /**
   * Building something that was not there before.
   *
   * A waterpark, a pool, a restaurant in the lobby, a renovation. Every one of
   * these is a claim that the product becomes worth more, and every one of them
   * used to be answered with the idle-capacity paragraph.
   */
  [
    'product',
    /\b(waterpark|water park|pool|slide|amenit\w*|renovat\w*|refurbish\w*|remodel|upgrade|upgrades|improve|improvement|restaurant|bar|gym|spa|build (a|an|some)|add (a|an) )\b/,
  ],
  [
    'demand',
    /\b(occupanc\w*|occupied|utili[sz]ation|fill|filling|filled|empty|vacan\w*|booked|bookings|footfall|traffic|more customers|more guests|demand)\b/,
  ],
  [
    'price',
    /\b(price|prices|priced|pricing|charge|charging|adr|discount|rate card|nightly rate|room rate|day rate|hourly rate|raise rates?|cut rates?)\b/,
  ],
  ['marketing', /\b(marketing|advertis\w*|promote|promotion|campaign|ads?|awareness)\b/],
  ['capacity', /\b(expand|more sites|more seats|more rooms|capacity|bigger|quadruple|double|scale)\b/],
  ['staff', /\b(staff\w*|labou?r|payroll|hire|fire|crew|employee|headcount|cut costs|costs)\b/],
  [
    'debt',
    /\b(debt|borrow|loan|revolver|financ\w*|raise money|invest|pay off|payoff|pay down|paydown|repay|principal|amorti[sz]\w*)\b/,
  ],
  ['seasonality', /\b(season\w*|swing|winter|summer)\b/],
];

function topicOf(question: string): Topic {
  const q = question.toLowerCase();
  let best: { topic: Topic; at: number } | undefined;
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    const at = q.search(pattern);
    if (at >= 0 && (best === undefined || at < best.at)) best = { topic, at };
  }
  return best?.topic ?? 'general';
}

/**
 * What has already been said this session.
 *
 * A hotel owner said "woah so we're probably overspending on marketing" and got
 * the marketing paragraph he had just been shown, verbatim; then asked "what's
 * the optimal price?" and got the price paragraph he had just been shown,
 * verbatim. Repeating an answer word for word is a specific kind of insult: it
 * says the second thing you typed was not read.
 *
 * A set of what was already printed is enough. It does not need to be clever —
 * it needs to never print the same sentence twice and to say something rather
 * than nothing when it has run out.
 */
export interface AdvisorMemory {
  said: Set<string>;
}

export const newAdvisorMemory = (): AdvisorMemory => ({ said: new Set() });

/**
 * Why the optimum stops where it does.
 *
 * A price recommendation with no reason behind it is a number to be trusted or
 * ignored, and neither is what the player wants. All three of these are real
 * and different: one is arithmetic, one is a sold-out building, and one is the
 * model refusing to extrapolate past where it means anything.
 */
const BINDING_NOTE: Record<PriceOptimum['binding'], string> = {
  CONTRIBUTION:
    'That is a genuine peak: past it the volume you give up costs more than the rate you gain.',
  CAPACITY:
    'It stops there because you sell out — below that price the extra demand has nowhere to go, ' +
    'so cutting further only lowers what you get for the units you were always going to fill.',
  MODEL_BAND:
    'It stops there because the model does: outside 0.4×–3× the reference price the demand ' +
    'response is clamped, and anything past this edge would be a statement about the clamp.',
};

const elasticityCaveat = (elasticity: number): string =>
  `All of it rests on the price elasticity of ${elasticity.toFixed(1)} the concept was drafted ` +
  `with — an assumption, not a measurement of your customers.`;

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
function advise(
  business: Business,
  result: TickResult,
  world: WorldState,
  history: readonly RunPoint[],
  question = '',
  memory?: AdvisorMemory,
): string[] {
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

  /**
   * Blocks being paid for that this quarter's volume does not need.
   *
   * "Cutting staff you have already paid for does not help" was said to a cafe
   * carrying four barista blocks against demand that needed two — where
   * cutting was the single most useful thing available. Idle capacity does not
   * mean the cost structure is right-sized; it usually means the opposite.
   */
  const overstaffed = business.costs.stepFixed
    .map((line) => {
      const per = Number(line.capacity?.capacityPerBlock ?? 0);
      if (per <= 0 || !stream) return undefined;
      const needed = Math.ceil(stream.demandVolume / per);
      const floor = Math.max(line.minimumBlocks ?? 0, needed);
      const spare = line.currentBlocks - floor;
      return spare > 0
        ? { line, spare, saving: line.blockCostPerQuarter * BigInt(spare) }
        : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);
  const sparePay = overstaffed.reduce<Money>((a, o) => a + o.saving, 0n);

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
    const occupancyParams = business.streams[0]?.params;

    /**
     * Idle rooms are not idle seats.
     *
     * "You already have 19 idle — more capacity earns nothing until demand
     * catches up" was said to a hotel owner who wanted to double his room
     * count, and it is simply wrong for this archetype. OCCUPANCY demand is
     * `units × occupancy`: occupancy is a RATE, so doubling the units doubles
     * the demand and the empty-room count with it. Every other archetype draws
     * from a demand pool fixed at concept lock, which is where that sentence
     * came from and where it belongs.
     */
    if (occupancyParams?.kind === 'OCCUPANCY') {
      const rate = stream.occupancy ?? used;
      out.push(
        `Rooms are not seats: occupancy is a rate here, so ${occupancyParams.units} units at ` +
          `${pct(rate)} become ${occupancyParams.units * 2} units at ${pct(rate)} — the empty ones ` +
          `scale up too, and so does the revenue. \`expand <units> <cost>\` adds them, two quarters out.`,
      );
      out.push(
        `Worth knowing that this is the generous case: the model has no view on whether a second ` +
          `${occupancyParams.units} units in the same town would fill at the same ${pct(rate)}, and ` +
          `in a small market they would not. \`upgrade <pct> <cost>\` is the other half — a better ` +
          `site rather than a bigger one.`,
      );
    } else if (stream.lostDemand > 0.5) {
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

  const first = business.streams[0];

  /**
   * "I want to add a small indoor waterpark."
   *
   * The one question the game had no shape for. Every lever it owned was
   * quantity — more rooms, more marketing, a different price — and none of them
   * is what a player means by building something new. The answer cannot be a
   * cost, because nothing here knows what a waterpark costs in Russell, Kansas.
   * It can be the trade, stated precisely enough that the player's own number
   * becomes a decision the game will hold them to.
   */
  if (topic === 'product' && first && stream) {
    const priceNow = streamPrice(first);
    const units = priceUnits(first, priceNow);
    const elasticity = first.modifiers.priceElasticity;
    // What a 10% claim is worth at today's volume, both ways round, so the
    // player can size their own number against something real.
    const asVolume = Math.pow(1.1, elasticity) - 1;
    const asRate = mulRate(is.revenue, 0.1);
    out.push(
      `That is a claim about what the product is worth, and it is a real lever: ` +
        `\`upgrade <pct> <cost>\` books it. You say how much more a customer would pay for the ` +
        `finished thing and what it costs to build; the buildout capitalises and it lands in two quarters.`,
    );
    out.push(
      `To size it: a 10% claim moves the reference price from ${units.colloquial ?? `$${units.command.toLocaleString()}`} ` +
        `up 10%, which at an elasticity of ${elasticity.toFixed(1)} is about ${pct(asVolume)} more ` +
        `volume at today's rate — or hold the volume, raise the rate 10%, and take ` +
        `${toCompact(asRate)} a quarter instead. The game will not tell you a waterpark is worth 10%; ` +
        `that number is yours, and the run is what tests it.`,
    );
  }

  /**
   * "What went wrong?"
   *
   * Routed to the same analysis the `postmortem` command prints, because a
   * player who asks the question in English deserves the answer they would have
   * got by typing a word they had no way to know about.
   */
  if (topic === 'postmortem') {
    out.push(...postmortem(history, business).lines.filter((l) => l !== ''));
  }

  /**
   * "How does this compare to just buying the index?"
   *
   * The question the game could not answer for its whole life until now. A
   * business with idle cash at 0% was being compared against nothing.
   */
  if (topic === 'invest') {
    const index = benchmarkSecurity();
    const held = positions(world, result.statements.period);
    const value = held.reduce<Money>((a, p) => a + p.value, 0n);
    out.push(
      `\`buy <ticker> <amount>\` invests household cash — \`quotes\` lists the five instruments and ` +
        `\`portfolio\` shows what you hold${value > 0n ? `, currently ${toCompact(value)}` : ''}. ` +
        `Business cash has to be \`distribute\`d first, and taxed on the way out.`,
    );
    out.push(
      `The comparison is the point: ${index.label.toLowerCase()} is assumed to return ` +
        `${((index.expectedAnnualPriceReturn + index.dividendYield) * 100).toFixed(1)}% a year with ` +
        `${(index.annualVolatility * 100).toFixed(0)}% volatility, and the run is scored against leaving ` +
        `your whole starting stake in it untouched. Household cash sitting in the current account earns ` +
        `nothing at all — \`buy TBILL\` is the floor under that.`,
    );
  }

  /**
   * "I want to buy a 256 room property in Des Moines."
   */
  if (topic === 'secondSite') {
    out.push(
      `A second property is not in this build — multi-business is M7, and the engine stubs ` +
        `START_BUSINESS rather than pretending. Saying so is the whole answer; there is no ` +
        `workaround worth typing.`,
    );
    out.push(
      `Inside this one: \`expand <units> <cost>\` buys more of it, \`upgrade <pct> <cost>\` makes it ` +
        `worth more, \`repay\` retires the debt, and \`distribute\` moves the cash to your household, ` +
        `where a real second deal would be funded from.`,
    );
  }

  /**
   * "how can we get occupancy up?"
   *
   * Fell through to the general diagnosis, which looked at a hotel running at
   * 68% of its keys and said "nothing is obviously binding this quarter". The
   * question has a real answer and the engine has all of it: occupancy is
   * `stabilizedOccupancy × ramp × priceEffect × season`, capped at the unit
   * count. Three of those four are visible, and the ceiling they imply is the
   * single most useful number a player at 68% could be told.
   */
  if (topic === 'demand' && first && stream) {
    const p = first.params;
    const priceNow = streamPrice(first);
    const priceMultiplier = priceEffect(priceNow, p.referencePrice, first.modifiers.priceElasticity)
      .multiplier;
    const quarters = first.state.quartersSinceLaunch;
    const ramp = maturityRamp(quarters, first.modifiers.rampFloor, first.modifiers.rampConstant);

    if (p.kind === 'OCCUPANCY') {
      const occupancy = stream.occupancy ?? used ?? 0;
      const ceiling = Math.min(1, p.stabilizedOccupancy * priceMultiplier);
      // Only worth two numbers when the price has actually moved the ceiling
      // off the drafted figure; otherwise it is the same number said twice.
      const moved = Math.abs(priceMultiplier - 1) > 0.02;
      out.push(
        `You are at ${pct(occupancy)} of ${p.units.toLocaleString()} units, and at today's rate ` +
          `the model tops out near ${pct(ceiling)}` +
          (moved
            ? ` — the concept's stabilized occupancy of ${pct(p.stabilizedOccupancy)}, moved by where ` +
              `you have priced. Price is what moves that ceiling; nothing else does.`
            : `, the stabilized occupancy the concept was drafted with. Price is what moves that ` +
              `ceiling; nothing else does.`),
      );
      if (ramp < 0.97) {
        out.push(
          `Some of the gap closes on its own: ${quarters === 0 ? 'you have not finished a quarter yet' : `${quarters} quarters in`}, ` +
            `the ramp has you at ${pct(ramp)} of stabilized demand and it climbs without you doing anything.`,
        );
      }
    } else if (used !== undefined) {
      const idle = Math.round((stream.capacityVolume ?? 0) - stream.realizedVolume);
      out.push(
        stream.lostDemand > 0.5
          ? `Demand is not the problem — you turned away ${Math.round(stream.lostDemand).toLocaleString()} ` +
              `this quarter. Capacity is what is binding: \`hire\` or \`expand\`.`
          : `You are running at ${pct(used)} of what you are staffed for, with ${idle.toLocaleString()} ` +
              `going unused. Demand is what is short, not your capacity to serve it.`,
      );
    }
  }

  if (topic === 'price' && first) {
    const priceNow = streamPrice(first);
    const units = priceUnits(first, priceNow);
    out.push(
      `You are at $${units.command.toLocaleString()} ${units.per}` +
        `${units.colloquial ? ` — ${units.colloquial}` : ''}. \`price ${units.command}\` is how it is ` +
        `typed: the command takes the first of those numbers, not the second.`,
    );

    const optimum = stream ? priceOptimum(business, first, stream, priceNow) : undefined;
    // Worth doing, not merely different. A 22% rate cut that earns the same
    // money is an argmax, not a recommendation, and the two have to read
    // differently or the player learns to distrust both.
    const gain =
      optimum === undefined
        ? 0
        : optimum.contributionNow > 0n
          ? Number(optimum.contribution - optimum.contributionNow) / Number(optimum.contributionNow)
          : optimum.contribution > optimum.contributionNow
            ? 1
            : 0;
    const worthMoving = gain > 0.02;

    if (optimum === undefined) {
      out.push('Elasticity is modelled, so a rise trades volume for margin.');
    } else if (!worthMoving && optimum.flat) {
      // "Cut your rent 22% to earn the same money" is what an argmax over a
      // plateau produces, and it is worse than no answer. At an elasticity near
      // 1 the volume response gives back what the rate change takes, and the
      // finding is that this business does not have a pricing decision.
      const lowEnd = priceUnits(first, optimum.band.low);
      const highEnd = priceUnits(first, optimum.band.high);
      out.push(
        `Contribution barely moves: anywhere from $${lowEnd.command.toLocaleString()} to ` +
          `$${highEnd.command.toLocaleString()}` +
          // "$46 a month to $345 a month" says the unit twice.
          `${lowEnd.colloquial ? ` (${lowEnd.colloquial.replace(/ an? \w+$/, '')} to ${highEnd.colloquial})` : ''} is worth within ` +
          `2% of the same money, because at an elasticity of ${optimum.elasticity.toFixed(1)} the volume ` +
          `you gain is almost exactly what the rate gives up. Price is not the lever in this business.`,
      );
    } else if (!worthMoving) {
      out.push(
        `Moving it is worth less than 2% of contribution either way, so there is nothing to win ` +
          `here — the lever is already about where it should be.`,
      );
    } else {
      const targetUnits = priceUnits(first, optimum.price);
      out.push(
        `Contribution peaks at $${targetUnits.command.toLocaleString()}` +
          `${targetUnits.colloquial ? ` (${targetUnits.colloquial})` : ''}, ` +
          `${optimum.factor > 1 ? 'up' : 'down'} ${pct(Math.abs(optimum.factor - 1))}: volume ` +
          `${Math.round(optimum.volumeNow).toLocaleString()} → ${Math.round(optimum.volume).toLocaleString()}, ` +
          `contribution ${toCompact(optimum.contributionNow)} → ${toCompact(optimum.contribution)} a ` +
          `quarter. \`price ${targetUnits.command}\` sets it.`,
      );
      out.push(`${BINDING_NOTE[optimum.binding]} ${elasticityCaveat(optimum.elasticity)}`);
    }
  }

  if (topic === 'marketing') {
    const spend = first?.marketingSpendPerQuarter ?? 0n;
    const half = first?.modifiers.halfSaturationSpend ?? 0n;
    // Past twice the half-saturation point, more spend is close to free money
    // thrown away — and repeating "response saturates" to someone who has
    // already tripled their budget and seen nothing is not advice.
    const tapped = half > 0n && spend > half * 2n;
    /**
     * For some archetypes the curve is not flat — it is absent.
     *
     * A hotel owner at $18k a quarter was told his spend had "saturated",
     * which describes a multiplier the engine never evaluates for OCCUPANCY:
     * §3.0.2 exempts it. The spend was expensed and bought nothing at any
     * level, and the honest thing is to say so and hand back the money.
     */
    if (first && !marketingMovesDemand(first.params.kind)) {
      out.push(
        spend > 0n
          ? `Marketing does not move this archetype in the model at all — not weakly, not with ` +
              `diminishing returns: the spend is expensed and demand never reads it. You are paying ` +
              `${toCompact(spend)} a quarter for that, and \`marketing 0\` is that much straight onto EBITDA.`
          : `Marketing does not move this archetype in the model — the spend is expensed and demand ` +
              `never reads it. Rate and time are what fill the units here.`,
      );
      out.push(
        `That is a simplification, and worth knowing as one: real hotels and landlords do buy demand. ` +
          `In this model they do not, so do not plan around it.`,
      );
    } else {
      out.push(
        tapped
          ? `You are at ${toCompact(spend)} a quarter against a half-saturation point of ` +
              `${toCompact(half)} — this lever is spent, which is why the last raise did nothing. ` +
              `Growth from here is a bigger market (\`market <pct> <cost>\`) or a higher price, not more spend.`
          : `\`marketing <amount>\` — you are at ${toCompact(spend)} a quarter. Response saturates: ` +
              `each extra dollar buys less than the last, and it moves demand rather than capacity.`,
      );
    }
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
        const spare = line.currentBlocks - Math.max(line.minimumBlocks ?? 0, needed);
        const blockedByFloor = needed < line.currentBlocks && spare <= 0;
        out.push(
          spare > 0
            ? `${line.label}: ${line.currentBlocks} blocks carrying ${Math.round(stream.demandVolume).toLocaleString()} ` +
                `of demand at ${per.toLocaleString()} each — ${spare} could go and still cover it, ` +
                `saving ${toCompact(line.blockCostPerQuarter * BigInt(spare))} a quarter.`
            : blockedByFloor
              ? // The doom loop, named. Volume needs fewer than you have, and
                // the concept's own floor forbids the cut — which the player
                // never chose and cannot see.
                `${line.label}: volume needs ${needed} blocks and you have ${line.currentBlocks}, but ` +
                  `this line was drafted with a minimum of ${line.minimumBlocks} and cannot go lower. ` +
                  `That floor is part of the concept, not a rule of the game.`
              : // Not a verdict. Cutting below demand is sometimes the right
                // move for a business that is going broke at full staffing,
                // and the only honest thing to do is price the trade.
                (() => {
                  const perUnit =
                    stream.realizedVolume > 0 ? Number(is.revenue) / stream.realizedVolume : 0;
                  const lostPerBlock = Math.min(per, stream.demandVolume);
                  const revenueAtRisk = BigInt(Math.round(lostPerBlock * perUnit));
                  return (
                    `${line.label}: ${line.currentBlocks} blocks is what this quarter's volume ` +
                    `needs. Each one you cut turns away about ${Math.round(lostPerBlock).toLocaleString()} ` +
                    `customers — ${toCompact(revenueAtRisk)} of revenue against ` +
                    `${toCompact(line.blockCostPerQuarter)} of pay.`
                  );
                })(),
        );
      }
    }
  }

  /**
   * "how do I pay off my SBA loan?" — answered with how to borrow.
   *
   * Owing and borrowing are opposite intentions that share every keyword, so
   * the question has to be read before the answer is chosen. The player who
   * asked this went on to type `debt -$400k`, which is the correct instinct
   * about arithmetic and the wrong thing to do to a ledger.
   */
  if (topic === 'debt') {
    const owed = business.debts.filter((d) => d.outstandingPrincipal > 0n);
    const totalOwed = owed.reduce<Money>((a, d) => a + d.outstandingPrincipal, 0n);

    if (/\b(pay off|payoff|pay down|paydown|repay|retire|get rid of|clear)\b/.test(question.toLowerCase())) {
      out.push(
        owed.length === 0
          ? 'Nothing is outstanding — there is no principal left to pay down.'
          : `\`repay <amount>\` pays principal down early, and \`repay all\` clears a facility. ` +
              `You owe ${toCompact(totalOwed)}: ` +
              `${owed.map((d) => `${d.label} ${toCompact(d.outstandingPrincipal)} at ${(d.annualRate * 100).toFixed(1)}%`).join(', ')}.`,
      );
      if (owed.length > 0) {
        // The rate is the return. Nothing else in this game reliably pays 10.5%
        // risk-free, and that is the whole case for early repayment.
        const dearest = [...owed].sort((a, b) => b.annualRate - a.annualRate)[0]!;
        out.push(
          `Paying it down early earns you its rate — ${(dearest.annualRate * 100).toFixed(1)}% on ` +
            `${dearest.label} — with no risk attached. Against ${toCompact(business.cash)} of cash, ` +
            `the question is only how much you want to keep for the next bad quarter.`,
        );
      }
    } else {
      out.push(
        is.ebitda < 0n
          ? `Borrowing funds losses, it does not end them: at ${toCompact(is.ebitda)} of EBITDA every ` +
              `quarter, more debt buys time and raises the interest you pay for it. ` +
              `\`debt <amount>\` and \`draw <amount>\` both work; neither changes the trajectory.`
          : `\`debt <amount>\` raises a term loan, \`draw\` uses the revolver, \`repay\` pays one ` +
              `down early. At ${toCompact(is.ebitda)} of EBITDA you can service some of it.`,
      );
    }
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
  // Extracted so that a repeated question can fall back to it: the second time
  // someone asks about marketing, the state of their business is a better
  // answer than the marketing paragraph they have already read.
  const generalDiagnosis = (): string[] => {
    const out: string[] = [];
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
          sparePay > 0n
            ? `You are at ${pct(used)} of what you are staffed for: demand is short of what you built, ` +
                `and you are staffed for the plan rather than the demand. \`marketing\` and \`price\` move ` +
                `volume; right-sizing the staffing is the half you control this quarter.`
            : `You are at ${pct(used)} of what you are staffed for, so the constraint is demand, not ` +
                `your capacity to serve it. \`marketing\` and \`price\` move volume, and the staffing ` +
                `already matches the volume.`,
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
    // Named before the debt line, because it is the only lever here that
    // changes the trajectory rather than buying time against it.
    if (sparePay > 0n) {
      const spareBlocks = overstaffed.reduce((a, o) => a + o.spare, 0);
      out.push(
        `You are paying for ${spareBlocks} ${spareBlocks === 1 ? 'block' : 'blocks'} this quarter's ` +
          `volume does not need — ${toCompact(sparePay)} a quarter. ` +
          `${overstaffed.map((o) => `\`fire ${o.line.id} ${o.spare}\``).join(' and ')}.`,
      );
    }
    if (is.interestExpense > 0n && is.ebitda < is.interestExpense) {
      out.push(
        `Interest alone is ${toCompact(is.interestExpense)} a quarter against ${toCompact(is.ebitda)} ` +
          `of EBITDA. Borrowing more raises that number rather than solving it.`,
      );
    }
    return out;
  };

  if (topic === 'general' || out.length === 0) out.push(...generalDiagnosis());

  if (out.length === 0) {
    out.push(
      `Nothing is obviously binding this quarter. \`price\`, \`marketing\`, \`hire\` and ` +
        `\`expand\` are the levers; \`skip 4\` runs a year if you want to see the trend first.`,
    );
  }

  return remember(out, generalDiagnosis, memory);
}

/**
 * Print nothing the player has already been given word for word.
 *
 * The fallbacks descend: the answer to what was asked, then the state of the
 * business, then an admission. The admission is allowed to repeat — "nothing
 * has changed" is a true sentence every time it is printed, and it is short.
 */
function remember(
  lines: string[],
  fallback: () => string[],
  memory: AdvisorMemory | undefined,
): string[] {
  if (!memory) return lines;
  const keep = (candidates: string[]): string[] => candidates.filter((l) => !memory.said.has(l));

  let fresh = keep(lines);
  if (fresh.length === 0) fresh = keep(fallback());
  if (fresh.length === 0) {
    return [
      `Same answer as last time — nothing in this quarter's numbers has moved since you asked. ` +
        `\`skip 1\` runs a quarter and changes them.`,
    ];
  }
  for (const line of fresh) memory.said.add(line);
  return fresh;
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
  '', 'help', 'quit', 'exit', 'lines', 'costs', 'skip', 'price', 'marketing', 'postmortem',
  'hire', 'fire', 'debt', 'repay', 'draw', 'inject', 'distribute', 'expand', 'market',
  'upgrade', 'renovate', 'policy', 'quotes', 'quote', 'portfolio', 'holdings', 'buy', 'sell',
  'businesses', 'switch', 'clone', 'divest', 'assume', 'assumptions',
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
/** An assumption's value, in its own units. */
function renderAssumptionValue(a: Assumption): string {
  if (typeof a.value === 'bigint') return toCompact(a.value);
  if (a.unit === 'pct') return pct(a.value);
  return `${a.value.toLocaleString()} ${a.unit === 'ratio' ? '' : a.unit}`.trim();
}

const renderRange = (a: Assumption): string =>
  a.unit === 'pct' && !a.isMoney
    ? `${pct(a.range.low)}–${pct(a.range.high)}`
    : a.isMoney
      ? `${toCompact(BigInt(Math.round(a.range.low * 100)))}–${toCompact(BigInt(Math.round(a.range.high * 100)))}`
      : `${a.range.low.toLocaleString()}–${a.range.high.toLocaleString()}`;

/** A plausible value for the error message, so the example actually parses. */
const exampleValue = (a: Assumption): string =>
  a.isMoney ? '12k' : a.unit === 'pct' ? '35%' : '450';

/**
 * The register, mid-game — §10.1's read half.
 *
 * The setup flow shows every one of these before commit; this is the same
 * ledger once the world exists, because "what does the model actually
 * believe?" is a question a player asks in period 6, usually right after the
 * screen disagreed with them.
 */
function renderAssumptions(business: Business): void {
  const all = Object.values(business.assumptions.byId).sort((a, b) =>
    a.category === b.category ? a.label.localeCompare(b.label) : a.category.localeCompare(b.category),
  );
  if (all.length === 0) {
    console.log(`  ${DIM}This business has no registered assumptions to argue with.${RESET}`);
    return;
  }
  console.log(
    `\n  ${BOLD}ASSUMPTIONS${RESET}  ${DIM}the numbers the model rests on — \`assume <id> <value> [why]\` revises one${RESET}`,
  );
  for (const a of all) {
    console.log(
      `  ${pad(a.id, 6)}${pad(a.label, 38)}${rpad(renderAssumptionValue(a), 10)}  ` +
        `${DIM}${rpad(renderRange(a), 17)}  ${a.provenance}${RESET}`,
    );
  }
}

function renderCosts(business: Business, result: TickResult): void {
  const entry = result.statements.byBusiness[business.id];
  if (!entry) {
    console.log(`  ${DIM}No statements yet — run a quarter first.${RESET}`);
    return;
  }
  const is = entry.incomeStatement;

  const lines: { label: string; amount: Money; note: string }[] = [
    ...business.costs.variableWithRevenue.map((c) => {
      // The rate is an assumption, and the register knows it by id. Naming the
      // command here matters because this line is where a player who thinks
      // the rate is wrong is looking when they think it.
      const assumptionId = business.assumptions.byPath[`costs.${c.id}.pctOfRevenue`];
      return {
        label: c.label,
        amount: mulRate(is.revenue, c.pctOfRevenue),
        note:
          `${pct(c.pctOfRevenue)} of revenue` +
          (assumptionId ? ` — \`assume ${assumptionId}\` changes it` : ''),
      };
    }),
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
      ` \`fire\`; the revenue-scaled rates are assumptions \`assume\` can revise; the rest` +
      ` is contracted.${RESET}`,
  );
}

/**
 * The heading has to come from the verdict, not from where it is printed.
 *
 * "WHAT IT RESTED ON" over an analysis that opens "short by $1.4k a quarter"
 * is the screen contradicting itself in its first two lines.
 */
function printPostmortem(history: readonly RunPoint[], business: Business, colour = ''): void {
  const analysis = postmortem(history, business);
  const heading =
    analysis.verdict === 'WORKED' ? 'WHAT IT RESTS ON' : 'WHAT WOULD HAVE HAD TO BE TRUE';
  console.log(`\n${colour ? DIM : BOLD}${heading}${RESET}`);
  for (const line of analysis.lines) {
    console.log(line === '' ? '' : `  ${colour}${line}${colour ? RESET : ''}`);
  }
}

/**
 * The model's half of the answer, and what happens when it cannot be trusted.
 *
 * Everything here fails soft. No key, a network error, a budget exhausted, or a
 * reply that quoted money the ledger never produced — every one of them leaves
 * the deterministic answer on screen and says nothing further. A game that
 * stops working because a model was unreachable would be a worse game than one
 * with no model in it.
 */
async function speakToPlayer(
  advisor: AdviceTransport,
  world: WorldState,
  business: Business,
  result: TickResult,
  findings: readonly string[],
  question: string,
  journal?: Journal,
): Promise<{ reply: string } | undefined> {
  try {
    const briefing = buildBriefing(world, business, result, findings, [...VERBS].filter(Boolean));
    const outcome = await askAdvisor(advisor, briefing, question, [], () => Date.now());
    if (!outcome) {
      // Twice in a row it could not answer without inventing a figure. The
      // arithmetic is already on screen and is still correct; adding "the model
      // could not be trusted" to the player's turn helps nobody.
      journal?.write({ kind: 'advice_refused', question });
      return undefined;
    }

    console.log('');
    const paragraphs = outcome.reply.split('\n').filter((p) => p.trim() !== '');
    paragraphs.forEach((paragraph, i) => {
      // The wait, on the last line only. The player asked for this as QA data
      // and it is the honest label on a pause they just sat through.
      const timing = i === paragraphs.length - 1 ? ` ${DIM}· ${(outcome.ms / 1000).toFixed(1)}s${RESET}` : '';
      console.log(`  ${paragraph}${timing}`);
    });

    // Suggestions are checked against the parser before they are shown. A
    // command that does not exist, coming from the thing that just recommended
    // it, is worse than no suggestion at all.
    const usable = outcome.suggestedCommands.filter((c) => VERBS.has(c.trim().split(/\s+/)[0] ?? ''));
    if (usable.length > 0) {
      console.log(`  ${DIM}${usable.map((c) => `\`${c}\``).join(' · ')}${RESET}`);
    }
    if (outcome.retriedOn && outcome.retriedOn.length > 0) {
      journal?.write({ kind: 'advice_corrected', question, figures: outcome.retriedOn });
    }
    return { reply: outcome.reply };
  } catch {
    // Transport failures are not the player's problem and not their fault.
    journal?.write({ kind: 'advice_failed', question });
    return undefined;
  }
}

/**
 * §11.5 — the sentence over the top of the quarter.
 *
 * Runs after `renderTurn`, so everything it explains is already on screen and
 * everything it says can be checked against what the player sees. Prints
 * nothing at all when it cannot pass the money guard, when the transport
 * fails, or when there is no model — the screen above is complete without it,
 * and correct-but-terse beats fluent-but-wrong.
 */
async function narrateTurn(
  advisor: (AdviceTransport & Partial<NarrationTransport>) | undefined,
  world: WorldState,
  business: Business,
  result: TickResult,
  history: readonly RunPoint[],
  journal?: Journal,
): Promise<void> {
  if (!advisor?.narrate) return;
  const period = result.statements.period;
  try {
    // The quarter before the one on screen, so "what changed" is a comparison
    // the model was handed rather than a memory it invents. After a `skip`,
    // that is the quarter immediately before the rendered one — which is also
    // the comparison the screen itself implies.
    const prior = history.length >= 2 ? history[history.length - 2] : undefined;
    const events = result.events
      .filter((e) => e.severity !== 'INFO')
      .map((e) => describeEvent(e));
    const briefing = buildBriefing(world, business, result, [], [...VERBS].filter(Boolean), {
      ...(prior ? { prior: { revenue: prior.revenue, ebitda: prior.ebitda, cash: prior.cash } } : {}),
      events,
    });
    const outcome = await narrateQuarter(
      { narrate: (system, input) => advisor.narrate!(system, input) },
      briefing,
      () => Date.now(),
    );
    if (!outcome) {
      // Twice it could not narrate without inventing a figure. Silence, and a
      // record — the rate at which this happens is the §1.1 quality signal.
      journal?.write({ kind: 'narration_failed', period });
      return;
    }

    const n = outcome.narration;
    console.log(`\n  ${BOLD}${n.headline}${RESET}`);
    for (const paragraph of n.narrative.split('\n').filter((x) => x.trim() !== '')) {
      console.log(`  ${paragraph}`);
    }
    if (n.suggestedQuestions.length > 0) {
      console.log(
        `  ${DIM}worth asking: ${n.suggestedQuestions
          .slice(0, 2)
          .map((q) => `"${q}"`)
          .join(' · ')} · ${(outcome.ms / 1000).toFixed(1)}s${RESET}`,
      );
    } else {
      console.log(`  ${DIM}· ${(outcome.ms / 1000).toFixed(1)}s${RESET}`);
    }

    journal?.write({
      kind: 'narration',
      period,
      headline: n.headline,
      narrative: n.narrative,
      ms: outcome.ms,
    });
    if (outcome.retriedOn && outcome.retriedOn.length > 0) {
      journal?.write({ kind: 'narration_corrected', period, figures: outcome.retriedOn });
    }
  } catch {
    // A transport fault costs the player a paragraph, not a turn.
    journal?.write({ kind: 'narration_failed', period });
  }
}

async function parseCommand(
  line: string,
  business: Business,
  result: TickResult,
  world: WorldState,
  history: readonly RunPoint[],
  journal?: Journal,
  memory?: AdvisorMemory,
  advisor?: AdviceTransport & Partial<NarrationTransport>,
): Promise<ParseResult> {
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

  /**
   * A negative amount is a different verb, not a smaller number.
   *
   * `debt -$400k` was read as "raise minus four hundred thousand of debt",
   * queued, and booked — a facility with a negative balance accruing interest.
   * The engine refuses it now; this refuses it at the point where the player
   * can still be told what they actually meant.
   */
  const positive = (amount: Money | undefined, verb: string, instead: string): string | undefined =>
    amount !== undefined && amount <= 0n
      ? `A negative \`${verb}\` is not the opposite of ${verb} — ${instead}`
      : undefined;

  /**
   * A bare `why` is the post-mortem; `why does revenue keep swinging?` is not.
   *
   * Making `why` a verb outright would swallow every why-question into the same
   * answer, which is the exact failure the topic router exists to prevent — so
   * it is a command only when it is the whole line.
   */
  if (verb.toLowerCase() === 'why' && rest.length === 0) {
    printPostmortem(history, business, DIM);
    return none;
  }

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

    case 'assumptions':
      renderAssumptions(business);
      return none;

    /**
     * §10.1's second half, finally reachable from the game.
     *
     * A vending operator said his coffee and soft-serve margins should run
     * 60-70% where the draft assumed a flat 50% product cost — a claim about
     * the real world (substitute a generic product, renegotiate supply) that
     * the game could not express: every registered assumption was locked the
     * moment setup ended, and the only margin lever left was price. The
     * engine's `ADJUST_ASSUMPTION` had write-through to the model all along;
     * no command ever emitted it.
     *
     * D-5 applies mid-game exactly as it does at setup: a value outside the
     * drafted range gets a warning and a provenance mark, never a refusal.
     * The player is the one looking at the real supplier quote.
     */
    case 'assume': {
      const token = rest[0] ?? '';
      const target = token.trim()
        ? Object.values(business.assumptions.byId).find(
            (a) => a.id === token || a.label.toLowerCase().startsWith(token.toLowerCase()),
          )
        : undefined;
      if (!target) {
        return fail(
          token.trim()
            ? `No assumption matches "${token}". \`assumptions\` lists every id.`
            : 'assume needs an assumption and a value, e.g. `assume a12 35%`. `assumptions` lists them.',
        );
      }

      const raw = rest[1] ?? '';
      if (!raw.trim()) {
        return fail(
          `${target.label} is currently ${renderAssumptionValue(target)}. ` +
            `Give the new value too, e.g. \`assume ${target.id} ${exampleValue(target)}\`.`,
        );
      }

      let newValue: number | Money;
      if (target.isMoney) {
        const money = parseMoney(raw);
        if (money === undefined) return fail(`${target.label} is a dollar amount, e.g. \`assume ${target.id} ${exampleValue(target)}\`.`);
        if (money < 0n) return fail(`${target.label} cannot be negative.`);
        newValue = money;
      } else if (target.unit === 'pct') {
        // "35%", "0.35" and "35" all mean the same rate: bare numbers above 1
        // are read as percentage points, because nobody types `assume a12 35`
        // meaning thirty-five times revenue.
        const numeric = Number(raw.replace(/%$/, '').replace(/,/g, ''));
        if (!Number.isFinite(numeric)) return fail(`${target.label} is a rate, e.g. \`assume ${target.id} 35%\`.`);
        const rate = raw.trim().endsWith('%') || numeric > 1 ? numeric / 100 : numeric;
        if (rate < 0 || rate > 1) return fail(`A rate has to sit between 0% and 100%; ${raw} does not.`);
        newValue = rate;
      } else {
        const numeric = Number(raw.replace(/,/g, ''));
        if (!Number.isFinite(numeric) || numeric < 0) {
          return fail(`${target.label} is a number (${target.unit}), e.g. \`assume ${target.id} ${exampleValue(target)}\`.`);
        }
        newValue = numeric;
      }

      const evidence = rest.slice(2).join(' ').trim();
      const action: Action = {
        kind: 'ADJUST_ASSUMPTION',
        assumptionId: target.id,
        newValue,
        ...(evidence ? { evidence } : {}),
      };

      // The warning, not the refusal (D-5). Out of the drafted range is a
      // claim worth flagging at the moment it is made — after the quarter runs
      // it is indistinguishable from a number that was always there.
      const numeric = typeof newValue === 'bigint' ? Number(newValue) / 100 : newValue;
      const flags: string[] = [];
      if (numeric < target.range.low || numeric > target.range.high) {
        flags.push(
          `outside the drafted range (${renderRange(target)}) — modelled anyway, recorded as ` +
            (evidence ? 'your sourced figure' : 'your assertion, no evidence behind it'),
        );
      }
      const deviation = deviationLabel({ ...target, value: newValue });
      if (deviation) flags.push(`${deviation} — benchmark: ${target.benchmarkBand!.source}`);
      return {
        actions: [action],
        ...(flags.length > 0 ? { message: `${DIM}${target.label}: ${flags.join('; ')}${RESET}` } : {}),
      };
    }

    case 'skip': {
      const n = Number(rest[0] ?? 1);
      if (!Number.isInteger(n) || n < 1) return fail('skip needs a positive whole number of quarters.');
      return { actions: [], skip: n };
    }

    case 'price': {
      const value = parseMoney(rest[0] ?? '');
      if (value === undefined) return fail('price needs an amount, e.g. `price 45`.');
      if (value <= 0n) return fail('A price has to be more than zero.');
      return { actions: [{ kind: 'SET_PRICE', streamId, newPrice: value }] };
    }

    /**
     * "Raising marketing spend doesn't seem to increase sales."
     *
     * It did not, and the model was right not to. A brewpub sitting past twice
     * its half-saturation point went $20k → $50k a quarter and bought about two
     * percent more demand for thirty thousand dollars, because the response
     * curve is `1 + maxLift·(1 − e^(−spend/half))` and it had already flattened.
     *
     * The engine was correct and the screen was silent, which is the worst
     * combination available: the player made the decision, waited two quarters,
     * and drew the conclusion that the lever is broken. The arithmetic is
     * cheap and it belongs at the moment of the decision, not in a help topic
     * the player has no reason to open.
     */
    case 'marketing': {
      const value = parseMoney(rest[0] ?? '');
      if (value === undefined) return fail('marketing needs an amount, e.g. `marketing 12k`.');
      // Zero is a real and sometimes correct choice; below zero is not a choice.
      if (value < 0n) return fail('Marketing spend cannot be negative. `marketing 0` turns it off.');

      const stream = business.streams[0];
      if (stream) {
        if (!marketingMovesDemand(stream.params.kind)) {
          console.log(
            `  ${YELLOW}Marketing does not move demand for this archetype in the model — the spend ` +
              `is expensed and demand never reads it. \`marketing 0\` is that money back.${RESET}`,
          );
        } else if (value > stream.marketingSpendPerQuarter) {
          const half = stream.modifiers.halfSaturationSpend;
          const lift = stream.modifiers.marketingMaxLift;
          const before = marketingMultiplier(stream.marketingSpendPerQuarter, lift, half);
          const after = marketingMultiplier(value, lift, half);
          const gain = before > 0 ? after / before - 1 : 0;
          const extra = value - stream.marketingSpendPerQuarter;
          // "Spent" is a judgement about where you are on the curve, not about
          // how big this particular step was: a $1k rise buying 1% is the
          // curve behaving, and calling that a dead lever would be wrong.
          const tapped = half > 0n && value > half * 2n;
          console.log(
            `  ${tapped ? YELLOW : DIM}${toCompact(extra)} a quarter more buys about ` +
              `${(gain * 100).toFixed(1)}% more demand. You are at ${toCompact(stream.marketingSpendPerQuarter)} ` +
              `against a half-saturation point of ${toCompact(half)}` +
              `${tapped ? `, and past twice that the curve is flat — this lever is close to spent.` : `.`}${RESET}`,
          );
        }
      }
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

      /**
       * What the cut costs, before it is made — and then make it anyway.
       *
       * "I'm fine with warnings: if you cut kitchen staff you'll need to cut
       * the hours fresh food is available. Cutting staff should probably hurt
       * revenues — but since I'm going broke at full staffing, that's what I
       * gotta do."
       *
       * Exactly right, and the engine already models the consequence: a line
       * cut below what demand needs becomes the binding constraint and the
       * excess is turned away. What was missing is the price tag at the moment
       * of the decision. This is not a refusal and must never become one — the
       * whole point is that going broke slowly is a worse outcome than serving
       * fewer customers, and only the player can weigh that.
       */
      if (firing) {
        const line = lines.find((c) => c.id === costId)!;
        const per = Number(line.capacity?.capacityPerBlock ?? 0);
        const stream = result.statements.byBusiness[business.id]?.derivedMetrics.streamMetrics[0];
        const is = result.statements.byBusiness[business.id]?.incomeStatement;
        if (per > 0 && stream && is && stream.realizedVolume > 0) {
          const after = (line.currentBlocks - blocks) * per;
          const lost = Math.max(0, stream.demandVolume - after);
          if (lost > 0.5) {
            // Revenue per unit read off the ledger rather than the price
            // parameter, so ancillary revenue and discounts are already in it.
            const perUnit = Number(is.revenue) / stream.realizedVolume;
            const saving = line.blockCostPerQuarter * BigInt(blocks);
            console.log(
              `  ${YELLOW}That takes ${line.label} below what demand needs: about ` +
                `${Math.round(lost).toLocaleString()} customers a quarter turned away, ` +
                `roughly ${toCompact(BigInt(Math.round(lost * perUnit)))} of revenue, to save ` +
                `${toCompact(saving)} of pay.${RESET}`,
            );
            console.log(
              `  ${DIM}${
                BigInt(Math.round(lost * perUnit)) > saving
                  ? 'That is more revenue than pay — it helps cash only if the margin on those customers is thin.'
                  : 'That saves more pay than it loses in revenue.'
              } Queued either way.${RESET}`,
            );
          }
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
      const sign = positive(principal, 'debt', 'to pay a loan down, use `repay <amount>`.');
      if (sign) return fail(sign);
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
      const sign = positive(amount, 'draw', 'to pay the revolver back, use `repay <amount> revolver`.');
      if (sign) return fail(sign);
      const revolver = business.debts.find((d) => d.kind === 'REVOLVER');
      if (!revolver) return fail('This business has no revolver.');
      return { actions: [{ kind: 'DRAW_REVOLVER', debtId: revolver.id, amount }] };
    }

    /**
     * "how do I pay off my SBA loan?"
     *
     * REPAY_DEBT has existed in the engine since M1 and had no command, so the
     * answer was `debt <amount> raises a term loan` — how to borrow, to someone
     * asking how to stop owing. He worked out the rest himself and typed
     * `debt -$400k`.
     *
     * Paying early is one of the few genuinely good decisions a profitable
     * business has left, and at 10.5% on an SBA facility it is a better return
     * than most things this game will offer.
     */
    case 'repay': {
      const outstanding = business.debts.filter((d) => d.outstandingPrincipal > 0n);
      if (outstanding.length === 0) return fail('Nothing is outstanding to repay.');

      // `repay 100k sba` and `repay sba 100k` are the same intent typed two
      // ways, and refusing one of them teaches nothing.
      const tokens = rest.filter((t) => t.trim() !== '');
      const named = tokens
        .map((t) =>
          outstanding.find(
            (d) =>
              d.id === t ||
              d.kind.toLowerCase().startsWith(t.toLowerCase()) ||
              d.label.toLowerCase().startsWith(t.toLowerCase()),
          ),
        )
        .find((d) => d !== undefined);
      const wantsAll = tokens.some((t) => t.toLowerCase() === 'all');
      const amountToken = tokens.find((t) => parseMoney(t) !== undefined);
      const requested = wantsAll ? undefined : parseMoney(amountToken ?? '');

      if (!wantsAll && requested === undefined) {
        return fail(
          `repay needs an amount: \`repay 100k\`, or \`repay all\`. Outstanding: ` +
            `${outstanding.map((d) => `${d.label} ${toCompact(d.outstandingPrincipal)}`).join(', ')}.`,
        );
      }
      const sign = positive(requested, 'repay', 'to borrow more, use `debt <amount>`.');
      if (sign) return fail(sign);

      // Largest balance by default: it is the one carrying the most interest,
      // and with one loan on the books there is nothing to disambiguate.
      const target =
        named ??
        [...outstanding].sort((a, b) =>
          a.outstandingPrincipal > b.outstandingPrincipal ? -1 : 1,
        )[0]!;
      if (!named && outstanding.length > 1 && tokens.length < 2) {
        console.log(
          `  ${DIM}Paying down ${target.label}, the largest balance. Name another to change that: ` +
            `${outstanding.map((d) => d.kind.toLowerCase()).join(', ')}.${RESET}`,
        );
      }

      const amount =
        requested === undefined || requested > target.outstandingPrincipal
          ? target.outstandingPrincipal
          : requested;
      if (requested !== undefined && requested > target.outstandingPrincipal) {
        console.log(
          `  ${DIM}${toCompact(requested)} is more than the ${toCompact(target.outstandingPrincipal)} ` +
            `outstanding on ${target.label}; paying it off instead.${RESET}`,
        );
      }
      // A warning, not a refusal: paying down debt into a cash shortfall is a
      // real decision with a real consequence, and the crisis ladder is what
      // the consequence looks like.
      if (amount > business.cash) {
        console.log(
          `  ${YELLOW}That is more cash than you have (${toCompact(business.cash)}). ` +
            `It will go through and the shortfall will hit the crisis ladder.${RESET}`,
        );
      }
      return { actions: [{ kind: 'REPAY_DEBT', debtId: target.id, amount }] };
    }

    case 'inject': {
      const amount = parseMoney(rest[0] ?? '');
      if (amount === undefined) return fail('inject needs an amount.');
      const sign = positive(amount, 'inject', 'to take money out, use `distribute <amount>`.');
      if (sign) return fail(sign);
      return { actions: [{ kind: 'INJECT_CAPITAL', businessId: business.id, amount }] };
    }

    case 'distribute': {
      const amount = parseMoney(rest[0] ?? '');
      if (amount === undefined) return fail('distribute needs an amount.');
      const sign = positive(amount, 'distribute', 'to put money in, use `inject <amount>`.');
      if (sign) return fail(sign);
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
          ? 'An occupancy business grows by building units — `expand <units> <cost>` — or by being ' +
            'worth more per unit: `upgrade <pct> <cost>`.'
          : p.kind === 'PROJECT_BACKLOG'
            ? 'A contractor grows by bidding more and delivering more — `expand` raises execution capacity.'
            : 'This archetype grows through acquisition spend rather than territory — `marketing <amount>`.',
      );
    }

    /**
     * "I want to add a small indoor waterpark."
     *
     * Asked three times, answered three times with "you already have 19 idle".
     * The idle rooms are the reason to build the waterpark, not the argument
     * against it — an amenity changes who is willing to stay and what they will
     * pay, and the game had no way to say that at all.
     *
     * The player supplies both numbers. Nothing here knows what a waterpark
     * does to a highway hotel in Kansas, and pretending to would be worse than
     * asking: what the game can do is charge for the buildout, hold the claim
     * to the model, and show what it turned out to be worth.
     */
    case 'upgrade':
    case 'renovate': {
      const uplift = parseNumber((rest[0] ?? '').replace('%', ''));
      const cost = parseMoney(rest[1] ?? '');
      if (uplift === undefined || uplift <= 0 || cost === undefined) {
        return fail(
          'upgrade needs a claim and a cost: `upgrade 15% 800k` — you think the improvement makes ' +
            'the product 15% more valuable to a customer, and it costs $800k to build.',
        );
      }
      if (uplift > 100) {
        return fail('An upgrade that more than doubles what customers will pay is a different business, not an improvement to this one.');
      }
      const stream = business.streams[0];
      if (!stream) return fail('No stream to improve.');
      console.log(
        `  ${DIM}Taken as a claim: ${uplift}% more willingness to pay, ${toCompact(cost)} to build, ` +
          `landing in two quarters. It arrives as demand at today's price — raise the price by the ` +
          `same ${uplift}% instead and you keep the volume and bank the difference.${RESET}`,
      );
      return {
        actions: [
          {
            kind: 'EXPAND_CAPACITY',
            businessId: business.id,
            spec: { streamId, buildoutCost: cost, qualityUpliftPct: uplift / 100 },
          },
        ],
      };
    }

    /**
     * "I want to invest my money in coca cola stock."
     *
     * Asked in the opening interview and answered, eventually, with a refusal.
     * The refusal was right about the product and wrong about the need: a
     * household sitting on cash at 0% is being compared against nothing, and a
     * business that returned 9% over a decade should have to say so next to
     * what the index did.
     *
     * The money comes out of the HOUSEHOLD, not the business. Company cash has
     * to be distributed — and taxed — before it can buy anything, which is both
     * what happens in life and the more useful thing to learn.
     */
    case 'quotes':
    case 'quote': {
      for (const line of quoteLines(world, result.statements.period)) console.log(`  ${DIM}${line}${RESET}`);
      return none;
    }

    case 'portfolio':
    case 'holdings': {
      for (const line of portfolioLines(world, result.statements.period)) {
        console.log(`  ${DIM}${line}${RESET}`);
      }
      console.log(
        `  ${DIM}Household cash ${toCompact(world.household.cash)}. ` +
          `Dividends and gains are taxed at the personal rate the quarter they land — no ` +
          `qualified-dividend or long-term rate is modelled, so the passive side is taxed a ` +
          `little harder here than in life.${RESET}`,
      );
      return none;
    }

    case 'buy': {
      const ticker = (rest[0] ?? '').toUpperCase();
      const security = getSecurity(ticker);
      if (!security) {
        return fail(
          `No security called "${rest[0] ?? ''}". \`quotes\` lists them: ` +
            `${listSecurities().map((s) => s.ticker).join(', ')}.`,
        );
      }
      const amount = parseMoney(rest[1] ?? '');
      if (amount === undefined) return fail(`buy needs an amount, e.g. \`buy ${ticker} 500k\`.`);
      const sign = positive(amount, 'buy', 'to sell a position, use `sell <ticker> <amount|all>`.');
      if (sign) return fail(sign);
      if (world.household.cash <= 0n) {
        return fail(
          'The household has no cash. `distribute <amount>` moves money out of the business first — ' +
            'and it is taxed on the way.',
        );
      }
      if (amount > world.household.cash) {
        console.log(
          `  ${DIM}Household cash is ${toCompact(world.household.cash)}; buying that much instead.${RESET}`,
        );
      }
      return { actions: [{ kind: 'BUY_SECURITY', ticker, amount }] };
    }

    case 'sell': {
      const ticker = (rest[0] ?? '').toUpperCase();
      const held = positions(world, result.statements.period).find((p) => p.ticker === ticker);
      if (!held) {
        const owned = positions(world, result.statements.period).map((p) => p.ticker);
        return fail(
          owned.length > 0
            ? `You do not hold ${ticker || 'that'}. You hold: ${owned.join(', ')}.`
            : 'You do not hold anything. `quotes` lists what there is to buy.',
        );
      }
      const token = (rest[1] ?? '').toLowerCase();
      if (token === '' ) return fail(`sell needs an amount, e.g. \`sell ${ticker} 100k\` or \`sell ${ticker} all\`.`);
      if (token === 'all') {
        return { actions: [{ kind: 'SELL_SECURITY', ticker, shares: held.shares }] };
      }
      const amount = parseMoney(token);
      if (amount === undefined) return fail(`sell needs an amount or \`all\`.`);
      const sign = positive(amount, 'sell', 'to add to a position, use `buy <ticker> <amount>`.');
      if (sign) return fail(sign);
      // Dollars in, shares out: the player thinks in the first and the ledger
      // keeps the second.
      const shares =
        held.value > 0n
          ? Math.min(held.shares, (held.shares * Number(amount)) / Number(held.value))
          : held.shares;
      return { actions: [{ kind: 'SELL_SECURITY', ticker, shares }] };
    }

    /**
     * "What would have had to be true" — §9.4, mandatory on insolvency and
     * available on demand at any time, which is the half that matters. A player
     * who can ask this in period 12 can still act on the answer.
     */
    case 'postmortem': {
      printPostmortem(history, business, DIM);
      return none;
    }

    /**
     * A portfolio, and which of it you are looking at.
     *
     * Every operating command means "this business", so with more than one on
     * the books there has to be a way to say which. `businesses` lists them
     * with the numbers that decide where attention goes.
     */
    case 'businesses': {
      const live = world.businesses.filter((b) => b.status !== 'SOLD');
      console.log(`\n  ${BOLD}${pad('BUSINESS', 30)}${rpad('REVENUE', 10)}${rpad('EBITDA', 10)}${rpad('CASH', 10)}${RESET}`);
      live.forEach((b, i) => {
        const entry = result.statements.byBusiness[b.id];
        const marker = b.id === business.id ? '›' : ' ';
        console.log(
          `${marker} ${pad(`${i + 1}. ${b.name}`, 30)}` +
            `${rpad(entry ? toCompact(entry.incomeStatement.revenue) : '—', 10)}` +
            `${rpad(entry ? toCompact(entry.incomeStatement.ebitda) : '—', 10)}` +
            `${rpad(toCompact(b.cash), 10)}  ${DIM}${b.status}${RESET}`,
        );
      });
      console.log(
        `  ${DIM}\`switch <n>\` changes which one your commands are about · ` +
          `\`clone <money> <name>\` opens another · \`divest <n>\` sells one.${RESET}`,
      );
      return none;
    }

    case 'switch': {
      const live = world.businesses.filter((b) => b.status !== 'SOLD' && b.status !== 'CLOSED');
      const token = (rest[0] ?? '').toLowerCase();
      const byIndex = Number(token);
      const target =
        Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= live.length
          ? live[byIndex - 1]
          : live.find((b) => b.name.toLowerCase().startsWith(token) && token !== '');
      if (!target) {
        return fail(
          `Which one? ${live.map((b, i) => `${i + 1}. ${b.name}`).join(' · ')}`,
        );
      }
      console.log(`  ${DIM}Now looking at ${target.name}.${RESET}`);
      return { actions: [], activate: target.id };
    }

    /**
     * "I want to use the cash flow from this one to buy a 256 room property in
     * Des Moines" — §9.5.
     *
     * Two numbers and a name, because §9.5's whole claim is that a second site
     * takes two minutes. Everything else about the concept carries over, and
     * the clone opens with a ramp floor ten points better than its parent's
     * because you have done this before.
     */
    case 'clone': {
      const equity = parseMoney(rest[0] ?? '');
      if (equity === undefined) {
        return fail('clone needs the money and a name: `clone 900k Des Moines` — optionally `2x` for a bigger site.');
      }
      const sign = positive(equity, 'clone', 'a second location costs money to open.');
      if (sign) return fail(sign);

      // `2x` anywhere in the rest is the size multiplier; the remainder is the
      // name, so `clone 4m Des Moines 4x` and `clone 4m 4x Des Moines` both work.
      const scaleToken = rest.find((t) => /^\d+(\.\d+)?x$/i.test(t));
      const scale = scaleToken ? Number(scaleToken.slice(0, -1)) : 1;
      const name = rest.slice(1).filter((t) => t !== scaleToken).join(' ').trim();
      if (name === '') return fail('A second location needs a name: `clone 900k Des Moines`.');
      if (!(scale > 0)) return fail('The size multiplier has to be more than zero.');

      const needed = cloneOutlay(business, scale);
      console.log(
        `  ${DIM}${scale === 1 ? 'The same business' : `${scale}× the size`} in a new place. ` +
          `Buildout alone is ${toCompact(needed)}; the rest of your ${toCompact(equity)} opens as its cash. ` +
          `Revenue starts two quarters out.${RESET}`,
      );
      if (equity < needed) {
        return fail(
          `${toCompact(equity)} does not cover the ${toCompact(needed)} of buildout. Commit more, or use a smaller multiplier.`,
        );
      }
      if (world.household.cash < equity) {
        return fail(
          `The household has ${toCompact(world.household.cash)}. \`distribute <amount>\` moves money ` +
            `out of a business first — and it is taxed on the way.`,
        );
      }
      return {
        actions: [
          {
            kind: 'START_BUSINESS',
            mode: 'CLONE',
            cloneFromId: business.id,
            clone: { name, equity, scale },
          },
        ],
      };
    }

    /** Selling one. `sell` belongs to securities, so this is its own verb. */
    case 'divest': {
      const live = world.businesses.filter((b) => b.status !== 'SOLD' && b.status !== 'CLOSED');
      const token = (rest[0] ?? '').toLowerCase();
      const byIndex = Number(token);
      const target =
        token === ''
          ? business
          : Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= live.length
            ? live[byIndex - 1]
            : live.find((b) => b.name.toLowerCase().startsWith(token));
      if (!target) return fail(`Which one? ${live.map((b, i) => `${i + 1}. ${b.name}`).join(' · ')}`);

      const multiple = Number(rest[1] ?? DEFAULT_MULTIPLE);
      if (!(multiple > 0)) return fail('The multiple has to be more than zero.');
      const proceeds = saleValue(target, multiple);
      console.log(
        `  ${DIM}${target.name} at ${multiple}× trailing EBITDA is ${toCompact(proceeds)} to the ` +
          `household after its debt, taxed as a gain. It closes in two quarters.${RESET}`,
      );
      return {
        actions: [{ kind: 'SELL_BUSINESS', businessId: target.id, multipleOfEbitda: multiple }],
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
      if (looksLikeAQuestion(line, verb)) {
        /**
         * The arithmetic first, always.
         *
         * The deterministic findings are exact, free and instant, and they go
         * on screen whether or not a model is reachable. The model is then
         * given them and told not to repeat them — so the worst case is the
         * game exactly as it was before, and the best case is the half the
         * arithmetic could never reach.
         */
        const answered = advise(business, result, world, history, line, memory);
        for (const said of answered) console.log(`  ${DIM}${said}${RESET}`);

        const spoken = advisor
          ? await speakToPlayer(advisor, world, business, result, answered, line, journal)
          : undefined;

        journal?.write({
          kind: 'asked',
          question: line,
          answered: spoken ? [...answered, spoken.reply] : answered,
        });
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
  options: {
    input?: LineSource;
    milestonePeriod?: number;
    journal?: Journal;
    /** Absent means no model in the loop, which is a supported way to play. */
    advisor?: AdviceTransport & Partial<NarrationTransport>;
  } = {},
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
  /**
   * Which business the turn's commands are about.
   *
   * Mutable, because a portfolio has more than one and every operating command
   * — price, hire, fire, expand — has to mean "this one". `switch` moves it and
   * a clone lands as the new active business, which is what a player who just
   * opened one wants to be looking at.
   */
  const opening = state.businesses[0];
  if (!opening) {
    console.error('Scenario has no business.');
    process.exit(1);
  }
  let businessId: string = opening.id;

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
  /**
   * Every quarter, kept.
   *
   * The post-mortem is arithmetic on the run's history, so the history has to
   * exist while the run is happening — a summary written at the end cannot say
   * which period the business was actually lost in.
   */
  /**
   * Per business, because the post-mortem is about one of them.
   *
   * "What would have had to be true" for a portfolio is not a question with an
   * answer; for the cafe in Rochester it is.
   */
  const histories = new Map<string, RunPoint[]>();
  const historyOf = (id: string): RunPoint[] => {
    const existing = histories.get(id);
    if (existing) return existing;
    const fresh: RunPoint[] = [];
    histories.set(id, fresh);
    return fresh;
  };

  const record = (result: TickResult): void => {
    for (const business of state.businesses) {
      const point = runPoint(result, business);
      if (point) historyOf(business.id).push(point);
    }
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

  console.log(
    options.advisor
      ? `${DIM}Ask anything in plain English — the numbers come from the engine, the judgement from a model.${RESET}`
      : `${DIM}Ask anything in plain English. No ${providerKeyVar()}, so answers are the engine's arithmetic alone.${RESET}`,
  );

  // The scoreboard fires once. After that the run belongs to the player.
  let pastMilestone = false;

  // Run period 0 so there is something to look at before the first decision.
  let last = advance([]);
  record(last);
  renderTurn(last, state.businesses.find((b) => b.id === businessId)!, state);
  await narrateTurn(
    options.advisor,
    state,
    state.businesses.find((b) => b.id === businessId)!,
    last,
    historyOf(businessId),
    options.journal,
  );

  try {
    while (true) {
      // A clone that has matured is the one the player wants to be looking at,
      // and a business that has been sold or closed cannot be the active one.
      const active = state.businesses.find((b) => b.id === businessId);
      if (!active || active.status === 'SOLD') {
        const next = state.businesses.find((b) => b.status !== 'SOLD' && b.status !== 'CLOSED');
        if (next) {
          businessId = next.id;
          console.log(`\n${DIM}Now running ${next.name}.${RESET}`);
        }
      }
      const business = state.businesses.find((b) => b.id === businessId)!;

      const survivors = state.businesses.filter(
        (b) => b.status !== 'CLOSED' && b.status !== 'SOLD',
      );
      if (survivors.length === 0) {
        console.log(
          `\n${RED}${BOLD}${
            state.businesses.length > 1 ? 'Every business is gone.' : `${business.name} is insolvent and closed.`
          }${RESET}`,
        );
        console.log(
          `Household net worth ${toDisplay(last.statements.household.netWorth)} · ` +
            `peak cash need was ${toDisplay(business.peakCashNeed)}`,
        );
        // §9.4: mandatory on insolvency. A run that ends with a liquidation
        // figure tells the player they lost without telling them what would
        // have had to be different, and the gap between those is the product.
        printPostmortem(historyOf(business.id), business);
        console.log('');
        for (const line of benchmarkLines(
          state,
          last.statements.household.netWorth,
          state.currentPeriod,
        )) {
          console.log(`  ${line}`);
        }
        break;
      }
      if (state.currentPeriod >= milestonePeriod && !pastMilestone) {
        console.log(`\n${BOLD}${GREEN}Ten-year milestone reached.${RESET}`);
        console.log(
          `Household net worth ${toDisplay(last.statements.household.netWorth)} · ` +
            `peak cash need ${toDisplay(business.peakCashNeed)} at period ${business.peakCashNeedPeriod}`,
        );
        printPostmortem(historyOf(business.id), business);
        // The number the run was missing: what the same money would have done
        // sitting in an index fund for the same ten years.
        console.log('');
        for (const line of benchmarkLines(
          state,
          last.statements.household.netWorth,
          state.currentPeriod,
        )) {
          console.log(`  ${line}`);
        }

        /**
         * Continue-play — M7's last item.
         *
         * Ten years is where the spec stops scoring, not where a business
         * stops. Ending the run there throws away the most interesting part of
         * a portfolio that took a decade to assemble, so the milestone is a
         * scoreboard and the player decides whether it was also a finish line.
         *
         * Blank or end-of-input stops, which is what a piped transcript that
         * has run out means and what a player pressing enter means.
         */
        const answer = await input.next(`\n${DIM}Keep going? (enter to stop)${RESET} > `);
        if (answer === undefined || answer.trim() === '' || answer.trim().toLowerCase() === 'quit') {
          break;
        }
        pastMilestone = true;
        console.log(`${DIM}Playing on. \`quit\` ends it whenever you like.${RESET}`);
        continue;
      }

      const queued: Action[] = [];
      let quit = false;
      let skip = 0;
      // Per quarter, not per session: repeating yourself inside one decision is
      // not listening, and repeating yourself after a quarter has run is the
      // same answer holding because the same numbers do.
      const memory = newAdvisorMemory();

      while (true) {
        const prompt = queued.length > 0 ? `${DIM}[${queued.length} queued]${RESET} > ` : '> ';
        const line = await input.next(prompt);
        if (line === undefined) {
          console.log(`\n${DIM}End of input — stopping at period ${state.currentPeriod}.${RESET}`);
          quit = true;
          break;
        }
        const parsed = await parseCommand(
          line,
          business,
          last,
          state,
          historyOf(businessId),
          options.journal,
          memory,
          options.advisor,
        );
        if (parsed.message) console.log(parsed.message);
        if (parsed.activate) businessId = parsed.activate;
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
              const arrives =
                a.spec.qualityUpliftPct !== undefined ? 'the improvement opens'
                : market ? 'the new market opens'
                : 'capacity arrives';
              console.log(`  ${YELLOW}buildout spread over two quarters; ${arrives} in two${RESET}`);
            }
          }
          continue;
        }
        if (line.trim() === '') break;
      }

      if (quit) break;

      if (skip > 0) {
        // Anything already queued belongs to the first of the skipped quarters.
        // `upgrade 15% 800k` then `skip 6` silently threw the buildout away and
        // ran six quarters that looked exactly like doing nothing — which is
        // what the player saw, and reasonably concluded about the lever.
        if (queued.length > 0) {
          console.log(
            `  ${DIM}Running ${queued.length} queued ${queued.length === 1 ? 'decision' : 'decisions'} ` +
              `in the first of those quarters.${RESET}`,
          );
        }
        for (let i = 0; i < skip && state.currentPeriod < milestonePeriod; i++) {
          last = advance(i === 0 ? queued : []);
          record(last);
          const b = state.businesses.find((x) => x.id === businessId)!;
          if (b.status === 'CLOSED') break;
        }
      } else {
        last = advance(queued);
        record(last);
      }

      renderTurn(last, state.businesses.find((b) => b.id === businessId)!, state);
      // One narration per pause, not per quarter: a `skip 8` narrates the
      // quarter that ended the skip, against the one before it. Narrating all
      // eight would be eight model calls nobody is reading.
      await narrateTurn(
        options.advisor,
        state,
        state.businesses.find((b) => b.id === businessId)!,
        last,
        historyOf(businessId),
        options.journal,
      );
    }
  } finally {
    if (!options.input) input.close();
  }
}
