import { ratio, toCompact, toDisplay, type Money } from '@bizsim/money';
import { streamPrice } from '@bizsim/engine';
import {
  deviationLabel,
  type Assumption,
  type DeltaAttribution,
  type Provenance,
} from '@bizsim/schemas';
import { priceUnits, shareNotice, uploadTarget } from '@bizsim/sim-cli';
import { advisorAvailable } from './advisor';
import type { AdvisorEntry, GameSession, TurnLogEntry } from './store';

/**
 * The view model: everything the client renders, display-ready.
 *
 * Every dollar figure crosses the wire as a string the server formatted from
 * engine output. The client owns layout and nothing else — it cannot recompute
 * a financial because it is never handed one (§1.1, applied to the browser).
 */

export interface Row {
  label: string;
  value: string;
  /** 0 = section line, 1 = detail line. */
  indent?: number;
  /** Subtotal/total — rendered with a rule above. */
  strong?: boolean;
  /** Negative money — rendered in the critical color. */
  negative?: boolean;
}

export interface Tile {
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'warning' | 'critical';
}

export interface DriverView {
  label: string;
  amount: string;
  negative: boolean;
  explanation: string;
  provenance?: string;
}

export interface AttributionView {
  lineLabel: string;
  delta: string;
  negative: boolean;
  drivers: DriverView[];
}

export interface TurnLogView {
  period: number;
  year: number;
  quarter: number;
  events: string[];
  attributions: AttributionView[];
}

export interface RegisterRowView {
  id: string;
  label: string;
  value: string;
  provenance: Provenance;
  sourceNote: string;
  deviation?: string;
  /**
   * The line's annual escalator, folded in as a column rather than its own
   * row — "Accounting & legal — annual escalator 2.0%" as a separate line
   * doubled the register's length while saying almost nothing. The id keeps
   * the escalator challengeable.
   */
  escalator?: string;
  escalatorId?: string;
}

/**
 * The register, clustered — a 57-row flat list is unreadable and most rows
 * are $75 line items or catalog escalators. At most ~9 fixed categories,
 * collapsed by default, groups with out-of-benchmark rows open.
 */
export interface RegisterGroupView {
  label: string;
  count: number;
  deviations: number;
  rows: RegisterRowView[];
}

/**
 * The register split by what each number bears on. Category clusters alone
 * still mixed a $95k buildout, a $28 average ticket, and "2,000 sq ft" in one
 * scroll — three different kinds of claim, checked three different ways. The
 * tabs separate them: what it costs to open (balance sheet and investing
 * cash flow), what sets each quarter's income statement, and the physical
 * shape of the business — load-bearing for both, a dollar line on neither.
 */
export interface RegisterTabView {
  key: RegisterTabKey;
  label: string;
  /** One line under the tab strip saying what lives here. */
  hint: string;
  count: number;
  deviations: number;
  groups: RegisterGroupView[];
}

export type RegisterTabKey = 'investment' | 'pnl' | 'descriptive';

const TABS: readonly { key: RegisterTabKey; label: string; hint: string }[] = [
  {
    key: 'investment',
    label: 'Investment',
    hint: 'What it costs to open and carry — capex, deposits, payment terms, financing.',
  },
  {
    key: 'pnl',
    label: 'P&L',
    hint: 'The prices, rates, and recurring amounts that set each quarter’s income statement.',
  },
  {
    key: 'descriptive',
    label: 'Descriptive',
    hint: 'The physical shape of the business — sizes, counts, hours. These shape the money without being money.',
  },
];

/**
 * Deterministic, from fields the schema already carries. Investment is the
 * category split the draft made (capex, working-capital terms, financing);
 * descriptive is anything left that is neither a dollar amount nor a rate —
 * square feet, seats, operating hours, staff counts.
 */
