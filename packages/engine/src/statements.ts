import { sum } from '@bizsim/money';
import type {
  BalanceSheet,
  Business,
  CashFlowStatement,
  IncomeStatement,
  PeriodIndex,
} from '@bizsim/schemas';
import { accumulatedDepreciation, ppeGross } from './depreciation.js';
import { currentPortionOfDebt, totalDebt } from './debt.js';
import type { ActionFlows, CrisisFlows, PostCrisis, PreCrisis } from './period.js';

/**
 * Financial statement assembly — spec §8.1–8.3.
 *
 * One note on origination fees. §8.3 lists them as a financing cash outflow and
 * §8.1 has no line for them at all. They cannot simply reduce financing
 * proceeds: cash would leave with nothing on the other side of the entry and
 * the sheet would stop balancing by exactly the fee — which is how a $500
 * discrepancy surfaces a hundred periods into a run, long after the loan that
 * caused it.
 *
 * So they are expensed to `financingCosts` (the line added for §8.4's sake, see
 * docs/plan/03-spec-gaps.md G-7) and then RECLASSIFIED: added back within
 * operating and subtracted within financing, netting to zero on cash. That is
 * the standard treatment for debt issuance costs, it puts the fee in the
 * financing section where §8.3 asks for it, and it ties. Real treatment
 * amortises the fee over the life of the facility; expensing it up front is a
 * documented MVP simplification.
 */

export function buildIncomeStatement(
  _pre: PreCrisis,
  post: PostCrisis,
  flows: ActionFlows,
  crisis: CrisisFlows,
): IncomeStatement {
  const grossProfit = post.revenue - post.cogs;
  const ebitda =
    grossProfit - post.labor - post.occupancy - post.marketing - post.generalAndAdmin;
  const ebit = ebitda - post.depreciation;
  const gainOnAssetDisposal = flows.gainOnDisposal + crisis.gainOnDisposal;
  const financingCosts =
    crisis.factoringCost +
    post.debtService.fees +
    flows.debtOriginationFees +
    crisis.originationFees;
  const pretaxIncome = ebit - post.debtService.interest + gainOnAssetDisposal - financingCosts;

  return {
    revenue: post.revenue,
    costOfGoodsSold: post.cogs,
    grossProfit,
    labor: post.labor,
    occupancy: post.occupancy,
    marketing: post.marketing,
    generalAndAdmin: post.generalAndAdmin,
    ebitda,
    depreciationAndAmortization: post.depreciation,
    ebit,
    interestExpense: post.debtService.interest,
    gainOnAssetDisposal,
    financingCosts,
    pretaxIncome,
    incomeTaxExpense: post.tax.incomeTaxExpense,
    netIncome: pretaxIncome - post.tax.incomeTaxExpense,
  };
}

export function buildCashFlowStatement(
  incomeStatement: IncomeStatement,
  pre: PreCrisis,
  post: PostCrisis,
  flows: ActionFlows,
  crisis: CrisisFlows,
): CashFlowStatement {
  const gain = incomeStatement.gainOnAssetDisposal;
  const deferredTaxes = post.tax.deferredTaxLiabilityDelta;
  const debtOriginationFees = flows.debtOriginationFees + crisis.originationFees;
  const cashFlowFromOperations =
    incomeStatement.netIncome +
    post.depreciation +
    deferredTaxes +
    debtOriginationFees - // reclassified into financing below; net effect on cash is nil
    gain -
    post.deltaNwc;

  const capitalExpenditures = flows.capex;
  const proceedsFromDisposals = flows.disposalProceeds + crisis.disposalProceeds;
  const cashFlowFromInvesting = proceedsFromDisposals - capitalExpenditures;

  const debtDrawdowns = flows.debtDrawdowns + crisis.drawdowns;
  const ownerContributions = flows.ownerContributions + crisis.householdInjection;
  const ownerDistributions = flows.ownerDistributions + post.tax.taxDistribution;
  const cashFlowFromFinancing =
    debtDrawdowns -
    flows.principalRepayments -
    post.debtService.principal -
    debtOriginationFees +
    ownerContributions -
    ownerDistributions;

  const netChangeInCash =
    cashFlowFromOperations + cashFlowFromInvesting + cashFlowFromFinancing;

  return {
    netIncome: incomeStatement.netIncome,
    depreciationAndAmortization: post.depreciation,
    deferredTaxes,
    gainOnAssetDisposal: gain,
    changeInNetWorkingCapital: post.deltaNwc,
    cashFlowFromOperations,
    capitalExpenditures,
    proceedsFromDisposals,
    cashFlowFromInvesting,
    debtDrawdowns,
    debtPrincipalRepayments: flows.principalRepayments + post.debtService.principal,
    debtOriginationFees,
    ownerContributions,
    ownerDistributions,
    cashFlowFromFinancing,
    netChangeInCash,
    beginningCash: pre.beginningCash,
    endingCash: pre.beginningCash + netChangeInCash,
  };
}

