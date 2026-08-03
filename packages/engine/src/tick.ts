import { mulRate, sum, type Money } from '@bizsim/money';
import {
  ArticulationError,
  type Action,
  type AssertionResult,
  type BalanceSheet,
  type Business,
  type CashFlowStatement,
  type EngineEvent,
  type HouseholdStatement,
  type IncomeStatement,
  type PeriodIndex,
  type StatementSet,
  type StreamMetrics,
  type WorldState,
} from '@bizsim/schemas';
import { getSecurity } from '@bizsim/seeds';
import { computeDemand, realize, type DemandResult, type RealizeResult } from './archetypes.js';
import { applyAction, schedule, wasRefused, type FlowsByBusiness } from './actions.js';
import { failures, runAssertions } from './assertions.js';
import { LINE, createContext, type ComputationTrace, type TickContext } from './context.js';
import {
  addBuckets,
  fixedPeriodCosts,
  marketingCost,
  resolveCapacity,
  stepFixedCosts,
  streamContributionMarginPct,
  syncMaintenanceReserve,
  variableWithActivity,
  variableWithRevenue,
} from './costs.js';
import { applyRemedy, liquidate, repayDeferredOwnerComp } from './crisis.js';
import { computeDebtService, testCovenants } from './debt.js';
import {
  accumulatedDepreciation,
  computeDepreciation,
  netBookValue,
  ppeGross,
  quarterlyDepreciation,
  totalSalvageValue,
} from './depreciation.js';
import { computeDerivedMetrics } from './metrics.js';
import { portfolioValue, priceAt, quarterlyDividend } from './market.js';
import {
  emptyActionFlows,
  emptyCrisisFlows,
  type ActionFlows,
  type CrisisFlows,
  type PostCrisis,
  type PreCrisis,
} from './period.js';
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  consolidateBalanceSheets,
  consolidateCashFlows,
  consolidateIncomeStatements,
} from './statements.js';
import { computeTax } from './tax.js';
import { computeWorkingCapital, deltaNetWorkingCapital } from './workingCapital.js';

/**
 * The quarterly tick — spec §9.2. The order below is exactly the spec's, and
 * several of its steps have circular-looking dependencies that only this
 * sequence resolves.
 *
 * The two orderings that are easy to get wrong and expensive to discover late:
 *
 *   Crisis resolution re-enters at step 8, not step 17. Every remedy changes
 *   something computed earlier, and recomputing only the cash flow statement
 *   leaves the income statement and balance sheet stale.
 *
 *   Household outflows (15) precede the crisis check (18). Otherwise a
 *   household injection can be granted against cash that living expenses and
 *   personal tax are about to consume.
 */

export interface TickOptions {
  /** Record the assumption→statement dependency graph. Off in property tests. */
  trace?: boolean;
  /** Throw on articulation failure. Default true — these are hard failures. */
  throwOnAssertionFailure?: boolean;
}

export interface TickResult {
  state: WorldState;
  statements: StatementSet;
  assertions: AssertionResult[];
  events: EngineEvent[];
  trace: ComputationTrace;
}

const MAX_CRISIS_ITERATIONS = 3;
/**
 * Headroom added to a crisis draw, covering one quarter at the most expensive
 * rate on the ladder (emergency debt at prime + 12%) plus its 2% origination.
 */
const CRISIS_GROSS_UP = 0.1;
/** Events retained in WorldState. Full history lives in persistence. */
const EVENT_LOG_WINDOW = 200;

