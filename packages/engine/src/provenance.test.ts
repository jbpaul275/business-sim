import { describe, expect, it } from 'vitest';
import { getSeedTemplate } from '@bizsim/seeds';
import { buildModelFromTemplate } from './buildModel.js';

/**
 * §10.3 provenance, on the one assumption that had it hardcoded.
 *
 * `marketingSpendPerQuarter` was registered as PLAYER_ASSUMED with the note
 * "Player-set marketing budget for this stream" — true when setup asked for a
 * marketing budget, and false ever since that question was removed. Nothing
 * caught it because nothing tested it, so every run opened by listing the
 * engine's own default under "your assertions with no evidence behind them":
 * the most damning line on the review screen, pointed at a number the player
 * had never seen, let alone asserted.
 *
 * PLAYER_ASSUMED ranks *below* the model's own estimate in §10.3, so this was
 * not a cosmetic mislabel. It put the register's least trusted grade on a
 * figure that had done nothing to earn it.
 */

const marketing = (model: ReturnType<typeof buildModelFromTemplate>) => {
  const found = model.assumptions.find((a) => a.path.endsWith('.marketingSpendPerQuarter'));
  if (!found) throw new Error('marketing spend was not registered at all');
  return found;
};

describe('where the marketing budget came from', () => {
  it('is not attributed to the player, who was never asked', () => {
    const model = buildModelFromTemplate({
      businessName: 'Reference Restaurant',
      template: getSeedTemplate('full_service_restaurant'),
      equityInjection: 0n,
    });
    expect(marketing(model).provenance).not.toBe('PLAYER_ASSUMED');
    expect(marketing(model).sourceNote).not.toMatch(/player-set/i);
  });

  it('tells the player the thing that is actually true about it', () => {
    // It is not locked. Saying so on the review screen is worth more than a
    // label describing where it came from, which they cannot act on.
    const model = buildModelFromTemplate({
      businessName: 'Reference Restaurant',
      template: getSeedTemplate('full_service_restaurant'),
      equityInjection: 0n,
    });
    expect(marketing(model).sourceNote).toContain('marketing');
  });

  it('carries the model’s grade when a drafted concept supplied it', () => {
    /**
     * The synthetic-template path. The figure arrives on the draft's stream
     * rather than in `params`, so the parameter loop never sees it — without an
     * explicit entry it falls through the mapper's `streams.*` catch-all and is
     * reported as CATALOG, an engine default the model never touched.
     */
    const model = buildModelFromTemplate({
      businessName: 'Telescope rental',
      template: getSeedTemplate('full_service_restaurant'),
      equityInjection: 0n,
      provenanceFor: (path) =>
        path.endsWith('marketingSpendPerQuarter') ? 'LLM_ESTIMATE' : undefined,
    });
    expect(marketing(model).provenance).toBe('LLM_ESTIMATE');
  });

  it('can still be a player’s own number, when one is genuinely supplied', () => {
    // The grade is resolved rather than forbidden: a caller that does ask
    // someone for the figure says so the same way everything else does.
    const model = buildModelFromTemplate({
      businessName: 'Reference Restaurant',
      template: getSeedTemplate('full_service_restaurant'),
      equityInjection: 0n,
      provenanceFor: (path) =>
        path.endsWith('marketingSpendPerQuarter') ? 'PLAYER_SOURCED' : undefined,
    });
    expect(marketing(model).provenance).toBe('PLAYER_SOURCED');
  });
});
