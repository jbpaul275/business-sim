import { toDisplay, fromDisplay, type Money } from '@bizsim/money';
import {
  buildModelFromTemplate,
  createWorld,
  createWorldConfig,
  tick,
  validateBusinessModel,
} from '@bizsim/engine';
import { draftToTemplate, type ConceptDraft } from '@bizsim/llm';

/**
 * Does the draft build the business the draft says it is building?
 *
 * A live run drafted a McDonald's franchise whose own open notes read "revenue
 * is anchored to a national average unit volume near $3.5-3.9M", and whose
 * traffic and capture figures produce $1.4M. Every cost line — 4% royalty, 10%
 * percentage rent, a salaried GM and two department managers — was sized for
 * the store it described. The player watched a McDonald's lose 30% of revenue
 * every quarter with no way to tell that the arithmetic was wrong rather than
 * the business.
 *
 * This is D-5's weak constraint, and it is not an opinion about whether the
 * concept is any good. A 256-flavour ice cream shop may take many times what
 * Ben & Jerry's takes; what it cannot do is bill a billion dollars from one
 * counter, and a model that states one figure and then builds another has made
 * an arithmetic error, not a bold claim.
 *
 * The check is the engine's own arithmetic rather than a second copy of it:
 * build the model, run it forward, read the revenue. Anything less would drift
 * from what the player actually sees, which would make it worse than nothing.
 */

/** Quarters to run before reading revenue — long enough for §3.7's ramp. */
const PROJECTION_QUARTERS = 12;

/**
 * How far off before it is worth saying anything.
 *
 * Deliberately loose. Seasonality, ramp and marketing response all move the
 * mature year around, and a check that fires on a 30% miss would be arguing
 * with the model about estimates rather than catching it contradicting itself.
 * These bounds catch the failure that motivated this — a 2.5x miss — and leave
 * ordinary disagreement alone.
 */
const TOO_LOW = 0.6;
const TOO_HIGH = 1.8;

export interface RevenueProjection {
  /** Revenue over the last four projected quarters. */
  matureAnnualRevenue: Money;
  /** What the draft said it would be. */
  expectedAnnualRevenue: Money;
  ratio: number;
  /** Volume in the last projected quarter, in the stream's own driver units. */
  matureQuarterlyVolume: number;
  /** Labour and owner comp the mature quarter actually carried. */
  matureQuarterlyLabour: Money;
}

/**
 * Run the drafted model forward and report what it actually earns.
 *
 * Returns undefined when the draft cannot be built at all — that is the
 * validator's error to raise with a proper code, not this function's to
 * pre-empt with a guess.
 */
export function projectMatureRevenue(draft: ConceptDraft): RevenueProjection | undefined {
  const stream = draft.stream;
  if (stream.expectedAnnualRevenue <= 0) return undefined;

  try {
    const mapped = draftToTemplate(draft);
    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      scale: mapped.scale,
      // Marketing stays at the template's own default rather than being
      // passed through: the question is what the business the model drafted
      // earns, not what it earns after the player has touched a dial.
      //
      // Funded well past anything it could need, for the same reason — a cash
      // crisis part-way through would cut marketing and answer a different
      // question than the one being asked.
      equityInjection: fromDisplay(1_000_000_000),
    });

    let world = createWorld({
      id: 'projection',
      playerId: 'projection',
      config: createWorldConfig({
        startMode: 'FREEPLAY',
        customCapital: fromDisplay(1_000_000_000),
      }),
      models: [model],
    });

    const revenues: Money[] = [];
    let lastVolume = 0;
    let lastLabour = 0n;
    for (let q = 0; q < PROJECTION_QUARTERS; q++) {
      const result = tick(world, [], { throwOnAssertionFailure: false });
      world = result.state;
      const entry = result.statements.byBusiness[world.businesses[0]!.id];
      revenues.push(entry?.incomeStatement.revenue ?? 0n);
      lastVolume = entry?.derivedMetrics.streamMetrics[0]?.realizedVolume ?? lastVolume;
      // The labour the mature quarter actually carried, blocks included. This
      // is the number the staffing check needs and it can only be read from a
      // run: how many blocks a concept ends up needing is the engine's answer,
      // not the draft's.
      lastLabour = entry?.incomeStatement.labor ?? lastLabour;
    }

    const mature = revenues.slice(-4).reduce<Money>((a, r) => a + r, 0n);
    const expected = fromDisplay(stream.expectedAnnualRevenue);
    if (expected <= 0n) return undefined;
    return {
      matureAnnualRevenue: mature,
      expectedAnnualRevenue: expected,
      ratio: Number(mature) / Number(expected),
      matureQuarterlyVolume: lastVolume,
      matureQuarterlyLabour: lastLabour,
    };
  } catch {
    // A draft that cannot be built has a structural problem, and the engine
    // will say so precisely a moment later. Swallowing it here keeps this from
    // reporting "revenue is $0" about a model that never ran.
    return undefined;
  }
}

