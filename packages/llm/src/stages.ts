import { z } from 'zod';
import { assertDraftShape, zConceptDraft, type ConceptDraft } from './draft.js';

/**
 * The draft as a pipeline of small calls instead of one monolith.
 *
 * The one-shot draft was the largest thing this codebase asks a model to do:
 * 85 seconds live, and a schema so large the constrained-decoding grammar
 * sometimes exceeded the API's size limit — at which point generation fell
 * back to unconstrained, which is where malformed drafts came from, which is
 * why the repair loop exists. Splitting the draft into stages makes every
 * call small enough that the grammar always compiles, makes a repair fix one
 * section instead of regenerating everything, and lets the player watch the
 * spec assemble instead of staring at a spinner.
 *
 * Stage shapes are `.pick()`ed from `zConceptDraft`, never redeclared — the
 * assembled object parses under the full schema by construction, and a field
 * added to the draft lands in exactly one stage or the assembly fails loudly
 * in tests.
 *
 * The spine is deliberately one call: archetype, parameters and the revenue
 * claim mutually constrain each other (volume × price must multiply out to
 * `expectedAnnualRevenue`), and splitting them is where incoherence would
 * actually creep in. Everything downstream elaborates the spine.
 */

export const zDraftSpine = zConceptDraft.pick({
  businessName: true,
  summary: true,
  legalForm: true,
  seedTemplateId: true,
  stream: true,
});
export const zDraftCosts = zConceptDraft.pick({ costLines: true });
export const zDraftCapital = zConceptDraft.pick({ capex: true, workingCapital: true });
export const zDraftFinish = zConceptDraft.pick({
  overheads: true,
  openNotes: true,
  founderProfile: true,
});

export type DraftStageName = 'spine' | 'costs' | 'capital' | 'finish';

export interface DraftStage {
  name: DraftStageName;
  /** Progress label, in the player's vocabulary. */
  label: string;
  schema: z.ZodTypeAny;
  /** The stage's ask, given everything already fixed. */
  instruction: (built: Readonly<Record<string, unknown>>) => string;
}

/**
 * Later stages see the earlier sections verbatim. That is the coherence
 * mechanism: the cost lines are written against the spine's actual scale and
 * archetype, not against a memory of the conversation.
 */
const consistent = (built: Readonly<Record<string, unknown>>): string =>
  Object.keys(built).length > 0
    ? `\n\nAlready fixed, verbatim — stay consistent with every figure in it:\n${JSON.stringify(built)}`
    : '';

const emitOnly = (what: string): string =>
  `Emit ONLY ${what}, as a single JSON object matching the section schema — no prose, no markdown fence, no fields from other sections.`;

export const DRAFT_STAGES: readonly DraftStage[] = [
  {
    name: 'spine',
    label: 'the revenue engine',
    schema: zDraftSpine,
    instruction: (built) =>
      `${emitOnly(
        'the concept spine: businessName, summary, legalForm, seedTemplateId, and the single revenue stream',
      )} The stream's parameters must genuinely multiply out to its expectedAnnualRevenue.${consistent(built)}`,
  },
  {
    name: 'costs',
    label: 'the cost structure',
    schema: zDraftCosts,
    instruction: (built) =>
      `${emitOnly('the operating cost lines: costLines')} Size them against the spine's scale and archetype.${consistent(built)}`,
  },
  {
    name: 'capital',
    label: 'what it takes to open',
    schema: zDraftCapital,
    instruction: (built) =>
      `${emitOnly('the capital section: capex and workingCapital')}${consistent(built)}`,
  },
  {
    name: 'finish',
    label: 'overheads and open questions',
    schema: zDraftFinish,
    instruction: (built) =>
      `${emitOnly('the closing section: overheads, openNotes, and founderProfile')} openNotes are ordered by what would change their decision, and a note recording a fork you guessed is written as a deferred question — branch taken, live alternative, what changes if they meant the other. founderProfile carries ONLY what the player actually said about their experience and hours — never an inference; leave the defaults when they said nothing.${consistent(built)}`,
  },
];

/** The assembled whole, validated under the full draft schema. */
export function assembleDraft(built: Readonly<Record<string, unknown>>): ConceptDraft {
  return assertDraftShape(built);
}
