import type { Money, PeriodIndex } from './primitives.js';

export type EngineEventKind =
  | 'STEP_BLOCK_CROSSED'
  | 'CAPACITY_CONSTRAINED'
  | 'COVENANT_BREACH'
  | 'LOST_DEMAND_THRESHOLD'
  | 'RUNWAY_WARNING'
  | 'CASH_CRISIS'
  | 'CRISIS_REMEDY_APPLIED'
  | 'INSOLVENCY'
  | 'PERSONAL_INSOLVENCY'
  | 'ELASTICITY_CLAMP'
  | 'ASSUMPTION_OUT_OF_BAND'
  | 'MILESTONE_REACHED'
  | 'BENCH_STRESS'
  | 'UNDERWRITING_DECLINED'
  | 'ACTION_REJECTED';

export interface EngineEvent {
  period: PeriodIndex;
  businessId?: string;
  kind: EngineEventKind;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  detail: Record<string, number | string>;
}

export interface AssertionResult {
  name: string;
  businessId?: string;
  passed: boolean;
  expected: Money;
  actual: Money;
}

/** Spec §8.4: one cent, to absorb rounding. */
export const ASSERTION_TOLERANCE: Money = 1n;

export class ArticulationError extends Error {
  constructor(
    readonly period: PeriodIndex,
    readonly failures: AssertionResult[],
  ) {
    const lines = failures
      .map(
        (f) =>
          `  ${f.name}${f.businessId ? ` [${f.businessId}]` : ''}: ` +
          `expected ${f.expected}, got ${f.actual} (off by ${f.actual - f.expected})`,
      )
      .join('\n');
    super(`Articulation failed at period ${period}:\n${lines}`);
    this.name = 'ArticulationError';
  }
}
