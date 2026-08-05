import { z } from 'zod';
import {
  zAssetCategory,
  zCrisisRemedy,
  zDebtKind,
  zLegalForm,
  zMoney,
  zNonNegative,
  zPositive,
} from './primitives.js';

export const zFixedAssetSpec = z.object({
  label: z.string(),
  category: zAssetCategory,
  grossCost: zMoney,
  quantity: z.number().int().positive(),
  usefulLifeYears: zPositive,
  section179Elected: z.boolean(),
});
export type FixedAssetSpec = z.infer<typeof zFixedAssetSpec>;

export const zDebtSpec = z.object({
  kind: zDebtKind,
  requestedPrincipal: zMoney,
  termQuarters: z.number().int().positive(),
  personalGuarantee: z.boolean(),
  /**
   * The application's management-experience section (07, stage 3): the
   * operator's stated years in this trade, straight from the founder
   * profile. Real SBA files price this; ours does too — a spread credit and
   * a wider advance at EXPERIENCED_OPERATOR_YEARS. Defaults to 0, which
   * earns nothing.
   */
  operatorYears: z.number().nonnegative().default(0),
});
export type DebtSpec = z.infer<typeof zDebtSpec>;

export const zCapacitySpec = z.object({
  streamId: z.string(),
  deltaSeats: zNonNegative.optional(),
  /**
   * Extra floor area taken in the same buildout. Added before seats, so a
   * player who wants more seats than the current box holds has to take (and
   * pay rent on) the space first — see `MIN_SQ_FT_PER_SEAT`.
   */
  deltaFloorAreaSqFt: zNonNegative.optional(),
  deltaUnits: zNonNegative.optional(),
  deltaExecutionCapacity: zMoney.optional(),
  /**
   * More market, as opposed to more capacity inside the market you have.
   *
   * A plumbing shop reached 82% utilisation with no bench hours left, $395k of
   * cash, and no way to grow: marketing had saturated, price trades volume for
   * margin, and every capacity lever adds seats or units inside a demand pool
   * that was fixed at concept lock and could never move. "Let's add another
   * truck so we can expand into a new city" had no expression in the game.
   *
   * A second territory is genuinely both things at once — you buy the yard and
   * the truck, and the addressable market grows — so it rides the same action,
   * with the same buildout cost, capitalisation and two-quarter lead time
   * rather than a parallel path that would have to re-earn all of it.
   */
  deltaDemandHoursPerQuarter: zNonNegative.optional(),
  deltaAddressableTrafficPerQuarter: zNonNegative.optional(),
  /**
   * A better product, rather than more of the same one.
   *
   * "I want to add a small indoor waterpark" — asked three times of a hotel at
   * 70% occupancy, answered three times with "you already have 19 idle". Idle
   * rooms are the reason to build the waterpark, not the argument against it:
   * the point of an amenity is that it changes who is willing to stay and what
   * they will pay, and the game had no way to express that at all.
   *
   * Modelled as an uplift to the REFERENCE price — the price the market thinks
   * this product is worth — not to the price charged. Demand responds to the
   * ratio between the two (§3.0.1), so a 15% uplift with the rate held gives
   * 15% more perceived value and the demand that follows from it, while the
   * player who would rather bank it can raise the rate 15% and keep occupancy
   * flat. One knob, and the player chooses which side to take it out of. It
   * works for every archetype because every archetype has a reference price.
   *
   * The size of the claim is the player's. Nothing here knows what a waterpark
   * does to a highway hotel in Kansas; what the game can do is charge for the
   * buildout, hold the claim to the model, and show what it was worth.
   */
  qualityUpliftPct: zNonNegative.optional(),
  buildoutCost: zMoney,
});
export type CapacitySpec = z.infer<typeof zCapacitySpec>;

/**
 * What differs about the second one — spec §9.5.
 *
 * The spec lists location, rent, addressable traffic, wage rate, buildout cost
 * and unit count. This is one multiplier covering all of them, because the
 * alternative is a second interview and the entire point of a clone is that
 * there is not one. A player who wants a materially different business runs
 * the full interview; a player who wants the same business somewhere else
 * wants two numbers and a name.
 */
export const zCloneSpec = z.object({
  name: z.string(),
  /** Household cash committed to opening it. */
  equity: zMoney,
  /** Site size against the parent. 1 is the same shop in a different town. */
  scale: zPositive.default(1),
});
export type CloneSpec = z.infer<typeof zCloneSpec>;

