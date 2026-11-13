import { z } from 'zod';

// Every environment variable is checked here, once, at startup (spec 3.1, R7).
// An empty value counts as missing, so a copied .env.example fails clearly.

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const required = z.preprocess(blankToUndefined, z.string());

const schema = z.object({
  OPENROUTER_API_KEY: required,
  EXA_API_KEY: required,
  DATABASE_URL: required,
  MODEL_MAIN: z.preprocess(blankToUndefined, z.string().default('anthropic/claude-sonnet-5.5')),
});

export type Config = z.infer<typeof schema>;

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; missing: string[] };

export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
  const parsed = schema.safeParse(env);
  if (parsed.success) return { ok: true, config: parsed.data };
  const missing = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  return { ok: false, missing };
}

// Checked once when the server loads this module (spec 3.1). The page and the
// chat route both read this result. Server-only: never import from chat.tsx.
export const configResult = loadConfig(process.env);
