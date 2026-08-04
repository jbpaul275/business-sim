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
}

const NOTES_SHOWN = 3;

export function toSetupView(session: SetupSession): SetupView {
  const view: SetupView = {
    id: session.id,
    phase: session.phase,
    chat: session.chat,
    busy: session.busy,
    ...(session.deadReason ? { deadReason: session.deadReason } : {}),
    ...(spendSummary(session) ? { spend: spendSummary(session)! } : {}),
  };

  if (session.concept) {
    const draft = session.concept.draft;
    view.draft = {
      businessName: draft.businessName,
      summary: draft.summary,
      archetype: draft.stream.archetype,
      archetypeRationale: draft.stream.archetypeRationale.split(/(?<=\.)\s+/)[0] ?? '',
      openNotes: draft.openNotes.slice(0, NOTES_SHOWN),
      hiddenNotes: Math.max(0, draft.openNotes.length - NOTES_SHOWN),
      synthetic: draft.seedTemplateId === null,
    };
  }

  if (session.phase === 'FUNDING' && session.proposal) {
    const p = session.proposal;
    const money = (m: Money): string => toDisplay(m, { showCents: false });
    const plan =
      p.proposedLoan > 0n
        ? `${money(p.proposedEquity)} of your own plus a ${money(p.proposedLoan)} SBA 7(a)` +
          (p.proposedRevolver > 0n ? `, and a ${money(p.proposedRevolver)} revolver` : '')
        : `${money(p.proposedEquity)} of your own, no debt needed`;
    view.funding = {
      needed: money(p.needed),
      investable: money(p.investable),
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
      notes: session.notes,
    };
  }

  return view;
}

const cMonthZero = (c: CandidateResult): Money => computeMonthZeroOutlays(c.model).total;
