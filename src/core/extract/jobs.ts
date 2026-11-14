import type { LanguageModel } from 'ai';
import { elapsedMs, log } from '@/utils/log';
import type { Store } from '@/core/ports';
import { extractExchange } from './extract';

// The extraction job (spec 6.3). It runs in this process; the exchanges table
// is the job list, so a job the process never finished is still pending at the
// next start, and the sweep picks it up. A failed attempt is retried here after
// a short wait, up to MAX_ATTEMPTS in all; then the exchange is marked failed
// and memory falls back to its full answer text.

export const MAX_ATTEMPTS = 3;
/** Waits before the second and third attempts. */
export const RETRY_DELAYS_MS = [2_000, 10_000];
/** One model call may take this long before it is abandoned as an error. */
export const EXTRACT_TIMEOUT_MS = 60_000;

export function createExtractionJobs(deps: { model: LanguageModel; store: Store; retryDelaysMs?: number[] }) {
  const { model, store } = deps;
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  // Exchanges with a job running now, so a hot reload or a repeated trigger
  // cannot start the same job twice.
  const running = new Set<string>();

  async function attempt(userId: string, exchangeId: string): Promise<'finished' | 'retry' | 'none'> {
    const job = await store.startExtraction(userId, exchangeId, MAX_ATTEMPTS);
    if (!job) return 'none';
    const start = performance.now();

    // Every claim needs a source, so an exchange without one has nothing to extract.
    if (job.sources.length === 0) {
      await store.saveExtraction(userId, exchangeId, { status: 'skipped', topic: null, summary: null, entities: [], claims: [] });
      log.info('extract.skipped', { exchange: exchangeId });
      return 'finished';
    }

    try {
      const out = await extractExchange(model, job, AbortSignal.timeout(EXTRACT_TIMEOUT_MS));
      await store.saveExtraction(userId, exchangeId, {
        status: 'done',
        topic: out.topic,
        summary: out.summary,
        entities: out.entities,
        claims: out.claims,
      });
      log.info('extract.done', { exchange: exchangeId, ms: elapsedMs(start), claims: out.claims.length, dropped: out.dropped });
      return 'finished';
    } catch (error) {
      const status = await store.failExtraction(userId, exchangeId, MAX_ATTEMPTS);
      log.warn('extract.failed', { exchange: exchangeId, ms: elapsedMs(start), status, error });
      return status === 'pending' ? 'retry' : 'finished';
    }
  }

  /** Runs one exchange's job to an end: done, skipped or failed. Never throws. */
  async function run(userId: string, exchangeId: string): Promise<void> {
    if (running.has(exchangeId)) return;
    running.add(exchangeId);
    try {
      for (let retry = 0; ; retry++) {
        if ((await attempt(userId, exchangeId)) !== 'retry') return;
        await sleep(delays[Math.min(retry, delays.length - 1)] ?? 0);
      }
    } catch (error) {
      // A database error: the exchange stays pending for the next sweep.
      log.error('extract.job_failed', { exchange: exchangeId, error });
    } finally {
      running.delete(exchangeId);
    }
  }

  /** Every pending exchange, oldest first, one at a time (spec 6.3). Never throws. */
  async function sweep(): Promise<void> {
    try {
      const pending = await store.pendingExtractions();
      log.info('extract.sweep', { pending: pending.length });
      for (const p of pending) await run(p.userId, p.id);
    } catch (error) {
      log.error('extract.sweep_failed', { error });
    }
  }

  return { run, sweep };
}

export type ExtractionJobs = ReturnType<typeof createExtractionJobs>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
