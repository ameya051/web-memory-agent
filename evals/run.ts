import { mkdir, writeFile } from 'node:fs/promises';
import { createExaSearch } from '@/services/search-exa';
import { createExtractModel, createMainModel, DEFAULT_MODEL_EXTRACT, type ReasoningEffort } from '@/services/model-openrouter';
import { setLogSink } from '@/utils/log';
import { CASES, type EvalCase } from './cases';
import { DEFAULT_TZ, openHarness, runOne, type CaseRun } from './harness';
import { judge, type Verdict } from './judge';

// npm run eval [-- --live] [--case id,id] [--model slug] [--effort low|medium|high] [--verbose]
//
// Fixture mode (default) scores every case: code checks on the tool trace and
// flags, then the judge on the answer text. Live mode runs the cases that need
// no fixture page against Exa and reports time to first token and total time
// only, since nobody knows whether a live price really changed (spec 10, 11).
// Both run on TEST_DATABASE_URL, emptied before each case. Full answers and
// traces go to evals/results/ for reading.

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const live = args.includes('--live');
const verbose = args.includes('--verbose');
const only = flag('case')?.split(',');
const modelId = flag('model') ?? process.env.MODEL_MAIN ?? 'anthropic/claude-sonnet-5.5';
const effort = (flag('effort') ?? 'medium') as ReasoningEffort;

const env = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set in .env.`);
    process.exit(1);
  }
  return value;
};
const apiKey = env('OPENROUTER_API_KEY');
const databaseUrl = env('TEST_DATABASE_URL');
const exaKey = live ? env('EXA_API_KEY') : null;

if (!verbose) setLogSink(() => {});

const cases = CASES.filter((c) => (!only || only.includes(c.id)) && (!live || c.live));
if (cases.length === 0) {
  console.error(`No cases match. Ids: ${CASES.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const model = createMainModel({ OPENROUTER_API_KEY: apiKey, MODEL_MAIN: modelId }, effort);
const judgeModel = createExtractModel({ OPENROUTER_API_KEY: apiKey, MODEL_EXTRACT: DEFAULT_MODEL_EXTRACT });
const harness = await openHarness(databaseUrl);

type Row = { case: EvalCase; run?: CaseRun; failures: string[]; verdict?: Verdict };
const rows: Row[] = [];

console.log(`${live ? 'Live' : 'Fixture'} eval: ${cases.length} cases, ${modelId}, effort ${effort}\n`);
try {
  for (const c of cases) {
    const timeZone = c.timeZone ?? DEFAULT_TZ;
    const now = harness.demoDay(timeZone);
    const row: Row = { case: c, failures: [] };
    rows.push(row);
    try {
      await harness.reset(c.history === 'seeded', timeZone, now);
      const search = exaKey ? createExaSearch({ apiKey: exaKey }) : harness.web(c.web ?? 'fixture');
      row.run = await runOne({ model, search, store: harness.store, now }, c.question, timeZone);
      if (!live) await score(row);
    } catch (error) {
      row.failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
    }
    print(row);
  }
} finally {
  await harness.close();
}

summarize();
await saveResults();

async function score(row: Row) {
  const run = row.run!;
  for (const check of row.case.checks) {
    const failure = check(run);
    if (failure) row.failures.push(failure);
  }
  if (row.case.rubric && run.answer) {
    row.verdict = await judge(judgeModel, { question: row.case.question, answer: run.answer, rubric: row.case.rubric });
    if (!row.verdict.pass) row.failures.push(`judge: ${row.verdict.reason}`);
  }
}

function seconds(ms: number | null | undefined) {
  return ms == null ? '   -  ' : `${(ms / 1000).toFixed(1).padStart(5)}s`;
}

function print(row: Row) {
  const r = row.run;
  const status = live ? (row.failures.length || r?.error ? 'ERR ' : '    ') : row.failures.length ? 'FAIL' : 'PASS';
  const shape = r ? `${r.steps} calls, ${r.calls.length} tools` : '';
  console.log(`${status} ${row.case.id.padEnd(30)} first token ${seconds(r?.firstTokenMs)}  total ${seconds(r?.totalMs)}  ${shape}`);
  for (const f of row.failures) console.log(`       - ${f}`);
  if (live && r?.error) console.log(`       - ${r.error}`);
}

function summarize() {
  const runs = rows.flatMap((r) => (r.run ? [r.run] : []));
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  };
  const firsts = runs.flatMap((r) => (r.firstTokenMs === null ? [] : [r.firstTokenMs]));
  console.log(`\nMedian first token ${seconds(median(firsts))}, median total ${seconds(median(runs.map((r) => r.totalMs)))}`);
  if (!live) {
    const passed = rows.filter((r) => r.failures.length === 0).length;
    console.log(`${passed}/${rows.length} passed`);
    process.exitCode = passed === rows.length ? 0 : 1;
  }
}

async function saveResults() {
  await mkdir('evals/results', { recursive: true });
  const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, '-')}-${live ? 'live' : 'fixture'}.json`;
  const out = rows.map((r) => ({ id: r.case.id, question: r.case.question, failures: r.failures, verdict: r.verdict, ...r.run }));
  await writeFile(file, JSON.stringify({ model: modelId, effort, live, cases: out }, null, 2));
  console.log(`Results: ${file}`);
}
