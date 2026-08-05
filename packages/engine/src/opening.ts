import { mulRate, sum, type Money } from '@bizsim/money';
import {
  DEFAULT_CRISIS_POLICY,
  DEFAULT_MAINTENANCE_PCT,
  FREEPLAY_CAPITAL_CAP,
  START_CAPITAL,
  emptyBalances,
  emptyRegister,
  emptyTaxState,
  type BusinessModel,
  type Business,
  type Household,
  type WorldConfig,
  type WorldState,
} from '@bizsim/schemas';
import { DEBT_PRODUCTS, openingLoanRate } from './debt.js';
import { totalMonthZero, type MonthZeroOutlays } from './workingCapital.js';

/**
 * World construction and the opening balance sheet — spec §9.1 Phase 4.
 *
 * Month-zero outlays hit cash before period 0 ticks. These are routinely
 * omitted from founder models and they materially change peak cash need, which
 * is the single most useful number a prospective founder can be handed.
 */

export interface WorldConfigInput {
  startMode: 'LOW' | 'MID' | 'HIGH' | 'FREEPLAY';
  customCapital?: Money;
  personalTaxRate?: number;
  corporateTaxRate?: number;
  stateCorporateTaxRate?: number;
  primeRate?: number;
  annualInflationPct?: number;
  annualLivingExpenses?: Money;
  milestonePeriod?: number;
  /**
   * Which decade of market history this run gets. Fixed at world creation and
   * never touched again, so the same seed replays the same prices exactly.
   */
  marketSeed?: number;
}

export function createWorldConfig(input: WorldConfigInput): WorldConfig {
  const startCapital =
    input.startMode === 'FREEPLAY'
      ? clampFreeplay(input.customCapital ?? START_CAPITAL.MID)
      : START_CAPITAL[input.startMode];

  return {
    startCapital,
    startMode: input.startMode,
    milestonePeriod: input.milestonePeriod ?? 39,
    personalTaxRate: input.personalTaxRate ?? 0.32,
    corporateTaxRate: input.corporateTaxRate ?? 0.21,
    stateCorporateTaxRate: input.stateCorporateTaxRate ?? 0.05,
    qualifiedDividendRate: 0.15,
    primeRate: input.primeRate ?? 0.075,
    annualInflationPct: input.annualInflationPct ?? 0.025,
    crisisPolicy: [...DEFAULT_CRISIS_POLICY],
    currency: 'USD',
    // A constant default, not a clock reading: `Date.now()` here would make
    // every run irreproducible and break replay, which is the one thing the
    // engine's purity exists to protect. Callers who want a different decade
    // pass one in, and the CLI's setup does.
    //
    // This particular constant is chosen, not arbitrary. The first one tried
    // produced a decade where the index went nowhere (0.7%/yr) while the tech
    // name compounded at 30% — a legitimate draw at these volatilities and a
    // terrible default, because every scenario run and every test would read
    // it as the market being broken and single names being a cheat code. This
    // seed lands every instrument within half a sigma of its own assumption
    // over forty quarters, so the shipped default is an unremarkable decade.
    marketSeed: input.marketSeed ?? 20_243_414,
  };
}

/**
 * FREEPLAY is "uncapped" in §16 Q4, which is both a modelling problem (a $10B
 * coffee shop produces a meaningless model) and a representation problem: every
 * float quantity multiplication and every exceljs cell value has to stay inside
 * safe integer range. $1B preserves the mode's spirit and closes both.
 */
export const clampFreeplay = (capital: Money): Money =>
  capital > FREEPLAY_CAPITAL_CAP ? FREEPLAY_CAPITAL_CAP : capital;

export interface CreateWorldInput {
  id: string;
  playerId: string;
  config: WorldConfig;
  models: readonly BusinessModel[];
  annualLivingExpenses?: Money;
}

export function createWorld(input: CreateWorldInput): WorldState {
  const livingExpenses = input.annualLivingExpenses ?? 6_000_000n; // $60,000
  let idCounter = 0;
  const nextId = (): string => `g${(idCounter += 1)}`;

  const household: Household = {
    cash: input.config.startCapital,
    personalDebts: [],
    holdings: [],
    stakes: [],
    cumulativeDraws: 0n,
    cumulativeInjections: 0n,
    cumulativePersonalTax: 0n,
    creditQuality: 'GOOD',
    annualLivingExpenses: livingExpenses,
    startingAnnualLivingExpenses: livingExpenses,
  };

  const businesses = input.models.map((model) =>
    openBusiness(model, household, nextId),
  );

  for (const business of businesses) {
    household.stakes.push({
      businessId: business.id,
      ownershipPct: 1,
      costBasis: business.balances.contributedCapital,
    });
  }

  return {
    id: input.id,
    playerId: input.playerId,
    createdAtPeriod: 0,
    // The first tick advances to period 0. Month-zero outlays have already been
    // applied by `openBusiness`, before any quarter runs.
    currentPeriod: -1,
    config: input.config,
    household,
    businesses,
    pendingActions: [],
    eventLog: [],
    idCounter,
    status: 'ACTIVE',
  };
}

