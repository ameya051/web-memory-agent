import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { markFlaggedNumbers } from '@/app/citations';
import { Markdown } from '@/app/markdown';
import { urlKey } from '@/utils/url';
import type { Cite } from '@/types/citations';

const SOURCE = 'https://www.hubspot.com/pricing/sales';
const cites = new Map<string, Cite>([['s3', { n: 1, url: SOURCE, title: 'HubSpot pricing' }]]);
const allowedUrls = new Set([urlKey(SOURCE)!]);

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, cites, allowedUrls }));

describe('answer rendering', () => {
  it('does not render images or raw HTML', () => {
    const html = render(`![chart](${SOURCE}) and <script>alert(1)</script><b>bold</b>`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
  });

  it('renders links only to the exchange sources', () => {
    const html = render(`[pricing](${SOURCE}) and [elsewhere](https://evil.example/x) and https://evil.example/y`);
    expect(html).toContain(`href="${SOURCE}"`);
    expect(html).not.toContain('evil.example/x"');
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('elsewhere');
  });

  it('numbers citations and marks an unknown ref as unverified', () => {
    const html = render('Pro is $90 [s3]. Starter is cheap [s8].');
    expect(html).toContain(`<sup class="cite"><a href="${SOURCE}" title="HubSpot pricing"`);
    expect(html).toContain('>1</a></sup>');
    expect(html).toContain('<sup class="cite unverified"');
    expect(html).not.toContain('[s8]');
  });

  it('marks a flagged figure', () => {
    const text = 'Plans:\n\n| Plan | Price |\n|---|---|\n| Pro | **$95** [s3] |';
    const flagged = markFlaggedNumbers(text, [
      { kind: 'number', value: '95', refs: ['s3'], sentence: '| Pro | **$95** [s3] |', index: 11 },
    ]);
    const html = render(flagged);
    expect(html).toContain('<strong>$<mark class="unverified" title="Not found in the cited source">95</mark></strong>');
  });
});
