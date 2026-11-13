import { APICallError } from 'ai';
import { log } from '@/utils/log';

// Turns a failure into the plain message shown in the thread (spec 6.4).
// Model failure details go to the server log, not to the browser.

/** A failed tool call. Its message is written for the model and the user. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function chatErrorMessage(error: unknown): string {
  // Already logged by runTool.
  if (error instanceof ToolError) return error.message;
  log.error('chat.model_failed', { error });
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return 'The model provider rejected OPENROUTER_API_KEY. Check the key in .env and restart.';
    }
    if (error.statusCode === 429) return 'The model provider is rate limiting requests. Try again in a moment.';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || /timed? ?out/i.test(error.message))) {
    return 'The model took too long to respond. Please try again.';
  }
  return 'The answer failed because the model call did not complete. Please try again.';
}
