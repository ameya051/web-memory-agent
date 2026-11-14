import { createExtractionJobs, type ExtractionJobs } from '@/core/extract/jobs';
import { createExtractModel } from '@/services/model-openrouter';
import { log } from '@/utils/log';
import { configResult } from './config';
import { getStore } from './store';

// The extraction jobs for this server process (spec 6.3). Kept on globalThis
// so a hot reload keeps the set of running jobs and cannot start one twice.
// Server-only: never import from chat.tsx.

const cache = globalThis as { extraction?: ExtractionJobs; sweepStarted?: boolean };

export function getJobs(): ExtractionJobs {
  if (!configResult.ok) throw new Error('getJobs called without a valid config.');
  return (cache.extraction ??= createExtractionJobs({ model: createExtractModel(configResult.config), store: getStore() }));
}

/**
 * The startup sweep (spec 6.3), in the background, once per process. Never
 * throws. A sweep that could not read the job list (the database was down, or
 * a migration was pending) does not count, so the next call starts it again.
 */
export function startSweep(): void {
  if (!configResult.ok || cache.sweepStarted) return;
  cache.sweepStarted = true;
  log.info('extract.sweep_start');
  void getJobs()
    .sweep()
    .then((swept) => {
      if (!swept) cache.sweepStarted = false;
    });
}
