import { NextResponse } from 'next/server';
import { getSession } from '../../../../../server/store';
import { parseSuggestion } from '../../../../../server/advisor';

/**
 * The command input's other half: one line of the game's own grammar in, one
 * staged move out — deterministic, no model call, validated against the real
 * business by the same parser that guards advisor chips. A non-parse is an
 * honest error the client can hand to the advisor as conversation instead.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'no such session' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { command?: unknown };
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return NextResponse.json({ error: 'nothing to parse' });

  const business = session.world.businesses.find((b) => b.id === session.businessId);
  if (!business) return NextResponse.json({ error: 'no business in this session' });

  const move = parseSuggestion(command, business);
  if (!move) {
    return NextResponse.json({ error: 'not a move this build can stage' });
  }
  return NextResponse.json({ move });
}
