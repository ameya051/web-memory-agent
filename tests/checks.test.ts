import { describe, expect, it } from 'vitest';
import { checkAnswer, splitSentences } from '@/core/agent/checks';

const sources = new Map([
  ['s1', { text: 'Sales Hub Professional costs $90 per seat per month. Enterprise costs $1,500.00 per month.' }],
  ['s2', { text: 'Pipedrive Essential costs $14 per seat per month.' }],
]);

const sentences = (text: string) => splitSentences(text).map(({ start, end }) => text.slice(start, end).trim());

describe('sentence split', () => {
  it('keeps trailing citations with their sentence and splits lines', () => {
    expect(sentences('Pro is $90. [s1] Starter is $20 [s1].\n| Essential | $14 [s2] |')).toEqual([
      'Pro is $90. [s1]',
      'Starter is $20 [s1].',
      '| Essential | $14 [s2] |',
    ]);
  });

  it('does not split on decimals', () => {
    expect(sentences('It costs $1.50 per user [s1].')).toEqual(['It costs $1.50 per user [s1].']);
  });
});

describe('number check', () => {
  it('passes numbers found in the cited source', () => {
    expect(checkAnswer(['Professional costs $90 per seat [s1].'], sources)).toEqual([]);
  });

  it('flags a number absent from its source, with where to find it', () => {
    const text = 'Intro line.\nProfessional costs $95 per seat [s1].';
    const flags = checkAnswer([text], sources);
    expect(flags).toEqual([
      { kind: 'number', value: '95', refs: ['s1'], sentence: 'Professional costs $95 per seat [s1].', index: 20 },
    ]);
  });

  it('skips written dates, but still checks a figure beside one', () => {
    for (const date of ['9 November', 'November 9, 2026', '9th Nov 2026', 'Nov. 9', '2026-11-09', 'November 2026']) {
      expect(checkAnswer([`On ${date} Professional cost $90 per seat [s1].`], sources)).toEqual([]);
    }
    expect(checkAnswer(['On 9 November Professional cost $95 per seat [s1].'], sources)).toMatchObject([{ value: '95' }]);
  });

  it('reads a lowercase "may" after a number as a word, not a month', () => {
    expect(checkAnswer(['The price of $29 may rise next year [s1].'], sources)).toMatchObject([{ value: '29' }]);
    expect(checkAnswer(['The $90 may rise next year [s1].'], sources)).toEqual([]);
  });

  it('checks against the cited source only, accepting any of several', () => {
    expect(checkAnswer(['Essential is $14 [s1].'], sources)).toHaveLength(1);
    expect(checkAnswer(['Essential is $14 [s1][s2].'], sources)).toEqual([]);
    expect(checkAnswer(['Essential is $14 [s1, s2].'], sources)).toEqual([]);
  });

  it('compares numbers without commas or trailing decimal zeros', () => {
    expect(checkAnswer(['Enterprise is $1500 a month [s1].'], sources)).toEqual([]);
    expect(checkAnswer(['Pro is $90.00 [s1].'], sources)).toEqual([]);
  });

  it('ignores uncited sentences, list numbering, words with digits, URLs and code', () => {
    const text = [
      'Revenue grew 40% last year.',
      '1. Pro is $90 [s1].',
      'GPT-4 and Q3 plans cost $90 [s1].',
      'See [the page](https://example.com/plan/77) or `v777` for $90 [s1].',
    ].join('\n');
    expect(checkAnswer([text], sources)).toEqual([]);
  });

  it('checks every number on a cited table row', () => {
    const flags = checkAnswer(['| Professional | $90 | $99 | [s1] |'], sources);
    expect(flags.map((f) => f.kind === 'number' && f.value)).toEqual(['99']);
  });
});

describe('citation check', () => {
  it('flags a ref that was not read in this answer, once', () => {
    const flags = checkAnswer(['Pro is $90 [s9]. Starter is cheap [s9].'], sources);
    expect(flags).toContainEqual({ kind: 'citation', ref: 's9' });
    expect(flags.filter((f) => f.kind === 'citation')).toHaveLength(1);
    // The figure has no valid source, so it is unverified too.
    expect(flags).toContainEqual(expect.objectContaining({ kind: 'number', value: '90', refs: [] }));
  });
});
