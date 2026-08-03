import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The screens do not assume every business is a restaurant.
 *
 * Three separate reports, all the same bug. A ready-mix concrete plant was told
 * its break-even was "12 covers/day". A hotel was told it had idle capacity
 * that earned nothing, which is false for OCCUPANCY. A mobile game studio was
 * shown "$5,000 Buildout & equipment" for a development machine, and told the
 * constraint was "the building".
 *
 * The cause each time is the same: the first seed template was a restaurant, so
 * its vocabulary became everyone's. D-5 says the concept path must accept a
 * business nobody has thought of, and a screen that can only describe premises
 * with covers in them does not.
 *
 * This is a lint, not a test of behaviour. It reads the CLI's own source and
 * fails on trade-specific nouns in strings the player sees — which is the only
 * way to catch the *next* one, since by construction nobody notices these until
 * a business that is not a restaurant walks into them.
 */

const SRC = new URL('.', import.meta.url).pathname;

/**
 * Words that belong to one trade, in a string shown to every trade.
 *
 * Deliberately short. A long list turns into a chore of exemptions and stops
 * being read; these are the words that actually shipped wrong.
 */
const TRADE_WORDS = [
  'the building',
  'covers/day',
  'covers a day',
  'seats/units',
  'physically produce',
  'the kitchen',
  'menu item',
  'the dining',
];

/**
 * Not on the list, deliberately: "walk into".
 *
 * It appears in the TRAFFIC archetype's own description — "physical throughput
 * of a place people walk into" — where it is exactly right, because that is
 * what the archetype is. A lint that fires on correct usage gets suppressed,
 * and a suppressed lint catches nothing. The list stays to words that shipped
 * wrong.
 */

/**
 * Lines exempt from the rule.
 *
 * `scenarios.ts` and the archetype descriptions in `setup.ts` are naming actual
 * restaurants and the actual TRAFFIC archetype, where the words are correct.
 * `postmortem.ts` composes `covers/day` from the stream's own `volumeNoun`,
 * which is the fix rather than the bug.
 */
const EXEMPT_FILES = new Set(['scenarios.ts', 'vocabulary.test.ts']);

/** A double-quoted, single-quoted or backticked string, roughly. */
const isPlayerFacing = (line: string): boolean =>
  /(`|'|")/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line);

describe('the screens speak every trade, not one', () => {
  const files = readdirSync(SRC).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXEMPT_FILES.has(f),
  );

  it('reads a real set of source files, or it is asserting nothing', () => {
    // A glob that silently matched zero files would pass every check below.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('play.ts');
    expect(files).toContain('setup.ts');
  });

  for (const word of TRADE_WORDS) {
    it(`never says "${word}" to a business that is not one`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
        for (const [i, line] of lines.entries()) {
          if (!isPlayerFacing(line)) continue;
          if (line.toLowerCase().includes(word)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }
});
