import { z } from 'zod';
import { devConfig, devState, devView } from '@/app/dev';

// Which web the agent searches: live Exa, or the fixture pages in evals/fixtures/pages.

const body = z.object({ mode: z.enum(['live', 'fixture']) });

export async function POST(req: Request) {
  const dev = devConfig();
  if (!dev.ok) return dev.response;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Expected { mode: "live" | "fixture" }.' }, { status: 400 });
  devState(dev.config).web = parsed.data.mode;
  return Response.json(devView(dev.config));
}
