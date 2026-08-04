import { NextResponse } from 'next/server';
import { finishSetup, getSetup } from '../../../../../server/setup';
import { toSetupView } from '../../../../../server/setupView';

/**
 * The player's standing out: "no more questions — build the model." Forces
 * the draft with whatever has been said; the model estimates the rest and
 * labels it, and the register review still argues every number. Same
 * long-call allowance as `say` — this IS the drafting call.
 */
export const maxDuration = 300;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });
  if (session.phase !== 'INTERVIEW') {
    return NextResponse.json({ error: 'the interview is already finished' }, { status: 409 });
  }

  try {
    await finishSetup(session);
  } catch (error) {
    return NextResponse.json({ error: String((error as Error).message) }, { status: 409 });
  }
  return NextResponse.json(toSetupView(session));
}
