import { NextResponse } from 'next/server';
import { fromDisplay } from '@bizsim/money';
import type { Action } from '@bizsim/schemas';
import { advanceSession, getSession } from '../../../../../server/store';
import { toView } from '../../../../../server/view';

/**
 * One turn: queued structured decisions, then the tick.
 *
 * The request carries the ActionBar's controls, not engine actions — the
 * server owns the translation, so a client cannot construct an action shape
 * the UI never offered. Free-text `ActionTranslation` (§11.4) arrives later
 * and lands here as another translator, behind the same confirmation rule.
 */

interface TurnRequest {
  price?: number;
  marketingPerQuarter?: number;
  hire?: { costId: string; blocks: number }[];
  fire?: { costId: string; blocks: number }[];
  skip?: number;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as TurnRequest;
  const business = session.world.businesses.find((b) => b.id === session.businessId);
  const stream = business?.streams[0];

  const actions: Action[] = [];
  if (typeof body.price === 'number' && Number.isFinite(body.price) && body.price > 0 && stream) {
    actions.push({ kind: 'SET_PRICE', streamId: stream.id, newPrice: fromDisplay(body.price) });
  }
  if (
    typeof body.marketingPerQuarter === 'number' &&
    Number.isFinite(body.marketingPerQuarter) &&
    body.marketingPerQuarter >= 0 &&
    stream
  ) {
    actions.push({
      kind: 'SET_MARKETING_SPEND',
      streamId: stream.id,
      amountPerQuarter: fromDisplay(body.marketingPerQuarter),
    });
  }
  for (const h of body.hire ?? []) {
    if (typeof h.costId === 'string' && Number.isInteger(h.blocks) && h.blocks > 0) {
      actions.push({ kind: 'ADD_STEP_BLOCK', costId: h.costId, blocks: h.blocks });
    }
  }
  for (const f of body.fire ?? []) {
    if (typeof f.costId === 'string' && Number.isInteger(f.blocks) && f.blocks > 0) {
      actions.push({ kind: 'REMOVE_STEP_BLOCK', costId: f.costId, blocks: f.blocks });
    }
  }

  const skip = typeof body.skip === 'number' && Number.isInteger(body.skip) ? body.skip : 0;
  advanceSession(session, actions, skip);
  return NextResponse.json(toView(session));
}
