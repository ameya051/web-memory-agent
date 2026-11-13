import { describe, expect, it } from 'vitest';
import { createDevClock } from '@/services/clock';
import { isCalendarDate, localDateTime, zonedTimeToUtc } from '@/utils/dates';

// The dev clock override and the local-time helpers behind seeding (spec 8).

describe('dev clock', () => {
  it('keeps ticking from a set time and returns to real time', async () => {
    const clock = createDevClock();
    expect(clock.overridden()).toBe(false);
    clock.set(new Date('2026-11-13T10:00:00Z'));
    const first = clock.now().getTime();
    expect(Math.abs(first - Date.parse('2026-11-13T10:00:00Z'))).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(clock.now().getTime()).toBeGreaterThan(first);
    expect(clock.overridden()).toBe(true);
    clock.set(null);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
    expect(clock.overridden()).toBe(false);
  });
});

describe('local time', () => {
  it('turns a wall time into the instant it happens in a timezone, across a DST change', () => {
    expect(zonedTimeToUtc('2026-11-08T23:30', 'America/Los_Angeles').toISOString()).toBe('2026-11-09T07:30:00.000Z');
    expect(zonedTimeToUtc('2026-03-07T03:30', 'America/New_York').toISOString()).toBe('2026-03-07T08:30:00.000Z');
    expect(zonedTimeToUtc('2026-03-09T03:30', 'America/New_York').toISOString()).toBe('2026-03-09T07:30:00.000Z');
    expect(zonedTimeToUtc('2026-11-09T10:05', 'Asia/Kolkata').toISOString()).toBe('2026-11-09T04:35:00.000Z');
  });

  it('formats a local date and time with its weekday', () => {
    expect(localDateTime(new Date('2026-11-09T04:35:00Z'), 'Asia/Kolkata')).toBe('Monday, 9 November 2026, 10:05');
  });

  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2026-11-03')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('3 Nov')).toBe(false);
  });
});
