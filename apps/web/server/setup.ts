import { randomUUID } from 'node:crypto';
import { fromDisplay, toDisplay, type Money } from '@bizsim/money';
import { computeMonthZeroOutlays, createWorldConfig } from '@bizsim/engine';
import type { Assumption, WorldConfig } from '@bizsim/schemas';
import {
  BudgetExhaustedError,
  ConceptInterview,
  ConceptRefusedError,
  MalformedDraftError,
  TransientError,
  UnusableResponseError,
  createConceptTransport,
  draftIssues,
  draftToTemplate,
  providerKeyPresent,
  providerKeyVar,
  type CallRecord,
  type ConceptDraft,
  type ConceptTransport,
  type MappedConcept,
} from '@bizsim/llm';
import { listSeedTemplates } from '@bizsim/seeds';
import {
  argueAssumption,
  arguableAssumptions,
  buildCandidate,
  buildabilityIssues,
  capacityCeilingIssues,
  capitalIntensityNote,
  proposeFunding,
  quoteForEquity,
  revenueRealityIssues,
  revolverFor,
  spendLine,
  staffingRealismIssues,
  type CandidateResult,
  type FundingContext,
  type FundingProposal,
  type JournalEvent,
} from '@bizsim/sim-cli';

/**
 * §9.1 Phases 0–4 as a server-side state machine — the CLI's setup flow with
 * the terminal removed.
 *
 * Same primitives, same order, same gates: the `ConceptInterview` drives
 * Phases 1–2, `proposeFunding`/`buildCandidate` carry Phase 4's arithmetic
 * (extracted so the two frontends cannot quote different plans), and
 * `argueAssumption` is the same §11.3 contract the CLI argues through. What
 * differs is only that state lives here between HTTP requests instead of
 * between prompts.
 */

export interface ChatEntry {
  who: 'you' | 'model' | 'system';
  text: string;
  /** The model's call-to-action line, kept separate for emphasis. */
  cta?: string;
  /** thought 12s, 3.1k thinking — the QA line under a model turn. */
  effort?: string;
}

export type SetupPhase = 'INTERVIEW' | 'FUNDING' | 'REVIEW' | 'DEAD';

export interface SeedChoice {
  scenario: string;
  templateId: string;
  label: string;
}

export interface SetupSession {
  id: string;
  phase: SetupPhase;
  /** The template the player chose to start from, when they chose one. */
  seed?: SeedChoice | undefined;
  transport: ConceptTransport;
  interview: ConceptInterview;
  calls: CallRecord[];
  events: JournalEvent[];
  chat: ChatEntry[];
  capital: Money;
  config: WorldConfig;
  concept?: { mapped: MappedConcept; draft: ConceptDraft };
  proposal?: FundingProposal | undefined;
  candidate?: CandidateResult | undefined;
  fundingAttempts: number;
  repairs: number;
  transientFailures: number;
  turns: number;
  /** Plausibility warnings and the capital-intensity note, shown at review. */
  notes: string[];
  deadReason?: string;
  /** Guards against concurrent model calls on one session. */
  busy: boolean;
}

const globalStore = globalThis as unknown as { __bizsimSetups?: Map<string, SetupSession> };
const setups: Map<string, SetupSession> = (globalStore.__bizsimSetups ??= new Map());

export const getSetup = (id: string): SetupSession | undefined => setups.get(id);

const MAX_REPAIRS = 2;
const MAX_TRANSIENT = 3;
const MAX_FINANCING_ATTEMPTS = 4;

const seconds = (ms: number): string =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function conceptAvailable(): { ok: boolean; keyVar: string } {
  return { ok: providerKeyPresent(), keyVar: providerKeyVar() };
}

