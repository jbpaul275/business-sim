import { describe, expect, it } from 'vitest';
import { createSession } from './store';
import { toView } from './view';

/**
 * "Show the math" (§16 Q3), end to end through the web wire.
 *
 * The engine's own suite proves the arithmetic ties. What this proves is that
 * it survives the trip: the store has to tick with tracing on, and the view has
 * to attach the panel to the right row. Either one silently off and the feature
 * is simply absent, with nothing failing.
 */

describe('the math on the income statement', () => {
  it('reaches the rows a player would ask about', () => {
    const view = toView(createSession('coffee'));
    const labelled = new Map(view.statements.is.map((r) => [r.label, r]));

    for (const label of ['Revenue', 'Labor', 'Gross profit', 'EBITDA', 'Net income']) {
      expect(labelled.get(label)?.math, `${label} has no math`).toBeDefined();
    }
  });

  it('a panel never re-prints the row it hangs under', () => {
    const view = toView(createSession('coffee'));
    for (const row of view.statements.is) {
      if (!row.math) continue;
      // The last step is a step, not a restatement of the total.
      const last = row.math.steps[row.math.steps.length - 1];
      if (last) expect(last.label).not.toBe(row.label);
    }
  });

  it('steps carry the assumption paths that make the register reachable', () => {
    const view = toView(createSession('coffee'));
    const revenue = view.statements.is.find((r) => r.label === 'Revenue');
    expect(revenue?.math).toBeDefined();
    const priced = revenue!.math!.steps.some((s) => s.path?.includes('avgTicket'));
    expect(priced).toBe(true);
  });

  it('a rolled-up line offers its contributors, each with its own arithmetic', () => {
    const view = toView(createSession('coffee'));
    const labor = view.statements.is.find((r) => r.label === 'Labor');
    expect(labor?.math?.parts?.length).toBeGreaterThan(0);
    for (const part of labor!.math!.parts!) {
      expect(part.steps.length).toBeGreaterThan(0);
      expect(part.result).toMatch(/^-?\$/);
    }
  });

  it('money in a panel is formatted exactly as the statement formats it', () => {
    const view = toView(createSession('coffee'));
    const labor = view.statements.is.find((r) => r.label === 'Labor');
    const parts = labor?.math?.parts ?? [];
    // Same formatter both sides, so a player comparing the two sees one
    // document rather than two conventions.
    for (const p of parts) expect(p.result).toMatch(/^-?\$[\d,]+\.\d{2}$/);
    expect(labor?.value).toMatch(/^-?\$[\d,]+\.\d{2}$/);
  });

  it('the balance sheet carries no math yet, and says so by absence', () => {
    // Stage 1 is the income statement. A row with nothing recorded renders no
    // affordance rather than one that opens onto an empty panel.
    const view = toView(createSession('coffee'));
    expect(view.statements.bs.every((r) => r.math === undefined)).toBe(true);
    expect(view.statements.cf.every((r) => r.math === undefined)).toBe(true);
  });
});
