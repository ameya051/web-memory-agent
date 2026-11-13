'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DevView } from './dev';

// Dev panel (spec 8): move "today", switch the agent to the fixture web, load
// the demo history, and show per-answer timings. Hidden in production.

export type DevProps = DevView & { demoDay: string };

type Props = { dev: DevProps; showTimings: boolean; onShowTimings: (on: boolean) => void };

export function DevPanel({ dev, showTimings, onShowTimings }: Props) {
  const router = useRouter();
  // Filled after mount: the server renders in its own timezone, not the browser's.
  const [when, setWhen] = useState('');
  useEffect(() => setWhen(toInput(new Date(dev.now))), [dev.now]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: unknown, done: (json: Record<string, unknown>) => string) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setNote(res.ok ? done(json) : String(json.error ?? `Failed (${res.status})`));
      if (res.ok) router.refresh();
    } catch {
      setNote('Request failed.');
    } finally {
      setBusy(false);
    }
  }

  // datetime-local values are the browser's local wall time.
  const setClock = (local: string | null) =>
    post('/api/dev/clock', { now: local === null ? null : new Date(local).toISOString() }, () =>
      local === null ? 'Back to real time.' : 'Clock set.',
    );

  return (
    <section className="dev" aria-labelledby="dev-heading">
      <h2 id="dev-heading">Dev</h2>
      <p suppressHydrationWarning>
        Now: {new Date(dev.now).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        {dev.overridden && ' (set)'}
      </p>
      <div className="row">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button type="button" disabled={busy || !when} onClick={() => setClock(when)}>
          Set
        </button>
      </div>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => (setWhen(dev.demoDay), setClock(dev.demoDay))}>
          Jump to demo day
        </button>
        <button type="button" disabled={busy || !dev.overridden} onClick={() => setClock(null)}>
          Real time
        </button>
      </div>
      <div className="row">
        Web:
        {(['live', 'fixture'] as const).map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="web"
              checked={dev.web === mode}
              disabled={busy}
              onChange={() => post('/api/dev/web', { mode }, () => `Web: ${mode}.`)}
            />
            {mode}
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          post('/api/dev/seed', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, (r) =>
            `Demo history: ${r.added} added, ${r.skipped} already there.`,
          )
        }
      >
        Load demo history
      </button>
      <label className="row">
        <input type="checkbox" checked={showTimings} onChange={(e) => onShowTimings(e.target.checked)} />
        Show timings
      </label>
      {note && <p className="note">{note}</p>}
    </section>
  );
}

/** A Date as a datetime-local value in the browser's timezone. */
function toInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
