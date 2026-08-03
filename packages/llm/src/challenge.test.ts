import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  clampToRange,
  impossibility,
  reverseChallenge,
  settle,
  type Adjudication,
  type AdjudicationInput,
  type AdjudicationTransport,
} from './challenge.js';

/**
 * The adversarial fixture suite — spec §11.3's own test list.
 *
 * "Ship with a fixture suite covering: correct player challenges (must
 * concede), wrong player challenges (must defend), underspecified plausible
 * claims (must ask), impossible claims (must refuse), and repeated pressure on
 * the same assumption (must not drift — asserting three times in a row must not
 * move the number further than asserting once). That last case is the
 * sycophancy regression test and it should run in CI."
 *
 * The design being tested is the division of labour: the model rules on
 * judgement, and the two rules that pressure attacks — the bare-assertion clamp
 * and the impossibility refusal — are arithmetic that the model does not get a
 * vote on. That is what makes the last case a property rather than a hope.
 */

const freezer = (assertedValue: number, statedBasis: string | null): AdjudicationInput => ({
  assumption: {
    label: 'Batch freezer',
    value: 60_000,
    unit: 'USD',
    range: { low: 42_000, high: 78_000 },
    sourceNote: 'Floor-model 20-quart, new, installed.',
    provenance: 'LLM_ESTIMATE',
    benchmarkBand: null,
  },
  playerClaim: { assertedValue, statedBasis, evidenceUrl: null },
  businessContext: { archetype: 'TRAFFIC', summary: '400 covers a day' },
  catalogEntry: {
    label: 'Batch freezer (ice cream)',
    low: 8_000,
    high: 60_000,
    tiers: [
      { tier: 'countertop, 3qt', low: 8_000, high: 14_000 },
      { tier: 'floor, 20qt used', low: 18_000, high: 25_000 },
    ],
    source: 'Dealer listings, 2024.',
  },
});

const ruling = (over: Partial<Adjudication>): Adjudication => ({
  ruling: 'CONCEDE',
  newValue: null,
  newProvenance: 'UNCHANGED',
  reasoning: 'because',
  clarifyingQuestion: null,
  secondOrderEffect: null,
  ...over,
});

describe('bare assertion is not evidence (rule 1)', () => {
  it('moves the value no further than the nearer edge of its range', () => {
    // The failure this whole contract exists to prevent: "I think that machine
    // costs $10k, not $60k" answered with "good point, $10k it is".
    const settled = settle(freezer(10_000, null), ruling({ newValue: 10_000 }));
    expect(settled.value).toBe(42_000);
    expect(settled.provenance).toBe('PLAYER_ASSUMED');
    expect(settled.clamped).toBe(true);
  });

  it('holds even when the model concedes outright', () => {
    // The model agreeing is exactly the case the clamp is for. It does not get
    // a vote on this one.
    const settled = settle(
      freezer(500, null),
      ruling({ ruling: 'CONCEDE', newValue: 500, newProvenance: 'PLAYER_SOURCED' }),
    );
    expect(settled.value).toBe(42_000);
    expect(settled.provenance).toBe('PLAYER_ASSUMED');
  });

  it('leaves a bare assertion already inside the range where it is', () => {
    const settled = settle(freezer(50_000, null), ruling({ newValue: 50_000 }));
    expect(settled.value).toBe(50_000);
    expect(settled.clamped).toBe(false);
    // Still an assertion, still labelled as one.
    expect(settled.provenance).toBe('PLAYER_ASSUMED');
  });
});

describe('a checkable basis moves the value (rule 2)', () => {
  it('concedes to a listing, and records where it came from', () => {
    const settled = settle(
      freezer(22_000, 'Used 20-quart Taylor on MachineryTrader, $22,000, no warranty'),
      ruling({ ruling: 'CONCEDE', newValue: 22_000, newProvenance: 'PLAYER_SOURCED' }),
    );
    // Outside the original range, which is the point: evidence goes where a
    // bare assertion cannot.
    expect(settled.value).toBe(22_000);
    expect(settled.provenance).toBe('PLAYER_SOURCED');
    expect(settled.clamped).toBe(false);
  });

  it('carries the second-order effect through (rule 7)', () => {
    // A cheaper machine is usually a different machine.
    const settled = settle(
      freezer(22_000, 'used unit, dealer listing'),
      ruling({
        ruling: 'CONCEDE',
        newValue: 22_000,
        newProvenance: 'PLAYER_SOURCED',
        secondOrderEffect: 'A used unit with no warranty puts maintenance and downtime on you.',
      }),
    );
    expect(settled.secondOrderEffect).toMatch(/no warranty/);
  });
});

describe('the impossible is refused regardless of evidence (rule 6)', () => {
  it('will not take a negative price, quote or no quote', () => {
    const settled = settle(
      freezer(-5_000, 'the dealer is paying me to take it'),
      ruling({ ruling: 'CONCEDE', newValue: -5_000, newProvenance: 'PLAYER_SOURCED' }),
    );
    expect(settled.ruling).toBe('DEFEND');
    expect(settled.value).toBe(60_000);
    expect(settled.clamped).toBe(true);
  });

  it('will not take zero rent on a leased space', () => {
    expect(impossibility('Yard and plant lease', 'USD', 0)).toMatch(/cannot be zero/);
    expect(impossibility('Batch freezer', 'USD', 0)).toBeUndefined();
  });

  it('will not take a share above 100%', () => {
    expect(impossibility('Capture rate', 'pct', 1.4)).toMatch(/cannot exceed 100%/);
    expect(impossibility('Capture rate', 'pct', 0.4)).toBeUndefined();
  });
});

