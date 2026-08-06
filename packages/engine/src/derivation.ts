import type { Money } from '@bizsim/money';

/**
 * The id of a statement line or metric that computations attribute to. Defined
 * here rather than in context.ts because both the §10.4 trace and a §16 Q3
 * derivation key off it, and context.ts already depends on this module — the
 * other direction would close a cycle.
 */
export type TraceKey = string;

/**
 * "Show the math" — spec §16 Q3, planned in docs/plan/08-show-the-math.md.
 *
 * The §10.4 trace records which assumptions CAN move a line and deliberately
 * discards the values and the operations, because the dependency graph was all
 * it ever needed. Revenue's trace says `captureRate` fed it; it does not say
 * `× 8.0%`. This carries the arithmetic as it actually ran.
 *
 * The law: a derivation is recorded where the formula lives, never
 * reconstructed where it is displayed. Reading parameters back out of
 * WorldState in the view and multiplying them together is a second
 * implementation of every formula, kept in sync by hope — and the first thing a
 * player does with a math panel is find the case where it does not make the
 * number above it. Same rule as §1.1, pointed at the view instead of the LLM.
 */

/**
 * A quantity with its unit, so the view can format it and the engine does not
 * have to. A rate renders as a percentage in the browser and may not in an
 * export; that is presentation, and presentation is not the engine's call.
 */
export type DerivedValue =
  /** Money, in cents. */
  | { kind: 'money'; cents: Money }
  /** A physical count — visits, orders, hours. */
  | { kind: 'count'; value: number; noun?: string }
  /** A proportion in 0..1, shown as a percentage. */
  | { kind: 'rate'; value: number }
  /** A multiplier around 1.0, shown as ×1.08. */
  | { kind: 'factor'; value: number }
  /** A plain number that is none of the above — a block count, a quarter index. */
  | { kind: 'number'; value: number; noun?: string };

export const money = (cents: Money): DerivedValue => ({ kind: 'money', cents });
export const count = (value: number, noun?: string): DerivedValue =>
  noun === undefined ? { kind: 'count', value } : { kind: 'count', value, noun };
export const rate = (value: number): DerivedValue => ({ kind: 'rate', value });
export const factor = (value: number): DerivedValue => ({ kind: 'factor', value });
export const number = (value: number, noun?: string): DerivedValue =>
  noun === undefined ? { kind: 'number', value } : { kind: 'number', value, noun };

/** One line of the arithmetic, in the order it ran. */
export interface DerivationStep {
  label: string;
  value: DerivedValue;
  /** How this step joins the previous one. Absent on the first step. */
  op?: '×' | '÷' | '+' | '−';
  /**
   * The assumption path behind this step, where one exists. It names the
   * register row that sets the value — which is the row the player can already
   * argue with. Show-the-math and the §11.3 challenge are the same loop seen
   * from two ends.
   */
  path?: string;
  /** A clause the arithmetic alone does not carry: "capped by capacity". */
  note?: string;
}

export interface Derivation {
  label: string;
  /** The statement line this rolls up into, for grouping under a subtotal. */
  line?: TraceKey;
  steps: DerivationStep[];
  result: DerivedValue;
}

/** Derivations recorded during a tick, keyed by figure id. */
export type DerivationMap = Record<string, Derivation>;

/** Figure ids. Keys are parsed by nothing — but they are grepped by people. */
export const figureId = {
  streamDemand: (streamId: string): string => `stream.${streamId}.demand`,
  streamRevenue: (streamId: string): string => `stream.${streamId}.revenue`,
  cost: (costId: string): string => `cost.${costId}`,
};
