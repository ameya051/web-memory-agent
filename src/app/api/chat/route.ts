import { createUIMessageStreamResponse } from 'ai';
import { systemClock } from '@/services/clock';
import { createMainModel } from '@/services/model-openrouter';
import { createExaSearch } from '@/services/search-exa';
import { PendingMigrationsError } from '@/services/store-postgres';
import { chatErrorMessage } from '@/core/agent/errors';
import { log } from '@/utils/log';
import { runChat } from '@/core/agent/loop';
import { parseChatRequest } from '@/core/agent/request';
import { toChatStream } from '@/core/agent/stream';
import { configResult } from '@/app/config';
import { getStore } from '@/app/store';

// Thin caller of the core: check config, validate the body, build the core with
// the real services, stream the answer with the output checks and the save at
// its end. req.signal carries the browser's stop or tab close through to the
// model and search calls (spec 6.4).

export async function POST(req: Request) {
  if (!configResult.ok) {
    return Response.json({ error: `Missing ${configResult.missing.join(', ')} in .env.` }, { status: 500 });
  }
  const { config } = configResult;

  const parsed = parseChatRequest(await req.json().catch(() => null));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const deps = {
    model: createMainModel(config),
    search: createExaSearch({ apiKey: config.EXA_API_KEY }),
    clock: systemClock,
    store: getStore(),
  };
  try {
    const run = await runChat(deps, parsed.request, req.signal);
    return createUIMessageStreamResponse({ stream: toChatStream(run, chatErrorMessage) });
  } catch (error) {
    // The question could not be saved or the thread loaded, so nothing ran.
    log.error('chat.db_failed_before_answer', { error });
    if (error instanceof PendingMigrationsError) return Response.json({ error: error.message }, { status: 503 });
    return Response.json({ error: 'Could not save your message: the database is unavailable. Check DATABASE_URL.' }, { status: 503 });
  }
}
