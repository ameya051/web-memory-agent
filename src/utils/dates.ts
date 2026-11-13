/** The calendar date of an instant in a timezone, as YYYY-MM-DD (en-CA formats dates that way). */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}
