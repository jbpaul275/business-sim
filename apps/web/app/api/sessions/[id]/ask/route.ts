import { NextResponse } from 'next/server';
import { askGame } from '../../../../../server/advisor';
import { getSession } from '../../../../../server/store';
import { toView } from '../../../../../server/view';

/**
 * One conversational exchange with the turn advisor. The reply lands in the
 * session's advisor feed, so the response is simply the refreshed view — the
 * same shape every other mutation returns.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '' || text.length > 2000) {
    return NextResponse.json({ error: 'say something (under 2000 characters)' }, { status: 400 });
  }

  const outcome = await askGame(session, text);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error ?? 'the advisor is unavailable' }, { status: 503 });
  }
  return NextResponse.json(toView(session));
}
