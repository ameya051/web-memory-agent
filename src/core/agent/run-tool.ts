import { log } from '@/utils/log';
import { ToolError } from './errors';
import type { ToolCallTime } from '@/types/agent';

// Runs one tool call: logs it with its duration and outcome, records its
// timing for the response total, and turns any failure into a ToolError so it
// stays apart from model errors in the stream. A cancelled call is rethrown as
// is. Page text is never logged; the logger redacts the search query.

export async function runTool<T>(
  name: string,
  input: unknown,
  body: () => Promise<T>,
  summarize: (output: T) => string,
  record: (call: ToolCallTime) => void,
): Promise<T> {
  const started = performance.now();
  /** Records the call's timing and returns the fields every log line shares. */
  const finish = (status: 'ok' | 'error' | 'cancelled') => {
    const ended = performance.now();
    record({ name, start: started, end: ended, ok: status === 'ok' });
    return { tool: name, status, ms: Math.round(ended - started), input };
  };

  try {
    const output = await body();
    log.info('tool.call', { ...finish('ok'), result: summarize(output) });
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.info('tool.call', finish('cancelled'));
      throw error;
    }
    const failure = error instanceof ToolError ? error : new ToolError(error instanceof Error ? error.message : String(error));
    log.warn('tool.call', { ...finish('error'), reason: failure.message });
    throw failure;
  }
}
