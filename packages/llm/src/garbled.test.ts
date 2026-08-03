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

describe('looksGarbled', () => {
  it('catches every token emitted twice', () => {
    expect(looksGarbled(DOUBLED)).toBe(true);
  });

  it('catches two different answers interleaved character by character', () => {
    // This one barely registers on adjacent-duplicate rate — 0.03, inside the
    // noise floor — and is caught by the malformed words interleaving creates.
    expect(looksGarbled(INTERLEAVED)).toBe(true);
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
