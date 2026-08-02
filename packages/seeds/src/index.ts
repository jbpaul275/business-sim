import { zSeedTemplate, type SeedTemplate } from '@bizsim/schemas';
import fullServiceRestaurant from '../data/full_service_restaurant.json' with { type: 'json' };

/**
 * Seed templates — spec §4.7. Stored as data, not code, so they can be revised
 * without a deploy.
 *
 * The benchmark bands do double duty: they seed the model AND they power the
 * cost-side pushback loop (§11.3.1). Founders are usually most wrong on the
 * cost side, and an out-of-band value is what turns the register from a passive
 * log into an active reviewer.
 *
 * MVP target is 12+ templates (§4.7). This is the calibrated first one; the
 * remaining eleven are M2 content work, and calibration — not authoring — is
 * the schedule risk. See docs/plan/02-milestones.md.
 */

const RAW: unknown[] = [fullServiceRestaurant];

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
