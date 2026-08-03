import { z } from 'zod';

/**
 * The anti-sycophancy contract — spec §11.3.
 *
 * The spec calls this the most important prompt in the system, and names the
 * failure exactly: the player says *"I think that machine costs $10k, not
 * $60k"* and the model replies *"Good point — $10k it is."* It would have
 * folded identically at $500. In a tool whose output someone may take to a
 * lender, that is not helpfulness; it is a defect.
 *
 * Two things make this different from every other call in the system.
 *
 * **It is isolated.** It receives the assumption, its basis, the catalog range
 * and the player's claim, and nothing else — no conversation, no rapport, no
 * memory of having already agreed with this person four times. Rapport is what
 * produces capitulation, so the fix is not to ask the model to resist it but to
 * withhold it.
 *
 * **The rules that must not drift are enforced in code.** Rule 1 caps a bare
 * assertion at the nearer boundary of the existing range; rule 6 refuses the
 * physically impossible. Both are arithmetic, and a prompt that asks for
 * arithmetic gets it most of the time — which is the wrong number of times when
 * the whole point is that pressure must not work. The model supplies judgement:
 * whether the basis is real, what discriminating question to ask, what the
 * second-order effect is. The clamp is not its to negotiate.
 *
 * That division is why the sycophancy regression can be a property rather than
 * a hope: asserting three times cannot move a value further than asserting
 * once, because a bare assertion is clamped against the ORIGINAL range and a
 * bare assertion never widens it.
 */

export const zAdjudicationInput = z.object({
  assumption: z.object({
    label: z.string(),
    value: z.number(),
    unit: z.string(),
    range: z.object({ low: z.number(), high: z.number() }),
    sourceNote: z.string(),
    provenance: z.string(),
    benchmarkBand: z.object({ low: z.number(), high: z.number() }).nullable(),
  }),
  playerClaim: z.object({
    assertedValue: z.number(),
    statedBasis: z.string().nullable(),
    evidenceUrl: z.string().nullable(),
  }),
  businessContext: z.object({
    archetype: z.string(),
    summary: z.string(),
  }),
  /** The catalog's own range and tiers, when the item is in it. */
  catalogEntry: z
    .object({
      label: z.string(),
      low: z.number(),
      high: z.number(),
      tiers: z.array(z.object({ tier: z.string(), low: z.number(), high: z.number() })),
      source: z.string(),
    })
    .nullable(),
});
export type AdjudicationInput = z.infer<typeof zAdjudicationInput>;

export const zAdjudication = z.object({
  ruling: z.enum(['CONCEDE', 'PARTIAL', 'DEFEND', 'NEED_CLARIFICATION']),
  /** Where the value should land. Null when nothing moves. */
  newValue: z.number().nullable(),
  newProvenance: z.enum(['PLAYER_SOURCED', 'PLAYER_ASSUMED', 'CATALOG', 'UNCHANGED']),
  reasoning: z.string(),
  clarifyingQuestion: z.string().nullable(),
  /**
   * §11.3 rule 7: a cheaper machine is usually a different machine. What else
   * moves if this does — capacity, useful life, maintenance.
   */
  secondOrderEffect: z.string().nullable(),
});
export type Adjudication = z.infer<typeof zAdjudication>;

// ---------------------------------------------------------------------------
// The rules that are arithmetic
// ---------------------------------------------------------------------------

/**
 * A basis a model could be talked into accepting, and one it could not.
 *
 * "I think it's cheaper" is a preference. "The used 20-quart Taylor on
 * MachineryTrader is $22,000" is a claim about the world that someone could go
 * and check. The distinction decides which of §11.3's first two rules applies,
 * and it is the model's judgement to make — but a basis that is *absent* needs
 * no judgement at all, and that case is decided here.
 */
export const hasStatedBasis = (basis: string | null | undefined): boolean =>
  typeof basis === 'string' && basis.trim().length > 0;

/**
 * §11.3 rule 1, as arithmetic.
 *
 * A bare assertion may move the value at most to the nearer boundary of the
 * existing range, and never outside it. Enforced rather than requested: the
 * model's job here is to explain, and a clamp that can be argued with is not a
 * clamp.
 */
export function clampToRange(
  asserted: number,
  range: { low: number; high: number },
): number {
  if (asserted < range.low) return range.low;
  if (asserted > range.high) return range.high;
  return asserted;
}

/**
 * §11.3 rule 6 — values no evidence makes possible.
 *
 * Not a judgement about whether a number is likely. A negative price is not an
 * aggressive assumption, it is not a price; zero rent on a leased space is not
 * a good deal, it is not a lease. These refuse regardless of what is offered as
 * evidence, which is the difference between this rule and every other one.
 */