export function createSetup(
  capitalDollars: number,
  // Injected in tests so the whole flow runs without a key or a network —
  // the same seam `RunSetupOptions.transport` gives the CLI.
  injectedTransport?: ConceptTransport,
  seed?: SeedChoice,
): SetupSession {
  const capital = fromDisplay(capitalDollars);
  const calls: CallRecord[] = [];
  const events: JournalEvent[] = [
    { kind: 'session', build: 'web-dev', startedAt: new Date().toISOString(), startCapital: toDisplay(capital) },
  ];
  const transport =
    injectedTransport ??
    createConceptTransport({
      onCall: (record) => {
        calls.push(record);
        events.push({ kind: 'call', ...record });
      },
    });
  const marketSeed = Date.now() % 1_000_000_007;
  events.push({ kind: 'market_seed', seed: marketSeed });

  const session: SetupSession = {
    id: randomUUID(),
    phase: 'INTERVIEW',
    transport,
    interview: new ConceptInterview({
      transport,
      templates: listSeedTemplates().map((t) => ({ id: t.id, label: t.label })),
    }),
    calls,
    events,
    ...(seed ? { seed } : {}),
    chat: [
      {
        who: 'model',
        // One question, then a conversation — and it is the question that
        // divides the two players this game serves: the investor who arrives
        // with research and wants it pressure-tested, and the daydreamer who
        // arrives with a vibe and wants help turning it into a business. The
        // options exhaust the space structurally; no reassurance tail needed.
        text: seed
          ? `${seed.label} it is. Do you have an idea in mind already, or would you like me to help you come up with one?`
          : 'What kind of business do you want to run? A half-formed idea is plenty.',
      },
    ],
    capital,
    config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: capital, marketSeed }),
    fundingAttempts: 0,
    repairs: 0,
    transientFailures: 0,
    turns: 0,
    notes: [],
    busy: false,
  };
  setups.set(session.id, session);
  return session;
}

/**
 * One player message through the interview, repair rounds included — the
 * CLI's `converse` loop, minus the terminal. Long-running by design: the
 * drafting call has run 85 seconds live, and the client shows that honestly
 * rather than this splitting into a polling protocol.
 */
/**
 * The interview's standing out — the "no more questions, build it" control.
 *
 * Depth is the player's choice: the KFC-inheritance player wants projections
 * after one message, the 256-flavours player wants forty turns on freezer
 * costs first, and both are right. This forces the draft with whatever has
 * been said so far; the interview prompt already covers thin transcripts
 * (estimate it, label it) and the register review still argues every number.
 */
export async function finishSetup(session: SetupSession): Promise<void> {
  return say(session, 'No more questions — build the model with what you have and estimate the rest.', {
    forceDraft: true,
  });
}

