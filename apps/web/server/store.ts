import { randomUUID } from 'node:crypto';
import { toDisplay } from '@bizsim/money';
import { attributeQuarter, tick, type TickResult } from '@bizsim/engine';
import type { Action, DeltaAttribution, StatementSet, WorldState } from '@bizsim/schemas';
import {
  SCENARIOS,
  describeAttribution,
  describeEvent,
  journalActions,
  type JournalEvent,
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
  };
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
  };
  sessions.set(session.id, session);
  return session;
}

/** Advance one quarter with the queued actions, then `skip` more without any. */
export function advanceSession(session: GameSession, actions: Action[], skip = 0): GameSession {
  const quarters = 1 + Math.max(0, Math.min(skip, 40));
  for (let i = 0; i < quarters; i++) {
    if (session.world.currentPeriod >= session.world.config.milestonePeriod + 40) break;
    const before = session.world;
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
    const business = session.world.businesses.find((b) => b.id === session.businessId);
    if (!business || business.status === 'CLOSED') {
      session.events.push({ kind: 'end', reason: 'insolvent' });
      break;
    }
  }
  return session;
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
