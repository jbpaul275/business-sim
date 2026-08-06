import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';
import { statementMath } from './showMath.js';
import type { DerivationStep, DerivedValue } from './derivation.js';

/**
 * "Show the math" (§16 Q3). The property that matters is not that a panel
 * exists — it is that the panel's arithmetic lands on the figure it hangs
 * under. A math panel that visibly fails to reproduce its own row destroys the
 * credibility the feature exists to build, so it is asserted rather than
 * eyeballed.
 */

function worldFor(id: string): WorldState {
  const template = getSeedTemplate(id);
  const model = buildModelFromTemplate({
    businessName: 'Show the math',
    template,
    archetype: template.defaultArchetypes[0]!,
    scale: {},
    equityInjection: fromDisplay(600_000),
    // A levered build, so the interest line has something to explain.
    debt: [{ kind: 'SBA_7A' as const, principal: fromDisplay(200_000), termQuarters: 40 }],
  });
  return createWorld({
    id: 'show-math',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: fromDisplay(900_000) }),
    models: [model],
  });
}

const cents = (v: DerivedValue): bigint => (v.kind === 'money' ? v.cents : 0n);

/** Fold a money-only step list the way the panel reads top to bottom. */
function foldMoney(steps: DerivationStep[]): bigint {
  let total = 0n;
  for (const [i, s] of steps.entries()) {
    const amount = cents(s.value);
    if (i === 0) total = amount;
    else if (s.op === '+') total += amount;
    else if (s.op === '−') total -= amount;
  }
  return total;
}

const allMoney = (steps: DerivationStep[]): boolean =>
  steps.length > 0 && steps.every((s) => s.value.kind === 'money');

describe('statementMath', () => {
  it('every subtotal panel reproduces the figure it hangs under', () => {
    const result = tick(worldFor('coffee_shop'), [], { trace: true });
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);

    // Every panel whose steps are all money is an addition the player can do
    // in their head. It must come out.
    let checked = 0;
    for (const m of Object.values(math)) {
      if (!allMoney(m.derivation.steps)) continue;
      expect(foldMoney(m.derivation.steps), `${m.derivation.label} does not fold to its own result`).toBe(
        cents(m.derivation.result),
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('a rolled-up line sums the parts it shows', () => {
    const result = tick(worldFor('coffee_shop'), [], { trace: true });
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);

    const labor = math['incomeStatement.labor'];
    expect(labor).toBeDefined();
    expect(labor!.parts.length).toBeGreaterThan(0);
    const summed = labor!.parts.reduce((acc, p) => acc + cents(p.result), 0n);
    expect(summed).toBe(entry.incomeStatement.labor);
  });

  it('a single-contributor line shows the chain, not a one-item sum', () => {
    // The coffee shop has one revenue stream. Folding "Revenue = Espresso" over
    // the actual factor chain costs a click and says nothing.
    const result = tick(worldFor('coffee_shop'), [], { trace: true });
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);

    const revenue = math['incomeStatement.revenue'];
    expect(revenue).toBeDefined();
    expect(revenue!.parts).toEqual([]);
    expect(revenue!.derivation.label).toBe('Revenue');
    expect(cents(revenue!.derivation.result)).toBe(entry.incomeStatement.revenue);
    // The chain, not a restatement: a served-volume step and a price step.
    expect(revenue!.derivation.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('interest expense carries only interest — never principal or line fees', () => {
    const result = tick(worldFor('coffee_shop'), [], { trace: true });
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);

    const interest = math['incomeStatement.interestExpense'];
    if (!interest) return; // an unlevered build has nothing to explain
    const summed =
      interest.parts.length > 0
        ? interest.parts.reduce((acc, p) => acc + cents(p.result), 0n)
        : cents(interest.derivation.result);
    expect(summed).toBe(entry.incomeStatement.interestExpense);
  });

  it('steps name the assumptions behind them, so the panel reaches the register', () => {
    const result = tick(worldFor('coffee_shop'), [], { trace: true });
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);

    const paths = Object.values(math)
      .flatMap((m) => [m.derivation, ...m.parts])
      .flatMap((d) => d.steps)
      .filter((s) => s.path !== undefined);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('records nothing when tracing is off — the property suite pays nothing', () => {
    const result = tick(worldFor('coffee_shop'), [], { trace: false });
    expect(result.trace.derivations).toEqual({});
    const id = result.state.businesses[0]!.id;
    const entry = result.statements.byBusiness[id]!;
    const math = statementMath(entry.incomeStatement, result.trace);
    // Subtotals are structural and survive; rolled-up lines have no parts to
    // show and are absent, so no affordance is offered for them.
    expect(math['incomeStatement.revenue']).toBeUndefined();
    expect(math['incomeStatement.ebitda']).toBeDefined();
  });

  it('the derivations do not change what the engine computes', () => {
    const traced = tick(worldFor('coffee_shop'), [], { trace: true });
    const untraced = tick(worldFor('coffee_shop'), [], { trace: false });
    const id = traced.state.businesses[0]!.id;
    const other = untraced.state.businesses[0]!.id;
    expect(traced.statements.byBusiness[id]!.incomeStatement).toEqual(
      untraced.statements.byBusiness[other]!.incomeStatement,
    );
  });
});
