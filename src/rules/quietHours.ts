const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface QuietHoursSettings {
  quietHoursEnabled: boolean;
  /** IANA timezone name — required; quiet hours never apply without one (never guess the server's timezone). */
  quietHoursTimezone: string | undefined;
  /** 0=Sunday..6=Saturday. Empty = every day. */
  quietHoursDays: number[];
  /** Minutes since local midnight. */
  quietHoursStartMinutes: number | undefined;
  quietHoursEndMinutes: number | undefined;
}

/**
 * Whether `now` falls inside the configured quiet-hours window, evaluated
 * in the group/contact's own configured IANA timezone — never the
 * server's (Render's) timezone, which would silently shift with wherever
 * the process happens to be deployed. Uses `Intl.DateTimeFormat`, which
 * resolves DST transitions from the IANA tz database itself, so no
 * separate DST handling is needed here.
 *
 * `start > end` is an overnight window (e.g. 17:00-09:00); it's treated as
 * belonging to the day it *starts* — so "Mon-Fri 17:00-09:00" covers
 * Monday 17:00 through Tuesday 09:00, attributed to Monday.
 *
 * Fails safe (returns `false`, i.e. automation proceeds normally) on any
 * misconfiguration — no timezone, no start/end, or a zero-length window —
 * rather than silently applying an ambiguous rule.
 */
export function isWithinQuietHours(now: Date, settings: QuietHoursSettings): boolean {
  if (!settings.quietHoursEnabled) return false;
  if (!settings.quietHoursTimezone) return false;
  if (settings.quietHoursStartMinutes == null || settings.quietHoursEndMinutes == null) {
    return false;
  }
  const start = settings.quietHoursStartMinutes;
  const end = settings.quietHoursEndMinutes;
  if (start === end) return false;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.quietHoursTimezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return false; // invalid IANA timezone name — never guess, never apply
  }

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hourStr = parts.find((p) => p.type === 'hour')?.value;
  const minuteStr = parts.find((p) => p.type === 'minute')?.value;
  const dayIndex = weekday ? WEEKDAY_INDEX[weekday] : undefined;
  if (dayIndex === undefined || hourStr === undefined || minuteStr === undefined) return false;

  const minutesNow = Number(hourStr) * 60 + Number(minuteStr);
  const days = settings.quietHoursDays.length > 0 ? settings.quietHoursDays : [0, 1, 2, 3, 4, 5, 6];

  if (start < end) {
    return days.includes(dayIndex) && minutesNow >= start && minutesNow < end;
  }

  // Overnight window.
  if (minutesNow >= start) return days.includes(dayIndex);
  if (minutesNow < end) {
    const prevDayIndex = (dayIndex + 6) % 7;
    return days.includes(prevDayIndex);
  }
  return false;
}
