import { type Money } from '@bizsim/money';
import {
  ASSERTION_TOLERANCE,
  type AssertionResult,
  type BalanceSheet,
  type CashFlowStatement,
  type IncomeStatement,
  type RevenueStream,
} from '@bizsim/schemas';

/**
 * Articulation assertions — spec §8.4. Hard failures, not warnings.
 *
 * If a player can ever export a model that does not tie, the credibility claim
 * the entire product rests on is gone. Any failure here is an engine bug: fail
 * loudly in development, and in production refuse to persist the period rather
 * than show the player a broken model.
 *
 * Note what these do NOT prove. Appendix A of the spec records a run where every
 * assertion passed for forty consecutive quarters while revenue was frozen by a
 * staffing bug. Articulation tests prove the books tie, not that the business
 * logic is right. Both suites in §13 are load-bearing.
 */

export interface AssertionInput {
  businessId: string;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlowStatement;
  streams: readonly RevenueStream[];

  beginningRetainedEarnings: Money;
  distributions: Money;
  beginningAccumDep: Money;
  depreciationExpense: Money;
  accumDepOnDisposals: Money;
  beginningPpeGross: Money;
  capex: Money;
  disposalsAtCost: Money;
  beginningDebt: Money;
  drawdowns: Money;
  principalRepayments: Money;
  totalSalvageValue: Money;
}

const within = (a: Money, b: Money): boolean => {
  const diff = a - b;
  return (diff < 0n ? -diff : diff) <= ASSERTION_TOLERANCE;
};

export function runAssertions(input: AssertionInput): AssertionResult[] {
  const { balanceSheet: bs, cashFlow: cf, businessId } = input;
  const results: AssertionResult[] = [];

  const check = (name: string, expected: Money, actual: Money): void => {
    results.push({ name, businessId, expected, actual, passed: within(expected, actual) });
  };

  const atLeast = (name: string, actual: Money, floor: Money): void => {
    results.push({
      name,
      businessId,
      expected: floor,
      actual,
      passed: actual >= floor - ASSERTION_TOLERANCE,
    });
  };

  check('balanceSheetBalances', bs.totalAssets, bs.totalLiabilities + bs.totalEquity);

  check('cashFlowTiesToCash', cf.endingCash, cf.beginningCash + cf.cashFlowFromOperations + cf.cashFlowFromInvesting + cf.cashFlowFromFinancing);

  check('cashOnBalanceSheetMatchesCashFlow', bs.cash, cf.endingCash);

  check(
    'retainedEarningsRollforward',
    bs.retainedEarnings,
    input.beginningRetainedEarnings + input.incomeStatement.netIncome - input.distributions,
  );

  check(
    'accumulatedDepreciationRollforward',
    bs.accumulatedDepreciation,
    input.beginningAccumDep + input.depreciationExpense - input.accumDepOnDisposals,
  );

  check(
    'ppeGrossRollforward',
    bs.ppeGross,
    input.beginningPpeGross + input.capex - input.disposalsAtCost,
  );

  check(
    'debtRollforward',
    bs.longTermDebt + bs.currentPortionOfDebt,
    input.beginningDebt + input.drawdowns - input.principalRepayments,
  );

  // Spec §8.4: cash must be non-negative. The crisis ladder (§9.4) is what makes
  // this true; the engine never silently overdrafts.
  atLeast('cashNonNegative', bs.cash, 0n);
  atLeast('inventoryNonNegative', bs.inventory, 0n);
  atLeast('accountsReceivableNonNegative', bs.accountsReceivable, 0n);
  atLeast('retainageReceivableNonNegative', bs.retainageReceivable, 0n);
  // The renewal term in §5.3 exists specifically to keep this true.
  atLeast('deferredRevenueNonNegative', bs.deferredRevenue, 0n);

  atLeast(
    'accumDepWithinDepreciableBase',
    bs.ppeGross - input.totalSalvageValue - bs.accumulatedDepreciation,
    0n,
  );

  // Only PROJECT_BACKLOG carries backlog; guard before asserting.
  for (const stream of input.streams) {
    if (stream.state.backlog !== undefined) {
      atLeast(`backlogNonNegative:${stream.id}`, stream.state.backlog, 0n);
    }
  }

  return results;
}

export const failures = (results: readonly AssertionResult[]): AssertionResult[] =>
  results.filter((r) => !r.passed);
