import { describe, expect, it } from 'vitest';
import type { Assumption } from '@bizsim/schemas';
import { statementTab, tabRegister } from './view';

/**
 * The tab split answers a play-test: category clusters alone still mixed a
 * buildout total, an average ticket, and "2,000 sq ft" in one scroll — three
 * different kinds of claim, checked three different ways. Classification must
 * be deterministic from fields the schema already carries.
 */

function assumption(over: Partial<Assumption>): Assumption {
  return {
    id: over.path ?? 'a',
    businessId: 'b',
    path: 'costs.fixed.0.amountPerQuarter',
    label: 'Rent',
    category: 'COST',
    value: 100_000n,
    unit: 'USD',
    isMoney: true,
    range: { low: 0, high: 10_000 },
    provenance: 'CATALOG',
    sourceNote: 'catalog default',
    outsideBenchmark: false,
    challengeHistory: [],
    ...over,
  };
}

describe('statementTab', () => {
  it('routes capex, working-capital terms, and financing to the investment tab', () => {
    expect(statementTab(assumption({ category: 'CAPEX', path: 'capex.0.amount' }))).toBe('investment');
    expect(
      statementTab(
        assumption({
          category: 'WORKING_CAPITAL',
          path: 'workingCapital.dsoDays',
          unit: 'days',
          isMoney: false,
          value: 45,
        }),
      ),
    ).toBe('investment');
    expect(statementTab(assumption({ category: 'FINANCING', path: 'financingPlan.rate', unit: 'pct', isMoney: false, value: 0.1 }))).toBe(
      'investment',
    );
  });

  it('routes dollar amounts and rates to the P&L tab', () => {
    expect(statementTab(assumption({}))).toBe('pnl');
    expect(
      statementTab(
        assumption({ category: 'REVENUE', path: 'streams.0.params.captureRate', unit: 'pct', isMoney: false, value: 0.04 }),
      ),
    ).toBe('pnl');
  });

  it('routes physical shape — square feet, seats, hours — to the descriptive tab', () => {
    // The live case: a food truck carrying a 2,000 sq ft floor area. Wrong
    // number, but also the wrong tab to argue it from — it is not a dollar
    // line on any statement.
    expect(
      statementTab(
        assumption({ category: 'REVENUE', path: 'streams.0.params.floorAreaSqFt', label: 'Floor area', unit: 'count', isMoney: false, value: 2_000 }),
      ),
    ).toBe('descriptive');
    expect(
      statementTab(
        assumption({ category: 'REVENUE', path: 'streams.0.params.hoursOpenPerQuarter', unit: 'hours', isMoney: false, value: 700 }),
      ),
    ).toBe('descriptive');
  });
});

describe('tabRegister', () => {
  it('keeps an escalator folded onto its base line inside the base tab', () => {
    const tabs = tabRegister([
      assumption({}),
      assumption({
        path: 'costs.fixed.0.annualEscalatorPct',
        label: 'Rent annual escalator',
        unit: 'pct',
        isMoney: false,
        value: 0.02,
      }),
    ]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.key).toBe('pnl');
    const rows = tabs[0]!.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.escalator).toBe('2.0%');
  });

  it('drops empty tabs and counts deviations per tab', () => {
    const tabs = tabRegister([
      assumption({
        category: 'CAPEX',
        path: 'capex.0.amount',
        label: 'Buildout',
        outsideBenchmark: true,
        benchmarkBand: { low: 100, high: 500, source: 'catalog' },
        value: 5_000_000n,
      }),
    ]);
    expect(tabs.map((t) => t.key)).toEqual(['investment']);
    expect(tabs[0]!.deviations).toBe(1);
  });
});
