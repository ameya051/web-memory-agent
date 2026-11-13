import type { Flag, SourceRead } from '@/types/agent';

// Output checks (spec 9.2), run once the answer has streamed. They annotate the
// answer and never change or hold it back.
//
// Citation check: every [sN] must be a ref read in this answer.
// Number check: in a sentence or table row that cites sources, every number
// must appear in the text of at least one source it cites. Numbers compare
// after removing commas and trailing decimal zeros, so "$1,000.00" matches
// "1000". Currency and units are not compared. List numbering, URLs, code and
// digits attached to a word ("Q3", "GPT-4") are not numbers here.

/** One citation marker: [s1] or [s1, s3]. */
export const CITATION = /\[(s\d+(?:\s*,\s*s\d+)*)\]/g;
const CITATION_RUN = /^(?:\s*\[s\d+(?:\s*,\s*s\d+)*\])+/;
const ANSWER_NUMBER = /(?<![\p{L}\d.,])(?<!\p{L}-)\d(?:[\d,]*\d)?(?:\.\d+)?/gu;
const SOURCE_NUMBER = /\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const NOT_NUMBERS = [
  /^[ \t]*\d+[.)](?=\s)/gm, // list numbering
  /\]\([^)\s]*\)/g, // markdown link targets
  /https?:\/\/\S+/g, // bare URLs
  /`[^`\n]*`/g, // inline code
];

export function checkAnswer(blocks: string[], sources: ReadonlyMap<string, Pick<SourceRead, 'text'>>): Flag[] {
  const flags: Flag[] = [];
  const badRefs = new Set<string>();
  const numbersBySource = new Map<string, Set<string>>();
  const sourceNumbers = (ref: string) => {
    let set = numbersBySource.get(ref);
    if (!set) {
      set = new Set((sources.get(ref)?.text.match(SOURCE_NUMBER) ?? []).map(canonical));
      numbersBySource.set(ref, set);
    }
    return set;
  };

  for (const block of blocks) {
    const masked = NOT_NUMBERS.reduce((text, re) => text.replace(re, blank), block);

    for (const { start, end } of splitSentences(masked)) {
      const refs = citedRefs(masked.slice(start, end));
      if (refs.length === 0) continue;

      for (const ref of refs) if (!sources.has(ref)) badRefs.add(ref);
      const valid = refs.filter((ref) => sources.has(ref));

      const scan = masked.slice(start, end).replace(CITATION, blank);
      for (const match of scan.matchAll(ANSWER_NUMBER)) {
        const n = canonical(match[0]);
        if (valid.some((ref) => sourceNumbers(ref).has(n))) continue;
        flags.push({ kind: 'number', value: match[0], refs: valid, sentence: block.slice(start, end), index: match.index });
      }
    }
  }

  return [...[...badRefs].map((ref): Flag => ({ kind: 'citation', ref })), ...flags];
}

/** Refs in citation markers, in order of appearance, without repeats. */
export function citedRefs(text: string): string[] {
  const refs = [...text.matchAll(CITATION)].flatMap((m) => m[1].split(/\s*,\s*/));
  return [...new Set(refs)];
}

/**
 * Sentence ranges in a block. Lines (so table rows) always end a sentence. A
 * sentence also ends at . ! or ? followed by a space, taking any citation
 * markers that follow with it: "costs $90. [s1]" is one sentence.
 */
export function splitSentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const push = (start: number, end: number) => {
    if (text.slice(start, end).trim() !== '') out.push({ start, end });
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      push(start, i);
      start = i + 1;
    } else if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      const end = i + 1 + (CITATION_RUN.exec(text.slice(i + 1))?.[0].length ?? 0);
      push(start, end);
      start = end;
      i = end - 1;
    }
  }
  push(start, text.length);
  return out;
}

/** "1,000.50" → "1000.5", "90.00" → "90", "05" → "5". */
function canonical(n: string): string {
  let s = n.replace(/,/g, '');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s.replace(/^0+(?=\d)/, '');
}

/** Replaces a match with spaces of the same length, so offsets stay valid. */
function blank(match: string): string {
  return ' '.repeat(match.length);
}
