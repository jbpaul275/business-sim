import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { createSession } from './store';
import { translateTurn } from './actions';

/**
 * The action bar's server-side translation, against a real business. The
 * semantics mirror the CLI's commands (play.ts is the reference): repay
 * targets the largest balance and never exceeds it, territory only exists
 * where demand is territorial, and malformed fields cost the move, not the
 * turn.
 */

const business = () => {
  const session = createSession('storage');
  return session.world.businesses.find((b) => b.id === session.businessId)!;
};

describe('translateTurn', () => {
  it('translates the growth and money moves into engine actions', () => {
    const b = business();
    const actions = translateTurn(
      {
        expand: { units: 40, costDollars: 200_000 },
        upgrade: { upliftPct: 15, costDollars: 250_000 },
        debt: { amountDollars: 300_000, termQuarters: 20 },
        inject: 50_000,
        distribute: 25_000,
      },
      b,
    );
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain('RAISE_DEBT');
    expect(kinds).toContain('INJECT_CAPITAL');
    expect(kinds).toContain('DISTRIBUTE');
    // Storage is OCCUPANCY: expand adds units, not seats.
    const expands = actions.filter((a) => a.kind === 'EXPAND_CAPACITY');
    expect(expands).toHaveLength(2);
    expect(expands.some((a) => a.kind === 'EXPAND_CAPACITY' && a.spec.deltaUnits === 40)).toBe(true);
    expect(
      expands.some((a) => a.kind === 'EXPAND_CAPACITY' && a.spec.qualityUpliftPct === 0.15),
    ).toBe(true);
    const loan = actions.find((a) => a.kind === 'RAISE_DEBT');
    expect(loan && loan.kind === 'RAISE_DEBT' && loan.spec.termQuarters).toBe(20);
  });

  it('territory is refused where demand is not territorial', () => {
    // Storage is OCCUPANCY — a new territory has no meaning; the move is
    // skipped, matching the CLI's refusal with directions.
    const actions = translateTurn({ territory: { pct: 40, costDollars: 150_000 } }, business());
    expect(actions).toHaveLength(0);
  });

  it('repay targets the largest balance and never exceeds it', () => {
    const b = business();
    const outstanding = b.debts.filter((d) => d.outstandingPrincipal > 0n);
    expect(outstanding.length).toBeGreaterThan(0);
    const largest = outstanding.sort((x, y) =>
      y.outstandingPrincipal > x.outstandingPrincipal ? 1 : -1,
    )[0]!;
    const actions = translateTurn({ repay: 999_000_000 }, b);
    const repay = actions.find((a) => a.kind === 'REPAY_DEBT');
    expect(repay && repay.kind === 'REPAY_DEBT' && repay.debtId).toBe(largest.id);
    expect(repay && repay.kind === 'REPAY_DEBT' && repay.amount).toBe(largest.outstandingPrincipal);
  });

  it('draw needs a revolver and finds it when present', () => {
    const b = business();
    const revolver = b.debts.find((d) => d.kind === 'REVOLVER');
    const actions = translateTurn({ draw: 20_000 }, b);
    if (revolver) {
      const draw = actions.find((a) => a.kind === 'DRAW_REVOLVER');
      expect(draw && draw.kind === 'DRAW_REVOLVER' && draw.debtId).toBe(revolver.id);
      expect(draw && draw.kind === 'DRAW_REVOLVER' && draw.amount).toBe(fromDisplay(20_000));
    } else {
      expect(actions).toHaveLength(0);
    }
  });

  it('malformed fields cost the move, not the turn', () => {
    const actions = translateTurn(
      {
        price: 52,
        expand: { units: -3, costDollars: 100_000 },
        upgrade: { upliftPct: 400, costDollars: 100_000 },
        debt: { amountDollars: Number.NaN },
      },
      business(),
    );
    expect(actions.map((a) => a.kind)).toEqual(['SET_PRICE']);
  });
});
