import { toCompact } from '@bizsim/money';
import { buildModelFromTemplate, computeMonthZeroOutlays } from '@bizsim/engine';
import { getSeedTemplate } from '@bizsim/seeds';
import { StartButton } from '../components/StartButton';

/**
 * The scenario picker. Server component: everything on a card is either
 * editorial (the one-line dynamics) or computed from the template itself —
 * the opening cost comes from the same month-zero probe the funding screen
 * uses, and the earning band is the template's own sourced §13.3 band. No
 * card number can drift from what the game actually charges or produces.
 *
 * "Describe your own" is the headline path, not a thirteenth card: the
 * templates exist so there is something to play without a model key, and so
 * the engine has calibrated ground truth — the conversation is the product.
 */

interface CardSpec {
  templateId: string;
  name: string;
  /** The binding constraint and the dynamic that decides the run, in words. */
  blurb: string;
  /** Year the calibrated build reaches its band (STATUS.md's maturity table). */
  matureBy: number;
}

const CARDS: Record<string, CardSpec> = {
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

interface CardFacts {
  toOpen: string;
  band?: string;
}

/** The card's numbers, computed from the template rather than written twice. */
function factsFor(spec: CardSpec): CardFacts {
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

export default function Home() {
  const cards = Object.entries(CARDS).map(([scenario, spec]) => ({
    scenario,
    spec,
    facts: factsFor(spec),
  }));

  return (
    <main className="picker">
      <h1>Business Sim</h1>
      <p className="sub">
        A deterministic engine, three statements that tie to the cent, and ten years to beat the
        index.
      </p>

      <a className="hero-card" href="/new">
        <div className="hero-title">Describe your own business</div>
        <div className="hero-sub">
          A sentence is enough. The model asks what it needs, drafts every number with its source —
          and you argue with any of them before a dollar is committed.
        </div>
        <span className="hero-go">Start the conversation →</span>
      </a>

      <div className="divider">or start from a calibrated template</div>

      <div className="scenario-grid">
        {cards.map(({ scenario, spec, facts }) => (
          <StartButton
            key={scenario}
            scenario={scenario}
            name={spec.name}
            blurb={spec.blurb}
            facts={[facts.toOpen, ...(facts.band ? [facts.band] : [])]}
          />
        ))}
      </div>
      <p className="picker-foot">
        Every template is calibrated against published operating benchmarks — the EBITDA bands above
        are the ranges its own test suite holds it to.
      </p>
    </main>
  );
}
