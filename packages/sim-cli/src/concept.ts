import {
  ConceptInterview,
  createConceptTransport,
  providerKeyPresent,
  providerKeyVar,
  BudgetExhaustedError,
  ConceptRefusedError,
  TransientError,
  isCancellation,
  MalformedDraftError,
  UnusableResponseError,
  draftIssues,
  draftToTemplate,
  type ConceptDraft,
  type CallRecord,
  type ConceptTransport,
  type MappedConcept,
} from '@bizsim/llm';
import { listSeedTemplates } from '@bizsim/seeds';
import { ask, type LineSource } from './input.js';
import { waiting } from './waiting.js';
import {
  buildabilityIssues,
  capacityCeilingIssues,
  revenueRealityIssues,
  staffingRealismIssues,
} from './plausibility.js';
import { accent, note, rule, speech, youPrompt } from './ui.js';
import { spendLine } from './spend.js';
import { faultLine } from './faults.js';
import type { Journal } from './journal.js';

/**
 * §9.1 Phases 1-2 as a conversation.
 *
 * What this replaces is the INPUT METHOD, not the phase. Phase 3 still reviews
 * every assumption with its provenance, Phase 4 is still a real gate, and the
 * engine still validates the result identically whether it came from a picker
 * or a chat. The difference is that the business no longer has to be one of
 * twelve things somebody thought of in advance.
 */

const BOLD = '[1m';
const DIM = '[2m';
const RESET = '[0m';
const YELLOW = '[33m';
const RED = '[31m';

export interface ConceptResult {
  mapped: MappedConcept;
  draft: ConceptDraft;
  /**
   * Re-enter the interview with a structural objection, transcript intact.
   *
   * Exists because the register can only move numbers. "I want to buy the
   * planes, not lease them" removes a cost line, adds capex and changes month
   * zero — a drafting question, and the conversation is the only thing that
   * can redraft. Returns the fresh result (also reopenable), or undefined if
   * the reopened conversation was abandoned.
   */
  reopen: (objection: string) => Promise<ConceptResult | undefined>;
}

