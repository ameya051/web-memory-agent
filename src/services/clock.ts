import type { Clock } from '@/core/ports';

// The only source of "now" (spec 3). The dev override arrives in phase 4.

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
