import {
  askAdvisor,
  createConceptTransport,
  narrateQuarter,
  providerKeyPresent,
  type AdviceTransport,
  type NarrationTransport,
} from '@bizsim/llm';
import { buildBriefing } from '@bizsim/sim-cli';
import type { Business } from '@bizsim/schemas';
import type { AdvisorEntry, GameSession, StagedMove, SuggestedMove } from './store';

/**
 * The model's half of the turn loop — narration over the quarter, and the
 * conversation in between. Everything here fails soft, same as the CLI: no
 * key, a transport fault, or a reply that quoted money the ledger never
 * produced all leave the deterministic screen — statements, attribution,
 * eigen question — intact and say nothing further.
 */

/**
 * The levers this build actually has. The web action bar carries price,
 * marketing, staffing and assumption revisions; `skip` is the run buttons.
 * Debt, expansion and the portfolio exist in the engine but have no web
 * controls yet, so they are deliberately absent — the briefing's closing
 * rule makes the advisor say "not in this build" instead of describing a
 * control that is not on the screen.
 */
export const WEB_COMMANDS: readonly string[] = [
  'price <amount> — set the price per unit; demand responds through the elasticity',
  'marketing <amount> — set marketing spend per quarter; diminishing returns',
  'assume <id> <value> — revise a model assumption by id: a COGS rate, a revenue share, a cost per unit. This is how supplier switches and renegotiated terms are recorded',
  'hire <line> [n] / fire <line> [n] — add or remove staffed blocks; cost lands now, capacity next quarter',
  'skip <n> — run quarters unattended',
];

const advisorFor = (session: GameSession): (AdviceTransport & Partial<NarrationTransport>) | undefined => {
  // A pre-set transport (a test double, or an earlier call) wins; otherwise
  // one is created when a key exists, journaling every call for the QA share.
  if (!session.transport) {
    if (!providerKeyPresent()) return undefined;
    session.transport = createConceptTransport({
      onCall: (record) => {
        session.events.push({ kind: 'call', ...record });
      },
    });
  }
  return session.transport;
};

const businessOf = (session: GameSession): Business | undefined =>
  session.world.businesses.find((b) => b.id === session.businessId);

const briefingFor = (session: GameSession, business: Business) =>
  buildBriefing(session.world, business, session.last, [], WEB_COMMANDS, {
    ...(session.prevQuarter ? { prior: session.prevQuarter } : {}),
    events: session.log.at(-1)?.events ?? [],
    attributions: session.attributions,
  });

/**
 * §11.5 narration for the quarter just advanced, inserted into the feed
 * BEFORE that quarter's eigen question — the turn is data first, then the
 * question, and the question is deterministic while this is optional color.
 */
export async function narrateAdvance(session: GameSession): Promise<void> {
  const advisor = advisorFor(session);
  const business = businessOf(session);
  if (!advisor?.narrate || !business || business.status === 'CLOSED') return;
  const period = session.last.statements.period;
  try {
    const outcome = await narrateQuarter(
      { narrate: (system, input) => advisor.narrate!(system, input) },
      briefingFor(session, business),
      () => Date.now(),
      session.attributions,
    );
    if (!outcome) {
      session.events.push({ kind: 'narration_failed', period });
      return;
    }
    const n = outcome.narration;
    const entry: AdvisorEntry = {
      who: 'advisor',
      kind: 'update',
      period,
      headline: n.headline,
      text: n.narrative,
    };
    const questionAt = session.advisor.findIndex(
      (e) => e.kind === 'question' && e.period === period,
    );
    if (questionAt >= 0) session.advisor.splice(questionAt, 0, entry);
    else session.advisor.push(entry);
    session.events.push({ kind: 'narration', period, headline: n.headline, narrative: n.narrative, ms: outcome.ms });
    if (outcome.retriedOn && outcome.retriedOn.length > 0) {
      session.events.push({ kind: 'narration_corrected', period, figures: outcome.retriedOn });
    }
  } catch {
    // A transport fault costs the player a paragraph, not a turn.
    session.events.push({ kind: 'narration_failed', period });
  }
}

