import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@bizsim/schemas';
import { describeEvent } from './events.js';

/**
 * "note that a lot of the feedback it does give is barely human readable ...
 * it's largely the AI talking to itself."
 *
 * The events are the most consequential lines on the screen — they are the
 * moments the business nearly died and what was done about it — and they were
 * printed as their own field dump. `iteration=1` means nothing to anyone
 * outside this codebase.
 */

const event = (kind: EngineEvent['kind'], detail: EngineEvent['detail']): EngineEvent => ({
  period: 0,
  kind,
  severity: 'WARNING',
  detail,
});

describe('engine events, in English', () => {
  it('says what a cash crisis was, not which loop iteration found it', () => {
    const said = describeEvent(event('CASH_CRISIS', { shortfall: 16_462.92, iteration: 1 }));
    expect(said).toContain('Ran out of cash');
    expect(said).toContain('$16.5k');
    // `iteration=1` is an implementation detail of the crisis ladder.
    expect(said).not.toContain('iteration');
  });

  it('keeps the engine note and adds what it does not say', () => {
    // "Deferred $8,561.25 of owner compensation" is already a sentence, so
    // restating it was noise. What it does not say is that the money is owed.
    const said = describeEvent(
      event('CRISIS_REMEDY_APPLIED', {
        remedy: 'DEFER_OWNER_COMP',
        note: 'Deferred $8,561.25 of owner compensation.',
      }),
    );
    expect(said).toContain('Deferred $8,561.25');
    expect(said).toContain('accrues');
    expect(said).not.toContain('DEFER_OWNER_COMP');
  });

  it('distinguishes the remedies you can undo from the ones you cannot', () => {
    // Drawing a revolver is a Tuesday. Selling the building you operate out of
    // is not, and both read identically before this.
    const revolver = describeEvent(
      event('CRISIS_REMEDY_APPLIED', { remedy: 'REVOLVER', note: 'Drew $5,509.24 on the revolver.' }),
    );
    const leaseback = describeEvent(
      event('CRISIS_REMEDY_APPLIED', {
        remedy: 'SALE_LEASEBACK',
        note: 'Sold and leased back Storefront building purchase for $44,134.62.',
      }),
    );
    expect(revolver).not.toMatch(/gone for good|permanent/);
    expect(leaseback).toMatch(/gone for good/);
    expect(leaseback).toMatch(/permanent cost/);
  });

  it('says what insolvency cost personally, which is the number that matters', () => {
    const said = describeEvent(
      event('INSOLVENCY', { liquidationProceeds: 6_037.67, guaranteedDeficiency: 27_750.06 }),
    );
    expect(said).toContain('$6.0k');
    expect(said).toContain('$27.8k');
    expect(said).toMatch(/follows you personally/);
  });

  it('reads a runway warning as time, not as a decimal', () => {
    expect(describeEvent(event('RUNWAY_WARNING', { quarters: 0.02 }))).toContain('Less than a month');
    expect(describeEvent(event('RUNWAY_WARNING', { quarters: 2.4 }))).toContain('2.4 quarters');
  });

  it('shows an event it has no sentence for rather than hiding it', () => {
    // A missing event is a worse failure than an ugly one.
    const said = describeEvent(event('MILESTONE_REACHED' as EngineEvent['kind'], {}));
    expect(said.length).toBeGreaterThan(0);
    const unknown = describeEvent({ ...event('CASH_CRISIS', { x: 1 }), kind: 'NOT_A_KIND' as EngineEvent['kind'] });
    expect(unknown).toContain('NOT_A_KIND');
    expect(unknown).toContain('x=1');
  });
});
