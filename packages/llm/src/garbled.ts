/**
 * Detecting a response that arrived corrupted rather than merely bad.
 *
 * Seen live, twice in one interview:
 *
 *   "LagosLagos–Ab–Abujauja is is Nigeria Nigeria''ss densest densest trunk"
 *   "NigeriaNigeria'sis domesticthe market only has African the market volumes"
 *
 * The first is every token emitted twice. The second is two *different* texts
 * interleaved character by character — one answer about Nigeria's volumes, one
 * comparing it to the DRC, spliced together. Both reached the player as prose.
 *
 * The cause is above this package: the JSON parsed cleanly and the `message`
 * field simply contained the mess, so it is a generation or serving artifact
 * rather than a bug in the client. That is exactly why it needs catching here —
 * we cannot fix it, but we can decline to show it, and a retry is cheap.
 *
 * Both signatures are easy to separate from real prose, which matters more than
 * catching every possible corruption: a false positive throws away a good
 * answer and costs a round trip, so the thresholds are set to be quiet.
 */

const normalise = (word: string): string => word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/**
 * A word containing an immediately repeated run of characters — "LagosLagos",
 * "Abujauja", "trunktrunk". Interleaving produces these constantly and ordinary
 * writing almost never does. Six characters minimum so "mama" and "papa" are
 * not evidence of anything.
 */
function hasInternalRepeat(word: string, minRun = 3): boolean {
  const w = normalise(word);
  if (w.length < 6) return false;
  for (let size = minRun; size <= Math.floor(w.length / 2); size++) {
    for (let i = 0; i + 2 * size <= w.length; i++) {
      if (w.slice(i, i + size) === w.slice(i + size, i + 2 * size)) return true;
    }
  }
  return false;
}

/**
 * Share of words identical to the word before them.
 *
 * Only meaningful over a decent span: "it is very, very expensive" is one
 * duplicate in eight words and reads as 0.125, which is above the threshold a
 * long corrupted response needs. Short answers repeat legitimately; corrupted
 * ones are never short.
 */
const MIN_WORDS_FOR_RATE = 20;

function adjacentDuplicateRate(text: string): number {
  const words = text.split(/\s+/).map(normalise).filter((w) => w.length > 1);
  if (words.length < MIN_WORDS_FOR_RATE) return 0;
  let duplicates = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) duplicates += 1;
  }
  return duplicates / (words.length - 1);
}

/**
 * Two independent signals, either sufficient. Measured against the live
 * failures and against prose containing brand names and camel case, which is
 * the obvious false positive:
 *
 *   token doubling      duplicate rate 0.38, internal repeats 2
 *   interleaved texts   duplicate rate 0.03, internal repeats 3
 *   ordinary prose      0.00 and 0 across every sample tried, including
 *                       "McDonald's ... iPhone-era ... PepsiCo's"
 */
export function looksGarbled(text: string): boolean {
  if (adjacentDuplicateRate(text) > 0.12) return true;
  const repeats = text.split(/\s+/).filter((w) => hasInternalRepeat(w)).length;
  return repeats >= 2;
}
