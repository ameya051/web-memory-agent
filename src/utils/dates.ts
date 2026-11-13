/** The calendar date of an instant in a timezone, as YYYY-MM-DD (en-CA formats dates that way). */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** The weekday of an instant in a timezone, such as "Monday". */
export function weekday(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(at);
}

/**
 * Such as "Monday, 9 November 2026, 10:05" in the timezone. Built from parts,
 * because ICU versions join the date and the time differently ("at" or ",").
 */
export function localDateTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** Whether a YYYY-MM-DD string is a real calendar date. */
export function isCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * The instant at which a wall-clock time ("2026-11-09T10:05") occurs in a
 * timezone. Two passes over the zone's offset, so a time next to a DST change
 * lands on the offset in force at that moment.
 */
export function zonedTimeToUtc(wallTime: string, timeZone: string): Date {
  const asUtc = Date.parse(`${wallTime}Z`);
  if (Number.isNaN(asUtc)) throw new Error(`Not a wall time: ${wallTime}`);
  const first = asUtc - offsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetMs(new Date(first), timeZone));
}

/** How far the zone's wall clock is ahead of UTC at an instant. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** A known IANA timezone, else UTC (spec 5.1). */
export function parseTimeZone(tz: string | undefined): string {
  return tz && isTimeZone(tz) ? tz : 'UTC';
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
