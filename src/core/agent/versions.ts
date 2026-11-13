import type { LatestFetch } from '@/core/ports';

// Page versions (spec 5.5): a full-page read gets the same version as the
// user's latest read of that URL when the normalised text hashes the same,
// and the next version when it differs. The first read is version 1.

export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** SHA-256 hex of the normalised text, through the global Web Crypto API. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalise(text)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function nextVersion(hash: string, latest: LatestFetch | null, now: Date): LatestFetch {
  if (!latest) return { version: 1, hash, firstSeenAt: now };
  if (latest.hash === hash) return latest;
  return { version: latest.version + 1, hash, firstSeenAt: now };
}
