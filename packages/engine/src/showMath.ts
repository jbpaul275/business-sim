import type { IncomeStatement } from '@bizsim/schemas';
import { LINE, type ComputationTrace, type TraceKey } from './context.js';
import {
  money as asMoney,
  type Derivation,
  type DerivationMap,
  type DerivationStep,
} from './derivation.js';

/**
 * The income statement's own arithmetic — spec §16 Q3, stage 1 of
 * docs/plan/08-show-the-math.md.
 *
 * Two kinds of figure live here and they are governed differently.
 *
 * **Rolled-up lines** (COGS, labor, occupancy, marketing, G&A) are assembled
 * from the derivations the cost engine recorded while it computed them. This
 * file never re-derives a cost; it groups what `costs.ts` already said.
 *
 * **Subtotals** (gross profit, EBITDA, EBIT, pretax, net income) are the one
 * place the "never reconstruct" law relaxes, deliberately. `Gross profit =
 * Revenue − COGS` is not a second implementation of a formula — it is a
 * restatement of two figures already printed on the same screen, and there is
 * nothing for it to drift from. Anything with a real formula behind it stays
 * the engine's job.
 */

/** A figure the player can open, with the arithmetic under it. */
export interface StatementMath {
  /** The statement line this explains — the row it hangs under. */
  line: TraceKey;
  derivation: Derivation;
  /**
   * The per-item derivations that rolled up into it: one cost line, one
   * revenue stream. Empty for a subtotal.
   */
  parts: Derivation[];
}

const totalStep = (label: string, cents: bigint, op?: DerivationStep['op']): DerivationStep => ({
  label,
  value: asMoney(cents),
  ...(op ? { op } : {}),
});

/** Group the recorded derivations by the statement line they roll into. */
function partsByLine(derivations: DerivationMap): Map<TraceKey, Derivation[]> {
  const byLine = new Map<TraceKey, Derivation[]>();
  for (const d of Object.values(derivations)) {
    if (d.line === undefined) continue;
    const list = byLine.get(d.line) ?? [];
    list.push(d);
    byLine.set(d.line, list);
  }
  return byLine;
}

/**
 * Revenue's parts are recorded twice per stream — the demand chain and the
 * revenue that came out of it. Only the revenue derivations sum to the line;
 * the demand chain is context, and showing both under one total would print an
 * addition that does not add up.
 */
const rollsUp = (d: Derivation): boolean => d.result.kind === 'money';

export function statementMath(
  is: IncomeStatement,
  trace: ComputationTrace,
): Record<string, StatementMath> {
  const byLine = partsByLine(trace.derivations);
  const out: Record<string, StatementMath> = {};

  const rollup = (line: TraceKey, label: string, total: bigint): void => {
    const parts = (byLine.get(line) ?? []).filter(rollsUp);
    // No recorded parts means nothing to show. An affordance that opens onto
    // an empty panel teaches the player the feature is unreliable, so the
    // caller renders no affordance at all.
    if (parts.length === 0) return;
    const only = parts[0];
    if (parts.length === 1 && only) {
      // One contributor is not a sum. Printing "Revenue = Espresso $99,171.05"
      // and hiding the actual chain one click deeper is a fold that costs the
      // player a click and tells them nothing.
      out[line] = { line, derivation: { ...only, label, line }, parts: [] };
      return;
    }
    out[line] = {
      line,
      derivation: {
        label,
        line,
        steps: parts.map((p, i) => totalStep(p.label, moneyOf(p), i === 0 ? undefined : '+')),
        result: asMoney(total),
      },
      parts,
    };
  };

  const subtotal = (line: TraceKey, label: string, steps: DerivationStep[], total: bigint): void => {
    out[line] = {
      line,
      derivation: { label, line, steps, result: asMoney(total) },
      parts: [],
    };
  };

  rollup(LINE.revenue, 'Revenue', is.revenue);
  rollup(LINE.cogs, 'Cost of goods sold', is.costOfGoodsSold);
  rollup(LINE.labor, 'Labor', is.labor);
  rollup(LINE.occupancy, 'Occupancy', is.occupancy);
  rollup(LINE.marketing, 'Marketing', is.marketing);
  rollup(LINE.gAndA, 'General & admin', is.generalAndAdmin);
  rollup(LINE.depreciation, 'Depreciation & amortization', is.depreciationAndAmortization);
  rollup(LINE.interest, 'Interest expense', is.interestExpense);

  subtotal(
    'incomeStatement.grossProfit',
    'Gross profit',
    [totalStep('Revenue', is.revenue), totalStep('Cost of goods sold', is.costOfGoodsSold, '−')],
    is.grossProfit,
  );
  subtotal(
    'incomeStatement.ebitda',
    'EBITDA',
    [
      totalStep('Gross profit', is.grossProfit),
      totalStep('Labor', is.labor, '−'),
      totalStep('Occupancy', is.occupancy, '−'),
      totalStep('Marketing', is.marketing, '−'),
      totalStep('General & admin', is.generalAndAdmin, '−'),
    ],
    is.ebitda,
  );
  subtotal(
    'incomeStatement.ebit',
    'EBIT',
    [
      totalStep('EBITDA', is.ebitda),
      totalStep('Depreciation & amortization', is.depreciationAndAmortization, '−'),
    ],
    is.ebit,
  );
  subtotal(
    'incomeStatement.pretaxIncome',
    'Pretax income',
    [
      totalStep('EBIT', is.ebit),
      totalStep('Interest expense', is.interestExpense, '−'),
      ...(is.gainOnAssetDisposal !== 0n
        ? [totalStep('Gain on asset disposal', is.gainOnAssetDisposal, '+')]
        : []),
      ...(is.financingCosts !== 0n ? [totalStep('Financing costs', is.financingCosts, '−')] : []),
    ],
    is.pretaxIncome,
  );
  subtotal(
    'incomeStatement.netIncome',
    'Net income',
    [
      totalStep('Pretax income', is.pretaxIncome),
      totalStep('Income tax expense', is.incomeTaxExpense, '−'),
    ],
    is.netIncome,
  );

  return out;
}

const moneyOf = (d: Derivation): bigint => (d.result.kind === 'money' ? d.result.cents : 0n);
