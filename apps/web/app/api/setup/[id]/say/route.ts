import { NextResponse } from 'next/server';
import { getSetup, object, say } from '../../../../../server/setup';
import { toSetupView } from '../../../../../server/setupView';

/**
 * One player message through the interview. Long-running by design — the
 * drafting call has run 85 seconds live — so the route holds the connection
 * rather than inventing a polling protocol for phase one.
 */
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { text?: unknown; objection?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') return NextResponse.json({ error: 'say something' }, { status: 400 });

  try {
    // An objection from the review screen re-enters the same conversation —
    // `reopen` in the CLI. The flag only affects journaling; the transcript is
    // one conversation either way.
    if (body.objection === true) await object(session, text);
    else await say(session, text);
  } catch (error) {
    return NextResponse.json({ error: String((error as Error).message) }, { status: 409 });
  }
  return NextResponse.json(toSetupView(session));
}