export const zAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SET_PRICE'), streamId: z.string(), newPrice: zMoney }),
  z.object({
    kind: z.literal('SET_MARKETING_SPEND'),
    streamId: z.string(),
    amountPerQuarter: zMoney,
  }),
  z.object({ kind: z.literal('ADD_STEP_BLOCK'), costId: z.string(), blocks: z.number().int().positive() }),
  z.object({ kind: z.literal('REMOVE_STEP_BLOCK'), costId: z.string(), blocks: z.number().int().positive() }),
  z.object({
    kind: z.literal('PURCHASE_ASSET'),
    businessId: z.string(),
    asset: zFixedAssetSpec,
    financing: z.enum(['CASH', 'DEBT']),
    debtSpec: zDebtSpec.optional(),
  }),
  z.object({ kind: z.literal('DISPOSE_ASSET'), assetId: z.string(), salePrice: zMoney }),
  z.object({ kind: z.literal('RAISE_DEBT'), businessId: z.string(), spec: zDebtSpec }),
  z.object({ kind: z.literal('REPAY_DEBT'), debtId: z.string(), amount: zMoney }),
  z.object({ kind: z.literal('DRAW_REVOLVER'), debtId: z.string(), amount: zMoney }),
  z.object({ kind: z.literal('INJECT_CAPITAL'), businessId: z.string(), amount: zMoney }),
  z.object({ kind: z.literal('DISTRIBUTE'), businessId: z.string(), amount: zMoney }),
  /**
   * Passive investment, from the household's own cash.
   *
   * Not from the business. A founder who wants to put company money in the
   * market has to `DISTRIBUTE` it first and pay the tax on the way out, which
   * is both what actually happens and the more instructive path.
   */
  z.object({ kind: z.literal('BUY_SECURITY'), ticker: z.string(), amount: zMoney }),
  z.object({ kind: z.literal('SELL_SECURITY'), ticker: z.string(), shares: zNonNegative }),
  z.object({ kind: z.literal('EXPAND_CAPACITY'), businessId: z.string(), spec: zCapacitySpec }),
  z.object({
    kind: z.literal('START_BUSINESS'),
    mode: z.enum(['FULL_INTERVIEW', 'CLONE']),
    cloneFromId: z.string().optional(),
    /** Required for CLONE. FULL_INTERVIEW re-enters setup and carries none. */
    clone: zCloneSpec.optional(),
  }),
  z.object({
    kind: z.literal('DELEGATE'),
    businessId: z.string(),
    managerCompPerQuarter: zMoney,
    managerQuality: z.enum(['BUDGET', 'STANDARD', 'STRONG']),
  }),
  z.object({ kind: z.literal('CLOSE_BUSINESS'), businessId: z.string() }),
  z.object({
    kind: z.literal('SELL_BUSINESS'),
    businessId: z.string(),
    multipleOfEbitda: zPositive.optional(),
  }),
  z.object({ kind: z.literal('RECLAIM'), businessId: z.string() }),
  z.object({ kind: z.literal('CHANGE_ENTITY_FORM'), businessId: z.string(), newForm: zLegalForm }),
  z.object({ kind: z.literal('SET_CRISIS_POLICY'), policy: z.array(zCrisisRemedy) }),
  z.object({
    kind: z.literal('ADJUST_ASSUMPTION'),
    assumptionId: z.string(),
    newValue: z.union([z.number(), zMoney]),
    evidence: z.string().optional(),
  }),
]);
export type Action = z.infer<typeof zAction>;
export type ActionKind = Action['kind'];

/**
 * Spec §9.3.1. `cost` is quarters until the cost lands, `effect` is quarters
 * until the capacity or benefit lands. The asymmetry is the point: you pay the
 * cook for a quarter before they raise throughput.
 */
export const LEAD_TIMES: Record<ActionKind, { cost: number; effect: number }> = {
  SET_PRICE: { cost: 0, effect: 0 },
  SET_MARKETING_SPEND: { cost: 0, effect: 0 },
  ADD_STEP_BLOCK: { cost: 0, effect: 1 },
  REMOVE_STEP_BLOCK: { cost: 0, effect: 0 },
  PURCHASE_ASSET: { cost: 0, effect: 1 },
  DISPOSE_ASSET: { cost: 0, effect: 0 },
  RAISE_DEBT: { cost: 0, effect: 1 },
  REPAY_DEBT: { cost: 0, effect: 0 },
  BUY_SECURITY: { cost: 0, effect: 0 },
  SELL_SECURITY: { cost: 0, effect: 0 },
  DRAW_REVOLVER: { cost: 0, effect: 0 },
  INJECT_CAPITAL: { cost: 0, effect: 0 },
  DISTRIBUTE: { cost: 0, effect: 0 },
  EXPAND_CAPACITY: { cost: 0, effect: 2 },
  START_BUSINESS: { cost: 0, effect: 2 },
  DELEGATE: { cost: 1, effect: 1 },
  CLOSE_BUSINESS: { cost: 1, effect: 1 },
  SELL_BUSINESS: { cost: 2, effect: 2 },
  RECLAIM: { cost: 1, effect: 1 },
  CHANGE_ENTITY_FORM: { cost: 0, effect: 1 },
  SET_CRISIS_POLICY: { cost: 0, effect: 0 },
  ADJUST_ASSUMPTION: { cost: 0, effect: 0 },
};

/** Applied at tick step 2a — cost lands now, capacity lands later (§9.2). */
export const IMMEDIATE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'SET_PRICE',
  'SET_MARKETING_SPEND',
  'DRAW_REVOLVER',
  'INJECT_CAPITAL',
  'DISTRIBUTE',
  'REMOVE_STEP_BLOCK',
  'REPAY_DEBT',
  'BUY_SECURITY',
  'SELL_SECURITY',
  'SET_CRISIS_POLICY',
  'ADJUST_ASSUMPTION',
  'DISPOSE_ASSET',
]);
