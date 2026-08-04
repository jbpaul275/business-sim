import { randomUUID } from 'node:crypto';
import { toDisplay, type Money } from '@bizsim/money';
import { attributeQuarter, tick, type TickResult } from '@bizsim/engine';
import type { Action, DeltaAttribution, StatementSet, WorldState } from '@bizsim/schemas';
import type { ConceptTransport } from '@bizsim/llm';
import {
  SCENARIOS,
  describeAttribution,
  describeEvent,
  journalActions,
  postmortem,
  runPoint,
  selectAxis,
  type JournalEvent,
  type RunPoint,
} from '@bizsim/sim-cli';

/**
 * Game sessions, in memory, keyed by id.
 *
 * The architecture rule this file exists to uphold: statements are rendered
 * server-side from engine output and the client NEVER recomputes financials —
 * §1.1 applied to the browser. So the world state lives here, the tick runs
 * here, and what crosses the wire is display-ready text.
 *
 * In-memory is a deliberate M8-phase-1 simplification: one player, one
 * process, sessions die with the dev server. Persistence is the event log's
 * job (architecture §4) and arrives with it. `globalThis` caching keeps
 * sessions alive across Next's dev-mode module reloads — without it every
 * code save would silently end the game.
 */

export interface TurnLogEntry {
  period: number;
  /** Non-INFO engine events, described in words. */
  events: string[];
  attributions: DeltaAttribution[];
}

/**
 * A decision the advisor suggested, already translated into something the
 * action bar can stage. The server does the parsing (it knows the cost ids
 * and the register); the client only applies it.
 */
export type StagedMove =
  | { type: 'price'; value: number }
  | { type: 'marketing'; value: number }
  | { type: 'assume'; assumptionId: string; value: string }
  | { type: 'staff'; costId: string; delta: number };

export interface SuggestedMove {
  command: string;
  stage: StagedMove;
}

/**
 * One item in the advisor feed. The turn structure lives here: each quarter
 * posts an `update` (what happened — LLM narration when a key is present)
 * and a `question` (the eigen axis, deterministic, always). `chat` is the
 * conversation the player has in between — which is the game, not overhead.
 */
export interface AdvisorEntry {
  who: 'advisor' | 'you';
  kind: 'update' | 'question' | 'chat';
  period?: number;
  /** Narration headline, on `update` entries. */
  headline?: string;
  /** The engine-computed ground a `question` stands on. */
  fact?: string;
  text: string;
  suggested?: SuggestedMove[];
}

export interface GameSession {
  id: string;
  scenario: string;
  world: WorldState;
  businessId: string;
  last: TickResult;
  priorStatements: StatementSet | undefined;
  /** §10.4 for the quarter on screen. */
  attributions: DeltaAttribution[];
  log: TurnLogEntry[];
  /**
   * The same record the CLI journals to disk, kept in memory: what the QA
   * share sends if the player hands this run over. Market seed and per-quarter
   * actions ride along, so a shared run is a deterministic replay.
   */
  events: JournalEvent[];
  /** The advisor feed: per-quarter update + eigen question, and the chat. */
  advisor: AdvisorEntry[];
  /** Axis keys already asked, oldest first — the repetition memory. */
  askedAxes: string[];
  /** One point per quarter traded, for the §9.4 postmortem. */
  history: RunPoint[];
  /** The postmortem posts once — closure or milestone, whichever comes first. */
  postmortemShown?: boolean;
  /** The quarter before the one on screen, for the narration's comparison. */
  prevQuarter?: { revenue: Money; ebitda: Money; cash: Money };
  /** Lazily created when a provider key is present; calls journal to `events`. */
  transport?: ConceptTransport;
  /** Guards against concurrent model calls on one session. */
  advisorBusy?: boolean;
  /** Set once the player has shared this run — the id they were shown. */
  sharedAs?: string;
}

const globalStore = globalThis as unknown as { __bizsimSessions?: Map<string, GameSession> };
const sessions: Map<string, GameSession> = (globalStore.__bizsimSessions ??= new Map());

export function listScenarios(): string[] {
  return Object.keys(SCENARIOS);
}

export function createSession(scenario: string): GameSession {
  const build = SCENARIOS[scenario];
  if (!build) throw new Error(`Unknown scenario "${scenario}"`);
  const world = build();
  const businessId = world.businesses[0]?.id;
  if (!businessId) throw new Error('Scenario has no business');

  // Period 0 runs immediately, same as the CLI: there is something to look at
  // before the first decision.
  const first = tick(world, [], { throwOnAssertionFailure: false });
  const session: GameSession = {
    // A full UUID, because this doubles as the primary key a QA share uploads
    // under — and the reference the player quotes to have it deleted.
    id: randomUUID(),
    scenario,
    world: first.state,
    businessId,
    last: first,
    priorStatements: first.statements,
    attributions: [],
    log: [logEntry(first, [])],
    events: [
      {
        kind: 'session',
        build: 'web-dev',
        startedAt: new Date().toISOString(),
        startCapital: toDisplay(world.household.cash),
      },
      { kind: 'market_seed', seed: world.config.marketSeed },
      quarterEvent(first, []),
    ],
    advisor: [],
    askedAxes: [],
    history: [],
  };
  recordPoint(session, first);
  pushQuestion(session);
  pushPostmortemIfOver(session);
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): GameSession | undefined {
  return sessions.get(id);
}

/**
 * Open a game from a committed setup world — the web equivalent of the CLI
 * handing `runSetup`'s world to `play`. The setup's journal events carry over,
 * so a QA share of the resulting run includes the interview, the draft and
 * every challenge that shaped the model.
 */
