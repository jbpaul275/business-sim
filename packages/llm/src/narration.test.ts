import { describe, expect, it } from 'vitest';
import type { DeltaAttribution } from '@bizsim/schemas';
import type { Briefing } from './advice.js';
import { NARRATION_PROMPT, narrateQuarter, type TurnNarration } from './narration.js';

/**
 * §11.5 under §1.1's rule, with more exposure than the advisor ever had: this
 * call runs every quarter, not on request, so a fabrication rate that would be
 * occasional in Q&A becomes a certainty here. What is tested is the guard loop
 * — pass, retry, silence — not the prose.
 */

const briefing: Briefing = {
  text: [
    'BRIEFING — every number below was computed by the engine. You have no others.',
    'Revenue this quarter: $169.9k',
    'EBITDA: -$119.0k',
    'Cash in the business: $443',
    'Last quarter revenue: $182.4k',
    'Event 1 this quarter: Drew $6,537.77 on the revolver.',
  ].join('\n'),
  figures: ['$169.9k', '$119.0k', '$443', '$182.4k', '$6,537.77'],
  commands: ['price', 'marketing', 'fire'],
};

const narration = (over: Partial<TurnNarration> = {}): TurnNarration => ({
  headline: 'Revenue slipped and the quarter ran on the revolver.',
  narrative:
    'Revenue fell from $182.4k to $169.9k and the shortfall was covered by the revolver draw. ' +
    'The staffing has not moved, so the margin gap is the demand dip, not the cost base.',
  suggestedQuestions: [],
  ...over,
});

/** A transport that replays a script and records what it was asked. */
const scripted = (replies: TurnNarration[]) => {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    narrate: async (system: string, input: string) => {
      seen.push(input);
      expect(system).toBe(NARRATION_PROMPT);
      const next = replies[i];
      if (!next) throw new Error('script exhausted');
      i += 1;
      return next;
    },
  };
};

describe('narrating a quarter', () => {
  it('passes a narration whose every figure the engine printed', async () => {
    const outcome = await narrateQuarter(scripted([narration()]), briefing);
    expect(outcome?.narration.headline).toContain('revolver');
    expect(outcome?.retriedOn).toBeUndefined();
  });

  it('catches an invented figure and re-asks with the offending tokens named', async () => {
    const transport = scripted([
      narration({ narrative: 'Marketing at $48k a quarter would fix this.' }),
      narration(),
    ]);
    const outcome = await narrateQuarter(transport, briefing);
    expect(outcome?.retriedOn).toEqual(['$48k']);
    // The retry saw its own failed attempt and the correction, so the second
    // answer is a revision rather than a re-roll of the same dice.
    expect(transport.seen[1]).toContain('$48k');
    expect(transport.seen[1]).toContain('not in the briefing');
  });

  it('chooses silence over a narration that cannot stop inventing', async () => {
    /**
     * The outcome that matters. The screen above is complete and correct
     * without the narration; a paragraph that needs two chances and still
     * quotes money the ledger never produced has nothing to add to it.
     */
    const outcome = await narrateQuarter(
      scripted([
        narration({ narrative: 'Costs are running at $200k.' }),
        narration({ narrative: 'Roughly $195k of costs, then.' }),
      ]),
      briefing,
    );
    expect(outcome).toBeUndefined();
  });

  it('sweeps the suggested questions too, not just the prose', async () => {
    // A fabricated figure is not less fabricated for arriving as a question.
    const outcome = await narrateQuarter(
      scripted([
        narration({ suggestedQuestions: ['Should I raise $250k of debt?'] }),
        narration(),
      ]),
      briefing,
    );
    expect(outcome?.retriedOn).toEqual(['$250k']);
  });

  it('carries engine attributions through untouched — §11.5 without model minting', async () => {
    /**
     * The spec puts `attributions` on the narration output; this build refuses
     * to let the model produce assumption IDs and provenance tags, so they are
     * attached from §10.4's engine computation. The contract tested here is
     * pass-through identity: what the engine computed is what the record
     * carries, even when the narration itself needed a retry.
     */
    const attributions: DeltaAttribution[] = [
      {
        line: 'revenue',
        lineLabel: 'Revenue',
        previous: 18_240_000n,
        current: 16_990_000n,
        delta: -1_250_000n,
        drivers: [
          {
            label: 'Seasonality',
            explanation: 'calendar Q3→Q4 (1.08→0.98)',
            amount: -1_250_000n,
            assumptionId: 'a12',
            path: 'streams.s1.seasonality',
            provenance: 'BENCHMARK',
          },
        ],
      },
    ];
    const outcome = await narrateQuarter(scripted([narration()]), briefing, () => 0, attributions);
    expect(outcome?.attributions).toBe(attributions);

    const silent = await narrateQuarter(scripted([narration()]), briefing, () => 0, []);
    expect(silent?.attributions).toBeUndefined();
  });

  it('lets the model restate engine money from events and prior quarters', async () => {
    // The revolver draw and last quarter's revenue are engine-printed; quoting
    // them is the whole point of handing them over.
    const outcome = await narrateQuarter(
      scripted([
        narration({
          narrative: 'The $6,537.77 revolver draw is what kept the quarter solvent.',
        }),
      ]),
      briefing,
    );
    expect(outcome).toBeDefined();
    expect(outcome?.retriedOn).toBeUndefined();
  });
});