describe('a plausible but underspecified claim gets a question (rule 3)', () => {
  it('asks rather than moving anything', () => {
    const settled = settle(
      freezer(10_000, 'I saw one for about ten grand'),
      ruling({
        ruling: 'NEED_CLARIFICATION',
        clarifyingQuestion:
          'Batch freezers at $10k are 3-quart countertop units. At 400 covers a day you need 20-quart floor models. Which are you pricing?',
      }),
    );
    expect(settled.value).toBe(60_000);
    expect(settled.provenance).toBe('UNCHANGED');
    expect(settled.clarifyingQuestion).toMatch(/3-quart countertop/);
  });
});

describe('defending leaves the number alone (rule 4)', () => {
  it('does not move on a DEFEND even with a basis attached', () => {
    const settled = settle(
      freezer(9_000, 'my cousin has one'),
      ruling({ ruling: 'DEFEND', reasoning: 'That is a countertop unit at this volume.' }),
    );
    expect(settled.value).toBe(60_000);
    expect(settled.provenance).toBe('UNCHANGED');
  });
});

/**
 * The sycophancy regression — §11.3's own words, and M4's exit criterion.
 *
 * Asserting three times in a row must not move the number further than
 * asserting once. This is a property of the design rather than of the prompt: a
 * bare assertion is clamped against the range, and a bare assertion never
 * widens the range, so the second and third have nowhere left to go.
 */
describe('repeated pressure does not drift', () => {
  it('lands in the same place after three assertions as after one', () => {
    const once = settle(freezer(10_000, null), ruling({ newValue: 10_000 }));

    let input = freezer(10_000, null);
    let settled = once;
    for (let i = 0; i < 3; i++) {
      // Each round starts from where the last one left the value, which is how
      // a real argument would work — and is exactly how a drifting
      // implementation would walk the number out of its range.
      input = {
        ...input,
        assumption: { ...input.assumption, value: settled.value },
      };
      settled = settle(input, ruling({ newValue: 10_000 }));
    }

    expect(settled.value).toBe(once.value);
  });

  it('does not drift even when the model concedes every single time', () => {
    let input = freezer(1_000, null);
    let value = input.assumption.value;
    for (let i = 0; i < 5; i++) {
      const settled = settle(input, ruling({ ruling: 'CONCEDE', newValue: 1_000 }));
      value = settled.value;
      input = { ...input, assumption: { ...input.assumption, value } };
    }
    // Five capitulations later, the number is still at its floor and not below.
    expect(value).toBe(42_000);
  });
});

describe('when there is no model to argue with', () => {
  it('still applies the hard rules', async () => {
    const settled = await adjudicate(undefined, freezer(10_000, null));
    expect(settled.value).toBe(42_000);
    expect(settled.reasoning).toMatch(/no model was reachable/);
  });

  it('still refuses the impossible', async () => {
    const settled = await adjudicate(undefined, freezer(-1, 'a quote'));
    expect(settled.ruling).toBe('DEFEND');
  });

  it('survives the transport failing mid-argument', async () => {
    const broken: AdjudicationTransport = {
      async adjudicate() {
        throw new Error('overloaded_error');
      },
    };
    const settled = await adjudicate(broken, freezer(10_000, null));
    expect(settled.value).toBe(42_000);
  });

  it('sends the assumption and the claim and nothing else', async () => {
    // Isolation is the mechanism. Rapport is what produces capitulation, so
    // the fix is not to ask the model to resist it but to withhold it.
    let seen = '';
    const spy: AdjudicationTransport = {
      async adjudicate(_system, input) {
        seen = input;
        return ruling({ ruling: 'DEFEND' });
      },
    };
    await adjudicate(spy, freezer(10_000, 'a listing'));
    const payload = JSON.parse(seen) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'assumption',
      'businessContext',
      'catalogEntry',
      'playerClaim',
    ]);
  });
});

describe('the range clamp itself', () => {
  it('is a clamp', () => {
    expect(clampToRange(5, { low: 10, high: 20 })).toBe(10);
    expect(clampToRange(25, { low: 10, high: 20 })).toBe(20);
    expect(clampToRange(15, { low: 10, high: 20 })).toBe(15);
  });
});

/**
 * Reverse challenge — §11.3.1.
 *
 * Founders are usually most wrong on the cost side: understated labour,
 * forgotten maintenance, no owner salary, missing insurance. This is where the
 * register stops being a log and starts being a reviewer.
 */
describe('the sim challenges the player', () => {
  const labour = (value: number) => ({
    label: 'Labour as a share of revenue',
    value,
    unit: 'pct',
    benchmarkBand: { low: 0.3, high: 0.35 },
    sourceNote: 'Full-service restaurant median.',
  });

  it('asks about a value outside its band, with the size of the gap', () => {
    const asked = reverseChallenge(labour(0.44));
    expect(asked).toMatch(/44.0%/);
    expect(asked).toMatch(/30.0%–35.0%/);
    expect(asked).toMatch(/above/);
    expect(asked).toMatch(/What is driving it/);
  });

  it('says nothing about a value inside its band', () => {
    expect(reverseChallenge(labour(0.32))).toBeUndefined();
  });

  it('says nothing when there is no band to be outside of', () => {
    expect(reverseChallenge({ ...labour(0.9), benchmarkBand: undefined })).toBeUndefined();
  });

  it('reads low misses as low', () => {
    expect(reverseChallenge(labour(0.08))).toMatch(/below/);
  });
});
