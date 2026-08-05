import { describe, expect, it } from 'vitest';
import { fromDisplay, mulRate } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import {
  DEBT_PRODUCTS,
  LEVERAGE_PRICING,
  collateralValue,
  leverageSpread,
  openingLoanRate,
  underwrite,
} from './debt.js';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';

/**
 * Leverage pricing — the mechanism behind "more equity buys a cheaper loan".
 *
 * A pre-revenue loan used to price at flat prime-plus-spread whether the owner
 * funded half the deal or a tenth of it, so the one thing a founder controls
 * at opening bought them nothing on rate. The quote on the funding screen, the
 * underwriting decision and the opened facility all read the same function, so
 * the number the player accepts is the number the ledger charges.
 */

const spec = (principal: bigint) => ({
  kind: 'SBA_7A' as const,
  requestedPrincipal: principal,
  termQuarters: 40,
  personalGuarantee: true,
  operatorYears: 0,
});

function openedWorld(equity: bigint, loan: bigint) {
  const config = createWorldConfig({ startMode: 'FREEPLAY', customCapital: fromDisplay(5_000_000) });
  const model = buildModelFromTemplate({
    businessName: 'Leverage Test',
    template: getSeedTemplate('full_service_restaurant'),
    scale: {
      seats: 64,
      turnsPerDay: 2,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      price: fromDisplay(42),
    },
    equityInjection: equity,
    ...(loan > 0n
      ? { debt: [{ kind: 'SBA_7A' as const, principal: loan, termQuarters: 40 }] }
      : {}),
  });
  return { config, world: createWorld({ id: 'w', playerId: 'p', config, models: [model] }) };
}

describe('leverageSpread', () => {
  it('is free at half-or-less financed and climbs by tier', () => {
    const equity = fromDisplay(1_000_000);
    // 50/50 → base; just past each boundary → the next tier's spread.
    expect(leverageSpread(fromDisplay(1_000_000), equity)).toBe(0);
    expect(leverageSpread(fromDisplay(1_500_000), equity)).toBe(0.0075); // 60%
    expect(leverageSpread(fromDisplay(3_000_000), equity)).toBe(0.015); // 75%
    expect(leverageSpread(fromDisplay(8_000_000), equity)).toBe(0.03); // ~89%
  });

  it('never prices past the SBA injection floor tier', () => {
    // A deal more levered than 90% is declined, not priced — but the function
    // must still return something sane for the decline message to carry.
    expect(leverageSpread(fromDisplay(99), fromDisplay(1))).toBe(0.03);
    expect(leverageSpread(fromDisplay(100), 0n)).toBe(0.03);
  });

  it('charges nothing on no loan', () => {
    expect(leverageSpread(0n, fromDisplay(100_000))).toBe(0);
  });

  it('tiers end exactly at the underwriting floor', () => {
    // The last tier's edge and MIN_OWNER_INJECTION_PCT are the same claim
    // stated twice; if someone moves one, this fails until they move both.
    expect(LEVERAGE_PRICING[LEVERAGE_PRICING.length - 1]!.maxDebtShare).toBe(0.9);
  });
});

describe('pre-revenue underwriting prices leverage', () => {
  it('quotes a dearer rate for a thinner deal, through the same function everywhere', () => {
    const half = openingLoanRate(0.075, fromDisplay(500_000), fromDisplay(500_000));
    const thin = openingLoanRate(0.075, fromDisplay(850_000), fromDisplay(150_000));
    expect(half).toBeCloseTo(0.075 + DEBT_PRODUCTS.SBA_7A.spreadOverPrime, 10);
    expect(thin).toBeGreaterThan(half);
    expect(thin).toBeCloseTo(half + 0.03, 10);
  });

  it('underwrite charges the same leverage step-up it approves', () => {
    // ~83% financed: approved (collateral covers, injection clears 10%), and
    // the approval carries the top-tier step-up rather than the flat rate.
    const { config, world } = openedWorld(fromDisplay(60_000), 0n);
    const business = world.businesses[0]!;
    const principal = fromDisplay(300_000);
    const decision = underwrite(business, spec(principal), config, world.household, 0);
    expect(decision.approved).toBe(true);
    expect(decision.rate).toBeCloseTo(
      openingLoanRate(config.primeRate, principal, business.balances.contributedCapital),
      10,
    );
  });

  it('still declines past the collateral, whatever the equity', () => {
    const { config, world } = openedWorld(fromDisplay(2_000_000), 0n);
    const business = world.businesses[0]!;
    const decision = underwrite(business, spec(fromDisplay(4_000_000)), config, world.household, 0);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('collateral');
  });

  it('still declines below the 10% injection, however small the loan', () => {
    const { config, world } = openedWorld(fromDisplay(1_000), 0n);
    const business = world.businesses[0]!;
    const decision = underwrite(business, spec(fromDisplay(100_000)), config, world.household, 0);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('10% minimum');
  });
});