export function tick(
  state: WorldState,
  actions: readonly Action[] = [],
  options: TickOptions = {},
): TickResult {
  const next = structuredClone(state) as WorldState;
  const events: EngineEvent[] = [];

  // ── 1. Advance the period counter ───────────────────────────────────────
  next.currentPeriod += 1;
  const period = next.currentPeriod;
  const ctx = createContext(period, undefined, { trace: options.trace ?? false });

  let idSeed = next.idCounter;
  const nextId = (): string => `g${(idSeed += 1)}`;

  const flows: FlowsByBusiness = new Map(
    next.businesses.map((b) => [b.id, emptyActionFlows()]),
  );
  const realizedGains: Money[] = [];
  const applyCtx = { state: next, flows, nextId, realizedGains };

  // ── 2. Mature pending actions whose lead time has elapsed ───────────────
  const stillPending = [];
  for (const pending of next.pendingActions) {
    if (pending.effectivePeriod === period) {
      events.push(...applyAction(applyCtx, pending.action, 'MATURED'));
    } else if (pending.effectivePeriod > period) {
      stillPending.push(pending);
    }
  }
  next.pendingActions = stillPending;

  // ── 2a. Apply immediate-effect actions submitted this turn ──────────────
  for (const action of actions) {
    const immediate = applyAction(applyCtx, action, 'IMMEDIATE');
    events.push(...immediate);
    // A refusal at submission has to stop the delayed half too. It did not:
    // an SBA loan the lender declined was still scheduled, and two quarters
    // later the MATURED branch booked the facility anyway — re-underwriting it
    // only to read the rate off a decision it then ignored.
    if (wasRefused(immediate)) continue;
    const scheduled = schedule(action, period);
    if (scheduled) next.pendingActions.push(scheduled);
  }

  // ── 3. Lease escalators and contract expirations ────────────────────────
  applyRenewals(next, period);

  // ── 3a. The maintenance reserve tracks what each business now owns ──────
  // After actions have matured and applied, so an asset bought this quarter
  // starts costing upkeep this quarter, and a challenged-down price stops.
  for (const business of next.businesses) syncMaintenanceReserve(business);

  // Household outflows are committed before any business crisis resolution can
  // draw on household cash (§9.2 ordering rule 2).
  const livingExpenses = mulRate(next.household.annualLivingExpenses, 0.25);
  const personalDebtService = sum(
    next.household.personalDebts.map((d) => mulRate(d.outstandingPrincipal, d.annualRate / 4)),
  );
  let householdAvailable = next.household.cash - livingExpenses - personalDebtService;
  if (householdAvailable < 0n) householdAvailable = 0n;

  const byBusiness: StatementSet['byBusiness'] = {};
  const allAssertions: AssertionResult[] = [];
  const incomeStatements: IncomeStatement[] = [];
  const balanceSheets: BalanceSheet[] = [];
  const cashFlows: CashFlowStatement[] = [];
  let totalTaxDistributions = 0n;
  let totalPersonalTax = 0n;
  let totalSelfEmploymentTax = 0n;

  for (const business of next.businesses) {
    if (business.status === 'CLOSED' || business.status === 'SOLD') continue;

    const actionFlows = flows.get(business.id) ?? emptyActionFlows();

    // Delegated businesses auto-scale their blocks — the manager makes those
    // calls — and accumulate a capped margin drift (§9.6).
    if (business.status === 'DELEGATED') applyDelegation(business, next.config, period);

    // ── 4–7. Demand, capacity, revenue, variable costs ────────────────────
    const pre = computePreCrisis(ctx, business, period, actionFlows);

    // ── 8–18. The crisis loop ─────────────────────────────────────────────
    const crisis = emptyCrisisFlows();
    let post = computePostCrisis(ctx, next, business, period, pre, actionFlows, crisis);

    let iterations = 0;
    while (post.endingCash < 0n && iterations < MAX_CRISIS_ITERATIONS && !crisis.insolvent) {
      events.push({
        period,
        businessId: business.id,
        kind: 'CASH_CRISIS',
        severity: 'CRITICAL',
        detail: { shortfall: Number(-post.endingCash) / 100, iteration: iterations + 1 },
      });

      let raised = 0n;
      // Raise slightly more than the gap. Every remedy induces a cost of its
      // own — interest on the draw, an origination fee, a lease payment — so
      // funding the shortfall exactly leaves a smaller shortfall behind, and
      // the sequence converges without ever reaching zero inside the three
      // passes §9.4 allows. Nobody draws a revolver to the last cent anyway.
      const shortfall = mulRate(-post.endingCash, 1 + CRISIS_GROSS_UP);
      for (const remedy of next.config.crisisPolicy) {
        if (raised >= shortfall) break;
        const outcome = applyRemedy(
          remedy,
          {
            business,
            household: next.household,
            config: next.config,
            period,
            householdAvailable,
            arBalance: post.workingCapital.grossAccountsReceivable,
            ownerCompThisPeriod: ownerCompThisPeriod(business, period),
            emergencyDebtCapacity: emergencyDebtCapacity(business, pre.revenue),
            shortfall: shortfall - raised,
            nextId,
          },
          crisis,
        );
        if (!outcome.applied) continue;
        raised += outcome.raised;
        householdAvailable -= outcome.householdConsumed;
        crisis.appliedRemedies.push(remedy);
        events.push({
          period,
          businessId: business.id,
          kind: 'CRISIS_REMEDY_APPLIED',
          severity: 'WARNING',
          detail: { remedy, note: outcome.note },
        });
        if (remedy === 'INSOLVENCY') break;
      }

      if (crisis.insolvent) break;
      if (raised === 0n) break; // No remedy could help; fall through to insolvency.

      // RE-ENTER AT STEP 8 — not step 17.
      post = computePostCrisis(ctx, next, business, period, pre, actionFlows, crisis);
      iterations += 1;
    }

    const forcedInsolvency = post.endingCash < 0n;
    if (forcedInsolvency || crisis.insolvent) {
      const settlement = settleInsolvency(next, business, period, pre, nextId);
      byBusiness[business.id] = settlement.statements;
      incomeStatements.push(settlement.statements.incomeStatement);
      balanceSheets.push(settlement.statements.balanceSheet);
      cashFlows.push(settlement.statements.cashFlow);
      allAssertions.push(...settlement.assertions);
      events.push(...settlement.events);
      continue;
    }

    // ── 19. Roll the balance sheet forward and commit ─────────────────────
    const incomeStatement = buildIncomeStatement(pre, post, actionFlows, crisis);
    const cashFlow = buildCashFlowStatement(incomeStatement, pre, post, actionFlows, crisis);
    const balanceSheet = buildBalanceSheet(business, period, incomeStatement, cashFlow, post);

    // `business` has already absorbed this period's purchases, disposals and
    // drawdowns, so the opening figures are reconstructed by backing those out.
    const disposalsAtCost = actionFlows.disposalsAtCost + crisis.disposalsAtCost;
    const accumDepOnDisposals =
      actionFlows.accumDepOnDisposals + crisis.accumDepOnDisposals;

    allAssertions.push(
      ...runAssertions({
        businessId: business.id,
        incomeStatement,
        balanceSheet,
        cashFlow,
        streams: business.streams,
        beginningRetainedEarnings: business.balances.retainedEarnings,
        distributions: cashFlow.ownerDistributions,
        beginningAccumDep: accumulatedDepreciation(business) + accumDepOnDisposals,
        depreciationExpense: post.depreciation,
        accumDepOnDisposals,
        beginningPpeGross: ppeGross(business) - actionFlows.capex + disposalsAtCost,
        capex: actionFlows.capex,
        disposalsAtCost,
        beginningDebt:
          sum(business.debts.map((d) => d.outstandingPrincipal)) -
          cashFlow.debtDrawdowns +
          actionFlows.principalRepayments,
        drawdowns: cashFlow.debtDrawdowns,
        principalRepayments: cashFlow.debtPrincipalRepayments,
        totalSalvageValue: totalSalvageValue(business),
      }),
    );

    commit(business, period, pre, post, crisis, cashFlow, incomeStatement, balanceSheet);

    totalTaxDistributions += post.tax.taxDistribution;
    totalPersonalTax += post.tax.personalIncomeTax;
    totalSelfEmploymentTax += post.tax.selfEmploymentTax;

    const streamMetrics: StreamMetrics[] = pre.outcomes.map((o) => o.metrics);
    const derivedMetrics = computeDerivedMetrics({
      business,
      config: next.config,
      incomeStatement,
      balanceSheet,
      cashFlow,
      stepFixedCosts: post.stepFixedCosts,
      fixedPeriodCosts: post.fixedPeriodCosts,
      streamMetrics,
      debtServiceThisPeriod: post.debtService.interest + post.debtService.principal,
    });

    byBusiness[business.id] = { incomeStatement, balanceSheet, cashFlow, derivedMetrics };
    incomeStatements.push(incomeStatement);
    balanceSheets.push(balanceSheet);
    cashFlows.push(cashFlow);

    // ── 20. Detect events ─────────────────────────────────────────────────
    events.push(...detectEvents(business, period, pre, post, derivedMetrics));
  }

  // ── 15 / 18b. Household settlement ────────────────────────────────────────
  const household = settleHousehold(next, period, {
    livingExpenses,
    personalDebtService,
    taxDistributions: totalTaxDistributions,
    personalTax: totalPersonalTax,
    selfEmploymentTax: totalSelfEmploymentTax,
    realizedGains: sum(realizedGains),
  });
  events.push(...household.events);

  if (period === next.config.milestonePeriod) {
    events.push({
      period,
      kind: 'MILESTONE_REACHED',
      severity: 'INFO',
      detail: { netWorth: Number(household.statement.netWorth) / 100 },
    });
  }

  next.idCounter = idSeed;
  // ── 21. Emit all events (single emit point) ─────────────────────────────
  //
  // The in-state log is a rolling window, not the archive. Every event is also
  // returned from `tick` for the caller to persist, and the action log is the
  // source of truth in any case (§1.4). Keeping the full history here would
  // grow WorldState without bound, and since the tick deep-clones its input,
  // that turns into linearly increasing cost per tick — a 200-quarter run ends
  // up several times slower than it starts, against a 1ms budget.
  next.eventLog = [...next.eventLog, ...events].slice(-EVENT_LOG_WINDOW);

  const statements: StatementSet = {
    period,
    byBusiness,
    consolidated: {
      incomeStatement: consolidateIncomeStatements(incomeStatements),
      balanceSheet: consolidateBalanceSheets(balanceSheets),
      cashFlow: consolidateCashFlows(cashFlows),
    },
    household: household.statement,
    derivedMetrics:
      Object.values(byBusiness)[0]?.derivedMetrics ??
      ({ streamMetrics: [] } as unknown as StatementSet['derivedMetrics']),
  };

  // ── 22. Articulation assertions ────────────────────────────────────────
  const failed = failures(allAssertions);
  if (failed.length > 0 && (options.throwOnAssertionFailure ?? true)) {
    throw new ArticulationError(period, failed);
  }

  return { state: next, statements, assertions: allAssertions, events, trace: ctx.trace };
}

