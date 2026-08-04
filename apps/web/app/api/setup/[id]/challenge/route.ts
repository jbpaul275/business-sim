import { NextResponse } from 'next/server';
import { challenge, getSetup } from '../../../../../server/setup';
import { toSetupView } from '../../../../../server/setupView';

/** Phase 3 — one §11.3 adjudication, isolated from the conversational thread. */
export const maxDuration = 120;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    assumptionId?: unknown;
    value?: unknown;
    basis?: unknown;
  };
  if (typeof body.assumptionId !== 'string' || typeof body.value !== 'string') {
    return NextResponse.json({ error: 'assumptionId and value required' }, { status: 400 });
  }
  const result = await challenge(
    session,
    body.assumptionId,
    body.value,
    typeof body.basis === 'string' ? body.basis : '',
  );
  if ('error' in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ result, view: toSetupView(session) });
}
