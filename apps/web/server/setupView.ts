import { toDisplay, type Money } from '@bizsim/money';
import { computeMonthZeroOutlays } from '@bizsim/engine';
import { computeConfidenceScore } from '@bizsim/schemas';
import { arguableAssumptions, type CandidateResult } from '@bizsim/sim-cli';
import { spendSummary, type ChatEntry, type SetupPhase, type SetupSession } from './setup';
import { toRegisterRow, type RegisterRowView } from './view';

/**
 * Everything the setup client renders, display-ready — same rule as the game
 * view: dollars cross the wire as strings the server formatted.
 */

export interface DraftView {
  businessName: string;
  summary: string;
  archetype: string;
  archetypeRationale: string;
  /** "Worth arguing with first" — the draft's own uncertainty, top three. */
  openNotes: string[];
  hiddenNotes: number;
  synthetic: boolean;
}

export interface FundingView {
  needed: string;
  investable: string;
  /**
   * The opening budget, itemized — the lines the aggregate is made of, so
   * the player can point at the one that is wrong for THEIR business and
   * argue with it in the chat.
   */
  budget: { label: string; amount: string }[];
  /** The worked plan, as one sentence. */
  planLine: string;
  /** Nonempty when even the capped plan cannot cover opening. */
  shortBy?: string;
  equityFloor: string;
  proposedEquityDollars: number;
  attemptsUsed: number;
}

export interface ReviewView {
  monthZero: string;
  openingCash: string;
  equity: string;
  outside?: string;
  debtLine?: string;
  confidence: string;
  register: RegisterRowView[];
  /** Ids worth arguing with first, in order. */
  arguable: string[];
  notes: string[];
}

export interface SetupView {
  id: string;
  phase: SetupPhase;
  chat: ChatEntry[];
  draft?: DraftView;
  funding?: FundingView;
  review?: ReviewView;
  deadReason?: string;
  spend?: string;
  busy: boolean;
  /** Stage label while the staged draft assembles, for the polling client. */
  progress?: string;
  /**
   * Whether "no more questions — build it" would produce something. True once
   * the player has said anything at all (or arrived seeded, where the
   * template itself is something); the interview estimates the rest.
   */
  canFinish: boolean;
}

const NOTES_SHOWN = 3;

/**
 * The archetype in words a player recognises. The enum is engine vocabulary —
 * a live draft card showed a plumber "PROJECT_BACKLOG" as a chip and then the
 * rationale said it again, which is the picker's old "metadata is not
 * information" bug recommitted. The same mapping scrubs the enum out of the
 * model-written rationale, since drafts from before the prompt learned this
 * rule still carry it.
 */
const ARCHETYPE_WORDS: Record<string, string> = {
  TRAFFIC: 'walk-in demand',
  UTILIZATION: 'billable hours',
  UNITS_CAC: 'paid customer acquisition',
  SUBSCRIPTION: 'recurring subscribers',
  OCCUPANCY: 'occupied units',
  PROJECT_BACKLOG: 'work won job by job',
};

/**
 * Engine vocabulary that reaches player-facing prose, in words. The warning
 * strings serve two audiences — they are repair instructions to the model,
 * where enum names are exact — so the translation happens here at the view,
 * not at the source. Spec section references get dropped for the same
 * reason: "(§4.2)" is a citation into a document the player has never seen.
 */
const ENGINE_WORDS: Record<string, string> = {
  ...ARCHETYPE_WORDS,
  VARIABLE_REVENUE: 'the percent-of-revenue class',
  VARIABLE_ACTIVITY: 'the per-unit class',
  STEP_FIXED: 'the staffed-capacity class',
  FIXED_PERIOD: 'the fixed-contract class',
};

const inWords = (archetype: string): string => ARCHETYPE_WORDS[archetype] ?? archetype;

const scrubEnums = (text: string): string =>
  Object.entries(ENGINE_WORDS)
    .reduce((out, [enumName, words]) => out.replaceAll(enumName, words), text)
    .replace(/\s*\(§[\d.]+\)/g, '');

