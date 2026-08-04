import { NextResponse } from 'next/server';
import { toDisplay, type Money } from '@bizsim/money';
import { computeMonthZeroOutlays } from '@bizsim/engine';
import { getSetup } from '../../../../../server/setup';
import { createSessionFromWorld } from '../../../../../server/store';

/**
 * Phase 4's final gate: committing freezes the model. The world was already
 * built and gated by `fund`; this records the commit and opens the game.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });
  if (session.phase !== 'REVIEW' || !session.candidate) {
    return NextResponse.json({ error: 'nothing to commit yet' }, { status: 409 });
  }

  const { model, world } = session.candidate;
  session.events.push({
    kind: 'commit',
    committed: true,
    equity: toDisplay(model.financingPlan.equityInjection),
    termDebt: toDisplay(
      model.financingPlan.debtRequests
        .filter((d) => d.kind !== 'REVOLVER')
        .reduce<Money>((a, d) => a + d.requestedPrincipal, 0n),
    ),
    openingCash: toDisplay(world.businesses[0]?.cash ?? 0n),
    monthZero: toDisplay(computeMonthZeroOutlays(model).total),
  });

  const game = createSessionFromWorld(world, model.businessName, session.events);
  session.phase = 'DEAD';
  session.deadReason = 'committed';
  return NextResponse.json({ playId: game.id });
}
