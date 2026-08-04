import { randomUUID } from 'node:crypto';
import { attributeQuarter, tick, type TickResult } from '@bizsim/engine';
import type { Action, DeltaAttribution, StatementSet, WorldState } from '@bizsim/schemas';
import { SCENARIOS, describeEvent } from '@bizsim/sim-cli';

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
    id: randomUUID().slice(0, 8),
    scenario,
    world: first.state,
    businessId,
    last: first,
    priorStatements: first.statements,
    attributions: [],
    log: [logEntry(first, [])],
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): GameSession | undefined {
  return sessions.get(id);
}

/** Advance one quarter with the queued actions, then `skip` more without any. */
export function advanceSession(session: GameSession, actions: Action[], skip = 0): GameSession {
  const quarters = 1 + Math.max(0, Math.min(skip, 40));
  for (let i = 0; i < quarters; i++) {
    if (session.world.currentPeriod >= session.world.config.milestonePeriod + 40) break;
    const before = session.world;
    const result = tick(before, i === 0 ? actions : [], { throwOnAssertionFailure: false });
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
    const business = session.world.businesses.find((b) => b.id === session.businessId);
    if (!business || business.status === 'CLOSED') break;
  }
  return session;
}

const logEntry = (result: TickResult, attributions: DeltaAttribution[]): TurnLogEntry => ({
  period: result.statements.period,
  events: result.events.filter((e) => e.severity !== 'INFO').map((e) => describeEvent(e)),
  attributions,
});
