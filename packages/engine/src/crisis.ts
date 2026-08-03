import { mulRate, sum, toDisplay, type Money } from '@bizsim/money';
import type {
  Business,
  CrisisRemedy,
  EngineEvent,
  Household,
  PeriodIndex,
  WorldConfig,
} from '@bizsim/schemas';
import { netBookValue } from './depreciation.js';
import type { CrisisFlows } from './period.js';

/**
 * Cash crisis resolution — spec §9.4. The engine never silently overdrafts.
 *
 * Resolution must not break engine purity. The tick is a pure function and
 * replay determinism depends on it, so the engine cannot pause mid-tick to ask
 * the player anything. Instead the player maintains a PRE-DECLARED ordered
 * `crisisPolicy`, editable between turns; the engine applies remedies in that
 * order until cash is non-negative or the list is exhausted. Afterwards the
 * orchestrator surfaces what was applied and offers a chance to revise the
 * policy and re-run the quarter — which keeps the decision meaningful while
 * keeping the engine deterministic.
 */

export const FACTORING_DISCOUNT = 0.04;
export const EMERGENCY_DEBT_SPREAD = 0.12;
export const EMERGENCY_DEBT_ORIGINATION = 0.02;
export const SALE_LEASEBACK_PROCEEDS_PCT = 0.9;
/** A sale-leaseback buys cash now and a fixed-period lease cost forever. */
export const SALE_LEASEBACK_ANNUAL_LEASE_RATE = 0.12;

export const LIQUIDATION_HAIRCUTS = {
  EQUIPMENT: 0.35,
  LEASEHOLD_IMPROVEMENTS: 0.0,
  VEHICLES: 0.35,
  REAL_PROPERTY: 0.85,
  'FF&E': 0.35,
  INVENTORY: 0.25,
} as const;

export interface RemedyContext {
  business: Business;
  household: Household;
  config: WorldConfig;
  period: PeriodIndex;
  /** Household cash net of commitments already made this period (§9.2 step 15). */
  householdAvailable: Money;
  /** Accounts receivable from the previous pass, available to factor. */
  arBalance: Money;
  /** Owner compensation this period, if deferral is applied. */
  ownerCompThisPeriod: Money;
  /**
   * How much emergency debt this business can still raise. §9.4 puts no
   * ceiling on remedy 5, but an unbounded lender of last resort means a failing
   * business never fails — it just accumulates debt at prime + 12% forever, and
   * the run never reaches the insolvency the sim exists to be willing to show.
   */
  emergencyDebtCapacity: Money;
  shortfall: Money;
  nextId: () => string;
}

export interface RemedyOutcome {
  applied: boolean;
  raised: Money;
  note: string;
  householdConsumed: Money;
}

const none = (note: string): RemedyOutcome => ({
  applied: false,
  raised: 0n,
  note,
  householdConsumed: 0n,
});