/**
 * What the engine's validator says about the drafted model, in the model's own
 * words, while there is still someone to tell.
 *
 * An offshore rave ship drafted 700 guests into 2,000 square feet. The engine
 * caught it exactly as designed — `CAPACITY_EXCEEDS_FOOTPRINT`, with the
 * arithmetic and both ways out — but it caught it at the commit gate, after the
 * player had answered five financing questions and put a million dollars in.
 * The run ended there, and the whole conversation went with it.
 *
 * The validator is not the problem; *when* it ran was. Running it against the
 * draft puts the same message in front of the model that wrote the fault, in a
 * repair round that costs one call instead of the session.
 *
 * Funded past anything it could need, so nothing here reports a financing
 * problem: how the business gets paid for is the player's question, asked
 * later, and answering it on their behalf would hide the real fault.
 */
export function buildabilityIssues(draft: ConceptDraft): string[] {
  try {
    const mapped = draftToTemplate(draft);
    const model = buildModelFromTemplate({
      businessName: mapped.businessName,
      template: mapped.template,
      archetype: mapped.archetype,
      legalForm: mapped.legalForm,
      scale: mapped.scale,
      equityInjection: fromDisplay(1_000_000_000),
      provenanceFor: mapped.provenanceFor,
    });
    return validateBusinessModel(model)
      .issues.filter((i) => i.severity === 'ERROR')
      .map((i) => `${i.code}: ${i.message}`);
  } catch (error) {
    // Throwing at all means the draft cannot even be assembled. That is still
    // a fault the model can fix, so it goes back rather than escaping as a
    // stack trace.
    return [`The draft could not be assembled: ${(error as Error).message}`];
  }
}

/**
 * What a mature year earns against what it costs to open.
 *
 * A 320-acre Tennessee campground drew $960,000 of capital into the ground and
 * reached $98,000 of mature revenue. The model said so, precisely, in its own
 * open notes — "a lifestyle-scale cash business attached to a real-estate
 * purchase, not an operating business that services $960k on its own" — and
 * then three screens of month-zero detail scrolled past and the gate asked
 * only whether opening was affordable. It was. The player committed, watched
 * it bleed for three years, and concluded he was bad at business.
 *
 * He was not. The tool knew and buried it.
 *
 * This is not a veto and must never become one. D-5 is explicit that a bad
 * business is the player's to build, and plenty of real ones look like this —
 * a working farm, a marina, anything where the land is the investment and the
 * operation is a job attached to it. What it is is the one sentence that
 * should be on screen at the moment of the decision rather than four screens
 * earlier.
 */
export function capitalIntensity(
  draft: ConceptDraft,
  openingCost: Money,
): { matureAnnualRevenue: Money; yearsOfRevenue: number } | undefined {
  const p = projectMatureRevenue(draft);
  if (!p || p.matureAnnualRevenue <= 0n || openingCost <= 0n) return undefined;
  return {
    matureAnnualRevenue: p.matureAnnualRevenue,
    yearsOfRevenue: Number(openingCost) / Number(p.matureAnnualRevenue),
  };
}

/**
 * Years of revenue past which it is worth saying out loud.
 *
 * Three is high on purpose. Restaurants and shops open for well under a year
 * of revenue; hotels, marinas and anything land-heavy run three to five and
 * are perfectly normal businesses. At six the capital is the investment and
 * the operation is a job attached to it, which is a different thing from what
 * most people think they are buying.
 */
const HEAVY_YEARS = 6;

/** One sentence for the commit screen, or nothing. */
export function capitalIntensityNote(
  draft: ConceptDraft,
  openingCost: Money,
): string | undefined {
  const c = capitalIntensity(draft, openingCost);
  if (!c || c.yearsOfRevenue < HEAVY_YEARS) return undefined;
  return (
    `Opening costs ${toDisplay(openingCost, { showCents: false })} and a mature year earns ` +
    `${toDisplay(c.matureAnnualRevenue, { showCents: false })} — ${c.yearsOfRevenue.toFixed(1)} years ` +
    `of revenue to get the doors open. That can be exactly right when the asset is the investment ` +
    `and the operation is a job attached to it. It is worth being sure that is the business you ` +
    `mean to buy.`
  );
}

