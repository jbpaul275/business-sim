import { toCompact, type Money } from '@bizsim/money';
import { demandFactors, type TickResult } from '@bizsim/engine';
import type { AttributionDriver, Business, DeltaAttribution, WorldState } from '@bizsim/schemas';
import { describeEvent } from './events.js';

/**
 * The eigen question — the one question a turn ends with.
 *
 * Every quarter the player's decision space has a principal axis: the
 * direction where their next decision gets multiplied rather than dampened.
 * The turn's job is (a) the data — what moved and why, which §10.4 already
 * decomposes — and (b) ONE question pointed down that axis. Three questions
 * are worse than one: they hand the player the ranking work this selector
 * exists to do.
 *
 * Deterministic on purpose. The engine picks the axis because the engine
 * computed the quarter; a model asked to choose would drift toward whatever
 * is easy to say. An LLM may put better words on the chosen axis later, but
 * the choice — and this fallback phrasing — never needs a key.
 *
 * The hierarchy: a crisis asks itself; otherwise the biggest driver of the
 * quarter's deltas; in a quiet quarter, the nearest looming constraint; and
 * when nothing looms, the slack — idle cash or idle capacity is a decision
 * nobody is making. A repetition memory keeps the same axis from being asked
 * two quarters running: a player who heard the question and chose not to act
 * has answered it for now, and asking again is nagging, not advising.
 */

export interface EigenAxis {
  /** Stable identity for the repetition memory, e.g. `driver:revenue:Marketing response`. */
  key: string;
  kind: 'crisis' | 'driver' | 'horizon' | 'slack';
  /** The engine-computed ground the question stands on. One sentence. */
  fact: string;
  /** The one question. */
  question: string;
}

export interface EigenInput {
  world: WorldState;
  business: Business;
  result: TickResult;
  attributions: readonly DeltaAttribution[];
  /** Axis keys already asked, oldest first. Only the recent tail matters. */
  asked: readonly string[];
}

/** How many quarters an axis rests after being asked. */
const SUPPRESS_WINDOW = 2;

export function selectAxis(input: EigenInput): EigenAxis {
  const recent = input.asked.slice(-SUPPRESS_WINDOW);
  const fresh = (axis: EigenAxis | undefined): EigenAxis | undefined =>
    axis && !recent.includes(axis.key) ? axis : undefined;

  return (
    crisisAxis(input) ??
    fresh(driverAxis(input)) ??
    fresh(horizonAxis(input)) ??
    fresh(slackAxis(input)) ??
    // Everything fresh is suppressed — a driver worth repeating beats silence.
    driverAxis(input) ??
    milestoneAxis(input)
  );
}

// ---------------------------------------------------------------------------
// Crisis — the question asks itself
// ---------------------------------------------------------------------------

function crisisAxis({ result }: EigenInput): EigenAxis | undefined {
  const critical = result.events.find((e) => e.severity === 'CRITICAL');
  if (!critical) return undefined;
  return {
    key: `crisis:${critical.kind}`,
    kind: 'crisis',
    fact: describeEvent(critical),
    question: 'What do you change in response?',
  };
}

// ---------------------------------------------------------------------------
// Driver — the biggest force on the quarter that just ran
// ---------------------------------------------------------------------------

function driverAxis(input: EigenInput): EigenAxis | undefined {
  const recent = input.asked.slice(-SUPPRESS_WINDOW);
  const candidates = input.attributions
    .flatMap((a) => a.drivers.map((d) => ({ a, d })))
    .filter(({ d }) => d.label !== 'Everything else')
    .sort(({ d: x }, { d: y }) => (abs(y.amount) > abs(x.amount) ? 1 : abs(y.amount) < abs(x.amount) ? -1 : 0));
  // Largest first, skipping rested axes — the runner-up is a real axis too,
  // and yielding to it is how a deflected question stops repeating.
  const pick =
    candidates.find(({ a, d }) => !recent.includes(driverKey(a, d))) ?? candidates[0];
  if (!pick) return undefined;
  return {
    key: driverKey(pick.a, pick.d),
    kind: 'driver',
    fact: `${pick.a.lineLabel} moved ${signed(pick.a.delta)}; the biggest force was ${pick.d.label.toLowerCase()} at ${signed(pick.d.amount)} (${pick.d.explanation}).`,
    question: driverQuestion(pick.a, pick.d),
  };
}

