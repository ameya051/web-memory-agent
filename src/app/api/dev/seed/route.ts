import { after } from 'next/server';
import { z } from 'zod';
import { loadDemoHistory } from '@/services/seed';
import { log } from '@/utils/log';
import { parseTimeZone } from '@/utils/dates';
import { devConfig, devState } from '@/app/dev';
import { getJobs } from '@/app/extraction';
import { getStore } from '@/app/store';

// Loads the demo history (spec 8) in the browser's timezone, then runs the
// extraction job over the new exchanges after the response. Safe to repeat.

const body = z.object({ timezone: z.string().optional() });

export async function POST(req: Request) {
  const dev = devConfig();
  if (!dev.ok) return dev.response;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Expected { timezone?: string }.' }, { status: 400 });
  try {
    const { exchanges, ...result } = await loadDemoHistory(
      getStore(),
      parseTimeZone(parsed.data.timezone),
      devState(dev.config).clock.now(),
    );
    after(async () => {
      for (const e of exchanges) await getJobs().run(e.userId, e.id);
    });
    return Response.json(result);
  } catch (error) {
    log.error('seed.failed', { error });
    return Response.json({ error: 'Could not load the demo history. Check the server log.' }, { status: 500 });
  }
}
