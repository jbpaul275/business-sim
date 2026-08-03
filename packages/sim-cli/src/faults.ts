/**
 * What went wrong with a draft, in one line a player can read.
 *
 * The repair message used to be the raw issue text — `streams[1] (unused):
 * TRAFFIC needs a 'avgTicket' parameter`, "a delivery app's commission is a
 * VARIABLE_REVENUE line" — which is written for the model and was noise to
 * someone buying a soft-serve truck. So it was replaced with "the first draft
 * did not come out right", and that over-corrected into the opposite fault:
 * the player could no longer tell whether it was the same thing every time or
 * something new, and neither could I from a pasted transcript.
 *
 * The middle is a category. Not the schema path and not silence: *what kind*
 * of thing was wrong, in the vocabulary of the business rather than the
 * vocabulary of the validator.
 *
 * A repair round is normal rather than a malfunction — the draft is a large
 * structured object, the decoding grammar sometimes exceeds the API's size
 * limit and falls back to unconstrained generation where nothing enforces
 * shape, and the checks on top of that are strict on purpose. What matters is
 * that a *pattern* of repairs is visible, because that is the signal that one
 * of those checks is miscalibrated.
 */

interface Category {
  /** Matched against the issue text, which this codebase writes. */
  test: RegExp;
  /** How to say it to someone who is buying a business, not debugging one. */
  say: string;
}

const CATEGORIES: readonly Category[] = [
  { test: /revenue streams, and only the first/, say: 'it split the business into separate revenue streams' },
  { test: /\bstream\b.*(?:missing|required|Required)/, say: 'it left out the revenue stream' },
  { test: /needs a '\w+' parameter/, say: 'it left out the price' },
  { test: /has no revenue/, say: 'it priced the business at zero' },
  { test: /seasonality/, say: 'its seasonal weights rescaled the year instead of shaping it' },
  { test: /in a mature year/, say: 'its volume did not add up to the revenue it claimed' },
  { test: /CAPACITY_EXCEEDS_FOOTPRINT/, say: 'it put more capacity in the space than fits' },
  { test: /UTILIZATION_WITHOUT_STAFFING/, say: 'it gave a billable-hours business nobody to bill hours' },
  { test: /low above high/, say: 'it wrote a range backwards' },
  { test: /duplicate|appears twice/i, say: 'it named the same parameter twice' },
  { test: /could not be assembled|did not match the schema|fields were missing/, say: 'it came back incomplete' },
];

/**
 * One line for the whole round, however many issues it carries.
 *
 * Two problems usually have one cause, and a list reintroduces exactly the
 * wall of text this exists to avoid.
 */
export function summariseFaults(issues: readonly string[]): string {
  const seen: string[] = [];
  for (const issue of issues) {
    const hit = CATEGORIES.find((c) => c.test.test(issue));
    if (hit && !seen.includes(hit.say)) seen.push(hit.say);
  }
  if (seen.length === 0) return 'the first draft did not come out right';
  if (seen.length === 1) return `the first draft came back wrong — ${seen[0]}`;
  return `the first draft came back wrong — ${seen[0]}, and ${seen[1]}`;
}

/** The same, for a later round, so a pattern of repairs is visible. */
export function faultLine(issues: readonly string[], attempt: number): string {
  const what = summariseFaults(issues);
  return attempt <= 1
    ? `${what} — asking for a corrected one`
    : `${what.replace(/^the first draft/, `draft ${attempt}`)} — asking again`;
}
