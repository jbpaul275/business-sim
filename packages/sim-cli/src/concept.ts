import {
  AnthropicConceptTransport,
  ConceptInterview,
  ConceptRefusedError,
  MalformedDraftError,
  UnusableResponseError,
  draftIssues,
  draftToTemplate,
  type ConceptDraft,
  type ConceptTransport,
  type MappedConcept,
} from '@bizsim/llm';
import { listSeedTemplates } from '@bizsim/seeds';
import { ask, type LineSource } from './input.js';
import { waiting } from './waiting.js';
import { buildabilityIssues, revenueRealityIssues } from './plausibility.js';
import { accent, note, rule, speech, youPrompt } from './ui.js';
import { spendLine } from './spend.js';

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
 */
export const conceptPathAvailable = (): boolean =>
  Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);

export async function runConceptInterview(
  input: LineSource,
  transport?: ConceptTransport,
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
  console.log(
    `${DIM}  \`why\` after any answer shows the reasoning behind it. Ctrl-C to abandon setup.${RESET}\n`,
  );

  let spinner = { stop: () => {}, label: (_: string) => {} };
  const interview = new ConceptInterview({
    transport: transport ?? new AnthropicConceptTransport(),
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

  for (;;) {
    if (!reply.trim()) {
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

    if (/^(why|explain)\b/i.test(reply)) {
      showReasoning();
      reply = await ask(input, youPrompt(), '', (raw) => raw.trim() || undefined);
      continue;
    }

    let state;
    spinner = waiting('thinking');
    try {
      state = await interview.send(reply);
    } catch (error) {
      spinner.stop();
      if (error instanceof ConceptRefusedError) {
        console.log(`\n  ${RED}${error.message}${RESET}`);
        console.log(`  ${DIM}This is the model's own safety filter, not a judgement about your business.${RESET}`);
        return undefined;
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
    console.log(`\n${speech(BOLD + wrap(state.cta, 70, '') + RESET)}`);
    if (state.message.trim() && interview.lastReasoning) {
      console.log(`${accent('▏')} ${DIM}\`why\` to see how it got there${RESET}`);
    }
    console.log('');

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
    const structural = [...draftIssues(state.draft), ...buildabilityIssues(state.draft)];
    const issues =
      structural.length > 0 ? structural : revenueRealityIssues(state.draft);
    if (issues.length > 0 && repairs < MAX_REPAIRS) {
      repairs += 1;
      console.log(`  ${YELLOW}The draft has problems I need to fix:${RESET}`);
      for (const issue of issues) console.log(`    - ${wrap(issue, 70, '      ').trimStart()}`);
      reply =
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
    for (const issue of revenueRealityIssues(state.draft)) {
      console.log(`\n  ${YELLOW}⚠ ${wrap(issue, 70, '    ').trimStart()}${RESET}`);
    }

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
    const spent = spendLine(interview.usage);
    if (spent) console.log(`\n${note(spent)}`);

    return { mapped: draftToTemplate(state.draft), draft: state.draft };
  }
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

  const stream = draft.streams[0];
  if (stream) {
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
