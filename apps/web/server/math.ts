import { toDisplay } from '@bizsim/money';
import { statementMath, type Derivation, type DerivedValue } from '@bizsim/engine';
import type { GameSession } from './store';

/**
 * "Show the math" (§16 Q3), formatted for the browser.
 *
 * The engine emits quantities with their units — `{ kind: 'rate', value: 0.08 }`
 * — and this decides that a rate reads as `8.0%`. That split is the point: the
 * engine never formats, and the view never computes. Every number below has
 * already been derived; nothing here does arithmetic beyond choosing digits.
 */

export interface MathStepView {
  label: string;
  value: string;
  op?: string;
  /** The register row that sets this value — the one the player can argue with. */
  path?: string;
  note?: string;
}

export interface MathView {
  label: string;
  steps: MathStepView[];
  result: string;
  /** The per-item derivations that rolled up into this figure. */
  parts?: MathView[];
  /**
   * A volume in this panel is shown rounded. Demand is continuous in the
   * engine, so "13,223 orders × $7.50" lands $1.45 away from the row above —
   * and a panel that visibly misses its own figure looks broken unless it says
   * why. Displaying "13,222.8 orders" instead would be its own kind of wrong.
   */
  rounded?: boolean;
}

/** The same formatter the statements use, so a panel and its row agree. */
const dollars = (cents: bigint): string => toDisplay(cents);

/** Counts are approximate by nature — 13,223.4 visits is false precision. */
const counted = (value: number, noun?: string): string => {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const n = rounded.toLocaleString('en-US');
  return noun ? `${n} ${noun}` : n;
};

/** Drop trailing zeros, but never the first decimal place. */
const trim = (fixed: string): string =>
  fixed.includes('.') ? fixed.replace(/(\.\d)0+$/, '$1').replace(/(\.\d*[1-9])0+$/, '$1') : fixed;

export function formatValue(v: DerivedValue): string {
  switch (v.kind) {
    case 'money':
      return dollars(v.cents);
    case 'count':
      return counted(v.value, v.noun);
    case 'rate':
      // Enough places to reproduce, never fewer. A quarterly rate of 2.625%
      // rounded to 2.6% misses the interest figure by $37 on $150k, and a
      // player checking the panel against the row finds it wrong.
      return `${trim((v.value * 100).toFixed(4))}%`;
    case 'factor':
      // Four places, not two: a payroll load of 1.1165 shown as ×1.12 does not
      // reproduce the figure below it, and a panel whose arithmetic visibly
      // fails to land is worse than no panel.
      return `×${v.value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    case 'number':
      return counted(v.value, v.noun);
  }
}

const isRounded = (d: Derivation): boolean =>
  d.steps.some(
    (s) =>
      (s.value.kind === 'count' || s.value.kind === 'number') && !Number.isInteger(s.value.value),
  );

function toView(d: Derivation): MathView {
  return {
    label: d.label,
    ...(isRounded(d) ? { rounded: true } : {}),
    steps: d.steps.map((s) => ({
      label: s.label,
      value: formatValue(s.value),
      ...(s.op ? { op: s.op } : {}),
      ...(s.path ? { path: s.path } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
    result: formatValue(d.result),
  };
}

/**
 * The math for each income-statement line, keyed by the row label it hangs
 * under. A line with nothing recorded is simply absent — the row then renders
 * no affordance at all, rather than one that opens onto an empty panel.
 */
export function mathByLabel(session: GameSession): Record<string, MathView> {
  const entry = session.last.statements.byBusiness[session.businessId];
  if (!entry) return {};
  const math = statementMath(entry.incomeStatement, session.last.trace);
  const out: Record<string, MathView> = {};
  for (const m of Object.values(math)) {
    const view = toView(m.derivation);
    if (m.parts.length > 0) out[m.derivation.label] = { ...view, parts: m.parts.map(toView) };
    else out[m.derivation.label] = view;
  }
  return out;
}