export function statementTab(a: Assumption): RegisterTabKey {
  if (a.category === 'CAPEX' || a.category === 'FINANCING' || a.category === 'WORKING_CAPITAL') {
    return 'investment';
  }
  if (!a.isMoney && a.unit !== 'pct') return 'descriptive';
  return 'pnl';
}

const GROUP_ORDER = [
  'Revenue & demand',
  'Marketing',
  'Staffing & payroll',
  'Facilities & equipment',
  'Software & tools',
  'Insurance',
  'Professional & compliance',
  'Working capital & terms',
  'Other expenses',
] as const;

function categorize(a: Assumption): (typeof GROUP_ORDER)[number] {
  const l = a.label.toLowerCase();
  if (/marketing|saturation spend|max lift/.test(l)) return 'Marketing';
  if (a.path.startsWith('streams.')) return 'Revenue & demand';
  if (
    a.path.startsWith('workingCapital.') ||
    /\b(dso|dpo|dio)\b|deposit|prepaid insurance months/.test(l)
  ) {
    return 'Working capital & terms';
  }
  if (/payroll|salary|wages|owner compensation|per block|staff/.test(l)) return 'Staffing & payroll';
  if (/insurance/.test(l)) return 'Insurance';
  if (/software|subscription|compute|hosting|stack|\bpos\b/.test(l)) return 'Software & tools';
  if (/rent|office|coworking|utilit|furniture|workstation|equipment|repairs|maintenance|buildout/.test(l)) {
    return 'Facilities & equipment';
  }
  if (/accounting|legal|permit|licen|compliance|tax/.test(l)) return 'Professional & compliance';
  if (/price|rate|ticket|hours|utilization|realization|seasonality|elasticity|ramp|churn|capture|traffic|demand/.test(l)) {
    return 'Revenue & demand';
  }
  return 'Other expenses';
}

interface FoldedRow {
  /** The assumption the row stands for — the base, when an escalator folded onto it. */
  assumption: Assumption;
  row: RegisterRowView;
}

function foldEscalators(assumptions: readonly Assumption[]): FoldedRow[] {
  // Escalators fold onto the line they escalate, matched by model path.
  const escalators = new Map<string, Assumption>();
  const bases: Assumption[] = [];
  for (const a of assumptions) {
    if (a.path.endsWith('.annualEscalatorPct')) {
      escalators.set(a.path.replace(/\.annualEscalatorPct$/, ''), a);
    } else {
      bases.push(a);
    }
  }
  const matched = new Set<string>();
  const rows: FoldedRow[] = bases.map((a) => {
    const basePath = a.path.replace(
      /\.(amountPerQuarter|blockCostPerQuarter|costPerUnit|pctOfRevenue)$/,
      '',
    );
    const esc = escalators.get(basePath);
    const row = toRegisterRow(a);
    if (!esc) return { assumption: a, row };
    matched.add(esc.id);
    return { assumption: a, row: { ...row, escalator: pct(esc.value as number), escalatorId: esc.id } };
  });
  // An escalator with no matchable base keeps its own row — folded away
  // silently it would become unchallengeable.
  for (const esc of escalators.values()) {
    if (!matched.has(esc.id)) rows.push({ assumption: esc, row: toRegisterRow(esc) });
  }
  return rows;
}

function groupFolded(folded: readonly FoldedRow[]): RegisterGroupView[] {
  const byGroup = new Map<string, RegisterRowView[]>();
  for (const f of folded) {
    const group = categorize(f.assumption);
    byGroup.set(group, [...(byGroup.get(group) ?? []), f.row]);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
    const groupRows = byGroup
      .get(g)!
      .sort((a, b) =>
        a.deviation && !b.deviation ? -1 : !a.deviation && b.deviation ? 1 : a.label.localeCompare(b.label),
      );
    return {
      label: g,
      count: groupRows.length,
      deviations: groupRows.filter((r) => r.deviation).length,
      rows: groupRows,
    };
  });
}