describe("the lender's file prices experience (07, stage 3)", () => {
  it('five years earns a spread credit, never below the tier-0 price', () => {
    const thin = openingLoanRate(0.075, fromDisplay(850_000), fromDisplay(150_000));
    const thinVeteran = openingLoanRate(0.075, fromDisplay(850_000), fromDisplay(150_000), 9);
    expect(thinVeteran).toBeCloseTo(thin - 0.0075, 10);
    // A half-equity deal already prices at tier 0 — a resume buys nothing more.
    const half = openingLoanRate(0.075, fromDisplay(500_000), fromDisplay(500_000));
    expect(openingLoanRate(0.075, fromDisplay(500_000), fromDisplay(500_000), 30)).toBeCloseTo(
      half,
      10,
    );
    // Four years is not five.
    expect(openingLoanRate(0.075, fromDisplay(850_000), fromDisplay(150_000), 4)).toBeCloseTo(
      thin,
      10,
    );
  });

  it('the advance-rate credit widens what the same collateral supports', () => {
    const { config, world } = openedWorld(fromDisplay(2_000_000), 0n);
    const business = world.businesses[0]!;
    const collateral = collateralValue(business);
    // A request between raw collateral and 1.15x of it: declined for the
    // newcomer, written for the operator the lender believes can run it.
    const between = mulRate(collateral, 1.08);
    expect(underwrite(business, spec(between), config, world.household, 0).approved).toBe(false);
    const veteran = { ...spec(between), operatorYears: 9 };
    expect(underwrite(business, veteran, config, world.household, 0).approved).toBe(true);
    // The credit is a factor, not a blank cheque.
    const past = { ...spec(mulRate(collateral, 1.3)), operatorYears: 9 };
    expect(underwrite(business, past, config, world.household, 0).approved).toBe(false);
  });
});

describe('the opened facility carries the quoted rate', () => {
  it('prices the opening term loan off the deal it actually sits in', () => {
    const equity = fromDisplay(100_000);
    const loan = fromDisplay(400_000); // 80% financed → +150bp
    const { world } = openedWorld(equity, loan);
    const sba = world.businesses[0]!.debts.find((d) => d.kind === 'SBA_7A')!;
    expect(sba.annualRate).toBeCloseTo(0.075 + DEBT_PRODUCTS.SBA_7A.spreadOverPrime + 0.015, 10);
  });

  it('leaves the revolver at flat pricing', () => {
    const { world } = openedWorld(fromDisplay(500_000), 0n);
    // Revolvers lend against receivables, not the capital structure.
    const model = buildModelFromTemplate({
      businessName: 'Revolver Test',
      template: getSeedTemplate('full_service_restaurant'),
      scale: {
        seats: 64,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 180_000,
        captureRate: 0.05,
        price: fromDisplay(42),
      },
      equityInjection: fromDisplay(50_000),
      debt: [{ kind: 'REVOLVER' as const, principal: fromDisplay(100_000), termQuarters: 40 }],
    });
    const w2 = createWorld({ id: 'w2', playerId: 'p', config: world.config, models: [model] });
    const revolver = w2.businesses[0]!.debts.find((d) => d.kind === 'REVOLVER')!;
    expect(revolver.annualRate).toBeCloseTo(0.075 + DEBT_PRODUCTS.REVOLVER.spreadOverPrime, 10);
  });
});
