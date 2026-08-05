import { NextResponse } from 'next/server';
import { advanceSession, getSession } from '../../../../../server/store';
import { narrateAdvance } from '../../../../../server/advisor';
import { describeActions, translateTurn, type TurnRequest } from '../../../../../server/actions';
import { toView } from '../../../../../server/view';

/**
 * One turn: queued structured decisions, then the tick.
 *
 * The request carries the ActionBar's controls, not engine actions — the
 * server owns the translation (see `actions.ts`), so a client cannot
 * construct an action shape the UI never offered.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as TurnRequest;
  const business = session.world.businesses.find((b) => b.id === session.businessId);
  const actions = translateTurn(body, business);

  const skip = typeof body.skip === 'number' && Number.isInteger(body.skip) ? body.skip : 0;
  advanceSession(session, actions, skip);
  // The model's paragraph over the quarter, when a key is present. Fails soft
  // inside — a transport fault costs the player a paragraph, not the turn.
  // It opens on the bet: the moves that actually queued, in player words.
  await narrateAdvance(session, business ? describeActions(actions, business) : []);
  return NextResponse.json(toView(session));
}