export function tabRegister(assumptions: readonly Assumption[]): RegisterTabView[] {
  // Fold first, tab by the base — an escalator belongs wherever its line does.
  const folded = foldEscalators(assumptions);
  return TABS.map((t) => {
    const groups = groupFolded(folded.filter((f) => statementTab(f.assumption) === t.key));
    return {
      ...t,
      count: groups.reduce((n, g) => n + g.count, 0),
      deviations: groups.reduce((n, g) => n + g.deviations, 0),
      groups,
    };
  }).filter((t) => t.count > 0);
}

export interface GameView {
  id: string;
  scenario: string;
  businessName: string;
  status: string;
  period: number;
  year: number;
  quarter: number;
  milestonePeriod: number;
  tiles: Tile[];
  statements: { is: Row[]; bs: Row[]; cf: Row[] };
  streams: { label: string; volume: string; detail: string; warning: boolean }[];
  staffing: { costId: string; label: string; blocks: number; pending: number; needed?: number; blockCost: string }[];
  debts: { label: string; detail: string }[];
  price: { value: number; per: string };
  marketingPerQuarter: number;
  /** Which of the occasional moves this business can express. */
  moves: { territory: boolean; revolver: boolean; expandNoun: string };
  attributions: AttributionView[];
  log: TurnLogView[];
  /**
   * The advisor feed: per-quarter update + eigen question, plus the chat.
   * Already display-ready — entries are prose the server assembled, and the
   * suggested moves are pre-parsed stage payloads the client applies verbatim.
   */
  advisor: AdvisorEntry[];
  /** Whether the chat input works — false when no provider key is set. */
  advisorAvailable: boolean;
  register: { confidence: string; count: number; tabs: RegisterTabView[] };
  household: { cash: string; netWorth: string };
  over: boolean;
  /**
   * The per-session QA share. Absent entirely when no endpoint is configured —
   * a checkout with no SUPABASE_URL never shows the affordance, matching the
   * CLI's silence. `sharedAs` is the reference the player quotes for deletion.
   */
  share?: { notice: string; sharedAs?: string };
}

