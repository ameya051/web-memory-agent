import type { Clock } from '@/core/ports';

// The only source of "now" (spec 3).

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can set and move. */
export function createSettableClock(start: Date) {
  let current = start;
  return {
    now: () => current,
    set(date: Date) {
      current = date;
    },
  };
}

/**
 * The dev clock override (spec 8): setting "now" stores an offset from the
 * system time, so the clock keeps ticking from the new time and messages sent
 * after it still get increasing timestamps. set(null) returns to real time.
 */
export function createDevClock(start?: Date) {
  let offsetMs = start ? start.getTime() - Date.now() : 0;
  let overridden = start !== undefined;
  return {
    now: () => new Date(Date.now() + offsetMs),
    set(date: Date | null) {
      offsetMs = date ? date.getTime() - Date.now() : 0;
      overridden = date !== null;
    },
    overridden: () => overridden,
  };
}

export type DevClock = ReturnType<typeof createDevClock>;
