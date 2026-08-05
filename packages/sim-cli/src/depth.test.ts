import { describe, expect, it } from 'vitest';
import { createWorldConfig } from '@bizsim/engine';
import { fromDisplay } from '@bizsim/money';
import { listSeedTemplates } from '@bizsim/seeds';
import { buildCandidate, candidatePlans, proposeFunding, type FundingContext } from './funding.js';
import { depthGauge, planDepth, stressDemand } from './depth.js';

/**
 * The depth gauge: risk read out BEFORE the dive, deterministically. The case
 * behind it is a play-test — a certified plumber with $500k insolvent in two
 * quarters, with nothing on the funding screen saying his plan touched the
 * crisis ladder early even at plan.
 */

function contextFor(capital: number): FundingContext {
  const template = listSeedTemplates().find((t) => t.id === 'coffee_shop') ?? listSeedTemplates()[0]!;
  return {
    businessName: 'Depth gauge test',
    template,
    archetype: template.defaultArchetypes[0]!,
    scale: {},
    marketing: template.modifierDefaults.baseMarketingSpendPerQuarter,
    config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: fromDisplay(capital) }),
  };
}

describe('planDepth', () => {
  it('is deterministic and never mutates the world it measures', () => {
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    const c = buildCandidate(ctx, {
      equity: p.proposedEquity,
      outside: 0n,
      loan: p.proposedLoan,
      revolver: p.proposedRevolver,
    });
    const before = JSON.stringify(c.world, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    const first = planDepth(c.world, c.world.businesses[0]!.id);
    const second = planDepth(c.world, c.world.businesses[0]!.id);
    expect(second).toEqual(first);
    expect(
      JSON.stringify(c.world, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).toBe(before);
    expect(first.quarters).toBe(12);
    expect(first.troughQuarter).toBeGreaterThanOrEqual(1);
  });

  it('a funded reference build holds air at plan', () => {
    // The calibrated coffee shop, funded on the proposed plan, survives its
    // own projection: no insolvency inside the window. If this fails, either
    // the seed drifted or the gauge is reading the wrong world.
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    const c = buildCandidate(ctx, {
      equity: p.proposedEquity,
      outside: 0n,
      loan: p.proposedLoan,
      revolver: p.proposedRevolver,
    });
    const depth = planDepth(c.world, c.world.businesses[0]!.id);
    expect(depth.insolvencyQuarter).toBeUndefined();
  });

  it('stress shortens air, and never lengthens it', () => {
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    const c = buildCandidate(ctx, {
      equity: p.proposedEquity,
      outside: 0n,
      loan: p.proposedLoan,
      revolver: p.proposedRevolver,
    });
    const id = c.world.businesses[0]!.id;
    const gauge = depthGauge(c.world, id);
    // Demand 30% under plan cannot leave MORE cash at the trough.
    expect(gauge.stressed.troughCash <= gauge.atPlan.troughCash).toBe(true);
    const mark = (d: { firstCrisisQuarter?: number }): number =>
      d.firstCrisisQuarter ?? Number.POSITIVE_INFINITY;
    expect(mark(gauge.stressed)).toBeLessThanOrEqual(mark(gauge.atPlan));
  });

  it('stressDemand scales the demand lever on a copy, per archetype', () => {
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    const c = buildCandidate(ctx, { equity: p.proposedEquity, outside: 0n, loan: 0n, revolver: 0n });
    const id = c.world.businesses[0]!.id;
    const stressed = stressDemand(c.world, id, 0.7);
    const original = c.world.businesses[0]!.streams[0]!.params;
    const scaled = stressed.businesses[0]!.streams[0]!.params;
    // Coffee shop is TRAFFIC: the walk-by count takes the stress.
    if (original.kind === 'TRAFFIC' && scaled.kind === 'TRAFFIC') {
      expect(scaled.addressableTrafficPerQuarter).toBeCloseTo(
        original.addressableTrafficPerQuarter * 0.7,
        6,
      );
    } else {
      throw new Error(`expected TRAFFIC, got ${original.kind}`);
    }
  });
});

describe("the lender's file in the proposal (07, stage 3)", () => {
  it('experience widens lendable at the same factor the underwriter applies', () => {
    const plain = proposeFunding(contextFor(500_000));
    const veteran = proposeFunding({ ...contextFor(500_000), domainYears: 9 });
    // 1.15x, exactly — the screen must never promise what the lender refuses,
    // so both sides read the same named factor.
    expect(veteran.lendable).toBe((plain.lendable * 115n) / 100n);
    const fourYears = proposeFunding({ ...contextFor(500_000), domainYears: 4 });
    expect(fourYears.lendable).toBe(plain.lendable);
  });
});

describe('candidatePlans', () => {
  it('offers distinct depths: lean carries more debt, cushioned more cash', () => {
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    const plans = candidatePlans(p);
    expect(plans.length).toBeGreaterThanOrEqual(2);
    const equities = plans.map((n) => n.equity.toString());
    expect(new Set(equities).size).toBe(plans.length);

    const lean = plans.find((n) => n.key === 'lean');
    const cushioned = plans.find((n) => n.key === 'cushioned');
    const proposed = plans.find((n) => n.key === 'proposed');
    if (lean && proposed) {
      expect(lean.equity < proposed.equity).toBe(true);
      expect(lean.plan.loan >= proposed.plan.loan).toBe(true);
    }
    if (cushioned && proposed) {
      expect(cushioned.equity > proposed.equity).toBe(true);
    }
  });

  it('every offered plan builds and funds — a card never promises a refused plan', () => {
    const ctx = contextFor(500_000);
    const p = proposeFunding(ctx);
    for (const n of candidatePlans(p)) {
      const c = buildCandidate(ctx, n.plan);
      expect(c.errors).toEqual([]);
      expect(c.shortfall).toBe(0n);
    }
  });
});
