import { systemClock } from '@/services/clock';
import { createExtractModel, DEFAULT_MODEL_EXTRACT } from '@/services/model-openrouter';
import { loadDemoHistory } from '@/services/seed';
import { createPostgresStore } from '@/services/store-postgres';
import { createExtractionJobs } from '@/core/extract/jobs';
import { parseTimeZone } from '@/utils/dates';

// Loads the demo history (spec 8) into DATABASE_URL, then runs the extraction
// job over it: npm run seed [-- --tz Area/City]. The timezone defaults to this
// machine's. Without OPENROUTER_API_KEY the exchanges stay pending and the
// app's startup sweep extracts them. Safe to run twice.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const at = process.argv.indexOf('--tz');
const timeZone = parseTimeZone(at === -1 ? Intl.DateTimeFormat().resolvedOptions().timeZone : process.argv[at + 1]);

const store = createPostgresStore(url);
try {
  const { added, skipped, exchanges } = await loadDemoHistory(store, timeZone, systemClock.now());
  console.log(`Demo history in ${timeZone}: ${added} conversations added, ${skipped} already there.`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(`OPENROUTER_API_KEY is not set: ${exchanges.length} exchanges left pending for the startup sweep.`);
  } else if (exchanges.length > 0) {
    const model = createExtractModel({ OPENROUTER_API_KEY: apiKey, MODEL_EXTRACT: process.env.MODEL_EXTRACT || DEFAULT_MODEL_EXTRACT });
    const jobs = createExtractionJobs({ model, store });
    for (const e of exchanges) await jobs.run(e.userId, e.id);
    console.log(`Extraction run over ${exchanges.length} exchanges.`);
  }
} finally {
  await store.end();
}
