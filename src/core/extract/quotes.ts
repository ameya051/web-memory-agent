// Whether a saved quote appears in a page's text, ignoring case and whitespace
// differences (spec 4.2, 6.3). Used by the extractor to drop unsupported
// claims, and by fetch_page to see whether a saved fact is still on the page.

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function quoteFound(quote: string, text: string): boolean {
  const q = fold(quote);
  return q !== '' && fold(text).includes(q);
}