export function applyRemedy(
  remedy: CrisisRemedy,
  ctx: RemedyContext,
  crisis: CrisisFlows,
): RemedyOutcome {
  const { business, shortfall } = ctx;
  if (shortfall <= 0n) return none('No shortfall.');

  switch (remedy) {
    case 'REVOLVER': {
      const revolver = business.debts.find(
        (d) => d.kind === 'REVOLVER' && (d.revolverLimit ?? 0n) > d.outstandingPrincipal,
      );
      if (!revolver) return none('No revolver with available capacity.');
      const available = (revolver.revolverLimit ?? 0n) - revolver.outstandingPrincipal;
      const draw = shortfall < available ? shortfall : available;
      revolver.outstandingPrincipal += draw;
      crisis.drawdowns += draw;
      return {
        applied: true,
        raised: draw,
        note: `Drew ${toDisplay(draw)} on the revolver.`,
        householdConsumed: 0n,
      };
    }

    case 'HOUSEHOLD_INJECTION': {
      if (ctx.householdAvailable <= 0n) return none('Household has no uncommitted cash.');
      const amount = shortfall < ctx.householdAvailable ? shortfall : ctx.householdAvailable;
      // The household actually pays. Recording only the business side would
      // create the money out of nothing at the world level.
      ctx.household.cash -= amount;
      ctx.household.cumulativeInjections += amount;
      crisis.householdInjection += amount;
      return {
        applied: true,
        raised: amount,
        note: `Household injected ${toDisplay(amount)}.`,
        householdConsumed: amount,
      };
    }

    case 'FACTOR_AR': {
      const available = ctx.arBalance - crisis.factoredReceivables;
      if (available <= 0n) return none('No receivables left to factor.');
      // Gross up so the net proceeds cover the shortfall.
      const needed = mulRate(shortfall, 1 / (1 - FACTORING_DISCOUNT));
      const factored = needed < available ? needed : available;
      const cost = mulRate(factored, FACTORING_DISCOUNT);
      crisis.factoredReceivables += factored;
      crisis.factoringCost += cost;
      return {
        applied: true,
        raised: factored - cost,
        note: `Factored ${toDisplay(factored)} of receivables at a ${FACTORING_DISCOUNT * 100}% discount.`,
        householdConsumed: 0n,
      };
    }

    case 'DEFER_OWNER_COMP': {
      if (crisis.deferOwnerComp) return none('Owner compensation is already deferred.');
      if (ctx.ownerCompThisPeriod <= 0n) return none('No owner compensation to defer.');
      crisis.deferOwnerComp = true;
      // Accrues as a liability. It does not vanish — see the repayment rule in
      // `repayDeferredOwnerComp`.
      return {
        applied: true,
        raised: ctx.ownerCompThisPeriod,
        note: `Deferred ${toDisplay(ctx.ownerCompThisPeriod)} of owner compensation.`,
        householdConsumed: 0n,
      };
    }

    case 'EMERGENCY_DEBT': {
      if (ctx.emergencyDebtCapacity <= 0n) {
        return none('No lender will extend further credit against this cash flow.');
      }
      const requested = mulRate(shortfall, 1 / (1 - EMERGENCY_DEBT_ORIGINATION));
      const principal =
        requested < ctx.emergencyDebtCapacity ? requested : ctx.emergencyDebtCapacity;
      const fee = mulRate(principal, EMERGENCY_DEBT_ORIGINATION);
      business.debts.push({
        id: ctx.nextId(),
        label: 'Emergency financing',
        kind: 'AMORTIZING',
        originalPrincipal: principal,
        outstandingPrincipal: principal,
        annualRate: ctx.config.primeRate + EMERGENCY_DEBT_SPREAD,
        termQuarters: 20,
        originatedPeriod: ctx.period,
        originationFeePct: EMERGENCY_DEBT_ORIGINATION,
        personalGuarantee: true,
        covenants: [],
      });
      crisis.drawdowns += principal;
      crisis.originationFees += fee;
      return {
        applied: true,
        raised: principal - fee,
        note: `Raised ${toDisplay(principal)} of emergency debt at ${((ctx.config.primeRate + EMERGENCY_DEBT_SPREAD) * 100).toFixed(1)}% with a personal guarantee.`,
        householdConsumed: 0n,
      };
    }

    case 'SALE_LEASEBACK': {
      const candidates = business.assets
        .filter((a) => a.category === 'EQUIPMENT' || a.category === 'REAL_PROPERTY')
        .sort((a, b) => Number(netBookValue(b) - netBookValue(a)));
      const asset = candidates[0];
      if (!asset || netBookValue(asset) <= 0n) return none('No asset available to sell and lease back.');

      const nbv = netBookValue(asset);
      const proceeds = mulRate(nbv, SALE_LEASEBACK_PROCEEDS_PCT);
      crisis.disposalProceeds += proceeds;
      crisis.disposalsAtCost += asset.grossCost;
      crisis.accumDepOnDisposals += asset.accumulatedDepreciation;
      crisis.gainOnDisposal += proceeds - nbv;

      business.assets = business.assets.filter((a) => a.id !== asset.id);
      business.costs.fixedPeriod.push({
        id: ctx.nextId(),
        label: `Lease — ${asset.label} (sale-leaseback)`,
        class: 'FIXED_PERIOD',
        amountPerQuarter: mulRate(proceeds, SALE_LEASEBACK_ANNUAL_LEASE_RATE / 4),
        annualEscalatorPct: 0.03,
        startPeriod: ctx.period,
        renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
        statementLine: 'OCCUPANCY',
        accruable: true,
        isLabor: false,
        isOwnerComp: false,
        isPrepaidExpense: false,
      });

      return {
        applied: true,
        raised: proceeds,
        note: `Sold and leased back ${asset.label} for ${toDisplay(proceeds)}; a permanent lease cost replaces it.`,
        householdConsumed: 0n,
      };
    }

    case 'INSOLVENCY':
      crisis.insolvent = true;
      return { applied: true, raised: 0n, note: 'Business is insolvent.', householdConsumed: 0n };
  }
}

