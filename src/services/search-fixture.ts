import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { urlKey } from '@/utils/url';
import type { SearchHit, SearchProvider } from '@/core/ports';
import type { FixturePage } from '@/types/fixtures';

// A fake web for tests and the eval (spec 3.1, R2): pages from evals/fixtures/,
// matched by keyword for search and by URL for page reads. Results are
// deterministic, so verdicts can be scored.

export async function loadFixturePages(dir = 'evals/fixtures/pages'): Promise<FixturePage[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as FixturePage));
}

export function createFixtureSearch(pages: FixturePage[]): SearchProvider {
  return {
    async search(query, signal) {
      signal?.throwIfAborted();
      const words = query.query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const domains = query.includeDomains?.map((d) => d.toLowerCase());

      return pages
        .filter((p) => !domains || domains.some((d) => hostname(p.url).endsWith(d)))
        .filter((p) => !query.publishedAfter || (p.published_date ?? '') >= query.publishedAfter)
        .map((p) => {
          const haystack = `${p.title} ${p.text}`.toLowerCase();
          return { page: p, score: words.filter((w) => haystack.includes(w)).length };
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.numResults)
        .map(({ page }): SearchHit => ({
          url: page.url,
          title: page.title,
          publishedDate: page.published_date ?? null,
          text: page.text.slice(0, query.maxChars),
        }));
    },

    async fetchPage(url, maxChars, signal) {
      signal?.throwIfAborted();
      const page = pages.find((p) => urlKey(p.url) === urlKey(url));
      if (!page) throw new Error(`Could not read ${url} (fixture page not found).`);
      return { url: page.url, title: page.title, text: page.text.slice(0, maxChars) };
    },
  };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
