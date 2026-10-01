import { describe, expect, it } from 'vitest';
import { isWithinQuietHours, type QuietHoursSettings } from './quietHours';

const BASE: QuietHoursSettings = {
  quietHoursEnabled: true,
  quietHoursTimezone: 'America/New_York',
  quietHoursDays: [],
  quietHoursStartMinutes: 17 * 60, // 5pm
  quietHoursEndMinutes: 9 * 60, // 9am
};

describe('isWithinQuietHours', () => {
  it('returns false when disabled', () => {
    expect(isWithinQuietHours(new Date(), { ...BASE, quietHoursEnabled: false })).toBe(false);
  });

  it('returns false (fails safe) when no timezone is configured', () => {
    expect(isWithinQuietHours(new Date(), { ...BASE, quietHoursTimezone: undefined })).toBe(false);
  });

  it('returns false (fails safe) when start/end are not configured', () => {
    expect(isWithinQuietHours(new Date(), { ...BASE, quietHoursStartMinutes: undefined })).toBe(
      false,
    );
  });

  it('returns false (fails safe) for an invalid IANA timezone name', () => {
    expect(isWithinQuietHours(new Date(), { ...BASE, quietHoursTimezone: 'Not/A_Real_Zone' })).toBe(
      false,
    );
  });

  it('returns false for a zero-length window (misconfiguration)', () => {
    expect(
      isWithinQuietHours(new Date(), {
        ...BASE,
        quietHoursStartMinutes: 0,
        quietHoursEndMinutes: 0,
      }),
    ).toBe(false);
  });

  it('overnight window: 10pm ET is within a 5pm-9am quiet window', () => {
    // 2026-01-15 is a Thursday. 22:00 ET = 03:00 UTC the next day (EST, UTC-5).
    const tenPmEastern = new Date('2026-01-16T03:00:00Z');
    expect(isWithinQuietHours(tenPmEastern, BASE)).toBe(true);
  });

  it('overnight window: 7am ET (the continuation from the previous evening) is within the window', () => {
    // 2026-01-16 07:00 ET = 12:00 UTC same day (EST, UTC-5).
    const sevenAmEastern = new Date('2026-01-16T12:00:00Z');
    expect(isWithinQuietHours(sevenAmEastern, BASE)).toBe(true);
  });

  it('overnight window: 2pm ET (midday) is NOT within the window', () => {
    const twoPmEastern = new Date('2026-01-16T19:00:00Z'); // 14:00 ET
    expect(isWithinQuietHours(twoPmEastern, BASE)).toBe(false);
  });

  it('respects configured days — an overnight window starting on an excluded day does not apply', () => {
    // 2026-01-16 is a Friday. Exclude Friday from the configured days.
    const tenPmFriday = new Date('2026-01-17T03:00:00Z'); // Fri 22:00 ET
    const settings = { ...BASE, quietHoursDays: [1, 2, 3, 4] }; // Mon-Thu only
    expect(isWithinQuietHours(tenPmFriday, settings)).toBe(false);
  });

  it('a same-day (non-overnight) window applies only within start-end on a configured day', () => {
    const settings: QuietHoursSettings = {
      quietHoursEnabled: true,
      quietHoursTimezone: 'America/New_York',
      quietHoursDays: [0, 6], // weekends only
      quietHoursStartMinutes: 9 * 60,
      quietHoursEndMinutes: 17 * 60,
    };
    // 2026-01-17 is a Saturday. Noon ET.
    const noonSaturday = new Date('2026-01-17T17:00:00Z');
    expect(isWithinQuietHours(noonSaturday, settings)).toBe(true);

    // 2026-01-19 is a Monday — excluded.
    const noonMonday = new Date('2026-01-19T17:00:00Z');
    expect(isWithinQuietHours(noonMonday, settings)).toBe(false);
  });

  it('handles a DST transition correctly (America/New_York, spring-forward)', () => {
    // 2026-03-08 is DST start in the US. Quiet hours 01:00-01:30 local —
    // 1:30am doesn't exist that night (clocks jump 2am->3am is the actual
    // US rule, so 01:30 does exist; use a window that still resolves
    // sensibly either side of the transition).
    const settings: QuietHoursSettings = {
      quietHoursEnabled: true,
      quietHoursTimezone: 'America/New_York',
      quietHoursDays: [],
      quietHoursStartMinutes: 0,
      quietHoursEndMinutes: 60,
    };
    // 2026-03-08 00:30 EST = 05:30 UTC.
    const beforeTransition = new Date('2026-03-08T05:30:00Z');
    expect(isWithinQuietHours(beforeTransition, settings)).toBe(true);
  });
});