export function toSetupView(session: SetupSession): SetupView {
  const view: SetupView = {
    id: session.id,
    phase: session.phase,
    chat: session.chat,
    busy: session.busy,
    canFinish:
      session.phase === 'INTERVIEW' &&
      !session.busy &&
      (session.turns > 0 || session.seed !== undefined || session.chat.some((c) => c.who === 'you')),
    ...(session.deadReason ? { deadReason: session.deadReason } : {}),
    ...(spendSummary(session) ? { spend: spendSummary(session)! } : {}),
    ...(session.progress.text ? { progress: session.progress.text } : {}),
  };

  if (session.concept) {
    const draft = session.concept.draft;
    view.draft = {
      businessName: draft.businessName,
      summary: draft.summary,
      archetype: inWords(draft.stream.archetype),
      archetypeRationale: scrubEnums(draft.stream.archetypeRationale.split(/(?<=\.)\s+/)[0] ?? ''),
      openNotes: draft.openNotes.slice(0, NOTES_SHOWN).map(scrubEnums),
      hiddenNotes: Math.max(0, draft.openNotes.length - NOTES_SHOWN),
      synthetic: draft.seedTemplateId === null,
    };
  }

  if (session.phase === 'FUNDING' && session.proposal) {
    const p = session.proposal;
    const money = (m: Money): string => toDisplay(m, { showCents: false });
    // The proposal deliberately rounds above bare opening costs — the excess
    // opens as cash, the cheapest runway there is. A plan that puts in more
    // than the stated need without saying why reads as a mistake, so the
    // line carries its own explanation.
    const cushion = p.proposedLoan === 0n && p.proposedEquity > p.needed ? p.proposedEquity - p.needed : 0n;
    const plan =
      p.proposedLoan > 0n
        ? `${money(p.proposedEquity)} of your own plus a ${money(p.proposedLoan)} SBA 7(a)` +
          (p.proposedRevolver > 0n ? `, and a ${money(p.proposedRevolver)} revolver` : '')
        : `${money(p.proposedEquity)} of your own, no debt needed` +
          (cushion > 0n ? ` — the ${money(cushion)} above opening costs starts as cash runway` : '');
    const budgetLines: [string, Money][] = [
      ['Buildout & equipment', p.outlays.buildoutAndEquipment],
      ['Lease signing — first, last & security', p.outlays.leaseSigning],
      ['Opening inventory', p.outlays.initialInventory],
      ['Pre-opening payroll & training', p.outlays.preOpeningPayroll],
      ['Pre-opening marketing', p.outlays.preOpeningMarketing],
      ['Permits & legal', p.outlays.permitsAndLegal],
      ['Prepaid insurance', p.outlays.prepaidInsurance],
      ['Loan origination fees', p.outlays.debtOriginationFees],
      ['Revolver commitment fee', p.outlays.revolverCommitmentFees],
      ['First quarter of fixed costs', p.quarterOfFixed],
    ];
    view.funding = {
      needed: money(p.needed),
      investable: money(p.investable),
      budget: budgetLines
        .filter(([, amount]) => amount > 0n)
        .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
        .map(([label, amount]) => ({ label, amount: money(amount) })),
      planLine: plan,
      ...(p.shortBy > 0n ? { shortBy: money(p.shortBy) } : {}),
      equityFloor: money(p.equityFloor),
      proposedEquityDollars: Number(p.proposedEquity) / 100,
      attemptsUsed: session.fundingAttempts,
    };
  }

  if (session.phase === 'REVIEW' && session.candidate) {
    const c = session.candidate;
    const model = c.model;
    const money = (m: Money): string => toDisplay(m, { showCents: false });
    const plan = model.financingPlan;
    const term = plan.debtRequests.filter((d) => d.kind !== 'REVOLVER');
    const revolver = plan.debtRequests.find((d) => d.kind === 'REVOLVER');
    const termTotal = term.reduce<Money>((a, d) => a + d.requestedPrincipal, 0n);
    const debtLine =
      termTotal > 0n
        ? `${money(termTotal)} term debt${revolver ? ` + ${money(revolver.requestedPrincipal)} revolver` : ''}`
        : revolver
          ? `${money(revolver.requestedPrincipal)} revolver only`
          : undefined;

    const byId = Object.fromEntries(model.assumptions.map((a) => [a.id, a]));
    const confidence = computeConfidenceScore({ byId, byPath: {}, confidenceScore: 0 });
    const register = [...model.assumptions]
      .sort((a, b) => (a.outsideBenchmark === b.outsideBenchmark ? a.label.localeCompare(b.label) : a.outsideBenchmark ? -1 : 1))
      .map(toRegisterRow);

    view.review = {
      monthZero: money(cMonthZero(c)),
      openingCash: money(c.openingCash),
      equity: money(plan.equityInjection),
      ...(plan.outsideCapital > 0n ? { outside: money(plan.outsideCapital) } : {}),
      ...(debtLine ? { debtLine } : {}),
      confidence: `${(confidence * 100).toFixed(1)}%`,
      register,
      arguable: arguableAssumptions(model.assumptions).map((a) => a.id),
      notes: session.notes.map(scrubEnums),
    };
  }

  return view;
}

const cMonthZero = (c: CandidateResult): Money => computeMonthZeroOutlays(c.model).total;