const money = (m: Money): string => toDisplay(m);
const compact = (m: Money): string => toCompact(m);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function toView(session: GameSession): GameView {
  const { last, world, businessId } = session;
  const business = world.businesses.find((b) => b.id === businessId)!;
  const entry = last.statements.byBusiness[businessId];
  const period = last.statements.period;

  const tiles: Tile[] = [];
  const isRows: Row[] = [];
  const bsRows: Row[] = [];
  const cfRows: Row[] = [];
  if (entry) {
    const is = entry.incomeStatement;
    const bs = entry.balanceSheet;
    const cf = entry.cashFlow;
    const m = entry.derivedMetrics;

    const runway = m.cashRunwayQuarters;
    tiles.push(
      { label: 'Revenue', value: compact(is.revenue) },
      {
        label: 'EBITDA',
        value: compact(is.ebitda),
        ...(is.revenue > 0n ? { hint: `${pct(ratio(is.ebitda, is.revenue))} margin` } : {}),
        ...(is.ebitda < 0n ? { tone: 'critical' as const } : {}),
      },
      {
        label: 'Cash',
        value: compact(bs.cash),
        ...(bs.cash < 2_500_000n ? { tone: 'critical' as const } : {}),
      },
      {
        label: 'Runway',
        value: Number.isFinite(runway) ? `${runway.toFixed(1)}q` : '∞',
        ...(Number.isFinite(runway) && runway < 2 ? { tone: 'warning' as const } : {}),
      },
      {
        label: 'Net income',
        value: compact(is.netIncome),
        ...(is.netIncome < 0n ? { tone: 'critical' as const } : {}),
      },
      { label: 'Equity', value: compact(bs.totalEquity) },
      { label: 'Peak cash need', value: compact(m.peakCashNeed) },
    );

    const row = (
      target: Row[],
      label: string,
      value: Money,
      opts: { indent?: number; strong?: boolean } = {},
    ): void => {
      target.push({
        label,
        value: money(value),
        ...(opts.indent !== undefined ? { indent: opts.indent } : {}),
        ...(opts.strong ? { strong: true } : {}),
        ...(value < 0n ? { negative: true } : {}),
      });
    };

    row(isRows, 'Revenue', is.revenue, { strong: true });
    row(isRows, 'Cost of goods sold', is.costOfGoodsSold, { indent: 1 });
    row(isRows, 'Gross profit', is.grossProfit, { strong: true });
    row(isRows, 'Labor', is.labor, { indent: 1 });
    row(isRows, 'Occupancy', is.occupancy, { indent: 1 });
    row(isRows, 'Marketing', is.marketing, { indent: 1 });
    row(isRows, 'General & admin', is.generalAndAdmin, { indent: 1 });
    row(isRows, 'EBITDA', is.ebitda, { strong: true });
    row(isRows, 'Depreciation & amortization', is.depreciationAndAmortization, { indent: 1 });
    row(isRows, 'EBIT', is.ebit, { strong: true });
    row(isRows, 'Interest expense', is.interestExpense, { indent: 1 });
    if (is.gainOnAssetDisposal !== 0n) row(isRows, 'Gain on asset disposal', is.gainOnAssetDisposal, { indent: 1 });
    if (is.financingCosts !== 0n) row(isRows, 'Financing costs', is.financingCosts, { indent: 1 });
    row(isRows, 'Pretax income', is.pretaxIncome, { strong: true });
    if (is.incomeTaxExpense !== 0n) row(isRows, 'Income tax expense', is.incomeTaxExpense, { indent: 1 });
    row(isRows, 'Net income', is.netIncome, { strong: true });

    row(bsRows, 'Cash', bs.cash, { indent: 1 });
    row(bsRows, 'Accounts receivable', bs.accountsReceivable, { indent: 1 });
    if (bs.retainageReceivable !== 0n) row(bsRows, 'Retainage receivable', bs.retainageReceivable, { indent: 1 });
    row(bsRows, 'Inventory', bs.inventory, { indent: 1 });
    row(bsRows, 'Prepaid expenses', bs.prepaidExpenses, { indent: 1 });
    row(bsRows, 'Current assets', bs.currentAssets, { strong: true });
    row(bsRows, 'PP&E, net', bs.ppeNet, { indent: 1 });
    row(bsRows, 'Total assets', bs.totalAssets, { strong: true });
    row(bsRows, 'Accounts payable', bs.accountsPayable, { indent: 1 });
    row(bsRows, 'Accrued liabilities', bs.accruedLiabilities, { indent: 1 });
    if (bs.deferredRevenue !== 0n) row(bsRows, 'Deferred revenue', bs.deferredRevenue, { indent: 1 });
    if (bs.deferredOwnerComp !== 0n) row(bsRows, 'Deferred owner comp', bs.deferredOwnerComp, { indent: 1 });
    row(bsRows, 'Current portion of debt', bs.currentPortionOfDebt, { indent: 1 });
    row(bsRows, 'Long-term debt', bs.longTermDebt, { indent: 1 });
    if (bs.deferredTaxLiability !== 0n) row(bsRows, 'Deferred tax liability', bs.deferredTaxLiability, { indent: 1 });
    row(bsRows, 'Total liabilities', bs.totalLiabilities, { strong: true });
    row(bsRows, 'Contributed capital', bs.contributedCapital, { indent: 1 });
    row(bsRows, 'Retained earnings', bs.retainedEarnings, { indent: 1 });
    row(bsRows, 'Total equity', bs.totalEquity, { strong: true });

    row(cfRows, 'Net income', cf.netIncome, { indent: 1 });
    row(cfRows, 'D&A', cf.depreciationAndAmortization, { indent: 1 });
    if (cf.deferredTaxes !== 0n) row(cfRows, 'Deferred taxes', cf.deferredTaxes, { indent: 1 });
    if (cf.gainOnAssetDisposal !== 0n) row(cfRows, 'Gain on disposal', cf.gainOnAssetDisposal, { indent: 1 });
    row(cfRows, 'Δ net working capital', cf.changeInNetWorkingCapital, { indent: 1 });
    row(cfRows, 'Cash from operations', cf.cashFlowFromOperations, { strong: true });
    row(cfRows, 'Capital expenditures', cf.capitalExpenditures, { indent: 1 });
    if (cf.proceedsFromDisposals !== 0n) row(cfRows, 'Proceeds from disposals', cf.proceedsFromDisposals, { indent: 1 });
    row(cfRows, 'Cash from investing', cf.cashFlowFromInvesting, { strong: true });
    row(cfRows, 'Debt drawdowns', cf.debtDrawdowns, { indent: 1 });
    row(cfRows, 'Principal repayments', cf.debtPrincipalRepayments, { indent: 1 });
    if (cf.debtOriginationFees !== 0n) row(cfRows, 'Origination fees', cf.debtOriginationFees, { indent: 1 });
    if (cf.ownerContributions !== 0n) row(cfRows, 'Owner contributions', cf.ownerContributions, { indent: 1 });
    if (cf.ownerDistributions !== 0n) row(cfRows, 'Owner distributions', cf.ownerDistributions, { indent: 1 });
    row(cfRows, 'Cash from financing', cf.cashFlowFromFinancing, { strong: true });
    row(cfRows, 'Net change in cash', cf.netChangeInCash, { strong: true });
    row(cfRows, 'Ending cash', cf.endingCash, { strong: true });
  }

  const streams = (entry?.derivedMetrics.streamMetrics ?? []).map((s) => {
    const noun = business.streams.find((x) => x.id === s.streamId)?.volumeNoun ?? 'units';
    let detail: string;
    let warning = false;
    if (s.lostDemand > 0.5) {
      warning = true;
      detail = `at capacity — turned away ${Math.round(s.lostDemand).toLocaleString()} of ${Math.round(s.demandVolume).toLocaleString()}`;
    } else if (s.capacityVolume !== undefined && s.capacityVolume > 0) {
      detail = `staffed for ${Math.round(s.capacityVolume).toLocaleString()} (${pct(s.realizedVolume / s.capacityVolume)} used)`;
    } else {
      detail = 'nothing capping volume';
    }
    if (s.occupancy !== undefined) detail += ` · occupancy ${pct(s.occupancy)}`;
    if (s.realizedUtilization !== undefined) detail += ` · utilisation ${pct(s.realizedUtilization)}`;
    if (s.backlogCoverageQuarters !== undefined) detail += ` · backlog ${s.backlogCoverageQuarters.toFixed(1)}q`;
    return {
      label: s.label,
      volume: `${Math.round(s.realizedVolume).toLocaleString()} ${noun}`,
      detail,
      warning,
    };
  });

  const needed = new Map<string, number>();
  for (const e of last.events) {
    if (e.kind === 'CAPACITY_CONSTRAINED' && e.detail.blocksNeeded !== undefined) {
      needed.set(String(e.detail.line), Number(e.detail.blocksNeeded));
    }
  }
  const staffing = business.costs.stepFixed.map((c) => ({
    costId: c.id,
    label: c.label,
    blocks: c.currentBlocks,
    pending: c.pendingBlocks,
    ...(needed.get(c.label) !== undefined ? { needed: needed.get(c.label)! } : {}),
    blockCost: compact(c.blockCostPerQuarter),
  }));

  // Only facilities that still mean something: a balance, or an undrawn line
  // that could be drawn. A twenty-year run on the crisis ladder otherwise
  // shows every emergency loan it ever repaid, forever, at $0 each.
  const debts = business.debts
    .filter((d) => d.outstandingPrincipal > 0n || d.revolverLimit !== undefined)
    .map((d) => ({
      // "SBA_7A facility" is an enum wearing a label; say it like a banker.
      label: d.label.replace(/SBA_7A/g, 'SBA 7(a)').replace(/_/g, ' '),
      detail:
        d.revolverLimit !== undefined
          ? `${compact(d.outstandingPrincipal)} drawn of ${compact(d.revolverLimit)} @ ${pct(d.annualRate)}`
          : `${compact(d.outstandingPrincipal)} outstanding @ ${pct(d.annualRate)}`,
    }));

  const stream = business.streams[0];
  const units = stream ? priceUnits(stream, streamPrice(stream)) : { command: 0, per: 'unit' };

  const assumptions = Object.values(business.assumptions.byId);
  const registerTabs = tabRegister(assumptions);

  return {
    id: session.id,
    scenario: session.scenario,
    businessName: business.name,
    status: business.status,
    period,
    year: Math.floor(period / 4) + 1,
    quarter: (period % 4) + 1,
    milestonePeriod: world.config.milestonePeriod,
    tiles,
    statements: { is: isRows, bs: bsRows, cf: cfRows },
    streams,
    staffing,
    debts,
    price: { value: units.command, per: units.per },
    marketingPerQuarter: stream ? Number(stream.marketingSpendPerQuarter) / 100 : 0,
    moves: {
      // A second territory is more market, not more room — it only exists
      // where demand is territorial (see actions.ts / play.ts `market`).
      territory: stream?.params.kind === 'UTILIZATION' || stream?.params.kind === 'TRAFFIC',
      revolver: business.debts.some((d) => d.kind === 'REVOLVER'),
      expandNoun: stream?.params.kind === 'OCCUPANCY' ? 'units' : 'seats',
    },
    attributions: session.attributions.map(toAttributionView),
    log: [...session.log].reverse().slice(0, 24).map(toLogView),
    advisor: session.advisor,
    advisorAvailable: advisorAvailable(),
    register: {
      confidence: pct(business.assumptions.confidenceScore),
      count: assumptions.length,
      tabs: registerTabs,
    },
    household: {
      cash: compact(world.household.cash),
      netWorth: compact(last.statements.household.netWorth),
    },
    over: business.status === 'CLOSED' || period >= world.config.milestonePeriod,
    ...(uploadTarget()
      ? {
          share: {
            notice: shareNotice(),
            ...(session.sharedAs ? { sharedAs: session.sharedAs } : {}),
          },
        }
      : {}),
  };
}