export function createSessionFromWorld(
  world: WorldState,
  label: string,
  priorEvents: JournalEvent[],
): GameSession {
  const businessId = world.businesses[0]?.id;
  if (!businessId) throw new Error('committed world has no business');
  const first = tick(world, [], { throwOnAssertionFailure: false });
  const session: GameSession = {
    id: randomUUID(),
    scenario: label,
    world: first.state,
    businessId,
    last: first,
    priorStatements: first.statements,
    attributions: [],
    log: [logEntry(first, [])],
    events: [...priorEvents, quarterEvent(first, [])],
    advisor: [],
    askedAxes: [],
    history: [],
  };
  recordPoint(session, first);
  pushQuestion(session);
  pushPostmortemIfOver(session);
  sessions.set(session.id, session);
  return session;
}

/** Advance one quarter with the queued actions, then `skip` more without any. */
export function advanceSession(session: GameSession, actions: Action[], skip = 0): GameSession {
  const quarters = 1 + Math.max(0, Math.min(skip, 40));
  for (let i = 0; i < quarters; i++) {
    if (session.world.currentPeriod >= session.world.config.milestonePeriod + 40) break;
    // A closed business does not trade. Ticking past closure produced a
    // statements pane with nothing in it — the final quarter's statements are
    // the postmortem's evidence, and they stay on screen.
    const standing = session.world.businesses.find((b) => b.id === session.businessId);
    if (!standing || standing.status === 'CLOSED') break;
    const before = session.world;
    // The quarter about to be replaced becomes the narration's comparison
    // point — after a skip, that is the quarter immediately before the one
    // rendered, which is also the comparison the screen itself implies.
    const prevEntry = session.last.statements.byBusiness[session.businessId];
    if (prevEntry) {
      session.prevQuarter = {
        revenue: prevEntry.incomeStatement.revenue,
        ebitda: prevEntry.incomeStatement.ebitda,
        cash: prevEntry.balanceSheet.cash,
      };
    }
    const applied = i === 0 ? actions : [];
    const result = tick(before, applied, { throwOnAssertionFailure: false });
    session.attributions = session.priorStatements
      ? attributeQuarter(
          { state: before, statements: session.priorStatements },
          result,
          session.businessId,
        )
      : [];
    session.priorStatements = result.statements;
    session.world = result.state;
    session.last = result;
    session.log.push(logEntry(result, session.attributions));
    if (applied.length > 0) {
      session.events.push(journalActions(result.statements.period, applied));
    }
    session.events.push(quarterEvent(result, session.attributions));
    recordPoint(session, result);
    const business = session.world.businesses.find((b) => b.id === session.businessId);
    if (!business || business.status === 'CLOSED') {
      session.events.push({ kind: 'end', reason: 'insolvent' });
      break;
    }
  }
  pushQuestion(session);
  pushPostmortemIfOver(session);
  return session;
}

const recordPoint = (session: GameSession, result: TickResult): void => {
  const business = session.world.businesses.find((b) => b.id === session.businessId);
  if (!business) return;
  const point = runPoint(result, business);
  if (point) session.history.push(point);
};

/**
 * §9.4's mandatory closing analysis, in the advisor feed where the player is
 * already looking. "What would have had to be true" converts a loss into a
 * specific, checkable claim about the real world — arithmetic on the run's
 * own history, no model call, exactly as the CLI prints it. Posted once, at
 * closure or the milestone, whichever comes first.
 */
function pushPostmortemIfOver(session: GameSession): void {
  if (session.postmortemShown) return;
  const business = session.world.businesses.find((b) => b.id === session.businessId);
  if (!business || session.history.length === 0) return;
  const over =
    business.status === 'CLOSED' ||
    session.last.statements.period >= session.world.config.milestonePeriod;
  if (!over) return;
  const analysis = postmortem(session.history, business);
  session.postmortemShown = true;
  session.advisor.push({
    who: 'advisor',
    kind: 'update',
    period: session.last.statements.period,
    headline:
      analysis.verdict === 'WORKED' ? 'What it rests on' : 'What would have had to be true',
    text: analysis.lines.filter((l) => l !== '').join('\n'),
  });
}

/**
 * The eigen question for the quarter on screen — §the-turn-loop. The engine
 * picks the axis (deterministically, from its own attribution and state);
 * the feed shows the data, then the one question. No key required.
 */
function pushQuestion(session: GameSession): void {
  const business = session.world.businesses.find((b) => b.id === session.businessId);
  if (!business || business.status === 'CLOSED') return;
  const axis = selectAxis({
    world: session.world,
    business,
    result: session.last,
    attributions: session.attributions,
    asked: session.askedAxes,
  });
  session.askedAxes.push(axis.key);
  session.advisor.push({
    who: 'advisor',
    kind: 'question',
    period: session.last.statements.period,
    fact: axis.fact,
    text: axis.question,
  });
}

const logEntry = (result: TickResult, attributions: DeltaAttribution[]): TurnLogEntry => ({
  period: result.statements.period,
  events: result.events.filter((e) => e.severity !== 'INFO').map((e) => describeEvent(e)),
  attributions,
});

/** The same shape the CLI journals, so one redaction path serves both. */
function quarterEvent(result: TickResult, attributions: DeltaAttribution[]): JournalEvent {
  const consolidated = result.statements.consolidated.incomeStatement;
  return {
    kind: 'quarter',
    period: result.statements.period,
    revenue: toDisplay(consolidated.revenue),
    ebitda: toDisplay(consolidated.ebitda),
    cash: toDisplay(result.statements.consolidated.balanceSheet.cash),
    events: result.events.filter((e) => e.severity !== 'INFO').map((e) => e.kind),
    ...(attributions.length > 0
      ? { attributions: attributions.map((a) => `${a.lineLabel} ${describeAttribution(a)}`) }
      : {}),
  };
}