/** Wrap plain text to a readable width — a terminal is not a chat window. */
function wrap(text: string, width = 76, indent = '  '): string {
  return text
    .split('\n')
    .map((paragraph) => {
      if (paragraph.trim() === '') return '';
      const words = paragraph.split(/\s+/);
      const lines: string[] = [];
      let line = '';
      for (const word of words) {
        if (line.length + word.length + 1 > width) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
      return lines.map((l) => indent + l).join('\n');
    })
    .join('\n');
}

/**
 * True when a live model is reachable. Checked rather than assumed so the CLI
 * can fall back to the structured path with an explanation instead of dying
 * with a stack trace on a missing key.
 *
 * Which key that is now depends on the provider — see `providerName`. The check
 * used to name `ANTHROPIC_API_KEY` here and in two other places, which is how a
 * provider switch turns into a bug hunt.
 */
export const conceptPathAvailable = (): boolean => providerKeyPresent();

/** The variable to export, for the message shown when there is not one. */
export const conceptKeyVar = (): string => providerKeyVar();

/**
 * How hard the last turn worked, for the line under the model's answer.
 *
 * Both currencies, because they measure different things and the gap between
 * them is the point: seconds are what the player waits and are hostage to load
 * and network; thinking tokens are what was actually spent reasoning and are
 * what `effort` controls. A turn that takes 30s and thought for 400 tokens was
 * slow for reasons the prompt cannot fix. One that thought 9,000 tokens on
 * "which town?" is the prompt's problem.
 *
 * This is QA data as much as player-facing: it travels in a pasted transcript,
 * which is how the effort settings actually get tuned.
 */
const seconds = (ms: number): string =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function effortLine(
  turn: { ms: number; thinkingTokens: number; calls: number } | undefined,
): string {
  if (!turn) return '';
  const thought = turn.thinkingTokens > 0 ? `, ${tokens(turn.thinkingTokens)} thinking` : '';
  // A turn that took two calls is a discarded reply, not slow reasoning. They
  // look identical on the clock and need opposite fixes, so say which it was.
  const retried = turn.calls > 1 ? `, ${turn.calls} calls` : '';
  return `thought ${seconds(turn.ms)}${thought}${retried}`;
}

export async function runConceptInterview(
  input: LineSource,
  transport?: ConceptTransport,
  journal?: Journal,
): Promise<ConceptResult | undefined> {
  console.log(`\n${rule('What are you building?')}`);
  console.log(
    speech(
      wrap(
        'Describe it however you like — a sentence is enough to start. I will ask ' +
          'what I need and estimate the rest, and you will see every number before ' +
          'anything is committed.',
        70,
        '',
      ),
    ),
  );
  /**
   * Which model is answering, said before it answers.
   *
   * "How can I confirm it's using Kimi and not Anthropic?" had no answer until
   * the session ended and the spend line named the models — which is too late
   * to be running the comparison you meant to run. Two provider keys can be
   * exported at once by design, so the resolved one is not guessable from the
   * environment either.
   *
   * Deliberately dim and on the hint line rather than announced: a player who
   * does not care should not have to read about model routing before they have
   * described their business.
   */
  let spinner = { stop: () => {}, label: (_: string) => {} };
  /**
   * Every model call, on disk as it happens.
   *
   * Kept in memory too, because the end-of-interview spend line prices the same
   * records — one source, so the number on screen and the number in the corpus
   * cannot disagree about what a session cost.
   */
  const calls: CallRecord[] = [];
  const live =
    transport ??
    createConceptTransport({
      onCall: (record) => {
        calls.push(record);
        journal?.write({ kind: 'call', ...record });
      },
    });

  /**
   * Which model is answering, said before it answers.
   *
   * "How can I confirm it's using Kimi and not Anthropic?" had no answer until
   * the session ended and the spend line named the models — which is too late
   * to be running the comparison you meant to be running. Two provider keys can
   * be exported at once by design, so the resolved one is not guessable from
   * the environment either.
   *
   * Read off the transport rather than re-derived, because the transport has
   * already resolved it. A screen naming the wrong model would be worse than
   * one naming none: it is the answer to the question being asked.
   *
   * Dim, and on the hint line rather than announced. A player who does not care
   * should not have to read about model routing before describing a business.
   */
  console.log(
    `${DIM}  \`why\` shows the reasoning · \`undo\` takes back your last message ·` +
      ` Ctrl-C stops a reply` +
      `${live.describe ? `\n  answered by ${live.describe()}` : ''}${RESET}\n`,
  );

  /**
   * Ctrl-C while the model is thinking stops the model, not the session.
   *
   * Someone pasted a fragment by accident and then had no way to take it back:
   * the only key that does anything during a call killed the whole setup, so
   * the choice was fifty-three seconds of a wrong answer or losing ten minutes
   * of conversation. Neither is a choice anyone should be offered.
   *
   * The handler is installed only around the call. Outside one, Ctrl-C keeps
   * its usual meaning — readline owns it, and abandoning setup is still one
   * keystroke away.
   */
  const whileCalling = async <T>(work: () => Promise<T>): Promise<T> => {
    let stopped = false;
    const onSigint = (): void => {
      if (stopped) {
        // Twice means they mean the session, not the call.
        process.exit(130);
      }
      stopped = true;
      live.cancel?.();
    };
    process.on('SIGINT', onSigint);
    try {
      return await work();
    } finally {
      process.off('SIGINT', onSigint);
    }
  };

  const interview = new ConceptInterview({
    transport: live,
    onDrafting: () => spinner.label('building the model'),
    // The templates are offered as a convenience, not a menu: the model uses
    // one only when its cost structure genuinely fits, and otherwise emits its
    // own cost lines (D-5).
    templates: listSeedTemplates().map((t) => ({ id: t.id, label: t.label })),
  });

  let reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
  /**
   * Consecutive blank replies before giving up.
   *
   * `ask` cannot distinguish "pressed enter" from "stdin is closed" — both
   * arrive as an empty string. Looping on either spins forever: piped input
   * runs out, every subsequent read returns empty, and the process allocates
   * transcript state until it is killed. Two blanks is generous for a human
   * and immediate enough for a closed pipe.
   */
  let blanks = 0;
  const MAX_BLANKS = 2;

  /**
   * Repair rounds spent sending a faulty draft back to the model.
   *
   * Bounded, because the loop that feeds issues back had no limit at all: a
   * model that keeps reproducing the same fault would be asked to fix it
   * forever, burning a call each time, with the player watching a spinner.
   * Two attempts is enough for a slip and short of an argument.
   */
  let repairs = 0;
  const MAX_REPAIRS = 2;

  /**
   * Consecutive "the model is busy" failures before asking the player.
   *
   * The SDK already backs off and retries inside a single call; this is the
   * layer above, for when that whole sequence exhausts. Three more attempts is
   * a minute or so of patience against the alternative of describing the
   * business again from scratch.
   */
  let transientFailures = 0;
  const MAX_TRANSIENT = 3;
  let turns = 0;

  /**
   * A correction for the drafting call, set by a repair round.
   *
   * When present, the next pass skips the conversational half entirely —
   * `repairDraft` puts the correction in front of the drafting call and only
   * the drafting call. Routing it through `send` (the old shape) paid a full
   * turn call first, whose entire contribution was the model saying
   * "resending it now" to the player, at 8-15 seconds and one billed call per
   * repair round.
   */
  let pendingRepair: string | undefined;

  /**
   * `why` shows the reasoning behind the last turn.
   *
   * It costs nothing. Thinking is billed whether or not the summary is
   * returned, and the default throws it away — so the honest short answer the
   * player asked for and the full working they occasionally want are the same
   * response, not two. No extra call, no extra turn, no extra bill.
   */
  const showReasoning = (): void => {
    if (!interview.lastReasoning) {
      console.log(`\n  ${DIM}Nothing recorded for that turn.${RESET}\n`);
      return;
    }
    console.log(`\n  ${DIM}── how it got there ${'─'.repeat(52)}${RESET}`);
    console.log(`${DIM}${wrap(interview.lastReasoning, 74)}${RESET}`);
    console.log(
      `  ${DIM}${'─'.repeat(72)}${RESET}\n` +
        `  ${DIM}A summary of the model's own reasoning, not a rewritten answer.${RESET}\n`,
    );
  };

  /**
   * The interview loop, callable more than once on the same conversation.
   *
   * "wait, I don't want to lease I want to buy the planes" — typed at the
   * challenge prompt, three screens after the draft, where the only grammar
   * was `challenge <n> <value>` and the reply was a canned hint. A structural
   * change is a drafting question, and the only thing that can redraft is
   * this conversation — so the result carries `reopen`, which re-enters this
   * loop with the whole transcript intact and returns a fresh draft.
   */
  const converse = async (first: string): Promise<ConceptResult | undefined> => {
    reply = first;
    blanks = 0;
    // A reopened conversation argues about a new draft, so it gets fresh
    // repair rounds — same rule as the argue-with-it prompt below.
    repairs = 0;
    pendingRepair = undefined;

    for (;;) {
      // A repair pass carries no new player message, so the player-input
      // handling below (blanks, `why`, `undo`) must not re-read the stale one.
      if (pendingRepair === undefined && !reply.trim()) {
        blanks += 1;
        if (blanks > MAX_BLANKS) {
          console.log(`\n  ${DIM}No input — abandoning setup. Nothing was committed.${RESET}`);
          return undefined;
        }
        console.log(`  ${DIM}Say something about the business, or Ctrl-C to abandon setup.${RESET}`);
        reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
        continue;
      }
      blanks = 0;

      if (pendingRepair === undefined && /^(why|explain)\b/i.test(reply)) {
        showReasoning();
        reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
        continue;
      }

      /**
       * "I didn't mean to send that."
       *
       * A pasted fragment — "re Blend it out and a" — cost fifty-three seconds
       * and put a question nobody asked into the transcript, with an answer to it
       * underneath. Every turn after that was reasoning against both. Taking the
       * pair back out is the whole fix.
       */
      if (pendingRepair === undefined && /^(undo|back|oops|scratch that)\b/i.test(reply)) {
        console.log(
          interview.undo()
            ? `  ${DIM}Taken back. The conversation is where it was before that message.${RESET}`
            : `  ${DIM}Nothing to take back yet.${RESET}`,
        );
        reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
        continue;
      }

      let state;
      spinner = waiting(
        pendingRepair !== undefined
          ? 'asking for a corrected draft'
          : process.stdout.isTTY
            ? 'thinking · Ctrl-C to stop'
            : 'thinking',
      );
      try {
        if (pendingRepair !== undefined) {
          // Annotated to cut a type-inference cycle: `state` evolves from this
          // branch, the repair correction at the bottom of the loop derives
          // from `state`, and `converse` referencing itself through `reopen`
          // makes the checker resolve the whole loop at once.
          const correction: string = pendingRepair;
          pendingRepair = undefined;
          const repaired: ConceptDraft = await whileCalling(() => interview.repairDraft(correction));
          state = {
            status: 'DRAFTED' as const,
            message: '',
            cta: '',
            draft: repaired,
            transcript: interview.transcript,
          };
        } else {
          state = await whileCalling(() => interview.send(reply));
        }
      } catch (error) {
        spinner.stop();
        /**
         * A busy model must not cost the conversation.
         *
         * A plastics factory died two turns in on `overloaded_error` — a
         * transient capacity signal that says nothing about the conversation —
         * and the player was told to start over and describe it again. That is
         * the one response that is definitely wrong. The transcript is intact in
         * memory and `send` rolls the unanswered message back out of it, so the
         * same reply can simply go again.
         */
        /**
         * Ctrl-C during a call stops the call, not the session.
         *
         * `send` has already rolled the message back out of the transcript by the
         * time this runs, so the conversation is exactly as it was — which means
         * the right thing to do is hand back the prompt and say nothing else.
         * Retrying a cancellation would be the opposite of what was asked for.
         */
        if (isCancellation(error)) {
          console.log(`  ${DIM}Stopped. Nothing was sent — your last message is not in the conversation.${RESET}`);
          journal?.write({ kind: 'cancelled' });
          reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
          continue;
        }

        if (error instanceof TransientError) {
          transientFailures += 1;
          if (transientFailures <= MAX_TRANSIENT) {
            console.log(
              `${DIM}  the model is busy — trying that again (${transientFailures} of ${MAX_TRANSIENT})${RESET}`,
            );
            journal?.write({ kind: 'transient', phase: error.phase, attempt: transientFailures });
            // A failed draft is not a failed turn. The turn before it succeeded
            // and is already in the transcript, so replaying the player's message
            // would put it there twice and the model would answer a conversation
            // that did not happen. Retry only the half that failed.
            if (error.phase === 'draft') {
              try {
                spinner = waiting('building the model');
                const draft = await interview.retryDraft();
                spinner.stop();
                state = { status: 'DRAFTED', message: '', cta: '', draft, transcript: interview.transcript };
              } catch (again) {
                spinner.stop();
                if (again instanceof TransientError) continue;
                throw again;
              }
            } else {
              continue;
            }
          } else {
          console.log(`\n  ${YELLOW}The model has been busy for several attempts running.${RESET}`);
            console.log(
              note(
                'Nothing is lost — press enter to try the same message again, or type something' +
                  ' else to carry on from here.',
              ),
            );
            transientFailures = 0;
            const again = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
            if (again.trim()) reply = again;
            continue;
          }
        }
        if (error instanceof ConceptRefusedError) {
          console.log(`\n  ${RED}${error.message}${RESET}`);
          console.log(`  ${DIM}This is the model's own safety filter, not a judgement about your business.${RESET}`);
          return undefined;
        }
        if (error instanceof BudgetExhaustedError) {
          // Only reachable when the retry with more room ran out too, which
          // means the concept is genuinely large rather than the budget wrong.
          console.log(
            `\n  ${RED}${wrap('The model could not fit this concept into a single draft, even with more room.', 74, '')}${RESET}`,
          );
          console.log(
            note(
              'Raise it with BIZSIM_DRAFT_MAX_TOKENS, or describe a simpler version — fewer' +
                ' channels, one location — and expand it once it is running.',
            ),
          );
          return undefined;
        }
        /**
         * A draft the schema rejects is a repair round, not the end of the run.
         *
         * It ended one live session over three missing `provenance` fields on a
         * nine-parameter soft-serve truck — a fault the model fixes in one call
         * when told, and which cost the player four turns of conversation
         * instead. Everything else that goes wrong with a draft already goes
         * back to the model; this was the one that did not, for no reason but
         * that it failed a different check.
         */
        if (error instanceof MalformedDraftError && repairs < MAX_REPAIRS) {
          repairs += 1;
          console.log(`${DIM}  ${faultLine([error.detail], repairs)}${RESET}`);
          if (process.env['BIZSIM_DEBUG']) console.log(`    ${DIM}${error.message}${RESET}`);
          // The paths go to the journal even though they are hidden from the
          // player: which fields the model forgets, across sessions, is what
          // decides whether the cure is a schema default, a prompt line, or a
          // different draft model.
          journal?.write({ kind: 'draft_rejected', round: repairs, detail: error.detail });
          pendingRepair =
            `That draft did not match the schema — ${error.detail}. ` +
            `Emit the whole draft again, with every required field present.`;
          continue;
        }
        if (error instanceof UnusableResponseError || error instanceof MalformedDraftError) {
          console.log(`\n  ${RED}${wrap(error.message, 74, '')}${RESET}`);
          console.log(`  ${DIM}Nothing was committed. Run \`pnpm sim --new\` to start again.${RESET}`);
          return undefined;
        }
        // Anything else — a bad key, a rate limit, a malformed draft — should
        // end setup with a sentence, not a stack trace. Losing the conversation
        // to an unhandled 400 is a worse failure than whatever caused it.
        console.log(`\n  ${RED}The interview could not continue: ${(error as Error).message}${RESET}`);
        console.log(`  ${DIM}Nothing was committed. Run \`pnpm sim --new\` to start again.${RESET}`);
        return undefined;
      }
      spinner.stop();

      if (state.status === 'EXHAUSTED') {
        console.log(`\n  ${YELLOW}${wrap(state.message, 74, '')}${RESET}`);
        return undefined;
      }

      // The conversation gets a left edge, so the region of the screen that is
      // someone talking is distinguishable at a glance from the region that is
      // the ledger. They should not look alike.
      if (state.message.trim()) console.log(`\n${speech(wrap(state.message, 70, ''))}`);
      // A repair or draft-retry pass has no conversational half — printing its
      // empty cta would draw a blank speech bubble between spinner and register.
      if (state.cta.trim()) console.log(`\n${speech(BOLD + wrap(state.cta, 70, '') + RESET)}`);
      // A repair or draft-retry pass made no conversational turn: journalling
      // one would record the previous player message a second time with a blank
      // answer, and the footer would print the timing of a turn that did not
      // happen on this pass.
      if (state.message.trim() || state.cta.trim()) {
        journal?.write({
          kind: 'turn',
          index: turns,
          player: reply,
          message: state.message,
          cta: state.cta,
          ...(interview.lastReasoning ? { reasoning: interview.lastReasoning } : {}),
          ms: interview.lastTurn?.ms ?? 0,
          thinkingTokens: interview.lastTurn?.thinkingTokens ?? 0,
          calls: interview.lastTurn?.calls ?? 1,
        });
        turns += 1;

        const effort = effortLine(interview.lastTurn);
        const why = state.message.trim() && interview.lastReasoning ? '`why` to see how it got there' : '';
        const footer = [why, effort].filter(Boolean).join(' · ');
        if (footer) console.log(`${accent('▏')} ${DIM}${footer}${RESET}`);
        console.log('');
      }

      if (state.status === 'ASKING') {
        reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
        continue;
      }

      // A draft can be well-formed and still be incoherent as data. These are
      // structural faults only — nothing here has an opinion about whether the
      // business is a good idea (D-5).
      //
      // Plus one check the LLM package cannot make, because making it requires
      // the engine: does the drafted volume actually produce the revenue the
      // draft says this business does? A model that states $3.5M and builds
      // $1.4M has contradicted itself, and the costs it wrote are sized for the
      // first number.
      // ...and one the engine already knows how to make. Running the validator
      // here rather than only at the commit gate is the difference between a
      // repair round and a dead end: an offshore rave ship put 700 guests into
      // 2,000 square feet, and the player found out after five financing
      // questions and a million dollars, with the conversation gone.
      // Structural first, and *only* structural when there is any. A lunar base
      // with no `ratePerUnitPerQuarter` prices at zero, so the revenue check
      // dutifully reported "$0 in a mature year, off by 0.00x" — a magnitude
      // claim about a shadow of the real fault, printed above it. One root cause
      // per round: the model fixes the price, and the revenue check gets a
      // meaningful number to check on the next pass.
      // A business that cannot break even with every unit sold is structural in
      // the only sense that matters: no decision downstream closes the gap. It
      // belongs with the faults that stop a draft, not with the warnings.
      const structural = [
        ...draftIssues(state.draft),
        ...buildabilityIssues(state.draft),
        ...capacityCeilingIssues(state.draft),
      ];
      // Both plausibility checks share the repair round when nothing structural
      // is wrong: a business whose revenue is right and whose staffing never
      // grows has one fault, not none, and the model can fix both at once.
      const issues =
        structural.length > 0
          ? structural
          : [...revenueRealityIssues(state.draft), ...staffingRealismIssues(state.draft)];
      if (issues.length > 0 && repairs < MAX_REPAIRS) {
        repairs += 1;
        /**
         * The player is told that something is being fixed, not what.
         *
         * These strings are written for the model — `streams[1]`, `avgTicket`,
         * "a delivery app's commission is a VARIABLE_REVENUE line" — and a live
         * session put all of that in front of someone buying a soft-serve truck.
         * It is the model's homework. That it is being redone is worth one line;
         * the schema vocabulary is not.
         */
        journal?.write({ kind: 'fault', round: repairs, issues });
        console.log(`${DIM}  ${faultLine(issues, repairs)}${RESET}`);
        if (process.env['BIZSIM_DEBUG']) {
          for (const issue of issues) console.log(`    ${DIM}- ${wrap(issue, 70, '      ').trimStart()}${RESET}`);
        }
        pendingRepair =
          `That draft has structural problems: ${issues.join(' ')} ` +
          `Please correct them and emit the draft again.`;
        continue;
      }
      // Out of repair attempts and still faulty. A draft that will not build
      // cannot be shown at all; a revenue contradiction can, and the player is
      // better off seeing the numbers and arguing with them than losing the
      // conversation over them.
      const unbuildable = [...draftIssues(state.draft), ...buildabilityIssues(state.draft)];
      if (unbuildable.length > 0) {
        console.log(`\n  ${RED}The model could not produce a buildable draft:${RESET}`);
        for (const issue of unbuildable) {
          console.log(`    ${RED}- ${wrap(issue, 70, '      ').trimStart()}${RESET}`);
        }
        console.log(`  ${DIM}Nothing was committed. Run \`pnpm sim --new\` to start again.${RESET}`);
        return undefined;
      }
      for (const issue of [
        ...revenueRealityIssues(state.draft),
        ...staffingRealismIssues(state.draft),
        ...capacityCeilingIssues(state.draft),
      ]) {
        console.log(`\n  ${YELLOW}⚠ ${wrap(issue, 70, '    ').trimStart()}${RESET}`);
      }

      // The draft is much the slower call — 85 seconds in one live run — and the
      // spinner that showed it disappears the moment it lands. Say what it cost.
      if (interview.lastDraft) {
        const d = interview.lastDraft;
        const thought = d.thinkingTokens > 0 ? `, ${tokens(d.thinkingTokens)} thinking` : '';
        console.log(`${DIM}  built the model in ${seconds(d.ms)}${thought}${RESET}`);
      }

      journal?.write({
        kind: 'draft',
        businessName: state.draft.businessName,
        archetype: state.draft.stream.archetype,
        draft: state.draft,
        ms: interview.lastDraft?.ms ?? 0,
      });

      renderConceptNotes(state.draft);

      /**
       * "Worth arguing with first" — and then, until now, nothing to argue with.
       *
       * The draft names the three figures it is least sure of and the CLI went
       * straight to asking for a marketing budget. Offering the three most
       * uncertain numbers in a business and then refusing to discuss them is
       * worse than not offering: it reads as a feature that does not work.
       */
      const objection = await ask(
        input,
        `\n${BOLD}Argue with any of it, or press enter to price it up: ${RESET}`,
        '',
        (raw) => raw.trim() || undefined,
      );
      if (objection.trim()) journal?.write({ kind: 'objection', text: objection });
      if (objection.trim()) {
        // A fresh drafting attempt the player asked for, so it gets fresh repair
        // rounds. Carrying the old count forward would mean a concept that took
        // two repairs early can never be argued with later.
        repairs = 0;
        reply = objection;
        continue;
      }

      // What the conversation cost, once, at the end. Not a running total: a
      // number ticking up while someone decides what to build changes what they
      // build, and this is a design tool before it is a budget.
      journal?.write({ kind: 'spend', ...interview.usage });
      const spent = spendLine(calls);
      if (spent) console.log(`\n${note(spent)}`);

      return {
        mapped: draftToTemplate(state.draft),
        draft: state.draft,
        // The conversation stays live behind the result: a structural
        // objection raised later in setup — at the register, after funding —
        // re-enters it here rather than dying against a numbers-only prompt.
        reopen: (objection: string) => converse(objection),
      };
    }
  };

  return converse(reply);
}

/** How many open notes to show before the rest go behind `notes`. */
const NOTES_SHOWN = 3;

/**
 * The concept, as briefly as it can honestly be put.
 *
 * Everything the model produced is kept; what is *shown* is the top of it. A
 * first live draft printed eight open notes at three lines each plus a
 * paragraph justifying the archetype against the two it rejected — accurate,
 * and a wall of text between the player and their numbers. The rejected
 * alternatives are the model's working, not the player's finding.
 */
export function renderConceptNotes(draft: ConceptDraft): void {
  console.log(`\n${BOLD}${draft.businessName}${RESET}`);
  console.log(wrap(draft.summary));

  const stream = draft.stream;
  {
    // First sentence only: "why this archetype", not "and here is why not the
    // other five", which is reasoning the player did not ask for.
    const reason = stream.archetypeRationale.split(/(?<=\.)\s+/)[0] ?? '';
    console.log(`\n  ${DIM}Revenue archetype${RESET}  ${stream.archetype}  ${DIM}${reason}${RESET}`);
  }

  if (draft.seedTemplateId === null) {
    console.log(
      `  ${DIM}No template fits, so cost lines were estimated directly and carry no` +
        ` benchmark bands.${RESET}`,
    );
  }

  if (draft.openNotes.length > 0) {
    console.log(`\n  ${YELLOW}Worth arguing with first:${RESET}`);
    for (const note of draft.openNotes.slice(0, NOTES_SHOWN)) {
      console.log(wrap(`- ${note}`, 74, '    '));
    }
    const hidden = draft.openNotes.length - NOTES_SHOWN;
    if (hidden > 0) {
      console.log(`  ${DIM}...and ${hidden} more — every one is in the register below.${RESET}`);
    }
  }
}
