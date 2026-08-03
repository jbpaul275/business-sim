import { DAYS_PER_QUARTER, mulRate, sum, type Money } from '@bizsim/money';
import type { Business, BusinessBalances } from '@bizsim/schemas';
import { streamDsoDays } from './archetypes.js';
import type { RealizeResult } from './archetypes.js';
import type { TickContext } from './context.js';

/**
 * Working capital and timing — spec §5.
 *
 * Amounts are only half of a cost. Timing is where the cash drama lives, and
 * ΔNWC is the single line that explains why a profitable business runs out of
 * money.
 */

export interface WorkingCapitalBalances {
  /**
   * Receivables before any crisis factoring. The factoring remedy must be
   * capped against this figure, not against the post-factoring balance —
   * selling more receivables than exist raises cash the balance sheet cannot
   * account for, and the shortfall shows up as an articulation failure a
   * hundred periods later.
   */
  grossAccountsReceivable: Money;
  accountsReceivable: Money;
  retainageReceivable: Money;
  inventory: Money;
  prepaidExpenses: Money;
  accountsPayable: Money;
  accruedLiabilities: Money;
  deferredRevenue: Money;
  deferredOwnerComp: Money;
}

export interface WorkingCapitalInput {
  outcomes: readonly RealizeResult[];
  quarterCogs: Money;
  quarterAccruableCosts: Money;
  quarterPrepaidCosts: Money;
  /** Owner comp deferred this period by crisis remedy 4, cumulative on the balance sheet. */
  deferredOwnerCompDelta: Money;
  /** Receivables sold under crisis remedy 3, removed from the AR balance. */
  factoredReceivables: Money;
}

export function computeWorkingCapital(
  ctx: TickContext,
  business: Business,
  input: WorkingCapitalInput,
): WorkingCapitalBalances {
  const wc = business.workingCapital;

  // AR is computed per stream, because PROJECT_BACKLOG bills on schedules of
  // value rather than invoices and carries its own DSO (§3.6, §5.1).
  let accountsReceivable = 0n;
  let retainageReceivable = business.balances.retainageReceivable;
  let deferredRevenue = 0n;

  for (const outcome of input.outcomes) {
    const stream = business.streams.find((s) => s.id === outcome.streamId);
    if (!stream) continue;

    const dso = streamDsoDays(stream, ctx.p('workingCapital.dsoDays', wc.dsoDays));
    accountsReceivable += mulRate(outcome.revenue, dso / DAYS_PER_QUARTER);

    // Retainage rollforward. Omitting this from ΔNWC breaks the cash-flow tie
    // for every PROJECT_BACKLOG business (§5.2).
    if (outcome.retainageWithheld !== undefined) {
      retainageReceivable += outcome.retainageWithheld - (outcome.retainageReleased ?? 0n);
    }

    // Mobilisation deposits are held against un-executed backlog and offset the
    // retainage drag.
    if (stream.params.kind === 'PROJECT_BACKLOG') {
      const backlog = outcome.newState.backlog ?? 0n;
      deferredRevenue += mulRate(
        backlog,
        ctx.p('workingCapital.customerDepositPct', wc.customerDepositPct),
      );
    }

    // Subscription prepay: cash collected exceeds revenue recognised, and the
    // difference is a liability that funds operations (§5.3).
    if (outcome.deferredCashCollected !== undefined) {
      const begin = business.balances.deferredRevenue;
      const recognised = outcome.recognizedSubscriptionRevenue ?? 0n;
      const end = begin + outcome.deferredCashCollected - recognised;
      deferredRevenue += end > 0n ? end : 0n;
    }
  }

  const grossAccountsReceivable = accountsReceivable;
  accountsReceivable -= input.factoredReceivables;
  if (accountsReceivable < 0n) accountsReceivable = 0n;
  if (retainageReceivable < 0n) retainageReceivable = 0n;

  const inventory = mulRate(
    input.quarterCogs,
    ctx.p('workingCapital.dioDays', wc.dioDays) / DAYS_PER_QUARTER,
  );

  // Labor and marketing are never accruable — payroll clears on a two-week
  // cycle and ad platforms bill on a card, regardless of when customers pay.
  // That mismatch is the mechanism by which growing businesses die (§5.1).
  const accountsPayable = mulRate(
    input.quarterAccruableCosts,
    ctx.p('workingCapital.dpoDays', wc.dpoDays) / DAYS_PER_QUARTER,
  );

  const securityDeposit = mulRate(business.monthlyRent, wc.securityDepositMonths);
  const prepaidInsurance = mulRate(
    input.quarterPrepaidCosts,
    ctx.p('workingCapital.prepaidInsuranceMonths', wc.prepaidInsuranceMonths) / 3,
  );

  return {
    grossAccountsReceivable,
    accountsReceivable,
    retainageReceivable,
    inventory,
    prepaidExpenses: securityDeposit + prepaidInsurance,
    accountsPayable,
    accruedLiabilities: business.balances.accruedLiabilities,
    deferredRevenue,
    deferredOwnerComp: business.balances.deferredOwnerComp + input.deferredOwnerCompDelta,
  };
}

/**
 * ΔNWC — spec §5.2.
 *
 * Growth makes this positive, which consumes cash. `deferredOwnerComp` is
 * included even though §5.2's list omits it: it is a liability that funds
 * operations exactly as deferred revenue does, and leaving it out breaks the
 * cash tie the moment crisis remedy 4 fires. See docs/plan/03-spec-gaps.md G-12.
 */
export function deltaNetWorkingCapital(
  begin: BusinessBalances,
  end: WorkingCapitalBalances,
): Money {
  return (
    end.accountsReceivable -
    begin.accountsReceivable +
    (end.retainageReceivable - begin.retainageReceivable) +
    (end.inventory - begin.inventory) +
    (end.prepaidExpenses - begin.prepaidExpenses) -
    (end.accountsPayable - begin.accountsPayable) -
    (end.accruedLiabilities - begin.accruedLiabilities) -
    (end.deferredRevenue - begin.deferredRevenue) -
    (end.deferredOwnerComp - begin.deferredOwnerComp)
  );
}

/** Cash conversion cycle = DSO + DIO − DPO (§8.5). */
export function cashConversionCycle(business: Business): number {
  const wc = business.workingCapital;
  return wc.dsoDays + wc.dioDays - wc.dpoDays;
}

/**
 * Month-zero cash outlays — spec §5.4. Routinely omitted from founder models
 * and materially changed by their omission.
 */
export interface MonthZeroOutlays {
  leaseSigning: Money;
  buildoutAndEquipment: Money;
  initialInventory: Money;
  permitsAndLegal: Money;
  prepaidInsurance: Money;
  preOpeningPayroll: Money;
  preOpeningMarketing: Money;
  debtOriginationFees: Money;
  /**
   * Paid for the availability of a line nobody has drawn on.
   *
   * Its own field rather than folded into `debtOriginationFees`, because it is
   * the one that appears when you borrowed nothing — and reporting it as debt
   * origination contradicts the screen that just offered "no debt needed, and
   * a $3,000 revolver".
   */
  revolverCommitmentFees: Money;
  total: Money;
}

export function totalMonthZero(outlays: Omit<MonthZeroOutlays, 'total'>): Money {
  return sum([
    outlays.leaseSigning,
    outlays.buildoutAndEquipment,
    outlays.initialInventory,
    outlays.permitsAndLegal,
    outlays.prepaidInsurance,
    outlays.preOpeningPayroll,
    outlays.preOpeningMarketing,
    outlays.debtOriginationFees,
    outlays.revolverCommitmentFees,
  ]);
}
