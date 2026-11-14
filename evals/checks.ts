import type { CaseRun, ToolCall } from './harness';

// Code checks over one case's run (spec 11). Each returns null when it holds,
// else a short reason. They read the tool trace, not the answer's wording.

export type Check = (r: CaseRun) => string | null;

const named = (r: CaseRun, name: string) => r.calls.filter((c) => c.name === name);

/** The memory exchanges search_memory returned, and its nearest list, across every call. */
function memoryQuestions(r: CaseRun): string[] {
  return named(r, 'search_memory').flatMap((c) => [
    ...(c.output?.exchanges ?? []).map((e: { question: string }) => e.question),
    ...(c.output?.nearest ?? []).map((n: { question: string }) => n.question),
  ]);
}

export const noTools: Check = (r) => (r.calls.length === 0 ? null : `used tools: ${r.calls.map((c) => c.name).join(', ')}`);

export const maxModelCalls =
  (n: number): Check =>
  (r) =>
    r.steps <= n ? null : `${r.steps} model calls, expected at most ${n}`;

export const noError: Check = (r) => (r.error === null ? null : `stream error: ${r.error}`);

/** No citation to an unread ref and no cited number missing from its source. */
export const noFlags: Check = (r) =>
  r.flags.length === 0
    ? null
    : `flags: ${r.flags.map((f) => (f.kind === 'citation' ? `citation ${f.ref}` : `number ${f.value}`)).join(', ')}`;

/** search_memory is called in the first step. */
export const memoryFirst: Check = (r) =>
  r.calls.some((c) => c.step === 0 && c.name === 'search_memory') ? null : 'search_memory not called in the first step';

/** Some search_memory call covers this local date. */
export const memoryDate =
  (date: string): Check =>
  (r) => {
    const covered = named(r, 'search_memory').some((c) => {
      const from = c.input?.date_from;
      const to = c.input?.date_to ?? from;
      return from !== undefined && from <= date && date <= to;
    });
    return covered ? null : `no search_memory call covering ${date}`;
  };

/** search_memory returned an exchange (or a nearest one) whose question contains this text. */
export const memoryFound =
  (text: string): Check =>
  (r) =>
    memoryQuestions(r).some((q) => q.includes(text)) ? null : `search_memory never returned the exchange about "${text}"`;

/** Every listed page was re-read with fetch_page. */
export const fetched =
  (...urls: string[]): Check =>
  (r) => {
    const read = named(r, 'fetch_page').map((c: ToolCall) => String(c.input?.url ?? ''));
    const missing = urls.filter((u) => !read.some((url) => url.includes(u)));
    return missing.length === 0 ? null : `not re-read: ${missing.join(', ')}`;
  };

export const noFetch: Check = (r) => (named(r, 'fetch_page').length === 0 ? null : 'fetch_page called with no saved pages to re-read');

/** The quote check on a re-read page gave this outcome for a saved claim's attribute. */
export const claimOutcome =
  (url: string, attribute: string, outcome: 'unchanged' | 'check'): Check =>
  (r) => {
    const claims = named(r, 'fetch_page')
      .filter((c) => String(c.input?.url ?? '').includes(url) && c.output)
      .flatMap((c) => c.output.saved_claims ?? []);
    const claim = claims.find((c: { attribute: string }) => c.attribute === attribute);
    if (!claim) return `no saved claim "${attribute}" on the read of ${url}`;
    return claim.outcome === outcome ? null : `"${attribute}" on ${url} was ${claim.outcome}, expected ${outcome}`;
  };

/** The page has a newer version than the seeded read (the hash changed). */
export const newVersion =
  (url: string): Check =>
  (r) => {
    const read = named(r, 'fetch_page').find((c) => String(c.input?.url ?? '').includes(url) && c.output);
    if (!read) return `${url} not read`;
    return read.output.version > 1 ? null : `${url} came back as version ${read.output.version}, expected a new version`;
  };

export const answerExcludes =
  (pattern: RegExp): Check =>
  (r) => {
    const m = r.answer.match(pattern);
    return m ? `answer contains "${m[0]}"` : null;
  };
