import { describe, expect, it } from 'vitest';
import { looksGarbled } from './garbled.js';

/**
 * The two corruptions below are verbatim from a live interview about starting
 * an airline. Both parsed as valid JSON and both reached the player as prose.
 */

const DOUBLED =
  "LagosLagos–Ab–Abujauja is is Nigeria Nigeria''ss densest densest trunk trunk,, " +
  'roughly roughly a a one one--hourhour hop hop,, so so an an M MDD--8383 can can ' +
  "turn turn it it three three or or four four times times a a day day.. I I''llll " +
  'model model the the A AOCOC process process,, heavy heavy maintenance maintenance ' +
  'reserves reserves and and Naira Naira fuel fuel exposure exposure myself myself ' +
  'as as estimates estimates..';

const INTERLEAVED =
  "LagosLagos.. NigeriaNigeria'sis domesticthe market only has African the market " +
  'volumes with and the fare volumes levels and to fare fill levels 160 to seats ' +
  'fill several 160 times seats a several day, times mostly a on day the — ' +
  'Lagos–Ab Lagos–Abujauja–Port–Port Harcourt Harcourt triangle triangle,. and D ' +
  'MDRC-80 hass are have familiar looser to oversight the and engineers no there surface.';

const RESTATED =
  '.a $2M perm search shop doing roughly $2.5-3M with 8-10 recruiters — searches ' +
  'opened, a fill rate, and an average fee per placement — plus SBA debt service on ' +
  "the $1M note. Every number will be my estimate, not a comp I've read.<br><br>Want " +
  'me to draft that so you can start argue with the figures?</p></summary>Fair — ' +
  "you've never seen the inside of one, so I'll build a plausible acquisition target " +
  "and you correct it. I'll model a $2M perm search firm at roughly $2.6M revenue, 9 " +
  'recruiters, fees as a percentage of placed salary, with SBA debt service on the $1M ' +
  'note.the the dials from there.</summary>Fair enough — I\'ll build a plausible ' +
  'target and you tear into it.</summary>Fair enough — I\'ll build a plausible ' +
  'target and you correct it.';

