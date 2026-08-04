import { NextResponse } from 'next/server';
import { shareRun } from '@bizsim/sim-cli';
import { getSession } from '../../../../../server/store';

/**
 * The per-session QA share. Consent is the POST itself — the client shows the
 * notice and the player confirms before this is ever called — and it covers
 * exactly one run, independent of any ambient telemetry setting. No
 * SUPABASE_URL on the server means nothing is sent anywhere, same as the CLI.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === 'string' ? body.note.slice(0, 4000) : '';

  try {
    const result = await shareRun(session.events, session.id, note);
    if (!result.shared) {
      return NextResponse.json({ error: result.skipped ?? 'not configured' }, { status: 503 });
    }
    session.sharedAs = result.reference ?? session.id;
    return NextResponse.json({ reference: session.sharedAs });
  } catch {
    return NextResponse.json({ error: 'QA endpoint unreachable' }, { status: 502 });
  }
}