const driverKey = (a: DeltaAttribution, d: AttributionDriver): string =>
  `driver:${a.line}:${d.label}`;

/**
 * Words on the axis. Each phrasing points at the decision the driver implies,
 * not at the number — the fact already carries the number.
 */
function driverQuestion(a: DeltaAttribution, d: AttributionDriver): string {
  const gained = d.amount > 0n;
  const onCost = a.line !== 'revenue';

  switch (d.label) {
    case 'Marketing response':
      if (onCost) {
        return gained
          ? 'Marketing spend went up — is the revenue it buys still ahead of it?'
          : 'You spent less on marketing. Was that a decision or a drift?';
      }
      return gained
        ? 'Is the next marketing dollar still paying for itself, or are you past the useful part of the curve?'
        : 'Pulling marketing back gave that revenue up. Worth what it saved?';
    case 'Price':
      return gained
        ? 'The price change is paying. Does it hold for another quarter, or was this the one-time gain?'
        : 'The price move cost you. Hold the line while demand adjusts, or walk it back?';
    case 'Seasonality':
      return gained
        ? 'The season gave you that, and the season will take it back. What changes before it turns?'
        : 'The season took it and will give it back. Do you carry costs flat through the trough, or cut into them?';
    case 'Maturity ramp':
      return gained
        ? 'That growth came from the market finding you, not from anything you did — and it fades. What replaces it?'
        : 'The ramp is working against you. What speeds it up?';
    case 'Capacity ceiling':
      return 'Demand outran what you can serve. Expand, raise the price, or let it walk?';
    case 'Subscriber base':
    case 'Customer base':
      return gained
        ? 'The base you already built did that on its own. What are you doing to keep it?'
        : 'The base is shrinking — that revenue walked out and keeps walking. What is making them leave?';
    case 'Backlog':
      return 'Revenue follows the backlog here. Are you winning work fast enough to feed it?';
    case 'Underlying demand':
      return 'Demand itself moved. Do you read that as noise, or as the market telling you something?';
    default:
      break;
  }

  // Cost-line drivers arrive labeled by the cost, not the mechanism.
  if (/escalator applied/.test(d.explanation)) {
    return `${d.label} just stepped up and stays up. What absorbs it?`;
  }
  if (/paid blocks/.test(d.explanation)) {
    return gained
      ? 'Staffing cost went up. Is the capacity it buys pointed at demand you actually have?'
      : 'You cut staffing. Does what remains cover the volume you are serving?';
  }
  if (onCost && d.assumptionId) {
    return `That rate is a model assumption (${d.assumptionId}). If your real number differs, revise it — otherwise, what offsets it?`;
  }
  return onCost
    ? `${d.label} is the cost that moved most. Can you reach it, or do you grow past it?`
    : 'That was the biggest force on the quarter. Lean into it, or correct it?';
}

// ---------------------------------------------------------------------------
// Horizon — nothing moved, but something is coming
// ---------------------------------------------------------------------------

function horizonAxis(input: EigenInput): EigenAxis | undefined {
  const recent = input.asked.slice(-SUPPRESS_WINDOW);
  const axes = [runwayAxis(input), seasonSwingAxis(input)].filter(
    (a): a is EigenAxis => a !== undefined,
  );
  return axes.find((a) => !recent.includes(a.key)) ?? axes[0];
}

function runwayAxis({ business, result }: EigenInput): EigenAxis | undefined {
  const m = result.statements.byBusiness[business.id]?.derivedMetrics;
  if (!m) return undefined;
  const runway = m.cashRunwayQuarters;
  if (!Number.isFinite(runway) || runway >= 4) return undefined;
  return {
    key: 'horizon:runway',
    kind: 'horizon',
    fact: `Cash covers about ${runway.toFixed(1)} more quarters at this burn.`,
    question: 'What changes before it runs out — revenue, costs, or financing?',
  };
}