export function computeMonthZeroOutlays(model: BusinessModel): MonthZeroOutlays {
  const wc = model.workingCapital;

  // First month + last month + security deposit, at the default 3 months.
  const leaseSigning = mulRate(model.monthlyRent, wc.securityDepositMonths + 2);

  const buildoutAndEquipment = sum(
    model.capex.map((c) => mulRate(c.grossCost, c.quantity)),
  );

  // Enough inventory to cover the planned run rate over the inventory cycle.
  const plannedQuarterlyCogs = estimateQuarterlyCogs(model);
  const initialInventory = mulRate(plannedQuarterlyCogs, wc.dioDays / 91.25);

  const prepaidInsurance = mulRate(
    sum(
      model.costs.fixedPeriod
        .filter((c) => c.isPrepaidExpense)
        .map((c) => c.amountPerQuarter),
    ),
    wc.prepaidInsuranceMonths / 3,
  );

  /**
   * A revolver's fee is not a debt origination fee, and saying so contradicted
   * the screen above it.
   *
   * A mobile game studio took the "no debt needed, and a $3,000 revolver"
   * option and was then charged $15 of "Debt origination fees" — correct
   * arithmetic (0.5% of the limit) under a label the player had just been told
   * did not apply to them. It is a commitment fee: paid for the *availability*
   * of a line nobody has drawn on, which is a different thing from a fee on
   * borrowed money, and worth its own row precisely because it is the one that
   * shows up when you borrowed nothing.
   */
  const feeFor = (kinds: (d: { kind: keyof typeof DEBT_PRODUCTS }) => boolean): Money =>
    sum(
      model.financingPlan.debtRequests
        .filter(kinds)
        .map((d) => mulRate(d.requestedPrincipal, DEBT_PRODUCTS[d.kind].originationFeePct)),
    );
  const debtOriginationFees = feeFor((d) => d.kind !== 'REVOLVER');
  const revolverCommitmentFees = feeFor((d) => d.kind === 'REVOLVER');

  const partial = {
    leaseSigning,
    buildoutAndEquipment,
    initialInventory,
    permitsAndLegal: model.preOpeningCosts.permitsAndLegal,
    prepaidInsurance,
    preOpeningPayroll: model.preOpeningCosts.payrollAndTraining,
    preOpeningMarketing: model.preOpeningCosts.marketing,
    debtOriginationFees,
    revolverCommitmentFees,
  };

  return { ...partial, total: totalMonthZero(partial) };
}

function estimateQuarterlyCogs(model: BusinessModel): Money {
  // A first-quarter revenue estimate at the ramp floor, purely to size the
  // opening inventory fill. The engine computes the real figure from period 0.
  const cogsPct = model.costs.variableWithRevenue
    .filter((c) => c.statementLine === 'COGS')
    .reduce((acc, c) => acc + c.pctOfRevenue, 0);

  const revenueEstimate = sum(
    model.streams.map((s) => {
      const p = s.params;
      const floor = s.modifiers.rampFloor;
      switch (p.kind) {
        case 'TRAFFIC':
          return mulRate(
            p.avgTicket,
            p.addressableTrafficPerQuarter * p.captureRate * floor,
          );
        case 'UNITS_CAC':
          return mulRate(p.avgOrderValue, 100 * floor);
        case 'OCCUPANCY':
          return mulRate(p.ratePerUnitPerQuarter, p.units * p.stabilizedOccupancy * floor);
        default:
          return 0n;
      }
    }),
  );
  return mulRate(revenueEstimate, cogsPct);
}