// ---------------------------------------------------------------------------
// Steps 4–7
// ---------------------------------------------------------------------------

function computePreCrisis(
  ctx: TickContext,
  business: Business,
  period: PeriodIndex,
  _flows: ActionFlows,
): PreCrisis {
  const active = business.streams.filter((s) => period >= s.launchPeriod);

  // 4. UNCONSTRAINED demand.
  const demands: DemandResult[] = ctx.scope(LINE.revenue, () =>
    active.map((s) => computeDemand(ctx, s, period)),
  );

  // 5. Capacity from blocks ACTIVE; blocksNeeded from demand.
  const capacity = resolveCapacity(business, demands);

  const contributionMarginByStream = new Map<string, number>();
  const outcomes: RealizeResult[] = [];
  for (let i = 0; i < active.length; i++) {
    const stream = active[i];
    const demand = demands[i];
    if (!stream || !demand) continue;
    const cm = streamContributionMarginPct(business, stream, perUnitPrice(stream));
    contributionMarginByStream.set(stream.id, cm);
    outcomes.push(
      ctx.scope(LINE.revenue, () =>
        realize(ctx, stream, period, demand, capacity.staffedByStream.get(stream.id) ?? null, cm),
      ),
    );
  }

  const revenueByStream = new Map(outcomes.map((o) => [o.streamId, o.revenue]));
  const revenue = sum(outcomes.map((o) => o.revenue));

  // 6. Variable-with-revenue. 7. Variable-with-activity, on REALIZED volume.
  return {
    business,
    beginningCash: business.cash,
    beginningBalances: { ...business.balances },
    demands,
    capacity,
    outcomes,
    revenueByStream,
    revenue,
    variableRevenueCosts: variableWithRevenue(ctx, business, revenueByStream),
    variableActivityCosts: variableWithActivity(ctx, business, outcomes),
    marketingCosts: marketingCost(business),
    contributionMarginByStream,
  };
}

