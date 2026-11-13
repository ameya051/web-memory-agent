import { createExtractionJobs, type ExtractionJobs } from '@/core/extract/jobs';
import { createExtractModel } from '@/services/model-openrouter';
import { log } from '@/utils/log';
import { configResult } from './config';
import { getStore } from './store';

// The extraction jobs for this server process (spec 6.3). Kept on globalThis
// so a hot reload keeps the set of running jobs and cannot start one twice.
// Server-only: never import from chat.tsx.

const cache = globalThis as { extraction?: ExtractionJobs; swept?: boolean };

export function getJobs(): ExtractionJobs {
  if (!configResult.ok) throw new Error('getJobs called without a valid config.');
  return (cache.extraction ??= createExtractionJobs({ model: createExtractModel(configResult.config), store: getStore() }));
}

/** The startup sweep (spec 6.3), in the background, once per process. Never throws. */
export function startSweep(): void {
  if (!configResult.ok || cache.swept) return;
  cache.swept = true;
  log.info('extract.sweep_start');
  void getJobs().sweep();
}
