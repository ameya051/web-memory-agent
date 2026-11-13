import { CITATION } from '@/core/agent/checks';
import type { Flag } from '@/types/agent';
import type { Cite } from '@/types/citations';

// Turns the checked answer text into what the page shows (spec 9.2):
// - [s2] becomes a numbered superscript link to that source, numbered in
//   order of first citation;
// - a ref that was not read in this answer shows as "unverified";
// - a figure the number check flagged is wrapped in <mark>.
//
// Flagged figures are located with the sentence the server sent, then wrapped
// in private-use sentinel characters before markdown parsing. The remark
// plugin below replaces each sentinel pair with a <mark> node.

const OPEN = '';
const CLOSE = '';
const SENTINELS = /[]/g;

export function markFlaggedNumbers(text: string, flags: Flag[]): string {
  const ranges: Array<[number, number]> = [];
  for (const flag of flags) {
    if (flag.kind !== 'number') continue;
    const at = text.indexOf(flag.sentence);
    if (at === -1) continue;
    const start = at + flag.index;
    if (text.slice(start, start + flag.value.length) === flag.value) ranges.push([start, start + flag.value.length]);
  }
  ranges.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of ranges) out = out.slice(0, start) + OPEN + out.slice(start, end) + CLOSE + out.slice(end);
  return out;
}

// A minimal mdast shape; custom nodes become HTML elements through data.hName.
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: { hName: string; hProperties: Record<string, unknown> };
};

const TOKEN = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}|${CITATION.source}`, 'g');

export function remarkCitations(cites: ReadonlyMap<string, Cite>) {
  return () => (tree: MdNode) => walk(tree, cites);
}

function walk(node: MdNode, cites: ReadonlyMap<string, Cite>) {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitText(child.value ?? '', cites);
    if (child.type === 'inlineCode' || child.type === 'code') child.value = child.value?.replace(SENTINELS, '');
    walk(child, cites);
    return [child];
  });
}

function splitText(value: string, cites: ReadonlyMap<string, Cite>): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index > last) out.push(text(value.slice(last, m.index)));
    if (m[1] !== undefined) {
      out.push(element('mark', { className: ['unverified'], title: 'Not found in the cited source' }, [text(m[1])]));
    } else {
      for (const ref of m[2].split(/\s*,\s*/)) out.push(citation(ref, cites.get(ref)));
    }
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push(text(value.slice(last)));
  return out;
}

function citation(ref: string, cite: Cite | undefined): MdNode {
  if (!cite) {
    return element('sup', { className: ['cite', 'unverified'], title: `Citation ${ref} removed: no such source in this answer` }, [
      text('unverified'),
    ]);
  }
  const link: MdNode = { type: 'link', url: cite.url, title: cite.title, children: [text(String(cite.n))] };
  return element('sup', { className: ['cite'] }, [link]);
}

function text(value: string): MdNode {
  return { type: 'text', value };
}

function element(hName: string, hProperties: Record<string, unknown>, children: MdNode[]): MdNode {
  return { type: hName, data: { hName, hProperties }, children };
}
