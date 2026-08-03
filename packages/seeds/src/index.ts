import { zSeedTemplate, zSecurity, type SeedTemplate, type Security } from '@bizsim/schemas';
import securities from '../data/securities.json' with { type: 'json' };
import fullServiceRestaurant from '../data/full_service_restaurant.json' with { type: 'json' };
import professionalServicesFirm from '../data/professional_services_firm.json' with { type: 'json' };
import ecommerceDtcBrand from '../data/ecommerce_dtc_brand.json' with { type: 'json' };
import b2bSaas from '../data/b2b_saas.json' with { type: 'json' };
import selfStorage from '../data/self_storage.json' with { type: 'json' };
import generalContractor from '../data/general_contractor.json' with { type: 'json' };

/**
 * Seed templates — spec §4.7. Stored as data, not code, so they can be revised
 * without a deploy.
 *
 * The benchmark bands do double duty: they seed the model AND they power the
 * cost-side pushback loop (§11.3.1). Founders are usually most wrong on the
 * cost side, and an out-of-band value is what turns the register from a passive
 * log into an active reviewer.
 *
 * MVP target is 12+ templates (§4.7). Six are here — one per archetype, so
 * every archetype is exercised by the property and plausibility suites. The
 * remaining six are M2 content work, and calibration, not authoring, is the
 * schedule risk. See docs/plan/02-milestones.md.
 */

const RAW: unknown[] = [
  fullServiceRestaurant,
  professionalServicesFirm,
  ecommerceDtcBrand,
  b2bSaas,
  selfStorage,
  generalContractor,
];

const templates = new Map<string, SeedTemplate>();
for (const raw of RAW) {
  const parsed = zSeedTemplate.parse(raw);
  templates.set(parsed.id, parsed);
}

export function getSeedTemplate(id: string): SeedTemplate {
  const template = templates.get(id);
  if (!template) {
    throw new Error(
      `Unknown seed template "${id}". Known: ${[...templates.keys()].join(', ')}`,
    );
  }
  return template;
}

export const listSeedTemplates = (): SeedTemplate[] => [...templates.values()];
export const seedTemplateIds = (): string[] => [...templates.keys()];

/**
 * The investable catalog — spec §10.3 CATALOG provenance.
 *
 * Five instruments, not five hundred. The point is the opportunity cost of the
 * player's own capital, not a trading game: an index to be measured against, a
 * dividend payer, a growth name, property at arm's length, and the risk-free
 * rate. Each carries the reasoning for its numbers, because they are
 * assumptions a player is entitled to argue with rather than quotes.
 */
const catalog = new Map<string, Security>();
for (const raw of securities) {
  const parsed = zSecurity.parse(raw);
  catalog.set(parsed.ticker, parsed);
}

export const listSecurities = (): Security[] => [...catalog.values()];
export const getSecurity = (ticker: string): Security | undefined =>
  catalog.get(ticker.toUpperCase());
export const benchmarkSecurity = (): Security =>
  [...catalog.values()].find((s) => s.isBenchmark) ?? [...catalog.values()][0]!;

/**
 * §12.2 requires each quarter's three monthly weights to average that quarter's
 * seasonality value, or the monthly and quarterly sheets in the export will not
 * reconcile — and a workbook whose own tabs disagree is worse than no workbook.
 */
export function validateMonthlyWeights(template: SeedTemplate): string[] {
  const issues: string[] = [];
  for (let q = 0; q < 4; q++) {
    const months = template.monthlySeasonalWeight.slice(q * 3, q * 3 + 3);
    const average = months.reduce((a, b) => a + b, 0) / 3;
    const target = template.seasonality[q] ?? 1;
    if (Math.abs(average - target) > 0.02) {
      issues.push(
        `${template.id}: Q${q + 1} monthly weights average ${average.toFixed(3)} but ` +
          `quarterly seasonality is ${target.toFixed(3)}.`,
      );
    }
  }
  const overall = template.monthlySeasonalWeight.reduce((a, b) => a + b, 0) / 12;
  if (Math.abs(overall - 1) > 0.02) {
    issues.push(`${template.id}: monthly weights average ${overall.toFixed(3)}, expected 1.00.`);
  }
  return issues;
}