export async function say(
  session: SetupSession,
  text: string,
  opts: { forceDraft?: boolean } = {},
): Promise<void> {
  if (session.phase === 'DEAD') return;
  if (session.busy) throw new Error('a model call is already running for this session');
  session.busy = true;
  try {
    session.phase = 'INTERVIEW';
    session.candidate = undefined;
    session.proposal = undefined;
    session.chat.push({ who: 'you', text });

    // The seed rides the first message as a stated preference — the same
    // sentence a player would type themselves ("start from your coffee shop
    // template"), so the interview prompt needs no second channel and the
    // model still owns the fit judgement (D-5: it uses a template only when
    // the cost structure genuinely fits what was described).
    let reply =
      session.seed && session.turns === 0
        ? `${text}\n\n(Start from the "${session.seed.label}" template — ${session.seed.templateId} — where its cost structure fits.)`
        : text;
    let pendingRepair: string | undefined;

    for (;;) {
      let state;
      try {
        if (pendingRepair !== undefined) {
          const correction: string = pendingRepair;
          pendingRepair = undefined;
          const repaired: ConceptDraft = await session.interview.repairDraft(correction);
          state = {
            status: 'DRAFTED' as const,
            message: '',
            cta: '',
            draft: repaired,
          };
        } else if (opts.forceDraft) {
          // The player pressed the out. No conversational turn — straight to
          // the draft call, with their instruction in the transcript so the
          // model knows the gaps are its to estimate.
          const forced: ConceptDraft = await session.interview.finish(reply);
          state = { status: 'DRAFTED' as const, message: '', cta: '', draft: forced };
        } else {
          state = await session.interview.send(reply);
        }
      } catch (error) {
        if (error instanceof TransientError) {
          session.transientFailures += 1;
          if (session.transientFailures <= MAX_TRANSIENT) {
            if (error.phase === 'draft') {
              try {
                const draft = await session.interview.retryDraft();
                state = { status: 'DRAFTED' as const, message: '', cta: '', draft };
              } catch (again) {
                if (again instanceof TransientError) {
                  session.chat.push({
                    who: 'system',
                    text: 'The model is busy. Nothing is lost — send your message again.',
                  });
                  return;
                }
                throw again;
              }
            } else {
              // `send` rolled the message back out of the transcript; the same
              // reply can simply go again on the next attempt.
              session.chat.push({
                who: 'system',
                text: 'The model is busy. Nothing is lost — send your message again.',
              });
              return;
            }
          } else {
            session.chat.push({
              who: 'system',
              text: 'The model has been busy for several attempts running. Send again to retry.',
            });
            session.transientFailures = 0;
            return;
          }
        } else if (error instanceof ConceptRefusedError) {
          die(session, `${error.message} — this is the model's own safety filter, not a judgement about your business.`);
          return;
        } else if (error instanceof BudgetExhaustedError) {
          die(
            session,
            'The model could not fit this concept into a single draft, even with more room. ' +
              'Describe a simpler version — fewer channels, one location — and expand it once it is running.',
          );
          return;
        } else if (error instanceof MalformedDraftError && session.repairs < MAX_REPAIRS) {
          session.repairs += 1;
          session.events.push({ kind: 'draft_rejected', round: session.repairs, detail: error.detail });
          session.chat.push({ who: 'system', text: 'The draft came back incomplete — asking for a corrected one.' });
          pendingRepair =
            `That draft did not match the schema — ${error.detail}. ` +
            `Emit the whole draft again, with every required field present.`;
          continue;
        } else if (error instanceof UnusableResponseError || error instanceof MalformedDraftError) {
          die(session, error.message);
          return;
        } else {
          die(session, `The interview could not continue: ${(error as Error).message}`);
          return;
        }
      }

      if (!state) return;

      if (state.status === 'EXHAUSTED') {
        die(session, state.message);
        return;
      }

      if (state.message.trim() || state.cta.trim()) {
        session.events.push({
          kind: 'turn',
          index: session.turns,
          player: reply,
          message: state.message,
          cta: state.cta,
          ...(session.interview.lastReasoning ? { reasoning: session.interview.lastReasoning } : {}),
          ms: session.interview.lastTurn?.ms ?? 0,
          thinkingTokens: session.interview.lastTurn?.thinkingTokens ?? 0,
          calls: session.interview.lastTurn?.calls ?? 1,
        });
        session.turns += 1;
        const t = session.interview.lastTurn;
        const effort = t
          ? `thought ${seconds(t.ms)}${t.thinkingTokens > 0 ? `, ${tokens(t.thinkingTokens)} thinking` : ''}`
          : undefined;
        session.chat.push({
          who: 'model',
          text: state.message,
          ...(state.cta.trim() ? { cta: state.cta } : {}),
          ...(effort ? { effort } : {}),
        });
      }

      if (state.status === 'ASKING') return;

      // DRAFTED. Structural first, and only structural when there is any —
      // one root cause per repair round.
      const structural = [
        ...draftIssues(state.draft),
        ...buildabilityIssues(state.draft),
        ...capacityCeilingIssues(state.draft),
      ];
      const issues =
        structural.length > 0
          ? structural
          : [...revenueRealityIssues(state.draft), ...staffingRealismIssues(state.draft)];
      if (issues.length > 0 && session.repairs < MAX_REPAIRS) {
        session.repairs += 1;
        session.events.push({ kind: 'fault', round: session.repairs, issues });
        session.chat.push({ who: 'system', text: 'The draft has problems the model can fix — asking for a corrected one.' });
        pendingRepair =
          `That draft has structural problems: ${issues.join(' ')} ` +
          `Please correct them and emit the draft again.`;
        continue;
      }
      const unbuildable = [...draftIssues(state.draft), ...buildabilityIssues(state.draft)];
      if (unbuildable.length > 0) {
        die(session, `The model could not produce a buildable draft: ${unbuildable.join(' ')}`);
        return;
      }

      // Survivable warnings ride to the review screen rather than dying here.
      session.notes = [
        ...revenueRealityIssues(state.draft),
        ...staffingRealismIssues(state.draft),
        ...capacityCeilingIssues(state.draft),
      ];

      session.events.push({
        kind: 'draft',
        businessName: state.draft.businessName,
        archetype: state.draft.stream.archetype,
        draft: state.draft,
        ms: session.interview.lastDraft?.ms ?? 0,
      });

      session.concept = { mapped: draftToTemplate(state.draft), draft: state.draft };
      session.proposal = proposeFunding(fundingContext(session));
      session.phase = 'FUNDING';
      return;
    }
  } finally {
    session.busy = false;
  }
}

