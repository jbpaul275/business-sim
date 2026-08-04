import { NextResponse } from 'next/server';
import { conceptAvailable, createSetup } from '../../../server/setup';
import { toSetupView } from '../../../server/setupView';

export async function POST(request: Request): Promise<NextResponse> {
  const available = conceptAvailable();
  if (!available.ok) {
    return NextResponse.json(
      {
        error:
          `No ${available.keyVar} is set on the server, so the conversational path is ` +
          'unavailable. Start from a template on the home screen instead.',
      },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { capital?: unknown };
  const capital =
    typeof body.capital === 'number' && Number.isFinite(body.capital) && body.capital > 0
      ? Math.min(body.capital, 1_000_000_000)
      : 500_000;
  return NextResponse.json(toSetupView(createSetup(capital)));
}
