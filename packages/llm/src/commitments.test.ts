import { describe, expect, it } from 'vitest';
import { moneySentences, statedFiguresAppendix, STATED_FIGURES_HEADER } from './commitments.js';
import type { InterviewMessage } from './client.js';

/**
 * The vending-machine contradiction, prevented at the layer where it happened.
 *
 * Turn 4: "a well-placed machine does $75-$150/day in a strong location,
 * $25-$50 in a mediocre one." Turn 6: "that is above the $15-$25/day a typical
 * US machine does." The model's own earlier figures were prose in history and
 * nothing made them commitments. This suite pins the extraction and the
 * appendix; the interview suite pins that the appendix actually reaches the
 * next call.
 */

const assistant = (content: string): InterviewMessage => ({ role: 'assistant', content });
const user = (content: string): InterviewMessage => ({ role: 'user', content });

describe('moneySentences', () => {
  it('keeps the sentence, not the token, because the qualifier is the claim', () => {
    const said =
      'A well-placed machine does $75-$150 a day in a strong location, $25-$50 in a mediocre one. ' +
      'Placement is nearly the whole game.';
    expect(moneySentences(said)).toEqual([
      'A well-placed machine does $75-$150 a day in a strong location, $25-$50 in a mediocre one.',
    ]);
  });

  it('finds money in every shape the advisor guard matches', () => {
    for (const text of ['Rent runs $4,000 a month.', 'Call it $1.1M all-in.', 'About $8.2k each.']) {
      expect(moneySentences(text), text).toHaveLength(1);
    }
  });

  it('ignores sentences with no money in them', () => {
    expect(moneySentences('Placement is nearly the whole game. Think foot traffic.')).toEqual([]);
  });

  it('treats line breaks as sentence breaks, since turns are often lists', () => {
    const listy = 'Two costs to know:\n- machines at $6,000 each\n- commission around 15% of gross';
    expect(moneySentences(listy)).toEqual(['- machines at $6,000 each']);
  });
});

describe('statedFiguresAppendix', () => {
  const VENDING = assistant(
    'A well-placed machine does $75-$150 a day in a strong location, $25-$50 in a mediocre one. ' +
      'What matters more is who owns the placement.',
  );

  it('is empty until the model has stated a figure', () => {
    expect(statedFiguresAppendix([])).toBe('');
    expect(statedFiguresAppendix([user('I want 40 machines at $50/day each.')])).toBe('');
    expect(statedFiguresAppendix([assistant('Where would the machines go?')])).toBe('');
  });

  it('quotes the model its own sentence back', () => {
    const appendix = statedFiguresAppendix([user('vending machines'), VENDING]);
    expect(appendix).toContain(STATED_FIGURES_HEADER);
    expect(appendix).toContain('$75-$150 a day in a strong location');
    // And says what the list is for — revision is allowed, silent
    // contradiction is not.
    expect(appendix).toContain('revise it openly');
  });

  it('never quotes the player as the model', () => {
    // The player's own figures are their business; the commitment mechanism is
    // about the model contradicting *itself*.
    const appendix = statedFiguresAppendix([
      user('My uncle says machines do $500 a day.'),
      VENDING,
    ]);
    expect(appendix).not.toContain('$500');
  });

  it('deduplicates a sentence the model repeated', () => {
    const appendix = statedFiguresAppendix([VENDING, user('go on'), VENDING]);
    expect(appendix.split('$75-$150').length - 1).toBe(1);
  });

  it('keeps the most recent statements when the cap bites', () => {
    // A revision is always the later sentence, so recency is the right end to
    // keep.
    const many: InterviewMessage[] = Array.from({ length: 20 }, (_, i) =>
      assistant(`Item ${i} runs about $${(i + 1) * 100} a month.`),
    );
    const appendix = statedFiguresAppendix(many);
    expect(appendix).toContain('$2000 a month'); // the last statement survives
    expect(appendix).not.toContain('$100 a month'); // the first aged out
    expect(appendix.match(/^- "/gm)).toHaveLength(12);
  });
});
