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
    for (let q = 0; q < PROJECTION_QUARTERS; q++) {
      const result = tick(world, [], { throwOnAssertionFailure: false });
      world = result.state;
      const entry = result.statements.byBusiness[world.businesses[0]!.id];
      revenues.push(entry?.incomeStatement.revenue ?? 0n);
    }

    const mature = revenues.slice(-4).reduce<Money>((a, r) => a + r, 0n);
    const expected = fromDisplay(stream.expectedAnnualRevenue);
    if (expected <= 0n) return undefined;
    return {
      matureAnnualRevenue: mature,
      expectedAnnualRevenue: expected,
      ratio: Number(mature) / Number(expected),
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
