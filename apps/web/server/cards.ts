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
}

export const CARDS: Record<string, CardSpec> = {
  restaurant: {
    templateId: 'full_service_restaurant',
    name: 'Full-service restaurant',
    blurb: 'Seats × turns against a lease that escalates 3% a year.',
    matureBy: 3,
  },
  qsr: {
    templateId: 'quick_service_restaurant',
    name: 'Quick-service restaurant',
    blurb: 'Counter throughput at a low ticket — the corner IS the marketing.',
    matureBy: 3,
  },
  coffee: {
    templateId: 'coffee_shop',
    name: 'Coffee shop',
    blurb: 'High-frequency small tickets; labor and rent take most of every one.',
    matureBy: 3,
  },
  retail: {
    templateId: 'retail_shop',
    name: 'Retail shop',
    blurb: 'Keystone margins on inventory that ties up cash for a season.',
    matureBy: 3,
  },
  services: {
    templateId: 'professional_services_firm',
    name: 'Professional services firm',
    blurb: 'Hours you can sell — utilisation and the bench decide the year.',
    matureBy: 4,
  },
  agency: {
    templateId: 'marketing_agency',
    name: 'Marketing agency',
    blurb: 'Sell hours, hold utilisation, flex the overflow to freelancers.',
    matureBy: 4,
  },
  ecommerce: {
    templateId: 'ecommerce_dtc_brand',
    name: 'Ecommerce / DTC brand',
    blurb: 'Every order is bought — CAC inflates as spend chases growth.',
    matureBy: 5,
  },
  saas: {
    templateId: 'b2b_saas',
    name: 'B2B SaaS',
    blurb: 'A retained base compounding slowly against a fixed engineering payroll.',
    matureBy: 9,
  },
  gym: {
    templateId: 'gym_fitness',
    name: 'Gym / fitness studio',
    blurb: 'Members churn every month; the building must be paid either way.',
    matureBy: 5,
  },
  storage: {
    templateId: 'self_storage',
    name: 'Self-storage facility',
    blurb: 'A fixed stock of units leasing up toward stabilized occupancy.',
    matureBy: 6,
  },
  contractor: {
    templateId: 'general_contractor',
    name: 'General contractor',
    blurb: 'Win bids, execute the backlog, wait out retainage.',
    matureBy: 4,
  },
  trades: {
    templateId: 'trades_contractor',
    name: 'Trades contractor',
    blurb: 'Trucks and crews on small jobs — customer deposits fund the work.',
    matureBy: 4,
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
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return {
    toOpen,
    ...(ebitda
      ? { band: `${pct(ebitda.low)}–${pct(ebitda.high)} EBITDA by year ${spec.matureBy}` }
      : {}),
  };
}
