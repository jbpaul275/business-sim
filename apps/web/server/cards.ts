import { toCompact } from '@bizsim/money';
import { buildModelFromTemplate, computeMonthZeroOutlays } from '@bizsim/engine';
import { getSeedTemplate } from '@bizsim/seeds';

/**
 * The picker's card data, shared with the setup flow — a card's scenario key
 * is also the seed the conversation starts from, so the mapping lives once.
 */

export interface CardSpec {
  templateId: string;
  name: string;
  /** The binding constraint and the dynamic that decides the run, in words. */
  blurb: string;
  /** Year the calibrated build reaches its band (STATUS.md's maturity table). */
  matureBy: number;
  /**
   * The one question the interview opens with. The template supplies the
   * economics; this asks for the single variable it can't supply — the one
   * whose answer most constrains everything else.
   *
   * Two rules, both learned from play-tests. First, ask for the fantasy the
   * player actually has, not the plan they don't: someone who clicked
   * "Coffee shop" is picturing a capybara café from TikTok, not a lease on a
   * corner — concept before logistics, and the model asks the logistics as
   * follow-ups. Second, the question must visibly exhaust the possibilities,
   * including "no idea yet": a question with no escape hatch reads as
   * "answer or else ?" and that is where players churn. "I don't know" has
   * to be a supported answer *in the question's own words*.
   */
  eigen: string;
}

export const CARDS: Record<string, CardSpec> = {
  restaurant: {
    templateId: 'full_service_restaurant',
    name: 'Full-service restaurant',
    blurb: 'Seats × turns against a lease that escalates 3% a year.',
    matureBy: 3,
    // Check size, turns, and cuisine all fall out of the occasion.
    eigen:
      'Do you have a cuisine or a concept in mind, or just the urge to run a restaurant? Either is enough to start.',
  },
  qsr: {
    templateId: 'quick_service_restaurant',
    name: 'Quick-service restaurant',
    blurb: 'Counter throughput at a low ticket — the corner IS the marketing.',
    matureBy: 3,
    // The signature item sets the ticket, the food cost, and the line.
    eigen:
      'What do you picture people lining up for — a signature item, a cuisine, or nothing specific yet?',
  },
  coffee: {
    templateId: 'coffee_shop',
    name: 'Coffee shop',
    blurb: 'High-frequency small tickets; labor and rent take most of every one.',
    matureBy: 3,
    // Concept first — location is the follow-up, and "open" is a fine answer.
    eigen:
      'Do you have a concept or theme in mind, or should we start from a classic neighborhood shop and make it yours from there?',
  },
  retail: {
    templateId: 'retail_shop',
    name: 'Retail shop',
    blurb: 'Keystone margins on inventory that ties up cash for a season.',
    matureBy: 3,
    // The merchandise picks the margin, the customer, and the season.
    eigen: 'Do you know what you want to sell, or just that you want a shop? Both work.',
  },
  services: {
    templateId: 'professional_services_firm',
    name: 'Professional services firm',
    blurb: 'Hours you can sell — utilisation and the bench decide the year.',
    matureBy: 4,
    // The expertise sets the bill rate and who's buying.
    eigen:
      'What would clients hire the firm to do — or should we pick a strong market together?',
  },
  agency: {
    templateId: 'marketing_agency',
    name: 'Marketing agency',
    blurb: 'Sell hours, hold utilisation, flex the overflow to freelancers.',
    matureBy: 4,
    // Agencies live or die on the niche they own.
    eigen:
      'Do you know what you want the agency to be known for, or should we find the niche together?',
  },
  ecommerce: {
    templateId: 'ecommerce_dtc_brand',
    name: 'Ecommerce / DTC brand',
    blurb: 'Every order is bought — CAC inflates as spend chases growth.',
    matureBy: 5,
    // The product decides the margin that has to survive the CAC.
    eigen: 'Do you have a product in mind, or just the itch to sell online? Either is a fine start.',
  },
  saas: {
    templateId: 'b2b_saas',
    name: 'B2B SaaS',
    blurb: 'A retained base compounding slowly against a fixed engineering payroll.',
    matureBy: 9,
    // The pain being priced sets ARPU, market size, and churn.
    eigen:
      'Do you know the problem your software would solve, or do you want help finding the wedge? Either works.',
  },
  gym: {
    templateId: 'gym_fitness',
    name: 'Gym / fitness studio',
    blurb: 'Members churn every month; the building must be paid either way.',
    matureBy: 5,
    // The member persona sets the price point and the churn.
    eigen:
      'What kind of gym do you picture — boutique, big-box, one discipline? A fuzzy picture is fine; we can sharpen it.',
  },
  storage: {
    templateId: 'self_storage',
    name: 'Self-storage facility',
    blurb: 'A fixed stock of units leasing up toward stabilized occupancy.',
    matureBy: 6,
    // The draw is either local knowledge or the model itself — both are starts.
    eigen:
      "What draws you to storage — a market you know, or the business model itself? Either is a fine start.",
  },
  contractor: {
    templateId: 'general_contractor',
    name: 'General contractor',
    blurb: 'Win bids, execute the backlog, wait out retainage.',
    matureBy: 4,
    // Residential remodels and commercial builds are different businesses.
    eigen:
      'Do you know what you want to build — remodels, custom homes, commercial — or should we talk through the options?',
  },
  trades: {
    templateId: 'trades_contractor',
    name: 'Trades contractor',
    blurb: 'Trucks and crews on small jobs — customer deposits fund the work.',
    matureBy: 4,
    // Plumbing, electrical, and HVAC each set their own job size and demand.
    eigen:
      'Do you have a trade — plumbing, electrical, HVAC — or are you picking one for the economics? Both work.',
  },
};

export interface CardFacts {
  toOpen: string;
  band?: string;
}

/** The card's numbers, computed from the template rather than written twice. */
export function factsFor(spec: CardSpec): CardFacts {
  const template = getSeedTemplate(spec.templateId);
  const model = buildModelFromTemplate({
    businessName: spec.name,
    template,
    archetype: template.defaultArchetypes[0]!,
    equityInjection: 0n,
  });
  const toOpen = `~${toCompact(computeMonthZeroOutlays(model).total)} to open`;
  const ebitda = template.plausibility.ebitdaMarginPct;
  return {
    toOpen,
    ...(ebitda
      ? { band: `${bandText(ebitda.low, ebitda.high)} EBITDA by year ${spec.matureBy}` }
      : {}),
  };
}

/**
 * "8–15%", one unit sign — and "−15% to 30%" when the band crosses zero,
 * because a minus and a range dash doing different jobs four characters apart
 * ("-15%–30%") is a puzzle, not a number.
 */
function bandText(low: number, high: number): string {
  const l = Math.round(low * 100);
  const h = Math.round(high * 100);
  return l < 0 ? `${l}% to ${h}%` : `${l}–${h}%`;
}