describe('looksGarbled', () => {
  it('catches every token emitted twice', () => {
    expect(looksGarbled(DOUBLED)).toBe(true);
  });

  it('catches two different answers interleaved character by character', () => {
    // This one barely registers on adjacent-duplicate rate — 0.03, inside the
    // noise floor — and is caught by the malformed words interleaving creates.
    expect(looksGarbled(INTERLEAVED)).toBe(true);
  });

  it('catches several complete attempts spliced together', () => {
    // The third corruption, and the one that got through: three restatements of
    // the same answer with HTML seams left in. No word repeats adjacently and
    // no word is malformed, so both earlier signals score zero.
    expect(looksGarbled(RESTATED)).toBe(true);
  });

  it('catches stray markup on its own', () => {
    // Nothing in a terminal interview about business models is HTML, so a
    // closing tag is evidence rather than a heuristic.
    expect(looksGarbled('Fine — a bistro it is.</summary>')).toBe(true);
    expect(looksGarbled('Two questions.<br><br>How big is the room?')).toBe(true);
  });

  it('catches a restated sentence with no adjacent duplicates', () => {
    const restated =
      'I will build a plausible acquisition target and you correct the figures. ' +
      'Then we can look at the debt service together. ' +
      'I will build a plausible acquisition target and you correct the figures.';
    expect(looksGarbled(restated)).toBe(true);
  });

  it('catches a reply that begins mid-word', () => {
    // The fourth live shape, on a traveling circus: word boundaries dropped
    // rather than text duplicated, so every earlier signal scores zero.
    expect(
      looksGarbled(
        'sethe practical ceiling: two-pole big top, roughly 1,500-2,000 seats, up in ' +
          "three to four hours with a dozen crew. Go three or four poles for 3,000+ and " +
          "you're into a full-day raising and a muchantially bigger crew.",
      ),
    ).toBe(true);
  });

  it('catches several attempts spliced with no sentence breaks', () => {
    // Verbatim, from a food-truck session. Two or three drafts of the same
    // answer run together: a lower-case opening, a sentence boundary with the
    // space eaten, and a trailing run of full stops.
    expect(
      looksGarbled(
        'the demand right — who buys? Farmers markets, breweries, office parks, ' +
          'festivals? Position matters most for capture.what the daily traffic looks ' +
          'like. Location strategy drives everything: a brewery lot on a Friday night ' +
          'is a different business from a weekday office park....',
      ),
    ).toBe(true);
  });

  it('does not flag punctuation that legitimately has no space after it', () => {
    // The cost of the sentence-boundary signal, checked rather than assumed.
    for (const text of [
      'Rent is $3.50 a square foot, e.g. a 900 sq.ft unit at $3,150.',
      'Their site is at example.com and the filing is on sec.gov.',
      'Roughly 1.5 turns a day vs. 2.2 for a drive-thru.',
      'The FDD Item 6 lists it; see franchise.org for the current one.',
    ]) {
      expect(looksGarbled(text), text).toBe(false);
    }
  });

  it('leaves ordinary answers alone', () => {
    const real = [
      'Most seats per dollar at that budget is an MD-82/83 — roughly 155-170 seats, and tired airframes have traded near scrap value.',
      "I have Lagos–Abuja economy sitting somewhere around ₦120,000–₦250,000 one-way now, up sharply since fuel deregulation — but I'm recalling that, not reading a fare sheet.",
      'Jefferson County off I-55 is the best cheap-land-with-real-traffic trade in the metro — North County is cheaper but the volumes that make it cheap are what get a site rejected.',
      '256 flavours needs about a third more counter than 40 does to serve the same queue.',
    ];
    for (const text of real) expect(looksGarbled(text)).toBe(false);
  });

  it('does not flag ordinary prose that reuses a phrase', () => {
    // The repeated-run signal needs to survive normal writing. Forty characters
    // is a long way past "the cost of the" and similar.
    expect(
      looksGarbled(
        'The cost of the buildout is the cost of the lease plus the cost of the ' +
          'equipment, and the cost of the equipment is the part you can shop around.',
      ),
    ).toBe(false);
    expect(
      looksGarbled(
        'Rent is 12% of revenue. Labour is 31% of revenue. Food is 30% of revenue. ' +
          'Marketing is 3% of revenue. That leaves about 15% before debt service.',
      ),
    ).toBe(false);
  });

  it('is not fooled by brand names and camel case', () => {
    // The obvious false positive. A detector that flags these is worse than no
    // detector, because it throws away good answers and costs a round trip.
    expect(
      looksGarbled(
        "A McDonald's or a Starbucks in an iPhone-era strip centre still lives or " +
          "dies on the drive-thru, and PepsiCo's own data says the same.",
      ),
    ).toBe(false);
    expect(looksGarbled('The GmbH filed with the BaFin; JPMorgan and BlackRock both passed.')).toBe(
      false,
    );
  });

  it('does not flag a lower-case opening that is genuinely how it starts', () => {
    // The cost of this signal. A model that legitimately opens with a
    // lower-cased brand loses a good answer and a round trip, so it is worth
    // knowing exactly which shapes pay it.
    expect(looksGarbled('iPhone-era strip centres still live on the drive-thru.')).toBe(true);
  });

  it('does not flag short answers, where the signals are meaningless', () => {
    expect(looksGarbled('Lagos.')).toBe(false);
    expect(looksGarbled('Yes — go on.')).toBe(false);
    expect(looksGarbled('')).toBe(false);
  });

  it('tolerates ordinary repetition that is not corruption', () => {
    expect(looksGarbled('It is very, very expensive, and that is that.')).toBe(false);
    expect(looksGarbled('Had had had. The couscous was bland.')).toBe(false);
  });
});