export interface InsolvencyResult {
  proceeds: Money;
  deficiencyAttachedToHousehold: Money;
  events: EngineEvent[];
}

/**
 * Insolvency is not game over. The business enters CLOSED; remaining businesses
 * continue unaffected unless cross-guaranteed. Any deficiency on personally
 * guaranteed debt attaches to the household and impairs credit — the real trap
 * of small-business lending, and it should not be softened.
 */
export function liquidate(
  business: Business,
  household: Household,
  period: PeriodIndex,
  nextId: () => string,
): InsolvencyResult {
  const assetProceeds = sum(
    business.assets.map((a) => mulRate(netBookValue(a), LIQUIDATION_HAIRCUTS[a.category])),
  );
  const inventoryProceeds = mulRate(business.balances.inventory, LIQUIDATION_HAIRCUTS.INVENTORY);
  const receivableProceeds = mulRate(business.balances.accountsReceivable, 0.7);
  const proceeds =
    assetProceeds + inventoryProceeds + receivableProceeds + (business.cash > 0n ? business.cash : 0n);

  // Secured creditors first, then unsecured.
  let remaining = proceeds;
  const secured = business.debts.filter(
    (d) => d.kind === 'EQUIPMENT_FINANCE' || d.kind === 'INTEREST_ONLY',
  );
  const unsecured = business.debts.filter((d) => !secured.includes(d));

  let deficiency = 0n;
  for (const debt of [...secured, ...unsecured]) {
    const paid = remaining < debt.outstandingPrincipal ? remaining : debt.outstandingPrincipal;
    remaining -= paid;
    const shortfall = debt.outstandingPrincipal - paid;
    debt.outstandingPrincipal = 0n;
    if (shortfall > 0n && debt.personalGuarantee) {
      deficiency += shortfall;
      household.personalDebts.push({
        ...debt,
        id: nextId(),
        label: `${debt.label} (guaranteed deficiency)`,
        originalPrincipal: shortfall,
        outstandingPrincipal: shortfall,
        attachedFromBusinessId: business.id,
      });
    }
  }

  if (deficiency > 0n) {
    household.creditQuality = 'IMPAIRED';
    household.creditImpairedUntilPeriod = period + 8;
  }

  business.status = 'CLOSED';
  business.cash = 0n;
  business.assets = [];
  business.streams = [];
  business.balances = {
    ...business.balances,
    accountsReceivable: 0n,
    inventory: 0n,
    prepaidExpenses: 0n,
    retainageReceivable: 0n,
    accountsPayable: 0n,
    accruedLiabilities: 0n,
    deferredRevenue: 0n,
    deferredOwnerComp: 0n,
  };

  return {
    proceeds,
    deficiencyAttachedToHousehold: deficiency,
    events: [
      {
        period,
        businessId: business.id,
        kind: 'INSOLVENCY',
        severity: 'CRITICAL',
        detail: {
          liquidationProceeds: Number(proceeds) / 100,
          guaranteedDeficiency: Number(deficiency) / 100,
        },
      },
    ],
  };
}

/**
 * Repayment rule for deferred owner compensation.
 *
 * Spec §9.4 says the deferral "accrues as a liability, does not vanish" and
 * then never says when it is paid. Left unspecified the balance grows
 * monotonically forever while the founder, in the fiction, goes unpaid
 * indefinitely. Repay from operating cash once the business can cover a
 * quarter's living expenses plus a one-quarter operating buffer.
 * See docs/plan/03-spec-gaps.md G-8.
 */
export function repayDeferredOwnerComp(
  business: Business,
  availableCash: Money,
  buffer: Money,
): Money {
  const owed = business.balances.deferredOwnerComp;
  if (owed <= 0n) return 0n;
  const spare = availableCash - buffer;
  if (spare <= 0n) return 0n;
  return spare < owed ? spare : owed;
}