/** How much chat history rides along on each question. */
const HISTORY_MESSAGES = 12;

/**
 * One conversational exchange. The player's message always enters the feed —
 * a question that vanished because the model faltered would read as the game
 * eating input — and the failure modes each get an honest, non-technical line.
 */
export async function askGame(
  session: GameSession,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const business = businessOf(session);
  if (!business) return { ok: false, error: 'no business in this session' };
  const advisor = advisorFor(session);
  if (!advisor) return { ok: false, error: 'no model key is set on the server' };
  if (session.advisorBusy) return { ok: false, error: 'the advisor is already thinking' };

  session.advisorBusy = true;
  const history = session.advisor
    .filter((e) => e.kind === 'chat')
    .slice(-HISTORY_MESSAGES)
    .map((e) => ({
      role: e.who === 'you' ? ('user' as const) : ('assistant' as const),
      content: e.text,
    }));
  session.advisor.push({ who: 'you', kind: 'chat', text });
  try {
    const outcome = await askAdvisor(
      advisor,
      briefingFor(session, business),
      text,
      history,
      () => Date.now(),
    );
    if (!outcome) {
      // Twice it could not answer without inventing a figure. The CLI goes
      // silent; a chat cannot, so the honest sentence stands in.
      session.events.push({ kind: 'advice_refused', question: text });
      session.advisor.push({
        who: 'advisor',
        kind: 'chat',
        text: 'I could not answer that without making up a number, so I will not — the statements on screen are the reliable version.',
      });
      return { ok: true };
    }
    const suggested = outcome.suggestedCommands
      .map((c) => parseSuggestion(c, business))
      .filter((s): s is SuggestedMove => s !== undefined);
    session.advisor.push({
      who: 'advisor',
      kind: 'chat',
      text: outcome.reply,
      ...(suggested.length > 0 ? { suggested } : {}),
    });
    if (outcome.retriedOn && outcome.retriedOn.length > 0) {
      session.events.push({ kind: 'advice_corrected', question: text, figures: outcome.retriedOn });
    }
    return { ok: true };
  } catch {
    session.events.push({ kind: 'advice_failed', question: text });
    session.advisor.push({
      who: 'advisor',
      kind: 'chat',
      text: 'I could not reach the model just now. The numbers on screen are unaffected — try again in a moment.',
    });
    return { ok: true };
  } finally {
    session.advisorBusy = false;
  }
}

/**
 * A suggested command, translated into something the action bar can stage.
 * Validated against the actual register and staffing lines — a chip that
 * stages a move the engine would reject is worse than no chip. Suggestions
 * that do not parse are dropped; the advice text still carries the idea.
 */
export function parseSuggestion(command: string, business: Business): SuggestedMove | undefined {
  const tokens = command.trim().split(/\s+/);
  const verb = (tokens[0] ?? '').toLowerCase();
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw.replace(/[$,]/g, ''));
    return Number.isFinite(value) ? value : undefined;
  };

  const stage = ((): StagedMove | undefined => {
    if (verb === 'price') {
      const value = num(tokens[1]);
      return value !== undefined && value > 0 ? { type: 'price', value } : undefined;
    }
    if (verb === 'marketing') {
      const value = num(tokens[1]);
      return value !== undefined && value >= 0 ? { type: 'marketing', value } : undefined;
    }
    if (verb === 'assume') {
      const assumptionId = tokens[1];
      const value = tokens[2];
      if (!assumptionId || value === undefined) return undefined;
      if (!business.assumptions.byId[assumptionId]) return undefined;
      return { type: 'assume', assumptionId, value };
    }
    if (verb === 'hire' || verb === 'fire') {
      const line = tokens[1];
      if (!line) return undefined;
      const cost = business.costs.stepFixed.find(
        (c) => c.id === line || c.label.toLowerCase() === line.toLowerCase(),
      );
      if (!cost) return undefined;
      const n = num(tokens[2]) ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
      return { type: 'staff', costId: cost.id, delta: verb === 'hire' ? n : -n };
    }
    return undefined;
  })();

  return stage ? { command, stage } : undefined;
}

export const advisorAvailable = (): boolean => providerKeyPresent();
