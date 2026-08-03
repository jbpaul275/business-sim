import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { tick } from '@bizsim/engine';
import type { Business, WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { postmortem, runPoint, type RunPoint } from './postmortem.js';

/**
 * "What would have had to be true" — §9.4.
 *
 * The spec calls this mandatory on insolvency and says why: for a prospective
 * founder it is the single most valuable output the product can generate,
 * because it converts a loss into a specific, checkable claim about the real
 * world. These tests are about whether the claim is specific and whether it is
 * true of the run that produced it.
 */

function run(
  scenario: string,
  periods: number,
  mutate?: (state: WorldState) => void,
): { history: RunPoint[]; business: Business } {
  let state = SCENARIOS[scenario]!();
  mutate?.(state);
  const id = state.businesses[0]!.id;
  const history: RunPoint[] = [];
  for (let i = 0; i < periods; i++) {
    const result = tick(state, [], { throwOnAssertionFailure: false });
    state = result.state;
    const business = state.businesses.find((b) => b.id === id)!;
    const point = runPoint(result, business);
    if (point) history.push(point);
  }
  return { history, business: state.businesses.find((b) => b.id === id)! };
}

/** Cut a restaurant's kitchen below what its demand needs, and wait. */
const starve = (state: WorldState): void => {
  const line = state.businesses[0]!.costs.stepFixed.find((c) => c.id === 'kitchen_labor');
  if (line) {
    line.minimumBlocks = 0;
    line.currentBlocks = 1;
  }
};

describe('a run that failed', () => {
  it('names the volume that would have been needed, in the operator’s own unit', () => {
    const { history, business } = run('restaurant', 36, starve);
    const analysis = postmortem(history, business);
    const text = analysis.lines.join('\n');

    // §9.4 names exactly these: covers per day, occupancy, utilisation, win rate.
    expect(text).toMatch(/covers\/day to break even/);
    // And the comparison, which is what makes it checkable.
    expect(text).toMatch(/against the [\d,]+ covers\/day you averaged/);
    expect(text).toMatch(/best quarter of the whole run reached/);
  });

  it('answers the price question after liquidation has cleared the streams', () => {
    // Insolvency sets `business.streams = []`, so nothing is left to price
    // against — and a closure is exactly when the question gets asked. The
    // answer is computed each quarter while the business still exists.
    const { history, business } = run('restaurant', 40, starve);
    expect(business.status).toBe('CLOSED');
    expect(business.streams).toHaveLength(0);
    const text = postmortem(history, business).lines.join('\n');
    expect(text).toMatch(/Price: (\$[\d,]+|no price the model will defend)/);
  });

  it('still reports volume when the closing quarter has no streams left', () => {
    // The last row of a failed run is the closing period: a real balance sheet
    // and no stream metrics, because liquidation clears them. Reading the units
    // off that row drops the volume, price and break-even lines — three of the
    // four things this analysis exists to say, missing at exactly the moment
    // they are wanted.
    const { history, business } = run('restaurant', 40, starve);
    expect(history[history.length - 1]!.metrics).toBeUndefined();

    const text = postmortem(history, business).lines.join('\n');
    expect(text).toMatch(/Volume: [\d,]+ covers\/day to break even/);
    expect(text).toMatch(/Price:/);
  });

  it('says when the run turned, and does not claim a crisis it recovered from was fatal', () => {
    const { history, business } = run('restaurant', 40, starve);
    const text = postmortem(history, business).lines.join('\n');
    expect(text).toMatch(/first cash crisis came/);
    expect(text).toMatch(/did not stop|traded out of it/);
  });

  it('states the single-lever caveat with the run’s own number in it', () => {
    const { history, business } = run('restaurant', 36, starve);
    const text = postmortem(history, business).lines.join('\n');
    expect(text).toMatch(/holds everything else at what it actually was/);
    // The example is the player's figure, not one from the transcript this was
    // written against.
    expect(text).not.toMatch(/"94% occupancy"/);
    expect(text).toMatch(/covers\/day" is a claim you can check/);
  });
});

describe('a run that is working', () => {
  it('frames the same analysis as what it rests on', () => {
    const { history, business } = run('cash-crunch', 24);
    const analysis = postmortem(history, business);
    expect(analysis.verdict).toBe('WORKED');
    const text = analysis.lines.join('\n');
    expect(text).toMatch(/clear by .* a quarter/);
    expect(text).toMatch(/What it rests on/);
    expect(text).not.toMatch(/What would have had to be true/);
  });

  it('never disagrees with itself about which it is', () => {
    // A business ten years in with positive lifetime EBITDA and a revenue line
    // that no longer covers its costs is not a business that worked. The verdict
    // used to read cumulative EBITDA while the body read the recent gap, and the
    // screen contradicted itself in its first two lines.
    for (const [scenario, periods] of [
      ['restaurant', 20],
      ['storage', 40],
      ['cash-crunch', 24],
      ['services', 16],
    ] as const) {
      const { history, business } = run(scenario, periods);
      const analysis = postmortem(history, business);
      const text = analysis.lines.join('\n');
      if (analysis.verdict === 'WORKED') {
        expect(text, scenario).toMatch(/What it rests on/);
        expect(text, scenario).toMatch(/clear by/);
      } else {
        expect(text, scenario).toMatch(/What would have had to be true/);
      }
    }
  });
});

describe('before there is anything to explain', () => {
  it('says so rather than dividing by zero', () => {
    const state = SCENARIOS['restaurant']!();
    const analysis = postmortem([], state.businesses[0]!);
    expect(analysis.lines.join('\n')).toMatch(/nothing to explain/);
  });
});

describe('the arithmetic is the run’s own', () => {
  it('quotes a peak cash need that matches the business', () => {
    const { history, business } = run('storage', 20);
    const text = postmortem(history, business).lines.join('\n');
    // Not a re-derivation: the same figure the engine tracked, so the screen
    // and the post-mortem can never disagree about it.
    expect(business.peakCashNeed).toBeGreaterThan(fromDisplay(1_000_000));
    expect(text).toMatch(new RegExp(`period ${business.peakCashNeedPeriod}`));
  });
});
