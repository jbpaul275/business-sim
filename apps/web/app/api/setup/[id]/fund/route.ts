import { NextResponse } from 'next/server';
import { toDisplay } from '@bizsim/money';
import { quoteForEquity } from '@bizsim/sim-cli';
import { fromDisplay } from '@bizsim/money';
import { fund, getSetup } from '../../../../../server/setup';
import { toSetupView } from '../../../../../server/setupView';

/**
 * Phase 4. `quoteOnly` prices an equity figure without committing an attempt —
 * the live "that takes a $X loan at Y%" line under the input; a real POST
 * spends one of the four financing attempts against the lender and the gate.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = getSetup(id);
  if (!session) return NextResponse.json({ error: 'no such setup' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    proposed?: unknown;
    equity?: unknown;
    quoteOnly?: unknown;
  };

  if (body.quoteOnly === true && typeof body.equity === 'number' && session.proposal) {
    const p = session.proposal;
    const equity = fromDisplay(body.equity);
    if (equity < p.equityFloor) {
      return NextResponse.json({
        quote: {
          belowFloor: true,
          floor: toDisplay(p.equityFloor, { showCents: false }),
        },
      });
    }
    const q = quoteForEquity(p.needed, session.config.primeRate, equity);
    return NextResponse.json({
      quote: {
        loan: toDisplay(q.loan, { showCents: false }),
        fullyFunded: q.loan === 0n,
        ratePct: (q.rate * 100).toFixed(1),
        sharePct: (q.share * 100).toFixed(0),
        ...(q.cheaper
          ? {
              cheaperHint:
                `Putting in ${toDisplay(q.cheaper.equity, { showCents: false })} keeps debt at or under ` +
                `${(q.cheaper.maxDebtShare * 100).toFixed(0)}% of the deal and prices at ` +
                `${(q.cheaper.rate * 100).toFixed(1)}%.`,
            }
          : {}),
      },
    });
  }

  const outcome = fund(
    session,
    body.proposed === true
      ? { proposed: true }
      : { equityDollars: typeof body.equity === 'number' ? body.equity : 0 },
  );

  return NextResponse.json({
    view: toSetupView(session),
    outcome: {
      ok: outcome.ok,
      ...(outcome.declined ? { declined: outcome.declined } : {}),
      ...(outcome.shortfall !== undefined
        ? { shortfall: toDisplay(outcome.shortfall, { showCents: false }) }
        : {}),
      ...(outcome.belowFloor !== undefined
        ? { belowFloor: toDisplay(outcome.belowFloor, { showCents: false }) }
        : {}),
      ...(outcome.attemptsLeft !== undefined ? { attemptsLeft: outcome.attemptsLeft } : {}),
    },
  });
}