function seasonSwingAxis({ business, result }: EigenInput): EigenAxis | undefined {
  const stream = business.streams[0];
  if (!stream) return undefined;
  const period = result.statements.period;
  const now = demandFactors(stream, period).season;
  const next = demandFactors(stream, period + 1).season;
  if (now <= 0) return undefined;
  const swing = next / now - 1;
  if (Math.abs(swing) < 0.12) return undefined;
  const pctText = `${Math.abs(Math.round(swing * 100))}%`;
  return {
    key: `horizon:season:${swing > 0 ? 'up' : 'down'}`,
    kind: 'horizon',
    fact: `Next quarter's seasonal demand runs about ${pctText} ${swing > 0 ? 'above' : 'below'} this one.`,
    question:
      swing > 0
        ? 'Are you staffed and stocked to catch it, or does it land on a business shaped for the quiet season?'
        : 'The quiet season is next. What do you carry through it, and what do you cut?',
  };
}

// ---------------------------------------------------------------------------
// Slack — nothing looms, but something is idle
// ---------------------------------------------------------------------------

function slackAxis(input: EigenInput): EigenAxis | undefined {
  const recent = input.asked.slice(-SUPPRESS_WINDOW);
  const axes = [idleCapacityAxis(input), idleCashAxis(input)].filter(
    (a): a is EigenAxis => a !== undefined,
  );
  return axes.find((a) => !recent.includes(a.key)) ?? axes[0];
}

function idleCapacityAxis({ business, result }: EigenInput): EigenAxis | undefined {
  const m = result.statements.byBusiness[business.id]?.derivedMetrics.streamMetrics[0];
  if (!m || m.capacityVolume === undefined || m.capacityVolume <= 0) return undefined;
  const used = m.realizedVolume / m.capacityVolume;
  if (used >= 0.55) return undefined;
  return {
    key: 'slack:capacity',
    kind: 'slack',
    fact: `You are staffed to serve ${Math.round(m.capacityVolume).toLocaleString()} and serving ${Math.round(m.realizedVolume).toLocaleString()} — ${Math.round(used * 100)}% of it.`,
    question: 'Do you grow into that capacity, or cut it down to the business you actually have?',
  };
}

function idleCashAxis({ business, result }: EigenInput): EigenAxis | undefined {
  const entry = result.statements.byBusiness[business.id];
  if (!entry) return undefined;
  const cash = entry.balanceSheet.cash;
  const is = entry.incomeStatement;
  const quarterlyCosts = is.revenue - is.ebitda;
  // "Idle" means comfortably more than a year of total operating costs — a
  // buffer nobody would call thin, sitting uninvested.
  if (quarterlyCosts <= 0n || cash < quarterlyCosts * 4n) return undefined;
  return {
    key: 'slack:cash',
    kind: 'slack',
    fact: `${toCompact(cash)} is sitting in the business — more than a year of operating costs.`,
    question: 'What is it for? Debt could come down, capacity could go up, or the household could take a distribution.',
  };
}

/** The floor: nothing is on fire, looming, or idle. Point at the horizon line. */
function milestoneAxis({ world, result }: EigenInput): EigenAxis {
  const remaining = Math.max(0, world.config.milestonePeriod - result.statements.period);
  return {
    key: 'slack:milestone',
    kind: 'slack',
    fact:
      remaining > 0
        ? `Nothing is pressing. ${remaining} quarter${remaining === 1 ? '' : 's'} to the ten-year mark.`
        : 'Nothing is pressing, and the milestone is behind you.',
    question:
      remaining > 0
        ? 'What do you want this business to look like when you get there?'
        : 'What are you still playing for — scale, income, or a clean exit?',
  };
}

// ---------------------------------------------------------------------------

const abs = (m: Money): Money => (m < 0n ? -m : m);
const signed = (m: Money): string => `${m < 0n ? '−' : '+'}${toCompact(abs(m))}`;