const signed = (m: Money): string => `${m < 0n ? '−' : '+'}${toCompact(m < 0n ? -m : m)}`;

const toAttributionView = (a: DeltaAttribution): AttributionView => ({
  lineLabel: a.lineLabel,
  delta: signed(a.delta),
  negative: a.delta < 0n,
  drivers: a.drivers.map((d) => ({
    label: d.label,
    amount: signed(d.amount),
    negative: d.amount < 0n,
    explanation: d.explanation,
    ...(d.provenance ? { provenance: d.provenance.toLowerCase().replace(/_/g, '-') } : {}),
  })),
});

const toLogView = (l: TurnLogEntry): TurnLogView => ({
  period: l.period,
  year: Math.floor(l.period / 4) + 1,
  quarter: (l.period % 4) + 1,
  events: l.events,
  attributions: l.attributions.map(toAttributionView),
});

export function toRegisterRow(a: Assumption): RegisterRowView {
  const value =
    typeof a.value === 'bigint'
      ? money(a.value)
      : a.unit === 'pct'
        ? pct(a.value)
        : a.value.toLocaleString();
  const deviation = a.outsideBenchmark ? deviationLabel(a) : undefined;
  return {
    id: a.id,
    label: a.label,
    value,
    provenance: a.provenance,
    sourceNote: a.sourceNote,
    ...(deviation ? { deviation } : {}),
  };
}
