import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Web sessions, on disk — architecture §4's "persistence is the event log"
 * applied at dev-server scale.
 *
 * Sessions lived only in `globalThis` maps, so every dev-server restart
 * silently ended every run and destroyed every unshared journal — including
 * the one play-test run whose evidence we most wanted (the Toledo shop died
 * before its journal could be shared, and a restart would have erased the
 * proof). Each mutation now writes the session to
 * `.bizsim/web-sessions/<kind>-<id>.json`, and a store miss reads it back.
 *
 * `.bizsim/` is already gitignored with the CLI's journals, for the same
 * reason: these files contain business ideas someone typed in confidence.
 *
 * Everything here is best-effort. A failed write costs durability, not the
 * running session; a failed read is a missing session, which the routes
 * already answer honestly with a 404.
 */

const DIR = path.join(process.cwd(), '.bizsim', 'web-sessions');

/**
 * JSON with the two things engine state carries that JSON cannot: Money
 * (bigint cents) and the non-finite numbers derived metrics legitimately
 * produce (an indefinite runway is `Infinity`, which stringifies to null and
 * would corrupt the round trip). Both travel as tagged wrappers.
 */
const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return { $m: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $num: String(value) };
  return value;
};

const reviver = (_key: string, value: unknown): unknown => {
  if (value !== null && typeof value === 'object') {
    const tagged = value as { $m?: unknown; $num?: unknown };
    if (typeof tagged.$m === 'string') return BigInt(tagged.$m);
    if (typeof tagged.$num === 'string') return Number(tagged.$num);
  }
  return value;
};

export function saveState(kind: 'game' | 'setup', id: string, state: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `${kind}-${id}.json`), JSON.stringify(state, replacer));
  } catch {
    // Best-effort: the in-memory session is still authoritative.
  }
}

export function loadState<T>(kind: 'game' | 'setup', id: string): T | undefined {
  // Ids are interpolated into paths; only UUID-shaped ones may pass.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(DIR, `${kind}-${id}.json`), 'utf8'), reviver) as T;
  } catch {
    return undefined;
  }
}
