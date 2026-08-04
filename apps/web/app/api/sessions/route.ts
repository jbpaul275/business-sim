import { NextResponse } from 'next/server';
import { createSession, listScenarios } from '../../../server/store';
import { toView } from '../../../server/view';

export function GET(): NextResponse {
  return NextResponse.json({ scenarios: listScenarios() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { scenario?: unknown };
  if (typeof body.scenario !== 'string') {
    return NextResponse.json({ error: 'scenario required' }, { status: 400 });
  }
  try {
    const session = createSession(body.scenario);
    return NextResponse.json(toView(session));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
