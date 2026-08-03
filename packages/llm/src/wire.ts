import { zodToJsonSchema } from 'zod-to-json-schema';
import { looksGarbled } from './garbled.js';
import { zTurnAdvice } from './advice.js';
import { zAdjudication } from './challenge.js';
import { zConceptDraft, zInterviewTurn } from './draft.js';
import { zTurnNarration } from './narration.js';

/**
 * What goes on the wire, independent of who is on the other end of it.
 *
 * Shared by the Anthropic and Kimi transports. Both compile the same four
 * schemas from the same Zod definitions and both parse the result with those
 * same definitions, which is the property that makes swapping providers a
 * transport change rather than a rewrite: the shapes the rest of the codebase
 * relies on cannot drift between them, because there is only one of each.
 *
 * Deliberately not re-exported from `index.ts`. These are the details of
 * talking to a model, and nothing above the transport should be reaching for
 * them.
 */

/**
 * The Anthropic SDK ships a `zodOutputFormat` helper, but it is typed against
 * Zod 4 and the rest of this monorepo is on Zod 3. Splitting Zod versions
 * across packages to gain one helper is a bad trade — schemas cross package
 * boundaries here — so schemas are converted to plain JSON Schema and handed to
 * the provider directly, then parsed with the same Zod 3 schema every other
 * package already uses.
 */
const jsonSchemaFor = (schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> =>
  // Structured outputs require `additionalProperties: false` on every object
  // and reject `$ref`, so the schema has to be emitted inline. Both providers
  // impose this; neither is being accommodated specially.
  zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;

export const TURN_SCHEMA = jsonSchemaFor(zInterviewTurn);
export const DRAFT_SCHEMA = jsonSchemaFor(zConceptDraft);
export const ADVICE_SCHEMA = jsonSchemaFor(zTurnAdvice);
export const ADJUDICATION_SCHEMA = jsonSchemaFor(zAdjudication);
export const NARRATION_SCHEMA = jsonSchemaFor(zTurnNarration);

/**
 * The draft asked for as prose, for the fallback path. Constrained decoding is
 * the better mechanism when it is available; this is what we send when the
 * grammar will not compile.
 */
export const DRAFT_AS_PROSE =
  'Emit the complete concept draft now, as a single JSON object and nothing ' +
  'else — no prose before or after, no markdown fence. It must match the ' +
  'schema you were given exactly, including every required field.';

/** Unconstrained generation likes markdown fences; constrained never emits one. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

/**
 * Model output to a JSON value, tolerating the shapes weak enforcement emits.
 *
 * The first live K2.6 session died two turns in on `Expected object, received
 * string`: the model returned the turn **double-encoded** — a JSON string
 * containing the JSON object — so `JSON.parse` succeeded and produced a
 * string, and Zod rightly refused it. That is what "schema support" without
 * constrained decoding looks like from the outside: mostly right, sometimes
 * wrapped, occasionally prose around the object.
 *
 * Three shapes, tried in order: the text as-is; the outermost `{…}` when prose
 * surrounds it; one unwrap when the value parses to a string. Never more than
 * one unwrap, and never anything cleverer — every result still goes through
 * the same Zod schema, so the guarantee stays "cannot pass unnoticed". This
 * recovers encodings of the right answer, not wrong answers.
 */
export function parseModelJson(text: string): unknown {
  const cleaned = stripFence(text);
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch (error) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last <= first) throw error;
    value = JSON.parse(cleaned.slice(first, last + 1));
  }
  if (typeof value === 'string') value = JSON.parse(value.trim());
  return value;
}

/**
 * A turn that cannot be shown or replayed.
 *
 * Two ways this happens, both seen live. The model returns text that is
 * corrupted — doubled, or two answers interleaved. Or it returns nothing at
 * all: valid JSON, schema-clean, empty strings. The second is the more
 * dangerous, because an empty assistant turn cannot go back into the
 * transcript — the API rejects a whitespace-only content block — so one empty
 * response ends the conversation two turns later with an error about message
 * formatting.
 */
export const isUnusable = (turn: { message: string; cta: string }): boolean =>
  turn.message.trim().length === 0 ||
  turn.cta.trim().length === 0 ||
  looksGarbled(turn.message) ||
  looksGarbled(turn.cta);
