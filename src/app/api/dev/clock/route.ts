import { z } from 'zod';
import { devConfig, devState, devView } from '@/app/dev';

// Dev clock override (spec 8): { now: ISO datetime } moves "today", null returns to real time.

const body = z.object({ now: z.iso.datetime({ offset: true }).nullable() });

export async function POST(req: Request) {
  const dev = devConfig();
  if (!dev.ok) return dev.response;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Expected { now: ISO datetime | null }.' }, { status: 400 });
  devState(dev.config).clock.set(parsed.data.now === null ? null : new Date(parsed.data.now));
  return Response.json(devView(dev.config));
}
