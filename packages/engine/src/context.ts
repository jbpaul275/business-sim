import type { AssumptionRegister, PeriodIndex } from '@bizsim/schemas';

/**
 * Provenance tracing — spec §10.4.
 *
 * Every derived figure shown to the player must be traceable to the assumptions
 * that produced it. The spec gives this one sentence; it is a cross-cutting
 * concern touching every computation in the engine, which is why it is threaded
 * through from the first tick rather than retrofitted (docs/plan/01-architecture.md §5).
 *
 * The mechanism is deliberately cheap: formula code reads a parameter through
 * `ctx.p(path, value)`, which records the read against whichever statement line
 * is currently in scope and returns the value unchanged. One indirection per
 * parameter read buys §10.4 attribution, the "show the math" affordance
 * (§16 Q3), and a pruning signal for sensitivity analysis (§12.3) — an
 * assumption no line reads cannot move the output, so its sweep can be skipped.
 */

export type TraceKey = string;

export interface ComputationTrace {
  /** statement line or metric id → assumption paths that fed it */
  byLine: Record<TraceKey, string[]>;
  /** assumption path → statement lines it feeds */
  byPath: Record<string, TraceKey[]>;
}

export interface TickContext {
  readonly period: PeriodIndex;
  readonly register: AssumptionRegister | undefined;
  /** Record a parameter read and return it unchanged. */
  p<T>(path: string, value: T): T;
  /** Attribute every read inside `fn` to `line`. */
  scope<T>(line: TraceKey, fn: () => T): T;
  readonly trace: ComputationTrace;
}

class Tracer implements TickContext {
  readonly trace: ComputationTrace = { byLine: {}, byPath: {} };
  private stack: TraceKey[] = [];

  constructor(
    readonly period: PeriodIndex,
    readonly register: AssumptionRegister | undefined,
  ) {}

  p<T>(path: string, value: T): T {
    const line = this.stack[this.stack.length - 1];
    if (line !== undefined) {
      const lines = (this.trace.byLine[line] ??= []);
      if (!lines.includes(path)) lines.push(path);
      const paths = (this.trace.byPath[path] ??= []);
      if (!paths.includes(line)) paths.push(line);
    }
    return value;
  }

  scope<T>(line: TraceKey, fn: () => T): T {
    this.stack.push(line);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }
}

/**
 * A context that records nothing. Property tests run 40 periods × 1,000 cases
 * per archetype; recording every read there is pure overhead against a 1ms tick
 * budget, and nothing reads the trace.
 */
class NullTracer implements TickContext {
  readonly trace: ComputationTrace = { byLine: {}, byPath: {} };
  constructor(
    readonly period: PeriodIndex,
    readonly register: AssumptionRegister | undefined,
  ) {}
  p<T>(_path: string, value: T): T {
    return value;
  }
  scope<T>(_line: TraceKey, fn: () => T): T {
    return fn();
  }
}

export function createContext(
  period: PeriodIndex,
  register: AssumptionRegister | undefined,
  options: { trace?: boolean } = {},
): TickContext {
  return options.trace === false
    ? new NullTracer(period, register)
    : new Tracer(period, register);
}

/** Map a cost line's statement line onto its trace key. */
export const lineKey = (line: string): TraceKey => {
  switch (line) {
    case 'COGS':
      return LINE.cogs;
    case 'LABOR':
      return LINE.labor;
    case 'OCCUPANCY':
      return LINE.occupancy;
    case 'MARKETING':
      return LINE.marketing;
    default:
      return LINE.gAndA;
  }
};

/** Statement-line trace keys, so attribution targets are not stringly-typed ad hoc. */
export const LINE = {
  revenue: 'incomeStatement.revenue',
  cogs: 'incomeStatement.costOfGoodsSold',
  labor: 'incomeStatement.labor',
  occupancy: 'incomeStatement.occupancy',
  marketing: 'incomeStatement.marketing',
  gAndA: 'incomeStatement.generalAndAdmin',
  depreciation: 'incomeStatement.depreciationAndAmortization',
  interest: 'incomeStatement.interestExpense',
  tax: 'incomeStatement.incomeTaxExpense',
  workingCapital: 'cashFlow.changeInNetWorkingCapital',
  capex: 'cashFlow.capitalExpenditures',
} as const;