export function buildBalanceSheet(
  business: Business,
  period: PeriodIndex,
  incomeStatement: IncomeStatement,
  cashFlow: CashFlowStatement,
  post: PostCrisis,
): BalanceSheet {
  const wc = post.workingCapital;
  const currentAssets =
    cashFlow.endingCash +
    wc.accountsReceivable +
    wc.retainageReceivable +
    wc.inventory +
    wc.prepaidExpenses;

  // `business.assets` has already been mutated by this period's purchases and
  // disposals, so gross PP&E is read straight off it — adding capex again here
  // would double-count every asset the player bought this quarter. The same
  // applies to accumulated depreciation on disposed assets: those assets are
  // gone from the array, so their accumulated depreciation left with them.
  const grossPpe = ppeGross(business);
  const accumDep = accumulatedDepreciation(business) + post.depreciation;

  const totalAssets = currentAssets + grossPpe - accumDep;

  // Scheduled principal has not been committed to the debt records yet; the
  // cash flow statement pays it this period, so the balance sheet must show it
  // gone.
  const debtTotal = totalDebt(business) - post.debtService.principal;
  const rawCurrentDebt = currentPortionOfDebt(business, period);
  const currentDebt = rawCurrentDebt > debtTotal ? debtTotal : rawCurrentDebt;
  const currentLiabilities =
    wc.accountsPayable +
    wc.accruedLiabilities +
    wc.deferredRevenue +
    wc.deferredOwnerComp +
    currentDebt;

  const deferredTaxLiability =
    business.balances.deferredTaxLiability + post.tax.deferredTaxLiabilityDelta;

  const totalLiabilities =
    currentLiabilities + (debtTotal - currentDebt) + deferredTaxLiability;

  const contributedCapital = business.balances.contributedCapital + cashFlow.ownerContributions;
  const retainedEarnings =
    business.balances.retainedEarnings + incomeStatement.netIncome - cashFlow.ownerDistributions;

  return {
    cash: cashFlow.endingCash,
    accountsReceivable: wc.accountsReceivable,
    retainageReceivable: wc.retainageReceivable,
    inventory: wc.inventory,
    prepaidExpenses: wc.prepaidExpenses,
    currentAssets,
    ppeGross: grossPpe,
    accumulatedDepreciation: accumDep,
    ppeNet: grossPpe - accumDep,
    totalAssets,
    accountsPayable: wc.accountsPayable,
    accruedLiabilities: wc.accruedLiabilities,
    deferredRevenue: wc.deferredRevenue,
    deferredOwnerComp: wc.deferredOwnerComp,
    currentPortionOfDebt: currentDebt,
    currentLiabilities,
    longTermDebt: debtTotal - currentDebt,
    deferredTaxLiability,
    totalLiabilities,
    contributedCapital,
    retainedEarnings,
    totalEquity: contributedCapital + retainedEarnings,
  };
}

export const zeroCashFlow = (): CashFlowStatement => ({
  netIncome: 0n,
  depreciationAndAmortization: 0n,
  deferredTaxes: 0n,
  gainOnAssetDisposal: 0n,
  changeInNetWorkingCapital: 0n,
  cashFlowFromOperations: 0n,
  capitalExpenditures: 0n,
  proceedsFromDisposals: 0n,
  cashFlowFromInvesting: 0n,
  debtDrawdowns: 0n,
  debtPrincipalRepayments: 0n,
  debtOriginationFees: 0n,
  ownerContributions: 0n,
  ownerDistributions: 0n,
  cashFlowFromFinancing: 0n,
  netChangeInCash: 0n,
  beginningCash: 0n,
  endingCash: 0n,
});

const zeroIncomeStatement = (): IncomeStatement => ({
  revenue: 0n,
  costOfGoodsSold: 0n,
  grossProfit: 0n,
  labor: 0n,
  occupancy: 0n,
  marketing: 0n,
  generalAndAdmin: 0n,
  ebitda: 0n,
  depreciationAndAmortization: 0n,
  ebit: 0n,
  interestExpense: 0n,
  gainOnAssetDisposal: 0n,
  financingCosts: 0n,
  pretaxIncome: 0n,
  incomeTaxExpense: 0n,
  netIncome: 0n,
});

export function consolidateIncomeStatements(
  statements: readonly IncomeStatement[],
): IncomeStatement {
  const out = zeroIncomeStatement();
  for (const s of statements) {
    for (const key of Object.keys(out) as (keyof IncomeStatement)[]) {
      out[key] += s[key];
    }
  }
  return out;
}

export function consolidateBalanceSheets(sheets: readonly BalanceSheet[]): BalanceSheet {
  const keys: (keyof BalanceSheet)[] = [
    'cash',
    'accountsReceivable',
    'retainageReceivable',
    'inventory',
    'prepaidExpenses',
    'currentAssets',
    'ppeGross',
    'accumulatedDepreciation',
    'ppeNet',
    'totalAssets',
    'accountsPayable',
    'accruedLiabilities',
    'deferredRevenue',
    'deferredOwnerComp',
    'currentPortionOfDebt',
    'currentLiabilities',
    'longTermDebt',
    'deferredTaxLiability',
    'totalLiabilities',
    'contributedCapital',
    'retainedEarnings',
    'totalEquity',
  ];
  const out = {} as BalanceSheet;
  for (const key of keys) out[key] = sum(sheets.map((s) => s[key]));
  return out;
}

export function consolidateCashFlows(
  flows: readonly CashFlowStatement[],
): CashFlowStatement {
  const out = zeroCashFlow();
  for (const key of Object.keys(out) as (keyof CashFlowStatement)[]) {
    out[key] = sum(flows.map((f) => f[key]));
  }
  return out;
}
