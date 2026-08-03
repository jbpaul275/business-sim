import { describe, expect, it } from 'vitest';
import { faultLine, summariseFaults } from './faults.js';

/**
 * "keep seeing the first draft did not come out right — why?"
 *
 * Because the message had been through both failure modes. First it printed
 * the raw issue text, which is written for the model — `streams[1] (unused):
 * TRAFFIC needs a 'avgTicket' parameter` — and was noise to someone buying a
 * soft-serve truck. Then it printed nothing but "did not come out right",
 * which meant nobody could tell whether it was the same fault every time.
 *
 * A category is the middle: what *kind* of thing was wrong, in the vocabulary
 * of the business rather than the validator.
 */

describe('saying what went wrong with a draft', () => {
  it('names the fault in the vocabulary of the business', () => {
    expect(
      summariseFaults([
        '2 revenue streams, and only the first is modelled — the rest would be dropped.',
      ]),
    ).toContain('split the business into separate revenue streams');

    expect(
      summariseFaults([
        "streams[0] (Boxes): UNITS_CAC needs a 'avgOrderValue' parameter — that is the price the engine reads.",
      ]),
    ).toContain('left out the price');

    expect(
      summariseFaults([
        'The volume and price you drafted produce $1,400,000 in a mature year, far below the $3,600,000 you said.',
      ]),
    ).toContain('volume did not add up to the revenue it claimed');

    expect(
      summariseFaults(['CAPACITY_EXCEEDS_FOOTPRINT: 700 seats will not fit in 2000 sq ft.']),
    ).toContain('more capacity in the space than fits');
  });

  it('carries no schema vocabulary into the message', () => {
    // The whole reason the raw text was removed. If any of these leak, the
    // player is reading the model's homework again.
    const line = summariseFaults([
      "streams[1] (unused): TRAFFIC needs a 'avgTicket' parameter. Known parameters: " +
        'avgTicket, addressableTrafficPerQuarter, captureRate.',
      'A delivery commission is a VARIABLE_REVENUE line, not a separate stream.',
    ]);
    for (const jargon of ['streams[', 'avgTicket', 'VARIABLE_REVENUE', 'TRAFFIC', 'param']) {
      expect(line, jargon).not.toContain(jargon);
    }
  });

  it('stays one line however many issues there are', () => {
    // Two problems usually have one cause, and a list reintroduces the wall of
    // text this exists to avoid.
    const line = summariseFaults([
      '3 revenue streams, and only the first is modelled — the rest would be dropped.',
      "streams[1] (unused): TRAFFIC needs a 'avgTicket' parameter.",
      'streams[2] (unused): seasonality needs exactly 4 quarterly weights.',
    ]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line.length).toBeLessThan(160);
  });

  it('does not repeat a category that appears twice', () => {
    const line = summariseFaults([
      "streams[0]: TRAFFIC needs a 'avgTicket' parameter.",
      "streams[1]: TRAFFIC needs a 'avgTicket' parameter.",
    ]);
    expect(line.match(/left out the price/g)).toHaveLength(1);
  });

  it('falls back rather than inventing a category it does not have', () => {
    expect(summariseFaults(['Something entirely new went wrong.'])).toBe(
      'the first draft did not come out right',
    );
    expect(summariseFaults([])).toBe('the first draft did not come out right');
  });

  it('distinguishes a second round from the first', () => {
    // A pattern of repairs is the signal that one of the checks is
    // miscalibrated, and it is invisible if every round reads identically.
    const issues = ['2 revenue streams, and only the first is modelled.'];
    expect(faultLine(issues, 1)).toContain('the first draft');
    expect(faultLine(issues, 1)).toContain('asking for a corrected one');
    expect(faultLine(issues, 2)).toContain('draft 2');
    expect(faultLine(issues, 2)).toContain('asking again');
    expect(faultLine(issues, 2)).not.toContain('the first draft');
  });
});
