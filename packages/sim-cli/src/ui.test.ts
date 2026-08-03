import { afterEach, describe, expect, it } from 'vitest';
import { box, frameWidth, masthead, rule, speech, visibleWidth, youPrompt } from './ui.js';
import { parseMoney } from './input.js';
import { fromDisplay } from '@bizsim/money';

/**
 * The frame is decoration, and decoration that misrenders is worse than none —
 * a box with a ragged right edge reads as a bug in the program, not a bug in
 * the box. So what is tested here is that it holds its shape: at any terminal
 * width, with colour on or off, with content longer than the frame.
 */

const columns = process.stdout.columns;
const isTTY = process.stdout.isTTY;

function atWidth<T>(width: number | undefined, fn: () => T): T {
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  }
}

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
});

describe('the frame holds its shape', () => {
  it('draws every line to the same width, colour or not', () => {
    for (const tty of [true, false]) {
      Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
      const lines = box(['BUSINESS SIMULATOR', 'short', '']).split('\n');
      const widths = new Set(lines.map(visibleWidth));
      expect(widths.size, `tty=${tty}`).toBe(1);
    }
  });

  it('wraps content longer than the frame instead of pushing the border off', () => {
    // An eighty-column masthead in a sixty-column terminal ran the right
    // border past the end of the line, which looks exactly like a rendering
    // bug because it is one.
    const lines = atWidth(60, () =>
      box(['x'.repeat(200)]).split('\n'),
    );
    expect(lines.length).toBeGreaterThan(3);
    expect(new Set(lines.map(visibleWidth)).size).toBe(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it('stays inside the terminal at any width, down to a very narrow one', () => {
    for (const width of [40, 56, 60, 80, 120, undefined]) {
      const drawn = atWidth(width, () => masthead().split('\n').map(visibleWidth));
      const frame = atWidth(width, frameWidth);
      expect(new Set(drawn), `columns=${width}`).toEqual(new Set([frame]));
      if (width !== undefined && width >= 58) {
        for (const w of drawn) expect(w, `columns=${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('never lets a rule run past the frame', () => {
    for (const width of [40, 60, 80, 200]) {
      const drawn = atWidth(width, () => visibleWidth(rule('Before you commit')));
      expect(drawn, `columns=${width}`).toBe(atWidth(width, frameWidth));
    }
  });

  it('measures what is drawn, not what is stored', () => {
    // The whole reason padding works. `.length` on a coloured string counts the
    // escape codes too, which is how a box ends up ragged only once colour is on.
    expect(visibleWidth('\x1b[1mfive\x1b[0m')).toBe(4);
    expect(visibleWidth('plain')).toBe(5);
  });

  it('marks every line of a speech, so the conversation has one edge', () => {
    const marked = speech('one\ntwo\nthree').split('\n');
    expect(marked).toHaveLength(3);
    for (const line of marked) expect(line).toContain('▏');
  });

  it('drops colour when the output is not a terminal', () => {
    // A pasted transcript is how this gets debugged, and a transcript full of
    // raw escape codes is not one.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // eslint-disable-next-line no-control-regex
    const escapes = /\x1b\[/;
    expect(escapes.test(masthead())).toBe(false);
    expect(escapes.test(rule('Funding'))).toBe(false);
    expect(escapes.test(youPrompt())).toBe(false);
  });
});

describe('reading an amount', () => {
  it('accepts the units the screen advertises', () => {
    // "Custom — free play, capped at $1B", and then `$1B` was rejected as
    // unreadable. A prompt that names a unit it cannot parse is worse than one
    // that names none.
    expect(parseMoney('$1B')).toBe(fromDisplay(1_000_000_000));
    expect(parseMoney('1b')).toBe(fromDisplay(1_000_000_000));
    expect(parseMoney('2bn')).toBe(fromDisplay(2_000_000_000));
    expect(parseMoney('1.5m')).toBe(fromDisplay(1_500_000));
    expect(parseMoney('12k')).toBe(fromDisplay(12_000));
    expect(parseMoney('$1,000,000,000')).toBe(fromDisplay(1_000_000_000));
    expect(parseMoney('$40,000')).toBe(fromDisplay(40_000));
    expect(parseMoney('45')).toBe(fromDisplay(45));
    expect(parseMoney('1 000 000')).toBe(fromDisplay(1_000_000));
  });

  it('still refuses what is genuinely unreadable', () => {
    for (const raw of ['', 'lots', '$', '1x', 'a million', '1.2.3']) {
      expect(parseMoney(raw), raw).toBeUndefined();
    }
  });
});
