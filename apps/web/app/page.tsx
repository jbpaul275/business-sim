import { listSeedTemplates } from '@bizsim/seeds';
import { SCENARIOS } from '@bizsim/sim-cli';
import { StartButton } from '../components/StartButton';

/**
 * The scenario picker. Server component: the list comes from the same
 * registries the CLI uses, so a template added as JSON appears here with no
 * further wiring — which is what §4.7's "content, not code" buys.
 */

const LABELS: Record<string, { name: string; kind: string }> = {
  restaurant: { name: 'Full-service restaurant', kind: 'TRAFFIC · Appendix A reference' },
  qsr: { name: 'Quick-service restaurant', kind: 'TRAFFIC' },
  coffee: { name: 'Coffee shop', kind: 'TRAFFIC' },
  retail: { name: 'Retail shop', kind: 'TRAFFIC' },
  services: { name: 'Professional services firm', kind: 'UTILIZATION' },
  agency: { name: 'Marketing agency', kind: 'UTILIZATION' },
  ecommerce: { name: 'Ecommerce / DTC brand', kind: 'UNITS_CAC' },
  saas: { name: 'B2B SaaS', kind: 'SUBSCRIPTION' },
  gym: { name: 'Gym / fitness studio', kind: 'SUBSCRIPTION' },
  storage: { name: 'Self-storage facility', kind: 'OCCUPANCY' },
  contractor: { name: 'General contractor', kind: 'PROJECT_BACKLOG' },
  trades: { name: 'Trades contractor', kind: 'PROJECT_BACKLOG' },
};

export default function Home() {
  const scenarios = Object.keys(SCENARIOS).filter((k) => LABELS[k] !== undefined);
  const templateCount = listSeedTemplates().length;

  return (
    <main className="picker">
      <h1>Business Sim</h1>
      <p className="sub">
        A deterministic engine, three statements that tie to the cent, and ten years to beat the
        index. {templateCount} calibrated templates.
      </p>
      <div className="scenario-grid">
        <a className="scenario-card" href="/new" style={{ textDecoration: 'none' }}>
          <div className="name">Describe your own</div>
          <div className="kind">a conversation — any business you can put in a sentence</div>
        </a>
        {scenarios.map((key) => (
          <StartButton key={key} scenario={key} name={LABELS[key]!.name} kind={LABELS[key]!.kind} />
        ))}
      </div>
    </main>
  );
}
