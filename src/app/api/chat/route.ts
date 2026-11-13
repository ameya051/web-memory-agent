import { createUIMessageStreamResponse } from 'ai';
import { after } from 'next/server';
import { createMainModel } from '@/services/model-openrouter';
import { PendingMigrationsError } from '@/services/store-postgres';
import { chatErrorMessage } from '@/core/agent/errors';
import { log } from '@/utils/log';
import { runChat } from '@/core/agent/loop';
import { parseChatRequest } from '@/core/request';
import { toChatStream } from '@/core/agent/stream';
import { configResult } from '@/app/config';
import { getJobs } from '@/app/extraction';
import { devState, searchFor } from '@/app/dev';
import { getStore } from '@/app/store';

// Thin caller of the core: check config, validate the body, build the core with
// the real services (or the dev clock and fixture web when set), stream the answer with the output checks and the save at
// its end. req.signal carries the browser's stop or tab close through to the
// model and search calls (spec 6.4). Once the response has ended, the saved
// exchange's extraction job runs (spec 6.3).

export async function POST(req: Request) {
  if (!configResult.ok) {
    return Response.json({ error: `Missing ${configResult.missing.join(', ')} in .env.` }, { status: 500 });
  }
  const { config } = configResult;

  const parsed = parseChatRequest(await req.json().catch(() => null));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const deps = {
    model: createMainModel(config),
    search: await searchFor(config),
    clock: devState(config).clock,
    store: getStore(),
  };
  try {
    const run = await runChat(deps, parsed.request, req.signal);
    // The stream reports the saved exchange when it ends; awaiting that makes
    // the job independent of when after() fires for a streamed body.
    let onDone!: (exchangeId: string | null) => void;
    const saved = new Promise<string | null>((resolve) => (onDone = resolve));
    after(async () => {
      const exchangeId = await saved;
      if (exchangeId) await getJobs().run(run.exchange.context.userId, exchangeId);
    });
    return createUIMessageStreamResponse({ stream: toChatStream(run, chatErrorMessage, onDone) });
  } catch (error) {
    // The question could not be saved or the thread loaded, so nothing ran.
    log.error('chat.db_failed_before_answer', { error });
    if (error instanceof PendingMigrationsError) return Response.json({ error: error.message }, { status: 503 });
    return Response.json({ error: 'Could not save your message: the database is unavailable. Check DATABASE_URL.' }, { status: 503 });
  }
}
