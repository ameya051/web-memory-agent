/** A URL compared by its parsed form without the #fragment; null if it is not http(s). */
export function urlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}
