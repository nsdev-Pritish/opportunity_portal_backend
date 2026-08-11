// Calendar arithmetic on plain 'YYYY-MM-DD' strings, with no date library.
//
// The repo has no date dependency (no date-fns / dayjs / moment in
// package.json), and adding one just for four subtractions isn't worth it.
// Everything here works on the year/month/day integers directly, or via
// Date.UTC, so a server running in any timezone — and any DST transition —
// produces the same answer. Constructing `new Date('2026-03-01')` and reading
// local getters would not: west of UTC that lands on Feb 28 local time.
//
// Month arithmetic clamps to the end of the target month rather than
// overflowing, which is the whole reason this isn't naive day subtraction:
// 2026-03-31 minus one month is 2026-02-28, not 2026-03-03.

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(dateString: string): DateParts {
  const match = DATE_RE.exec(dateString);
  if (!match) throw new Error(`Expected a YYYY-MM-DD date string, got: ${dateString}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDate({ year, month, day }: DateParts): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Day count for a month, leap years included. month is 1-12. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Shifts by whole days. Safe across month/year boundaries and DST (UTC only). */
export function addDays(dateString: string, days: number): string {
  const { year, month, day } = parseDate(dateString);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/**
 * Shifts by whole calendar months, keeping the same day-of-month where that
 * day exists and clamping to the last day of the target month where it does
 * not. Jan 31 minus 1 month is Dec 31; Mar 31 minus 1 month is Feb 28 (or 29
 * in a leap year) — never a silent roll-forward into the following month.
 */
export function addMonths(dateString: string, months: number): string {
  const { year, month, day } = parseDate(dateString);
  const zeroBased = (year * 12) + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  return formatDate({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(dateString: string): number {
  const { year, month, day } = parseDate(dateString);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isMonday(dateString: string): boolean {
  return dayOfWeek(dateString) === 1;
}

export function isFirstOfMonth(dateString: string): boolean {
  return parseDate(dateString).day === 1;
}

/** True only on Jan 1, Apr 1, Jul 1 and Oct 1. */
export function isQuarterStart(dateString: string): boolean {
  const { month, day } = parseDate(dateString);
  return day === 1 && (month === 1 || month === 4 || month === 7 || month === 10);
}