export function undo(session: SetupSession): boolean {
  const undone = session.interview.undo();
  if (undone) {
    // Take the pair — the player's message and the model's answer — off the
    // visible chat too, mirroring the transcript exactly.
    while (session.chat.length > 0 && session.chat[session.chat.length - 1]!.who !== 'you') {
      session.chat.pop();
    }
    session.chat.pop();
  }
  return undone;
}

function fundingContext(session: SetupSession): FundingContext {
  const mapped = session.concept!.mapped;
  return {
    businessName: mapped.businessName,
    template: mapped.template,
    archetype: mapped.archetype,
    scale: mapped.scale,
    marketing: mapped.template.modifierDefaults.baseMarketingSpendPerQuarter,
    config: session.config,
    provenanceFor: mapped.provenanceFor,
  };
}

export interface FundOutcome {
  ok: boolean;
  /** Why not, when not: lender declines, a shortfall, or a floor violation. */
  declined?: { kind: string; reason: string }[];
  shortfall?: Money;
  belowFloor?: Money;
  attemptsLeft?: number;
}

/** Phase 4 — one financing attempt against the gate and the lender. */
export function fund(
  session: SetupSession,
  request: { proposed: true } | { equityDollars: number },
): FundOutcome {
  if (session.phase !== 'FUNDING' || !session.concept || !session.proposal) {
    return { ok: false };
  }
  const ctx = fundingContext(session);
  const p = session.proposal;

  let equity: Money;
  let outside = 0n;
  let loan: Money;
  let revolver: Money;
  if ('proposed' in request) {
    equity = p.proposedEquity;
    loan = p.proposedLoan;
    revolver = p.proposedRevolver;
  } else {
    const dealEquity = fromDisplay(request.equityDollars);
    if (dealEquity < p.equityFloor) {
      return { ok: false, belowFloor: p.equityFloor };
    }
    const quote = quoteForEquity(p.needed, session.config.primeRate, dealEquity);
    loan = quote.loan;
    revolver = revolverFor(p.lendable, dealEquity, loan);
    outside = dealEquity > p.investable ? dealEquity - p.investable : 0n;
    equity = dealEquity - outside;
  }

  const candidate = buildCandidate(ctx, { equity, outside, loan, revolver });
  if (candidate.errors.length > 0) {
    die(session, `This model cannot be committed: ${candidate.errors.join('; ')}`);
    return { ok: false };
  }

  session.fundingAttempts += 1;
  const attemptsLeft = MAX_FINANCING_ATTEMPTS - session.fundingAttempts;

  if (candidate.declined.length > 0 || candidate.shortfall > 0n) {
    if (attemptsLeft <= 0) {
      die(
        session,
        'The gap has not closed in four tries, so the business is probably too big for the money ' +
          'rather than badly financed. Start again and describe something smaller.',
      );
      return { ok: false };
    }
    return {
      ok: false,
      ...(candidate.declined.length > 0 ? { declined: candidate.declined } : {}),
      ...(candidate.shortfall > 0n ? { shortfall: candidate.shortfall } : {}),
      attemptsLeft,
    };
  }

  session.candidate = candidate;
  session.phase = 'REVIEW';
  // The campground owner's sentence, at the moment he needs it: a build whose
  // debt no operating year services, said before commit rather than in a
  // scrolled-away draft note.
  const heavy = capitalIntensityNote(
    session.concept.draft,
    computeMonthZeroOutlays(candidate.model).total,
  );
  session.notes = [...session.notes, ...candidate.warnings, ...(heavy ? [heavy] : [])];
  return { ok: true };
}