function openBusiness(
  model: BusinessModel,
  household: Household,
  nextId: () => string,
): Business {
  const outlays = computeMonthZeroOutlays(model);

  const debtProceeds = sum(model.financingPlan.debtRequests.map((d) => d.requestedPrincipal));
  const equity = model.financingPlan.equityInjection;
  // Outside money — a tax credit, a grant, a partner — is contributed capital
  // that the household never paid, so only the founder's own injection moves
  // the household balance.
  const outside = model.financingPlan.outsideCapital;

  household.cash -= equity;
  household.cumulativeInjections += equity;

  const assets = model.capex.flatMap((spec) =>
    Array.from({ length: spec.quantity }, () => ({
      id: nextId(),
      label: spec.label,
      category: spec.category,
      grossCost: spec.grossCost,
      acquiredPeriod: -1,
      usefulLifeYears: spec.usefulLifeYears,
      accumulatedDepreciation: 0n,
      salvageValue: spec.salvageValue ?? 0n,
      maintenancePctOfGrossPerYear: DEFAULT_MAINTENANCE_PCT[spec.category],
      section179Elected: spec.section179Elected,
      ...(spec.replacementCycleYears !== undefined
        ? { replacementCycleYears: spec.replacementCycleYears }
        : {}),
    })),
  );

  const debts = model.financingPlan.debtRequests.map((spec) => ({
    id: nextId(),
    label: `${spec.kind} facility`,
    kind: spec.kind,
    originalPrincipal: spec.requestedPrincipal,
    outstandingPrincipal: spec.kind === 'REVOLVER' ? 0n : spec.requestedPrincipal,
    // Term facilities carry the leverage-priced rate the funding screen
    // quoted — one source (`openingLoanRate`), so the number accepted is the
    // number charged. Revolvers price flat: they lend against receivables,
    // not the deal's capital structure.
    annualRate:
      spec.kind === 'REVOLVER'
        ? 0.075 + DEBT_PRODUCTS.REVOLVER.spreadOverPrime
        : openingLoanRate(0.075, spec.requestedPrincipal, equity + outside, spec.operatorYears ?? 0),
    termQuarters: spec.termQuarters,
    originatedPeriod: -1,
    originationFeePct: DEBT_PRODUCTS[spec.kind].originationFeePct,
    personalGuarantee: spec.personalGuarantee,
    ...(spec.kind === 'REVOLVER' ? { revolverLimit: spec.requestedPrincipal } : {}),
    covenants: [],
  }));

  const revolverLimits = sum(
    model.financingPlan.debtRequests
      .filter((d) => d.kind === 'REVOLVER')
      .map((d) => d.requestedPrincipal),
  );
  const drawnDebt = debtProceeds - revolverLimits;

  const openingCash = equity + outside + drawnDebt - outlays.total;

  const securityDeposit = mulRate(model.monthlyRent, model.workingCapital.securityDepositMonths);
  const capitalisedCapex = sum(assets.map((a) => a.grossCost));

  const balances = {
    ...emptyBalances(),
    inventory: outlays.initialInventory,
    prepaidExpenses: securityDeposit + outlays.prepaidInsurance,
    contributedCapital: equity + outside,
    // Pre-opening payroll, marketing, permits and origination fees are expensed
    // at inception rather than capitalised; they open the books at a deficit,
    // which is exactly what the founder's first balance sheet actually looks
    // like.
    retainedEarnings: -(
      model.preOpeningCosts.payrollAndTraining +
      model.preOpeningCosts.marketing +
      model.preOpeningCosts.permitsAndLegal +
      // Both fee lines. They were one field until a revolver's commitment fee
      // was split onto its own row for the screen, and expensing only the term
      // half left the opening balance sheet short by exactly the revolver fee —
      // caught by the articulation suite at period 0, which is what it is for.
      outlays.debtOriginationFees +
      outlays.revolverCommitmentFees +
      mulRate(model.monthlyRent, 2)
    ),
  };

  void capitalisedCapex;

  return {
    id: nextId(),
    name: model.businessName,
    legalForm: model.legalForm,
    ownershipPct: 1,
    foundedPeriod: 0,
    status: 'PRE_LAUNCH',
    seedTemplateId: model.seedTemplateId,
    streams: model.streams.map((s) => ({
      ...s,
      state: { quartersSinceLaunch: 0 },
    })),
    costs: model.costs,
    workingCapital: model.workingCapital,
    assets,
    debts,
    cash: openingCash,
    balances,
    taxState: emptyTaxState(),
    monthlyRent: model.monthlyRent,
    assumptions: buildRegister(model),
    trailingEbitda: [],
    trailingDebtService: [],
    cumulativeUnfinancedCash: -outlays.total,
    peakCashNeed: outlays.total,
    peakCashNeedPeriod: 0,
  };
}

function buildRegister(model: BusinessModel): Business['assumptions'] {
  const register = emptyRegister();
  for (const assumption of model.assumptions) {
    register.byId[assumption.id] = assumption;
    register.byPath[assumption.path] = assumption.id;
  }
  return register;
}