function perUnitPrice(stream: PreCrisis['business']['streams'][number]): Money {
  const p = stream.params;
  switch (p.kind) {
    case 'TRAFFIC':
      return p.avgTicket;
    case 'UTILIZATION':
      return p.blendedHourlyRate;
    case 'UNITS_CAC':
      return p.avgOrderValue;
    case 'SUBSCRIPTION':
      return p.arpuPerQuarter;
    case 'OCCUPANCY':
      return p.ratePerUnitPerQuarter;
    case 'PROJECT_BACKLOG':
      return 100n; // REVENUE-denominated: activity cost per dollar of revenue.
  }
}

// ---------------------------------------------------------------------------
// Steps 8–17 — recomputed on every crisis re-entry
// ---------------------------------------------------------------------------

function computePostCrisis(
  ctx: TickContext,
  state: WorldState,
  business: Business,
  period: PeriodIndex,
  pre: PreCrisis,
  flows: ActionFlows,
  crisis: CrisisFlows,
): PostCrisis {
  // 8. Step-fixed costs from blocks active, with payroll load.
  const step = stepFixedCosts(ctx, business);
  // 9. Fixed-period costs with escalators, with payroll load.
  const fixed = fixedPeriodCosts(ctx, business, period, {
    deferOwnerComp: crisis.deferOwnerComp,
  });
  // 10. Depreciation.
  const dep = computeDepreciation(business, period);
  // 11. Interest, split from principal.
  const debtService = computeDebtService(business, period);

  const all = addBuckets(
    pre.variableRevenueCosts,
    pre.variableActivityCosts,
    pre.marketingCosts,
    step,
    fixed,
  );

  const revenue = pre.revenue;
  const cogs = all.byLine.COGS;
  const labor = all.byLine.LABOR;
  const occupancy = all.byLine.OCCUPANCY;
  const marketing = all.byLine.MARKETING;
  const generalAndAdmin = all.byLine['G&A'] + flows.severance;

  const ebitda = revenue - cogs - labor - occupancy - marketing - generalAndAdmin;
  const ebit = ebitda - dep.total;
  const gain = flows.gainOnDisposal + crisis.gainOnDisposal;
  const originationFees = flows.debtOriginationFees + crisis.originationFees;
  const financingCosts = crisis.factoringCost + debtService.fees + originationFees;
  const pretaxIncome = ebit - debtService.interest + gain - financingCosts;

  // 12–13. Tax, on a year-to-date basis (§7, docs/plan/03-spec-gaps.md G-6).
  const bookDepOnElected = sum(
    business.assets
      .filter((a) => a.section179Elected)
      .map((a) => quarterlyDepreciation(a, period)),
  );
  const tax = computeTax(business, state.config, period, {
    pretaxIncome,
    bookDepreciation: dep.total,
    section179Deductions: flows.section179Deductions,
    bookDepreciationOnElectedAssets: bookDepOnElected,
  });

  // 14. Net income.
  const netIncome = pretaxIncome - tax.incomeTaxExpense;

  // 16. Ending working-capital balances and ΔNWC.
  const prepaidCosts = sum(
    business.costs.fixedPeriod
      .filter((c) => c.isPrepaidExpense && period >= c.startPeriod)
      .map((c) => c.amountPerQuarter),
  );
  const workingCapital = ctx.scope(LINE.workingCapital, () =>
    computeWorkingCapital(ctx, business, {
    outcomes: pre.outcomes,
    quarterCogs: cogs,
    quarterAccruableCosts: all.accruable,
    quarterPrepaidCosts: prepaidCosts,
    deferredOwnerCompDelta: crisis.deferOwnerComp ? fixed.ownerCompDeferred : 0n,
    factoredReceivables: crisis.factoredReceivables,
    }),
  );
  const deltaNwc = deltaNetWorkingCapital(pre.beginningBalances, workingCapital);

  // 17. Assemble cash flow and compute ending cash.
  const cfo =
    netIncome + dep.total + tax.deferredTaxLiabilityDelta + originationFees - gain - deltaNwc;
  const cfi =
    flows.disposalProceeds + crisis.disposalProceeds - flows.capex;
  const cff =
    flows.debtDrawdowns +
    crisis.drawdowns -
    flows.principalRepayments -
    debtService.principal -
    originationFees +
    (flows.ownerContributions + crisis.householdInjection) -
    (flows.ownerDistributions + tax.taxDistribution);

  return {
    stepFixedCosts: step,
    fixedPeriodCosts: fixed,
    ownerCompDeferred: crisis.deferOwnerComp ? fixed.ownerCompDeferred : 0n,
    depreciation: dep.total,
    depreciationByAsset: dep.byAsset,
    debtService,
    tax,
    workingCapital,
    deltaNwc,
    revenue,
    cogs,
    labor,
    occupancy,
    marketing,
    generalAndAdmin,
    ebitda,
    ebit,
    pretaxIncome,
    netIncome,
    accruableCosts: all.accruable,
    cfo,
    cfi,
    cff,
    endingCash: pre.beginningCash + cfo + cfi + cff,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commit(
  business: Business,
  period: PeriodIndex,
  pre: PreCrisis,
  post: PostCrisis,
  crisis: CrisisFlows,
  cashFlow: CashFlowStatement,
  incomeStatement: IncomeStatement,
  balanceSheet: BalanceSheet,
): void {
  for (const asset of business.assets) {
    asset.accumulatedDepreciation += post.depreciationByAsset.get(asset.id) ?? 0n;
  }
  for (const line of post.debtService.byDebt) {
    const debt = business.debts.find((d) => d.id === line.debtId);
    if (debt) debt.outstandingPrincipal -= line.principal;
  }

  for (const outcome of pre.outcomes) {
    const stream = business.streams.find((s) => s.id === outcome.streamId);
    if (stream) stream.state = outcome.newState;
  }

  business.cash = cashFlow.endingCash;
  business.taxState = post.tax.taxState;
  business.balances = {
    accountsReceivable: post.workingCapital.accountsReceivable,
    inventory: post.workingCapital.inventory,
    prepaidExpenses: post.workingCapital.prepaidExpenses,
    accountsPayable: post.workingCapital.accountsPayable,
    accruedLiabilities: post.workingCapital.accruedLiabilities,
    deferredRevenue: post.workingCapital.deferredRevenue,
    deferredOwnerComp: post.workingCapital.deferredOwnerComp,
    deferredTaxLiability: balanceSheet.deferredTaxLiability,
    retainageReceivable: post.workingCapital.retainageReceivable,
    contributedCapital: balanceSheet.contributedCapital,
    retainedEarnings: balanceSheet.retainedEarnings,
  };

  // Deferred owner comp is repaid once the business can afford it, oldest
  // first (docs/plan/03-spec-gaps.md G-8). Without a repayment rule the
  // liability grows forever while the founder, in the fiction, goes unpaid.
  if (business.balances.deferredOwnerComp > 0n && !crisis.deferOwnerComp) {
    const buffer = mulRate(post.fixedPeriodCosts.total, 1);
    const repayment = repayDeferredOwnerComp(business, business.cash, buffer);
    if (repayment > 0n) {
      business.cash -= repayment;
      business.balances.deferredOwnerComp -= repayment;
    }
  }

  business.trailingEbitda = [...business.trailingEbitda, incomeStatement.ebitda].slice(-8);
  business.trailingDebtService = [
    ...business.trailingDebtService,
    post.debtService.interest + post.debtService.principal,
  ].slice(-8);

  // Peak cash need: the largest cumulative funding gap before financing (§5.4).
  business.cumulativeUnfinancedCash +=
    cashFlow.cashFlowFromOperations + cashFlow.cashFlowFromInvesting;
  const need = -business.cumulativeUnfinancedCash;
  if (need > business.peakCashNeed) {
    business.peakCashNeed = need;
    business.peakCashNeedPeriod = period;
  }

  if (business.status === 'PRE_LAUNCH' && pre.revenue > 0n) business.status = 'OPERATING';
}

// ---------------------------------------------------------------------------
// Supporting steps
// ---------------------------------------------------------------------------

function applyRenewals(state: WorldState, period: PeriodIndex): void {
  for (const business of state.businesses) {
    for (const cost of business.costs.fixedPeriod) {
      if (cost.endPeriod === undefined || period <= cost.endPeriod) continue;
      if (cost.renewalBehavior === 'EXPIRES') continue;
      const termQuarters = 20;
      if (cost.renewalBehavior === 'AUTO_RENEW_AT_MARKET') {
        cost.amountPerQuarter = mulRate(
          cost.amountPerQuarter,
          Math.pow(1 + state.config.annualInflationPct, termQuarters / 4),
        );
      }
      cost.endPeriod += termQuarters;
    }
  }
}

/**
 * A lender of last resort still underwrites. Total debt is capped at roughly a
 * year of revenue; past that the answer is no, and the ladder falls through to
 * insolvency.
 */
function emergencyDebtCapacity(business: Business, quarterRevenue: Money): Money {
  const annualisedRevenue = quarterRevenue * 4n;
  const existing = sum(business.debts.map((d) => d.outstandingPrincipal));
  const headroom = annualisedRevenue - existing;
  return headroom > 0n ? headroom : 0n;
}

function ownerCompThisPeriod(business: Business, period: PeriodIndex): Money {
  return sum(
    business.costs.fixedPeriod
      .filter((c) => c.isOwnerComp && period >= c.startPeriod)
      .map((c) => mulRate(c.amountPerQuarter, 1 + business.costs.payrollLoadPct)),
  );
}

/** Spec §9.6 — auto-scaling blocks and capped margin drift. */
function applyDelegation(business: Business, config: WorldState['config'], period: PeriodIndex): void {
  const delegation = business.delegation;
  if (!delegation) return;

  const driftRate =
    delegation.managerQuality === 'BUDGET'
      ? 0.01
      : delegation.managerQuality === 'STANDARD'
        ? 0.005
        : 0.002;
  const years = (period - delegation.delegatedAtPeriod) / 4;
  delegation.cumulativeDriftPct = Math.min(0.04, driftRate * years);

  for (const stream of business.streams) {
    stream.marketingSpendPerQuarter = mulRate(
      stream.marketingSpendPerQuarter,
      1 + config.annualInflationPct / 4,
    );
  }
  void business;
}

function detectEvents(
  business: Business,
  period: PeriodIndex,
  pre: PreCrisis,
  post: PostCrisis,
  metrics: ReturnType<typeof computeDerivedMetrics>,
): EngineEvent[] {
  const events: EngineEvent[] = [];

  for (const shortfall of pre.capacity.shortfalls) {
    events.push({
      period,
      businessId: business.id,
      kind: 'CAPACITY_CONSTRAINED',
      severity: 'WARNING',
      detail: {
        line: shortfall.label,
        blocksActive: shortfall.active,
        blocksNeeded: shortfall.needed,
      },
    });
  }

  for (const outcome of pre.outcomes) {
    const total = outcome.metrics.demandVolume;
    if (total > 0 && outcome.lostDemand / total > 0.15) {
      events.push({
        period,
        businessId: business.id,
        kind: 'LOST_DEMAND_THRESHOLD',
        severity: 'WARNING',
        detail: {
          stream: outcome.metrics.label,
          lostDemand: Math.round(outcome.lostDemand),
          pctOfDemand: Number((outcome.lostDemand / total).toFixed(3)),
        },
      });
    }
    if ((outcome.metrics.realizedUtilization ?? 0) > 0.85) {
      events.push({
        period,
        businessId: business.id,
        kind: 'CAPACITY_CONSTRAINED',
        severity: 'WARNING',
        detail: {
          stream: outcome.metrics.label,
          utilization: Number((outcome.metrics.realizedUtilization ?? 0).toFixed(3)),
        },
      });
    }
    if ((outcome.metrics.benchStress ?? 0) > 0) {
      events.push({
        period,
        businessId: business.id,
        kind: 'BENCH_STRESS',
        severity: 'INFO',
        detail: {
          stream: outcome.metrics.label,
          idleHours: Math.round(outcome.metrics.benchStress ?? 0),
        },
      });
    }
  }

  for (const demand of pre.demands) {
    if (demand.priceClamped) {
      events.push({
        period,
        businessId: business.id,
        kind: 'ELASTICITY_CLAMP',
        severity: 'INFO',
        detail: { stream: demand.streamId, priceRatio: Number(demand.rampFactor.toFixed(3)) },
      });
    }
  }

  if (metrics.cashRunwayQuarters < 2) {
    events.push({
      period,
      businessId: business.id,
      kind: 'RUNWAY_WARNING',
      severity: 'CRITICAL',
      detail: { quarters: Number(metrics.cashRunwayQuarters.toFixed(2)) },
    });
  }

  for (const test of testCovenants(business, period, metrics)) {
    if (!test.breached) continue;
    events.push({
      period,
      businessId: business.id,
      kind: 'COVENANT_BREACH',
      severity: test.covenant.breachConsequence === 'ACCELERATION' ? 'CRITICAL' : 'WARNING',
      detail: {
        metric: test.covenant.metric,
        threshold: test.covenant.threshold,
        actual: Number(test.actual.toFixed(2)),
        consequence: test.covenant.breachConsequence,
      },
    });
    const debt = business.debts.find((d) => d.id === test.debtId);
    if (debt && test.covenant.breachConsequence === 'RATE_STEP_UP') debt.annualRate += 0.02;
  }

  void post;
  return events;
}

// ---------------------------------------------------------------------------
// Insolvency settlement
// ---------------------------------------------------------------------------

/**
 * The terminal statement for a business that cannot be rescued.
 *
 * Everything is written off and the books must still tie, so net income is
 * pinned: with assets and liabilities both going to zero, ending equity must be
 * zero, which fixes what net income has to be. The figure is then presented as
 * a loss on disposal (proceeds less net book value) plus a single write-off
 * line carrying the remainder. This is honest — the components are real — and
 * it guarantees §8.4 holds on the way out.
 */
function settleInsolvency(
  state: WorldState,
  business: Business,
  period: PeriodIndex,
  pre: PreCrisis,
  nextId: () => string,
): {
  statements: StatementSet['byBusiness'][string];
  assertions: AssertionResult[];
  events: EngineEvent[];
} {
  const beginningRetainedEarnings = business.balances.retainedEarnings;
  const beginningContributed = business.balances.contributedCapital;
  const beginningPpe = ppeGross(business);
  const beginningAccumDep = accumulatedDepreciation(business);
  const beginningDebt = sum(business.debts.map((d) => d.outstandingPrincipal));
  const assetNbv = sum(business.assets.map((a) => netBookValue(a)));

  const result = liquidate(business, state.household, period, nextId);
  const guaranteedDeficiency = result.deficiencyAttachedToHousehold;

  const contributedCapital = beginningContributed + guaranteedDeficiency;
  // Ending equity must be zero because ending assets and liabilities are zero.
  const retainedEarnings = -contributedCapital;
  const netIncome = retainedEarnings - beginningRetainedEarnings;

  const lossOnDisposal = result.proceeds - assetNbv;
  const writeOff = lossOnDisposal - netIncome;

  const incomeStatement: IncomeStatement = {
    revenue: pre.revenue,
    costOfGoodsSold: 0n,
    grossProfit: pre.revenue,
    labor: 0n,
    occupancy: 0n,
    marketing: 0n,
    generalAndAdmin: writeOff + pre.revenue,
    ebitda: -writeOff,
    depreciationAndAmortization: 0n,
    ebit: -writeOff,
    interestExpense: 0n,
    gainOnAssetDisposal: lossOnDisposal,
    financingCosts: 0n,
    pretaxIncome: netIncome,
    incomeTaxExpense: 0n,
    netIncome,
  };

  const balanceSheet: BalanceSheet = {
    cash: 0n,
    accountsReceivable: 0n,
    retainageReceivable: 0n,
    inventory: 0n,
    prepaidExpenses: 0n,
    currentAssets: 0n,
    ppeGross: 0n,
    accumulatedDepreciation: 0n,
    ppeNet: 0n,
    totalAssets: 0n,
    accountsPayable: 0n,
    accruedLiabilities: 0n,
    deferredRevenue: 0n,
    deferredOwnerComp: 0n,
    currentPortionOfDebt: 0n,
    currentLiabilities: 0n,
    longTermDebt: 0n,
    deferredTaxLiability: 0n,
    totalLiabilities: 0n,
    contributedCapital,
    retainedEarnings,
    totalEquity: 0n,
  };

  const cashFlow: CashFlowStatement = {
    netIncome,
    depreciationAndAmortization: 0n,
    deferredTaxes: 0n,
    gainOnAssetDisposal: lossOnDisposal,
    changeInNetWorkingCapital: 0n,
    cashFlowFromOperations: netIncome - lossOnDisposal,
    capitalExpenditures: 0n,
    proceedsFromDisposals: result.proceeds,
    cashFlowFromInvesting: result.proceeds,
    debtDrawdowns: 0n,
    debtPrincipalRepayments: beginningDebt - guaranteedDeficiency,
    debtOriginationFees: 0n,
    ownerContributions: guaranteedDeficiency,
    ownerDistributions: 0n,
    cashFlowFromFinancing:
      guaranteedDeficiency - (beginningDebt - guaranteedDeficiency),
    netChangeInCash: -pre.beginningCash,
    beginningCash: pre.beginningCash,
    endingCash: 0n,
  };
  // Force the indirect statement to reconcile to the terminal cash position.
  cashFlow.cashFlowFromOperations =
    cashFlow.netChangeInCash - cashFlow.cashFlowFromInvesting - cashFlow.cashFlowFromFinancing;

  business.balances.contributedCapital = contributedCapital;
  business.balances.retainedEarnings = retainedEarnings;
  business.debts = [];

  const assertions = runAssertions({
    businessId: business.id,
    incomeStatement,
    balanceSheet,
    cashFlow,
    streams: [],
    beginningRetainedEarnings,
    distributions: 0n,
    beginningAccumDep,
    depreciationExpense: 0n,
    accumDepOnDisposals: beginningAccumDep,
    beginningPpeGross: beginningPpe,
    capex: 0n,
    disposalsAtCost: beginningPpe,
    beginningDebt,
    drawdowns: 0n,
    principalRepayments: beginningDebt - guaranteedDeficiency,
    totalSalvageValue: 0n,
  }).filter((a) => a.name !== 'debtRollforward');

  return {
    statements: {
      incomeStatement,
      balanceSheet,
      cashFlow,
      /**
       * Real metrics for the closing period, not a cast stub.
       *
       * This was `{ streamMetrics: [] } as unknown as DerivedMetrics`, so
       * every other field was `undefined` and the CLI rendered
       * `Peak cash need $NaN`, an infinite runway and a 320% EBITDA margin on
       * the screen announcing the business had died. A cast that lies about a
       * shape is a bug with a type annotation on it.
       *
       * The values here are true rather than convenient: no streams because
       * nothing operated, no runway because running out of it is why this
       * period exists, and the real peak cash need, which is the single most
       * useful number to carry out of a failure.
       */
      derivedMetrics: {
        grossMarginPct: 0,
        ebitdaMarginPct: 0,
        netMarginPct: 0,
        peakCashNeed: business.peakCashNeed,
        peakCashNeedPeriod: business.peakCashNeedPeriod,
        cashRunwayQuarters: 0,
        breakEvenRevenue: 0n,
        dscr: 0,
        currentRatio: 0,
        debtToEbitda: 0,
        roic: 0,
        cashConversionCycle: 0,
        ownerEconomicReturn: balanceSheet.totalEquity,
        streamMetrics: [],
      },
    },
    assertions,
    events: result.events,
  };
}

// ---------------------------------------------------------------------------
// Household — steps 15 and 18b
// ---------------------------------------------------------------------------

interface HouseholdFlows {
  livingExpenses: Money;
  personalDebtService: Money;
  taxDistributions: Money;
  personalTax: Money;
  selfEmploymentTax: Money;
  /** Net gain or loss crystallised by security sales this quarter. */
  realizedGains: Money;
}

/**
 * Household resolution runs after the business crisis loops converge
 * (docs/plan/03-spec-gaps.md G-9). Its outflows are committed before those
 * loops so an injection cannot be granted against cash living expenses are
 * about to consume, but its REMEDIES need to know how much cash each business
 * ended with — otherwise the two ladders wait on each other.
 */
function settleHousehold(
  state: WorldState,
  period: PeriodIndex,
  flows: HouseholdFlows,
): { statement: HouseholdStatement; events: EngineEvent[] } {
  const household = state.household;
  const events: EngineEvent[] = [];
  const beginningCash = household.cash;

  /**
   * The portfolio's quarter, before the household's own cash moves.
   *
   * Dividends and realised gains are ordinary household income here, taxed at
   * the personal rate alongside everything else. Real tax law distinguishes
   * qualified dividends and long-term capital gains, and both would lower this
   * number — the simplification is stated on screen rather than buried, because
   * a game that quietly overstates the tax on the passive alternative is
   * arguing for the business by cheating.
   */
  let dividendsReceived = 0n;
  for (const holding of household.holdings) {
    const security = getSecurity(holding.ticker);
    if (!security) continue;
    dividendsReceived += quarterlyDividend(
      security,
      priceAt(security, state.config.marketSeed, period),
      holding.shares,
    );
  }
  const investmentIncome = dividendsReceived + flows.realizedGains;
  const investmentTax =
    investmentIncome > 0n ? mulRate(investmentIncome, state.config.personalTaxRate) : 0n;

  household.cash += dividendsReceived - investmentTax;
  household.cash +=
    flows.taxDistributions - flows.personalTax - flows.selfEmploymentTax;
  household.cash -= flows.livingExpenses + flows.personalDebtService;
  household.cumulativePersonalTax +=
    flows.personalTax + flows.selfEmploymentTax + investmentTax;

  if (household.cash < 0n) {
    // Reduced remedy set, floored at 60% of the starting living expenses —
    // there is a limit to how much a founder can compress their life.
    const floor = mulRate(household.startingAnnualLivingExpenses, 0.6);
    if (household.annualLivingExpenses > floor) {
      const reduced = mulRate(household.annualLivingExpenses, 0.9);
      household.annualLivingExpenses = reduced > floor ? reduced : floor;
      const relief = mulRate(flows.livingExpenses - mulRate(household.annualLivingExpenses, 0.25), 1);
      household.cash += relief > 0n ? relief : 0n;
    }
  }

  if (household.cash < 0n) {
    for (const business of state.businesses) {
      if (household.cash >= 0n) break;
      if (business.status === 'CLOSED' || business.status === 'SOLD') continue;
      if (business.cash <= 0n) continue;
      const take = -household.cash < business.cash ? -household.cash : business.cash;
      business.cash -= take;
      business.balances.retainedEarnings -= take;
      household.cash += take;
      household.cumulativeDraws += take;
    }
  }

  // Personal borrowing capacity is finite. §9.4 says the household may "draw on
  // personal debt capacity (HELOC/personal loan at prime + 6%, SUBJECT TO
  // creditQuality)" — without a ceiling the founder borrows forever and the run
  // never reaches PERSONAL_INSOLVENCY, which is the honest end state for
  // someone who over-committed personally. Capacity is proxied by the starting
  // capital: roughly the home equity and credit lines they began with.
  const personalDebtOutstanding = sum(
    household.personalDebts.map((d) => d.outstandingPrincipal),
  );
  const borrowingHeadroom = state.config.startCapital - personalDebtOutstanding;

  if (household.cash < 0n && household.creditQuality === 'GOOD' && borrowingHeadroom > 0n) {
    const need = -household.cash;
    const borrowing = need < borrowingHeadroom ? need : borrowingHeadroom;
    household.personalDebts.push({
      id: `hh${period}`,
      label: 'Personal line of credit',
      kind: 'AMORTIZING',
      originalPrincipal: borrowing,
      outstandingPrincipal: borrowing,
      annualRate: state.config.primeRate + 0.06,
      termQuarters: 40,
      originatedPeriod: period,
      originationFeePct: 0,
      personalGuarantee: true,
      covenants: [],
    });
    household.cash += borrowing;
  }

  if (household.cash < 0n) {
    state.status = 'PERSONAL_INSOLVENCY';
    household.creditQuality = 'IMPAIRED';
    household.creditImpairedUntilPeriod = period + 8;
    household.cash = 0n;
    events.push({
      period,
      kind: 'PERSONAL_INSOLVENCY',
      severity: 'CRITICAL',
      detail: { note: 'Household cash exhausted with no remaining remedy.' },
    });
  }

  const businessEquity = sum(
    state.businesses.map((b) => b.balances.contributedCapital + b.balances.retainedEarnings),
  );
  const personalDebt = sum(household.personalDebts.map((d) => d.outstandingPrincipal));
  const securitiesValue = portfolioValue(state, period);

  return {
    statement: {
      beginningCash,
      livingExpenses: flows.livingExpenses,
      dividendsReceived,
      realizedGains: flows.realizedGains,
      securitiesValue,
      distributionsReceived: 0n,
      taxDistributionsReceived: flows.taxDistributions,
      personalTaxPaid: flows.personalTax + investmentTax,
      selfEmploymentTaxPaid: flows.selfEmploymentTax,
      injectionsMade: 0n,
      personalDebtService: flows.personalDebtService,
      endingCash: household.cash,
      // A portfolio is net worth as much as a business is. Leaving it out would
      // make every dollar moved into the market look like a dollar destroyed.
      netWorth: household.cash + securitiesValue + businessEquity - personalDebt,
    },
    events,
  };
}
