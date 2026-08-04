import {
  zSeedTemplate,
  zSecurity,
  zCatalogItem,
  type SeedTemplate,
  type Security,
  type CatalogItem,
} from '@bizsim/schemas';
import securities from '../data/securities.json' with { type: 'json' };
import costCatalog from '../data/cost_catalog.json' with { type: 'json' };
import fullServiceRestaurant from '../data/full_service_restaurant.json' with { type: 'json' };
import professionalServicesFirm from '../data/professional_services_firm.json' with { type: 'json' };
import ecommerceDtcBrand from '../data/ecommerce_dtc_brand.json' with { type: 'json' };
import b2bSaas from '../data/b2b_saas.json' with { type: 'json' };
import selfStorage from '../data/self_storage.json' with { type: 'json' };
import generalContractor from '../data/general_contractor.json' with { type: 'json' };
import quickServiceRestaurant from '../data/quick_service_restaurant.json' with { type: 'json' };
import coffeeShop from '../data/coffee_shop.json' with { type: 'json' };
import retailShop from '../data/retail_shop.json' with { type: 'json' };
import marketingAgency from '../data/marketing_agency.json' with { type: 'json' };
import tradesContractor from '../data/trades_contractor.json' with { type: 'json' };
import gymFitness from '../data/gym_fitness.json' with { type: 'json' };

/**
 * Seed templates — spec §4.7. Stored as data, not code, so they can be revised
 * without a deploy.
 *
 * The benchmark bands do double duty: they seed the model AND they power the
 * cost-side pushback loop (§11.3.1). Founders are usually most wrong on the
 * cost side, and an out-of-band value is what turns the register from a passive
 * log into an active reviewer.
 *
 * All twelve of §4.7's templates are here. The first six were built one per
 * archetype, so every archetype is exercised by the property and plausibility
 * suites; the second six reuse those archetypes for the trades §4.7 lists —
 * which is why calibration, not authoring, was the schedule risk.
 */

const RAW: unknown[] = [
  fullServiceRestaurant,
  professionalServicesFirm,
  ecommerceDtcBrand,
  b2bSaas,
  selfStorage,
  generalContractor,
  quickServiceRestaurant,
  coffeeShop,
  retailShop,
  marketingAgency,
  tradesContractor,
  gymFitness,
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

/**
 * The cost catalog — D-2, and §11.3 rule 1's prerequisite.
 *
 * A first tranche, not the full ~500 items D-2 scopes: enough to give the
 * adjudication contract real ranges to argue from across the six existing
 * templates, with the tiers that turn "$10k or $60k" into a question with an
 * answer. Items accrete; the mechanism does not.
 *
 * Every entry carries the source of its range in a sentence a player can check.
 * A catalog whose numbers cannot be traced is the same guess with more
 * confidence attached, which is what this exists to stop.
 */
const catalogItems = costCatalog.map((raw) => zCatalogItem.parse(raw));

export const listCatalogItems = (): CatalogItem[] => [...catalogItems];

/**
 * The catalog entry a cost line is about, by the words used for it.
 *
 * Matched on keywords rather than on ids, because the line was written by a
 * model describing a business and the catalog was written by someone describing
 * an item. The longest keyword that appears wins, since a two-word match is far
 * less likely to be a coincidence than a one-word one.
 *
 * Keywords are deliberately narrow. A bare "cooler" on the walk-in entry
 * matched "reach-in cooler" — a different item at a fifth of the price — and a
 * wrong match is worse than no match here: it hands the adjudicator an
 * authoritative-looking range for something else, which is the exact failure
 * the catalog exists to prevent.
 */
export function findCatalogItem(label: string): CatalogItem | undefined {
  const text = label.toLowerCase();
  let best: { item: CatalogItem; length: number } | undefined;
  for (const item of catalogItems) {
    for (const keyword of item.keywords) {
      if (keywordMatches(text, keyword.toLowerCase()) && (!best || keyword.length > best.length)) {
        best = { item, length: keyword.length };
      }
    }
  }
  return best?.item;
}

/**
 * Whole-word match, not substring.
 *
 * `includes` made every short keyword a landmine: "gl" — general liability's
 * own abbreviation — matched *glycol* and *glassware*, and any label with
 * "coffee" in it contains "ffe". A wrong match is worse than none here (it
 * hands the adjudicator an authoritative-looking range for a different item),
 * and the wrongest matches were the ones nobody would think to test for
 * because no human reads "coffee" and sees FF&E in the middle of it.
 *
 * Boundaries are alphanumeric-based rather than regex `\b`, because keywords
 * like "ff&e" and "build-out" end in characters `\b` treats as boundaries
 * already — the check has to be "not glued to another letter or digit".
 */
function keywordMatches(text: string, keyword: string): boolean {
  const boundary = (index: number): boolean =>
    index >= text.length || !/[a-z0-9]/.test(text[index]!);
  let from = 0;
  while (true) {
    const at = text.indexOf(keyword, from);
    if (at === -1) return false;
    const end = at + keyword.length;
    // An optional trailing "s", because drafts pluralise — "Line cooks (2)",
    // "Dog daycare attendants" — and a boundary check with no stemming would
    // trade the substring landmines for a plural blind spot.
    const afterOk = boundary(end) || (text[end] === 's' && boundary(end + 1));
    if ((at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) && afterOk) return true;
    from = at + 1;
  }
}