/**
 * The projection as something to hand back to the model, or nothing at all.
 *
 * Phrased as a contradiction rather than a correction: the model is told what
 * it said and what it built, and left to decide which one was wrong. Telling it
 * "raise the capture rate" would be this file having an opinion about the
 * business, which is exactly what D-5 forbids.
 */
export function revenueRealityIssues(draft: ConceptDraft): string[] {
  const p = projectMatureRevenue(draft);
  if (!p) return [];
  if (p.ratio >= TOO_LOW && p.ratio <= TOO_HIGH) return [];

  const direction = p.ratio < TOO_LOW ? 'far below' : 'far above';
  return [
    `The volume and price you drafted produce ${toDisplay(p.matureAnnualRevenue, { showCents: false })} ` +
      `in a mature year, ${direction} the ${toDisplay(p.expectedAnnualRevenue, { showCents: false })} ` +
      `you said this business should do — off by ${p.ratio.toFixed(2)}x. The cost lines are sized ` +
      `for the business you described, so one of the two is wrong. Either correct the volume ` +
      `parameters so they reach the revenue you stated, or restate the revenue this business ` +
      `actually does at the scale you have drafted.`,
  ];
}

/**
 * Staffing that never has to grow.
 *
 * A Buffalo brewpub reached $4.4M a year — 34,000 transactions a quarter, 370
 * covers a day — on five staffing blocks and an owner, and never once needed a
 * sixth. Not because the player managed it well: because the concept was
 * drafted with a `capacityPerBlock` so generous that one front-of-house block
 * covered every customer the business would ever see. Labour landed at 8% of
 * revenue where full-service food runs 30-35%, and the single most consequential
 * decision in an operating business — when to hire — never came up.
 *
 * The engine is not wrong here and cannot be. §4.3 makes blocks a player
 * decision and the engine only forces one when demand exceeds what the blocks
 * support; if a block supports everything, nothing is ever forced. The claim
 * that needs checking is the draft's, and this is where it gets checked.
 *
 * A warning rather than a refusal, per the standing rule: a business genuinely
 * can be less labour-intensive than its trade, and the player is the one who
 * knows whether this one is. What they cannot do is notice the omission from a
 * screen that shows five lines all reading "1 blocks" forever.
 */

/**
 * Below this share of revenue, a labour line is not a constraint on anything.
 *
 * Deliberately low — far below any real trade's band, so it fires on the
 * failure rather than on a difference of opinion. A software business at 20% is
 * not flagged; a restaurant at 8% is.
 */
const IMPLAUSIBLY_LIGHT = 0.12;

export function staffingRealismIssues(draft: ConceptDraft): string[] {
  const p = projectMatureRevenue(draft);
  if (!p || p.matureAnnualRevenue <= 0n) return [];

  const annualLabour = p.matureQuarterlyLabour * 4n;
  const share = Number(annualLabour) / Number(p.matureAnnualRevenue);
  if (share >= IMPLAUSIBLY_LIGHT) return [];

  // Which lines would never have crossed a block boundary — the mechanism
  // behind the number, and the part the model can actually fix.
  const blocks = draft.costLines
    .filter((line) => line.class === 'STEP_FIXED' && line.isLabor && (line.capacityPerBlock ?? 0) > 0)
    .map((line) => ({
      label: line.label,
      per: line.capacityPerBlock!,
      needed: Math.ceil(p.matureQuarterlyVolume / line.capacityPerBlock!),
    }));
  const neverGrows = blocks.filter((b) => b.needed <= 1);
  if (blocks.length === 0) return [];

  const detail = neverGrows
    .slice(0, 3)
    .map(
      (b) =>
        `${b.label} at ${Math.round(b.per).toLocaleString()} per block covers all ` +
        `${Math.round(p.matureQuarterlyVolume).toLocaleString()} of it with one`,
    )
    .join('; ');

  return [
    `At maturity this business does ${toDisplay(p.matureAnnualRevenue, { showCents: false })} a year ` +
      `on ${toDisplay(annualLabour, { showCents: false })} of labour — ${(share * 100).toFixed(1)}% of ` +
      `revenue, where most operating businesses run three to four times that. ` +
      (neverGrows.length > 0
        ? `The reason is the block sizes: ${detail}. `
        : '') +
      `That means the staffing never has to grow, and hiring — the decision this whole cost class ` +
      `exists to model — never comes up. Either the volume one block supports is too high, or this ` +
      `business really is that light and the sourceNote should say why.`,
  ];
}