export interface ChallengeResult {
  ruling: string;
  reasoning: string;
  clarifyingQuestion?: string;
  secondOrderEffect?: string;
  applied: boolean;
  clamped: boolean;
  resultingValue: string;
  provenance: string;
}

/** Phase 3 — argue with one number, through the same §11.3 contract as the CLI. */
export async function challenge(
  session: SetupSession,
  assumptionId: string,
  rawValue: string,
  basis: string,
): Promise<ChallengeResult | { error: string }> {
  const model = session.candidate?.model;
  if (session.phase !== 'REVIEW' || !model) return { error: 'nothing to challenge yet' };
  const target = model.assumptions.find((a) => a.id === assumptionId);
  if (!target) return { error: 'no such assumption' };
  const asserted = parseAssumptionValue(target, rawValue);
  if (asserted === undefined) return { error: `"${rawValue}" is not a valid value for ${target.label}` };
  if (session.busy) return { error: 'a model call is already running' };

  session.busy = true;
  try {
    const outcome = await argueAssumption({
      transport: session.transport,
      target,
      writeTo: model,
      asserted,
      basis,
      archetype: model.streams[0]?.archetype ?? 'TRAFFIC',
      businessName: model.businessName,
    });
    session.events.push({ kind: 'objection', text: `challenge ${target.label}: ${rawValue} ${basis}`.trim() });
    return {
      ruling: outcome.settlement.ruling,
      reasoning: outcome.settlement.reasoning,
      ...(outcome.settlement.clarifyingQuestion
        ? { clarifyingQuestion: outcome.settlement.clarifyingQuestion }
        : {}),
      ...(outcome.settlement.secondOrderEffect
        ? { secondOrderEffect: outcome.settlement.secondOrderEffect }
        : {}),
      applied: outcome.applied,
      clamped: outcome.settlement.clamped,
      resultingValue: renderAssumptionValue(target),
      provenance: target.provenance,
    };
  } finally {
    session.busy = false;
  }
}

/** A structural objection re-enters the interview, transcript intact. */
export async function object(session: SetupSession, text: string): Promise<void> {
  session.events.push({ kind: 'objection', text });
  session.repairs = 0;
  await say(session, text);
}

function die(session: SetupSession, reason: string): void {
  session.phase = 'DEAD';
  session.deadReason = reason;
  session.chat.push({ who: 'system', text: reason });
}

export function spendSummary(session: SetupSession): string | undefined {
  return spendLine(session.calls) || undefined;
}

// ---------------------------------------------------------------------------
// Value parsing/rendering, shared with the in-game assume route
// ---------------------------------------------------------------------------

export function parseAssumptionValue(target: Assumption, raw: string): number | Money | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if (target.isMoney) {
    const cleaned = text.replace(/[$,]/g, '');
    const scaled = /k$/i.test(cleaned)
      ? Number(cleaned.replace(/k$/i, '')) * 1_000
      : /m$/i.test(cleaned)
        ? Number(cleaned.replace(/m$/i, '')) * 1_000_000
        : Number(cleaned);
    if (!Number.isFinite(scaled) || scaled < 0) return undefined;
    return fromDisplay(scaled);
  }
  if (target.unit === 'pct') {
    const numeric = Number(text.replace(/%$/, '').replace(/,/g, ''));
    if (!Number.isFinite(numeric)) return undefined;
    const rate = text.endsWith('%') || numeric > 1 ? numeric / 100 : numeric;
    return rate >= 0 && rate <= 1 ? rate : undefined;
  }
  const numeric = Number(text.replace(/,/g, ''));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

export const renderAssumptionValue = (a: Assumption): string => {
  if (typeof a.value === 'bigint') return toDisplay(a.value, { showCents: false });
  if (a.unit === 'pct') return `${Number((a.value * 100).toPrecision(4))}%`;
  return String(Number(a.value.toPrecision(6)));
};

export { arguableAssumptions };
