import type { Action, WorldState } from '@bizsim/schemas';
import { tick, type TickOptions, type TickResult } from './tick.js';

/**
 * Event sourcing — spec §1.4.
 *
 * The ordered action log is the source of truth; snapshots are a cache. State
 * must be reproducible by replaying actions from genesis through the engine.
 *
 * This is what gives deterministic replay, debuggability, the ability to
 * migrate the engine and recompute old games, and a cheap path to a future
 * "what if I hadn't done that" feature. The snapshot-integrity test in
 * `replay.test.ts` is the only test that actually proves the claim — without
 * it, the log is decorative.
 */

export interface ActionLogEntry {
  period: number;
  actions: Action[];
}

export function replay(
  genesis: WorldState,
  log: readonly ActionLogEntry[],
  options: TickOptions = {},
): TickResult[] {
  const results: TickResult[] = [];
  let state = genesis;

  const byPeriod = new Map<number, Action[]>();
  for (const entry of log) {
    byPeriod.set(entry.period, [...(byPeriod.get(entry.period) ?? []), ...entry.actions]);
  }

  const lastPeriod = log.reduce((max, e) => Math.max(max, e.period), genesis.currentPeriod);
  for (let period = genesis.currentPeriod + 1; period <= lastPeriod; period++) {
    const result = tick(state, byPeriod.get(period) ?? [], options);
    results.push(result);
    state = result.state;
  }

  return results;
}

/** Replay `periods` quarters from genesis, applying whatever the log holds. */
export function replayFromGenesis(
  genesis: WorldState,
  log: readonly ActionLogEntry[],
  periods: number,
  options: TickOptions = {},
): TickResult[] {
  const byPeriod = new Map<number, Action[]>();
  for (const entry of log) {
    byPeriod.set(entry.period, [...(byPeriod.get(entry.period) ?? []), ...entry.actions]);
  }

  const results: TickResult[] = [];
  let state = genesis;
  for (let i = 0; i < periods; i++) {
    const period = genesis.currentPeriod + 1 + i;
    const result = tick(state, byPeriod.get(period) ?? [], options);
    results.push(result);
    state = result.state;
  }
  return results;
}
