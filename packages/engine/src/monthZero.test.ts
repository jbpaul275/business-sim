import { describe, expect, it } from 'vitest';
import { getSeedTemplate } from '@bizsim/seeds';
import { buildModelFromTemplate, computeMonthZeroOutlays } from './index.js';
import { totalMonthZero } from './workingCapital.js';

/**
 * §5.4 month zero, and the two things it was saying wrongly.
 *
 * A mobile game studio took the "no debt needed, and a $3,000 revolver" option
 * and was then shown $15 of "Debt origination fees" — arithmetically right
 * (0.5% of the limit) under a label the screen had just told them did not
 * apply. A revolver's fee buys the *availability* of a line nobody has drawn
 * on, which is a different thing from a fee on borrowed money, and it is
 * precisely the fee that turns up when you borrowed nothing.
 */

const model = (kinds: ('SBA_7A' | 'REVOLVER')[]) => {
  const built = buildModelFromTemplate({
    businessName: 'Studio',
    template: getSeedTemplate('b2b_saas'),
    equityInjection: 100_000_00n,
  });
  return {
    ...built,
    financingPlan: {
      ...built.financingPlan,
      debtRequests: kinds.map((kind) => ({
        kind,
        requestedPrincipal: kind === 'REVOLVER' ? 3_000_00n : 100_000_00n,
        termQuarters: 40,
        personalGuarantee: true,
        operatorYears: 0,
      })),
    },
  };
};

describe('month zero fees', () => {
  it('does not call a revolver commitment fee a debt origination fee', () => {
    const outlays = computeMonthZeroOutlays(model(['REVOLVER']));
    expect(outlays.debtOriginationFees).toBe(0n);
    // 0.5% of the $3,000 limit — the $15 that appeared under the wrong heading.
    expect(outlays.revolverCommitmentFees).toBe(15_00n);
  });

  it('keeps term-debt fees where they belong', () => {
    const outlays = computeMonthZeroOutlays(model(['SBA_7A']));
    expect(outlays.debtOriginationFees).toBe(3_000_00n);
    expect(outlays.revolverCommitmentFees).toBe(0n);
  });

  it('changes no total by splitting the row', () => {
    /**
     * The split is presentational and must stay that way. It is one field
     * becoming two, and the opening balance sheet expenses both — getting that
     * wrong left the books short by exactly the revolver fee, which the
     * articulation suite caught at period 0.
     */
    const both = computeMonthZeroOutlays(model(['SBA_7A', 'REVOLVER']));
    expect(both.debtOriginationFees + both.revolverCommitmentFees).toBe(3_015_00n);
    const { total, ...parts } = both;
    expect(totalMonthZero(parts)).toBe(total);
  });
});