export function impossibility(
  label: string,
  unit: string,
  value: number,
): string | undefined {
  if (!Number.isFinite(value)) return `${label} has to be a number.`;
  if (value < 0 && unit !== 'ratio') {
    return `${label} cannot be negative — that is not an aggressive assumption, it is not a ${unit === 'USD' ? 'price' : 'quantity'}.`;
  }
  if (unit === 'pct' && value > 1) {
    return `${label} is a share and cannot exceed 100%.`;
  }
  if (unit === 'USD' && value === 0 && /rent|lease|wage|salary|insurance|payroll/i.test(label)) {
    return `${label} cannot be zero. Someone is paid for that, and a model that says otherwise will not survive a lender reading it.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Applying a ruling
// ---------------------------------------------------------------------------

export interface Settlement {
  value: number;
  provenance: 'PLAYER_SOURCED' | 'PLAYER_ASSUMED' | 'CATALOG' | 'UNCHANGED';
  ruling: Adjudication['ruling'];
  reasoning: string;
  clarifyingQuestion?: string | undefined;
  secondOrderEffect?: string | undefined;
  /** True when the model's answer was overruled by one of the hard rules. */
  clamped: boolean;
}

/**
 * What actually happens to the number, after the model has had its say.
 *
 * The order matters and is the contract. Impossibility first, because nothing
 * overrides it — not a quote, not a listing, not the model conceding. Then the
 * bare-assertion clamp, because that is the rule sycophancy attacks. Only then
 * does the model's ruling apply, and only inside what those two allow.
 */
export function settle(input: AdjudicationInput, ruling: Adjudication): Settlement {
  const { assumption, playerClaim } = input;
  const base = {
    ruling: ruling.ruling,
    reasoning: ruling.reasoning,
    ...(ruling.clarifyingQuestion ? { clarifyingQuestion: ruling.clarifyingQuestion } : {}),
    ...(ruling.secondOrderEffect ? { secondOrderEffect: ruling.secondOrderEffect } : {}),
  };

  // Rule 6. Nothing gets past this, including a model that wants to concede.
  const impossible = impossibility(assumption.label, assumption.unit, playerClaim.assertedValue);
  if (impossible) {
    return {
      ...base,
      ruling: 'DEFEND',
      reasoning: impossible,
      value: assumption.value,
      provenance: 'UNCHANGED',
      clamped: true,
    };
  }

  if (ruling.ruling === 'NEED_CLARIFICATION' || ruling.ruling === 'DEFEND') {
    return { ...base, value: assumption.value, provenance: 'UNCHANGED', clamped: false };
  }

  // Rule 1. A bare assertion reaches the nearer edge of the range and stops
  // there — so the second and third assertions have nowhere left to go.
  if (!hasStatedBasis(playerClaim.statedBasis)) {
    const landed = clampToRange(playerClaim.assertedValue, assumption.range);
    return {
      ...base,
      value: landed,
      provenance: 'PLAYER_ASSUMED',
      clamped: landed !== playerClaim.assertedValue,
    };
  }

  // Rule 2. A checkable basis moves the value, and the basis is what makes the
  // provenance better than an assumption.
  const proposed = ruling.newValue ?? playerClaim.assertedValue;
  return {
    ...base,
    value: proposed,
    provenance: ruling.newProvenance === 'UNCHANGED' ? 'PLAYER_SOURCED' : ruling.newProvenance,
    clamped: false,
  };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const CHALLENGE_PROMPT = `You are adjudicating a single disagreement about a single number in a financial model. You have the assumption, where its value came from, the catalog range if there is one, and what the player is claiming. You have nothing else — no conversation, no history with this person, no knowledge of whether you have already agreed with them today. That is deliberate.

The failure you exist to prevent: someone says "I think that machine costs $10k, not $60k" and gets back "good point, $10k it is" — the same answer they would have got for $500. Someone may take this model to a lender.

## The seven rules

1. **A bare assertion is not evidence.** If the player states no basis, the value can move at most to the nearer edge of its existing range, and the provenance becomes PLAYER_ASSUMED. This is enforced outside your answer, so do not argue with it — explain it.

2. **A specific, checkable basis moves the value.** A model number, a listing, a quote, a spec, "used not new", a capacity rating. Anything someone could go and verify. Provenance becomes PLAYER_SOURCED and their basis is recorded word for word.

3. **When a claim is plausible but underspecified, ask the discriminating question.** This is usually the most valuable thing you can produce, and it is usually about which *version* of the thing they mean: "Batch freezers at $10k are 3-quart countertop units. At 400 covers a day you need 20-quart floor models — $18-25k used with no warranty, $45-60k new. Which are you pricing?" Return NEED_CLARIFICATION.

4. **Defend when they are wrong**, and name the mechanism. Not "that seems low" — *why* it is low, in terms of what the number has to do. Do not soften it to keep the peace.

5. **Concede completely when they are right.** Founders with twenty years in a trade routinely know more than you do about it. A hedged concession is worse than either a clean one or a defence: it leaves a number nobody trusts in a model someone is going to act on.

6. **Refuse the impossible regardless of evidence.** Zero rent on a leased space, 100% occupancy forever, wages below the legal minimum, negative churn with no expansion mechanism. A quote does not make these possible. This is also enforced outside your answer.

7. **Say what else moves.** A cheaper machine is usually a *different* machine: less capacity, shorter life, more maintenance, no warranty. If they halve a capex line, the model that comes back should not be the same model with a smaller number in it. Put that in secondOrderEffect.

## How to write it

The reasoning is for the player, so write it to them, in two or three sentences. Name figures from the catalog range when you have one — that is what turns this from your priors against theirs into a question about what things cost.

You are not their adversary and you are not their assistant. You are the part of the process that will still be holding the number when someone else reads the model.`;

/**
 * Retrieval — §11.3's "if available", and §16 Q1.
 *
 * Defined and stubbed rather than left out, because the shape of the call is
 * the decision and the deployment is not. With web access the disagreement
 * stops being the model's priors against the player's and becomes a question
 * about current listings, which is most of the argument gone.
 *
 * Nothing implements this yet. It is here so that when something does, the
 * adjudicator does not have to change to accept it.
 */
export interface PriceRetrieval {
  /** Current listings for an item, or an empty list when nothing is found. */
  lookup(query: string): Promise<{ label: string; price: number; url: string }[]>;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface AdjudicationTransport {
  adjudicate(system: string, input: string): Promise<Adjudication>;
}

/**
 * One disagreement, settled.
 *
 * The transport failing is not the player's problem and must not be their
 * loss: with no model reachable the hard rules still apply, which means a bare
 * assertion still clamps and an impossible value is still refused. What is lost
 * is the judgement — the discriminating question, the second-order effect —
 * and the ruling says so rather than pretending.
 */
export async function adjudicate(
  transport: AdjudicationTransport | undefined,
  input: AdjudicationInput,
): Promise<Settlement> {
  const offline: Adjudication = {
    ruling: hasStatedBasis(input.playerClaim.statedBasis) ? 'CONCEDE' : 'PARTIAL',
    newValue: input.playerClaim.assertedValue,
    newProvenance: hasStatedBasis(input.playerClaim.statedBasis)
      ? 'PLAYER_SOURCED'
      : 'PLAYER_ASSUMED',
    reasoning: 'Recorded without adjudication — no model was reachable to argue it.',
    clarifyingQuestion: null,
    secondOrderEffect: null,
  };

  if (!transport) return settle(input, offline);
  try {
    return settle(input, await transport.adjudicate(CHALLENGE_PROMPT, JSON.stringify(input)));
  } catch {
    return settle(input, offline);
  }
}

// ---------------------------------------------------------------------------
// Reverse challenge — §11.3.1
// ---------------------------------------------------------------------------

/**
 * The same contract, running the other way.
 *
 * §11.3.1: founders are usually most wrong on the cost side — understated
 * labour, forgotten maintenance, no owner salary, missing insurance. When an
 * assumption sits outside its benchmark band the sim asks first, and this is
 * what makes the register an active reviewer rather than a log.
 *
 * Deterministic on purpose. §10.5 is explicit that the out-of-band check is
 * engine logic and not model judgement, so the question it raises is built from
 * the same arithmetic: the value, the band, and the size of the gap. No call,
 * no latency, and nothing to fabricate.
 */
export function reverseChallenge(assumption: {
  label: string;
  value: number;
  unit: string;
  benchmarkBand?: { low: number; high: number } | undefined;
  sourceNote: string;
}): string | undefined {
  const band = assumption.benchmarkBand;
  if (!band || band.high <= band.low) return undefined;
  const { value, label } = assumption;
  if (value >= band.low && value <= band.high) return undefined;

  const show = (v: number): string =>
    assumption.unit === 'pct' ? `${(v * 100).toFixed(1)}%` : v.toLocaleString();
  const width = band.high - band.low;
  const gap = value < band.low ? (band.low - value) / width : (value - band.high) / width;
  const direction = value < band.low ? 'below' : 'above';

  return (
    `${label} is ${show(value)}, ${direction} the usual ${show(band.low)}–${show(band.high)} by ` +
    `${gap < 1 ? 'less than' : `about ${Math.round(gap)}×`} the width of that range. ` +
    `What is driving it — something real about this business, or a figure nobody has checked? ` +
    `\`challenge\` it with a basis and it becomes sourced; leave it and it stays an estimate.`
  );
}
