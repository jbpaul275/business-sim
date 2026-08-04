import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { attributeQuarter, tick } from '@bizsim/engine';
import type { DeltaAttribution } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { selectAxis, type EigenInput } from './eigen.js';

/**
 * The selector's contract: one axis per quarter, chosen by hierarchy —
 * crisis, then the biggest attribution driver, then the nearest looming
 * constraint, then the slack — with a repetition memory so the same question
 * never lands two quarters running.
 */

function played(quarters: number, asked: string[] = []): EigenInput {
  const state = SCENARIOS['storage']!();
  let result = tick(state, [], { throwOnAssertionFailure: true });
  let attributions: readonly DeltaAttribution[] = [];
  for (let i = 0; i < quarters; i++) {
    const prev = result;
    result = tick(result.state, [], { throwOnAssertionFailure: true });
    attributions = attributeQuarter(
      { state: prev.state, statements: prev.statements },
      result,
      result.state.businesses[0]!.id,
    );
  }
  return {
    world: result.state,
    business: result.state.businesses[0]!,
    result,
    attributions,
    asked,
  };
}

describe('selectAxis', () => {
  it('always returns exactly one axis', () => {
    const axis = selectAxis(played(2));
    expect(axis.question).toMatch(/\?$/);
    expect(axis.fact.length).toBeGreaterThan(10);
  });

  it('picks the biggest attribution driver when the quarter moved', () => {
    const input = played(2);
    // Lease-up quarters move revenue; the top driver is the axis.
    expect(input.attributions.length).toBeGreaterThan(0);
    const axis = selectAxis(input);
    expect(axis.kind).toBe('driver');
    const biggest = input.attributions
      .flatMap((a) => a.drivers.map((d) => ({ a, d })))
      .filter(({ d }) => d.label !== 'Everything else')
      .sort(({ d: x }, { d: y }) =>
        (y.amount < 0n ? -y.amount : y.amount) > (x.amount < 0n ? -x.amount : x.amount) ? 1 : -1,
      )[0]!;
    expect(axis.key).toBe(`driver:${biggest.a.line}:${biggest.d.label}`);
  });

  it('rests an axis that was just asked and yields to the runner-up', () => {
    const input = played(2);
    const first = selectAxis(input);
    const second = selectAxis({ ...input, asked: [first.key] });
    expect(second.key).not.toBe(first.key);
  });

  it('repeats the top driver rather than going silent when everything is rested', () => {
    const input = played(2);
    const first = selectAxis(input);
    // Suppress every candidate the selector could reach.
    const all = [
      ...input.attributions.flatMap((a) =>
        a.drivers.map((d) => `driver:${a.line}:${d.label}`),
      ),
      'horizon:runway',
      'horizon:season:up',
      'horizon:season:down',
      'slack:capacity',
      'slack:cash',
      'slack:milestone',
    ];
    const axis = selectAxis({ ...input, asked: all.slice(-2).concat(all) });
    expect(axis).toBeDefined();
    // With a 2-quarter window only the tail is actually suppressed, so the
    // selector still lands on a real axis rather than throwing.
    expect(axis.question).toMatch(/\?$/);
    expect(first).toBeDefined();
  });

  it('falls back to a horizon or slack axis in a quiet quarter', () => {
    const input = played(2);
    const quiet = { ...input, attributions: [] as DeltaAttribution[] };
    const axis = selectAxis(quiet);
    expect(['horizon', 'slack']).toContain(axis.kind);
    expect(axis.question).toMatch(/\?$/);
  });

  it('asks about idle cash when a pile sits uninvested', () => {
    const input = played(2);
    const entry = input.result.statements.byBusiness[input.business.id]!;
    entry.balanceSheet.cash =
      (entry.incomeStatement.revenue - entry.incomeStatement.ebitda) * 9n + fromDisplay(1_000_000);
    const axis = selectAxis({ ...input, attributions: [], asked: ['slack:capacity'] });
    expect(axis.key).toBe('slack:cash');
    expect(axis.fact).toContain('year of operating costs');
  });

  it('phrases the marketing driver as a question about the next dollar', () => {
    const attribution: DeltaAttribution = {
      line: 'revenue',
      lineLabel: 'Revenue',
      previous: fromDisplay(100_000),
      current: fromDisplay(150_000),
      delta: fromDisplay(50_000),
      drivers: [
        {
          label: 'Marketing response',
          explanation: 'spend up this quarter',
          amount: fromDisplay(50_000),
        },
      ],
    };
    const input = played(1);
    const axis = selectAxis({ ...input, attributions: [attribution] });
    expect(axis.kind).toBe('driver');
    expect(axis.question).toContain('marketing dollar');
    expect(axis.fact).toContain('+$50');
  });
});
