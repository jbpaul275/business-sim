import { NextResponse } from 'next/server';
import { getSession } from '../../../../server/store';
import { toView } from '../../../../server/view';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });
  return NextResponse.json(toView(session));
}
