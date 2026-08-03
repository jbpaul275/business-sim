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
/**
 * Markup that has no business in a terminal interview. A third live corruption
 * spliced several complete attempts together and left the seams showing:
 * `</summary>`, `<br><br>`, `</p>`. Nothing this prompt asks for is HTML, so a
 * closing tag is unambiguous evidence rather than a heuristic.
 */
const STRAY_MARKUP = /<\/?(?:summary|br|p|div|span|thinking|answer)\b[^>]*>/i;

/**
 * A long run of text appearing twice.
 *
 * The same corruption restated its answer three times — "Fair enough — I'll
 * build a plausible target and you correct it" and near-variants — which no
 * per-word signal notices, because none of the words repeat *adjacently*.
 * Forty characters is long enough that ordinary prose does not repeat it by
 * accident, and short enough to catch a restated sentence.
 */
function hasRepeatedRun(text: string, run = 40): boolean {
  const t = text.replace(/\s+/g, ' ');
  if (t.length < run * 2) return false;
  const seen = new Set<string>();
  for (let i = 0; i + run <= t.length; i++) {
    const slice = t.slice(i, i + run);
    if (seen.has(slice)) return true;
    seen.add(slice);
  }
  return false;
}

/**
 * A reply that begins mid-word.
 *
 * The fourth live corruption merged word boundaries rather than duplicating or
 * interleaving: "sethe practical ceiling" for "Set the practical ceiling", and
 * "a muchantially bigger crew" for "a much more substantially bigger crew".
 * Every earlier signal scores zero on it — nothing repeats, nothing is
 * doubled, no markup leaks — because the damage is a dropped boundary rather
 * than added text.
 *
 * This catches only the case where the merge lands on the first word, which is
 * a fraction of the shape. It earns its place because the evidence is
 * unambiguous rather than statistical: this prompt asks for prose, and prose
 * does not open in lower case. Nothing in the corpus of good answers does.
 *
 * Mid-sentence merges are not caught, and are not catchable without a
 * dictionary. A heuristic guessing at whether "muchantially" is a word would
 * throw away real answers containing real unusual words, which costs more than
 * the corruption does.
 */
const OPENS_MID_WORD = /^\s*\p{Ll}/u;

/**
 * A sentence ending and the next beginning with no space between them.
 *
 * "Position matters most for capture.what the daily traffic looks like" — the
 * same boundary-dropping corruption, landing mid-reply where the opening
 * signal cannot see it. Both runs are required to be four letters or more,
 * which excludes the shapes that legitimately look like this: `e.g.`, `sq.ft`,
 * decimals, and hostnames, whose suffixes are almost all shorter than that.
 */
const RUNS_SENTENCES_TOGETHER = /\p{Ll}{4,}\.\p{Ll}{4,}/u;

export function looksGarbled(text: string): boolean {
  if (STRAY_MARKUP.test(text)) return true;
  if (OPENS_MID_WORD.test(text)) return true;
  if (RUNS_SENTENCES_TOGETHER.test(text)) return true;
  if (adjacentDuplicateRate(text) > 0.12) return true;
  if (hasRepeatedRun(text)) return true;
  const repeats = text.split(/\s+/).filter((w) => hasInternalRepeat(w)).length;
  return repeats >= 2;
}
