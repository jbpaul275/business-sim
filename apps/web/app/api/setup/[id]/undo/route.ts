import { NextResponse } from 'next/server';
import { getSetup, undo } from '../../../../../server/setup';
import { toSetupView } from '../../../../../server/setupView';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });
  undo(session);
  return NextResponse.json(toSetupView(session));
}
