import {
  AnthropicConceptTransport,
  ConceptInterview,
  ConceptRefusedError,
  draftIssues,
  draftToTemplate,
  type ConceptDraft,
  type ConceptTransport,
  type MappedConcept,
} from '@bizsim/llm';
import { listSeedTemplates } from '@bizsim/seeds';
import { ask, type LineSource } from './input.js';

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
  console.log(`\n${BOLD}WHAT ARE YOU BUILDING?${RESET}`);
  console.log(
    wrap(
      'Describe it however you like — a sentence is enough to start. I will ask ' +
        'what I need and estimate the rest, and you will see every number before ' +
        'anything is committed.',
    ),
  );
  console.log(`${DIM}${wrap('Ctrl-C to abandon setup.', 76, '  ')}${RESET}\n`);

  const interview = new ConceptInterview({
    transport: transport ?? new AnthropicConceptTransport(),
    // The templates are offered as a convenience, not a menu: the model uses
    // one only when its cost structure genuinely fits, and otherwise emits its
    // own cost lines (D-5).
    templates: listSeedTemplates().map((t) => ({ id: t.id, label: t.label })),
  });

  let reply = await ask(input, `${BOLD}you${RESET} > `, '', (raw) => raw.trim() || undefined);

  for (;;) {
    let state;
    try {
      state = await interview.send(reply);
    } catch (error) {
      if (error instanceof ConceptRefusedError) {
        console.log(`\n  ${RED}${error.message}${RESET}`);
        console.log(`  ${DIM}This is the model's own safety filter, not a judgement about your business.${RESET}`);
        return undefined;
      }
      // Anything else — a bad key, a rate limit, a malformed draft — should
      // end setup with a sentence, not a stack trace. Losing the conversation
      // to an unhandled 400 is a worse failure than whatever caused it.
      console.log(`\n  ${RED}The interview could not continue: ${(error as Error).message}${RESET}`);
      console.log(`  ${DIM}Nothing was committed. Run \`pnpm sim --new\` to start again.${RESET}`);
      return undefined;
    }

    if (state.status === 'EXHAUSTED') {
      console.log(`\n  ${YELLOW}${wrap(state.message, 74, '')}${RESET}`);
      return undefined;
    }

    console.log(`\n${wrap(state.message)}`);
    console.log(`\n${BOLD}${wrap(state.cta, 74)}${RESET}\n`);

    if (state.status === 'ASKING') {
      reply = await ask(input, `${BOLD}you${RESET} > `, '', (raw) => raw.trim() || undefined);
      continue;
    }

    // A draft can be well-formed and still be incoherent as data. These are
    // structural faults only — nothing here has an opinion about whether the
    // business is a good idea (D-5).
    const issues = draftIssues(state.draft);
    if (issues.length > 0) {
      console.log(`  ${YELLOW}The draft has problems I need to fix:${RESET}`);
      for (const issue of issues) console.log(`    - ${issue}`);
      reply =
        `That draft has structural problems: ${issues.join(' ')} ` +
        `Please correct them and emit the draft again.`;
      continue;
    }

    return { mapped: draftToTemplate(state.draft), draft: state.draft };
  }
}

/** What the model estimated rather than learned, shown before the register. */
export function renderConceptNotes(draft: ConceptDraft): void {
  console.log(`\n${BOLD}${draft.businessName}${RESET}`);
  console.log(wrap(draft.summary));

  const stream = draft.streams[0];
  if (stream) {
    console.log(`\n  ${DIM}Revenue archetype${RESET}  ${stream.archetype}`);
    console.log(wrap(stream.archetypeRationale, 74, '    '));
  }

  if (draft.seedTemplateId === null) {
    console.log(
      `\n  ${DIM}${wrap(
        'No seed template fits this concept, so its cost lines were estimated ' +
          'directly and it carries no benchmark bands. That is deliberate: an ' +
          'inherited band would flag every line against numbers that do not ' +
          'describe this business.',
        74,
        '',
      )}${RESET}`,
    );
  }

  if (draft.openNotes.length > 0) {
    console.log(`\n  ${YELLOW}Least certain, and the first things worth arguing with:${RESET}`);
    for (const note of draft.openNotes) console.log(wrap(`- ${note}`, 74, '    '));
  }
}
