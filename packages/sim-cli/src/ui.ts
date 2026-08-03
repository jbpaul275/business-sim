/**
 * The frame around the game.
 *
 * A terminal is a terminal, and a session that opens with `STARTING CAPITAL`
 * and no preamble reads as a script someone left running rather than a place
 * you have entered. This is not decoration for its own sake: knowing which
 * region of the screen is the conversation — and that you are inside something
 * with edges — is what makes a CLI feel like a game instead of a prompt.
 *
 * Everything degrades. Colour is dropped when the output is not a terminal or
 * when NO_COLOR is set, and the box characters are chosen from the range that
 * has been safe in every terminal since the nineties. A pasted transcript
 * should read cleanly, because pasted transcripts are how this gets debugged.
 */

const plain = (): boolean =>
  !process.stdout.isTTY || process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb';

/** Amber — the ledger colour, and warm enough to read as an interior. */
const ACCENT_ON = '\x1b[38;5;179m';
const DIM_ON = '\x1b[2m';
const BOLD_ON = '\x1b[1m';
const RESET_ON = '\x1b[0m';

export const accent = (s: string): string => (plain() ? s : `${ACCENT_ON}${s}${RESET_ON}`);
export const dim = (s: string): string => (plain() ? s : `${DIM_ON}${s}${RESET_ON}`);
export const bold = (s: string): string => (plain() ? s : `${BOLD_ON}${s}${RESET_ON}`);

/**
 * Printable width, ignoring escape sequences.
 *
 * Padding a line that contains colour codes by `.length` pads by the codes too,
 * which is how a box ends up with a ragged right edge that only appears once
 * colour is on. Counting what is actually drawn is the whole job here.
 */
export const visibleWidth = (s: string): number =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, '').length;

const MIN_WIDTH = 56;
const MAX_WIDTH = 78;

export function frameWidth(): number {
  const columns = process.stdout.columns ?? MAX_WIDTH;
  const usable = columns - 2;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, usable));
}

/**
 * Break a line to fit, keeping any leading escape sequence on every fragment.
 *
 * Colour is applied to the whole string before it gets here, so a naive split
 * puts the opening code on the first fragment and the reset on the last, and
 * the middle of a wrapped line loses its styling. Re-applying the prefix is
 * cheaper than threading style through the caller.
 */
function fit(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  // eslint-disable-next-line no-control-regex
  const prefix = /^(?:\x1b\[[0-9;]*m)+/.exec(line)?.[0] ?? '';
  // A single token longer than the frame has to be cut, not wrapped: an id or
  // a URL has no space to break at, and leaving it long is the ragged edge
  // this function exists to prevent.
  const words = line.split(' ').flatMap((word) => {
    if (visibleWidth(word) <= width) return [word];
    const pieces: string[] = [];
    for (let i = 0; i < word.length; i += width) pieces.push(word.slice(i, i + width));
    return pieces;
  });
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) > width && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  // Re-open the style on every fragment and close it on every fragment, or the
  // first line's dim bleeds into the padding and the border behind it.
  return prefix
    ? out.map((piece) => `${piece.startsWith(prefix) ? piece : prefix + piece}${RESET_ON}`)
    : out;
}

/**
 * A rounded box. Lines are padded to the frame width by what they *draw*, so a
 * coloured line and a plain one end at the same column — padding by `.length`
 * counts the escape codes and gives a ragged right edge that only shows up
 * once colour is on.
 *
 * Content longer than the frame is wrapped rather than allowed to run: an
 * eighty-column masthead in a sixty-column terminal pushed the right border
 * off the end of the line, which looks like a rendering bug because it is one.
 */
export function box(lines: readonly string[]): string {
  const width = frameWidth();
  const inner = width - 4;
  const top = accent(`╭${'─'.repeat(width - 2)}╮`);
  const bottom = accent(`╰${'─'.repeat(width - 2)}╯`);
  const body = lines
    .flatMap((line) => fit(line, inner))
    .map((line) => {
      const pad = Math.max(0, inner - visibleWidth(line));
      return `${accent('│')}  ${line}${' '.repeat(pad)}${accent('│')}`;
    });
  return [top, ...body, bottom].join('\n');
}

/**
 * The masthead. Printed once, before anything asks for anything.
 *
 * The second line is the product's actual claim rather than a tagline, because
 * it is also the thing a new player most needs to know: nothing here is
 * committed until they say so, which is what makes it safe to try an absurd
 * idea.
 */
export function masthead(): string {
  return box([
    bold('BUSINESS SIMULATOR'),
    dim('Every number carries its source. Nothing is real until you commit.'),
  ]);
}

/**
 * A labelled divider, for the seams between phases.
 *
 *   ── FUNDING ──────────────────────────────────────────────────
 */
export function rule(label: string): string {
  const width = frameWidth();
  const HEAD = 2;
  const MIN_TAIL = 3;
  const room = width - HEAD - MIN_TAIL - 2; // the two spaces around the label
  const shown = label.toUpperCase().slice(0, Math.max(1, room));
  const text = ` ${shown} `;
  // Exactly `width`, never approximately: a rule two characters short of the
  // box above it is more distracting than no rule at all.
  const tail = Math.max(MIN_TAIL, width - HEAD - visibleWidth(text));
  return `${accent('─'.repeat(HEAD))}${bold(text)}${accent('─'.repeat(tail))}`;
}

/**
 * The conversation's left edge.
 *
 * Everything the interviewer says carries this bar, so the region of the screen
 * that is *the conversation* is distinguishable at a glance from the region
 * that is numbers. That distinction is the whole point: one of them is someone
 * talking to you and the other is the ledger, and they should not look alike.
 */
export function speech(text: string): string {
  return text
    .split('\n')
    .map((line) => `${accent('▏')} ${line}`)
    .join('\n');
}

/**
 * An indented explanatory line, wrapped to the frame.
 *
 * Prose that runs past the rule above it makes the rule look arbitrary rather
 * than structural — the eye reads the longest line as the real width.
 */
export function note(text: string): string {
  return fit(text, frameWidth() - 2)
    .map((line) => `  ${dim(line)}`)
    .join('\n');
}

/** The player's own prompt, marked so their turn is visibly theirs. */
export const youPrompt = (): string => `${accent('▌')} ${bold('you')} ${dim('›')} `;
