import { describe, expect, it } from 'vitest';
import { findCatalogItem, listCatalogItems } from './index.js';

/**
 * The cost catalog — D-2, the data §11.3 rule 1 clamps against.
 *
 * These ranges overrule players. A bare assertion moves a value at most to the
 * nearer boundary of the best range available, and when a catalog entry
 * matches, that boundary is the catalog's. So a wrong range here does not sit
 * quietly in a file — it wins arguments it should lose, against players who
 * are right. The properties below are the ones a bad entry would break.
 */

const items = listCatalogItems();

describe('the catalog data', () => {
  it('is a real tranche, not a placeholder', () => {
    // A regression to a handful of items would silently return M4 to
    // adjudicating between the model's own guesses.
    expect(items.length).toBeGreaterThanOrEqual(140);
  });

  it('has unique ids', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('has coherent ranges, with every tier inside its item', () => {
    for (const item of items) {
      expect(item.low, item.id).toBeLessThanOrEqual(item.high);
      expect(item.low, item.id).toBeGreaterThanOrEqual(0);
      for (const tier of item.tiers) {
        expect(tier.low, `${item.id} / ${tier.tier}`).toBeLessThanOrEqual(tier.high);
        // A tier outside its own item's range means the clamp and the tier
        // disagree about what is possible, and the player sees both.
        expect(tier.low, `${item.id} / ${tier.tier}`).toBeGreaterThanOrEqual(item.low);
        expect(tier.high, `${item.id} / ${tier.tier}`).toBeLessThanOrEqual(item.high);
      }
    }
  });

  it('cites a source a player could actually go and check', () => {
    // "Estimates" is not a source. The catalog's whole claim over the draft's
    // own range is that its numbers can be traced.
    for (const item of items) {
      expect(item.source.length, item.id).toBeGreaterThanOrEqual(40);
    }
  });

  it('never puts one keyword on two items', () => {
    /**
     * Ties resolve first-in-array, silently. "buildout" sat on both the
     * restaurant and the self-storage items, so a storage draft's "unit
     * buildout" was clamped against restaurant dollars-per-square-foot — an
     * authoritative-looking range for a different thing entirely.
     */
    const seen = new Map<string, string>();
    for (const item of items) {
      for (const keyword of item.keywords) {
        const owner = seen.get(keyword.toLowerCase());
        expect(owner, `"${keyword}" on both ${owner} and ${item.id}`).toBeUndefined();
        seen.set(keyword.toLowerCase(), item.id);
      }
    }
  });

  it('units mean what they say', () => {
    // A pct item above 1.0 is almost certainly percentage points typed as a
    // fraction — the register would read 15 as 1500%.
    for (const item of items) {
      if (item.unit === 'pct') expect(item.high, item.id).toBeLessThanOrEqual(1);
    }
  });
});

describe('routing a draft label to its item', () => {
  /**
   * Labels as models actually write them, not as the catalog spells them.
   * Every one of these is the kind of line a draft has produced in a real
   * session, and each must land on the item whose range fits it.
   */
  const fixtures: [string, string][] = [
    ['Walk-in cooler and condenser', 'walk_in_cooler'],
    ['Reach-in cooler (used)', 'reach_in_cooler'],
    ['Line cooks (2)', 'line_cook_wage'],
    ['Customer support (part-time)', 'support_rep_wage'],
    ['Unit buildout', 'restaurant_buildout_sqft'],
    ['Storage buildout, phase 1', 'self_storage_buildout_unit'],
    ['Espresso machine, 2-group', 'espresso_machine'],
    ['7bbl brewhouse', 'brewhouse'],
    ['App store commission (30%)', 'platform_commission'],
    ['Paid user acquisition (CPI)', 'cost_per_install'],
    ['Mixer driver wages', 'cdl_driver_wage'],
    ['Ready-mix batch plant', 'batch_plant'],
    ['Liquor license', 'liquor_license'],
    ['Hotel FF&E refresh', 'hotel_ffe_key'],
    ['Workers comp insurance', 'workers_comp_rate'],
    ['Commissary kitchen rent', 'commissary_rent'],
    ['Dog daycare attendants', 'daycare_attendant_wage'],
    ['Zero-turn mowers (2)', 'zero_turn_mower'],
  ];

  for (const [label, id] of fixtures) {
    it(`"${label}" → ${id}`, () => {
      expect(findCatalogItem(label)?.id).toBe(id);
    });
  }

  it('matches whole words, never the inside of one', () => {
    /**
     * `includes` made every short keyword a landmine: "gl" — general
     * liability's own abbreviation — matched *glycol* and *glassware*, and any
     * label containing "coffee" contains "ffe". The wrongest matches are the
     * ones nobody tests for, because no human reads "coffee" and sees FF&E in
     * the middle of it.
     */
    expect(findCatalogItem('Glycol chiller')?.id).toBe('glycol_chiller');
    expect(findCatalogItem('Coffee roaster, 5kg')?.id).toBe('coffee_roaster');
    expect(findCatalogItem('Glassware and smallwares')?.id).toBe('smallwares');
    expect(findCatalogItem('Graphic design retainer')?.id).not.toBe('signage');
  });

  it('returns nothing rather than something wrong', () => {
    // A label the catalog has no business ruling on. No match means the
    // adjudicator argues from the draft's own range, honestly labelled.
    expect(findCatalogItem('Meteorite acquisition budget')).toBeUndefined();
  });
});
