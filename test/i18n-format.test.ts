/**
 * VX4-7 part 1b — the three kinds of date.
 *
 * No database. `test/i18n-dates.db.test.ts` covers the half that needs one:
 * that the DRIVER hands a `date` column over as a string, which is what makes
 * `formatCalendarDate`'s contract satisfiable in the first place.
 *
 * ── WHY THESE TESTS SET `process.env.TZ` ────────────────────────────────────
 *
 * Because the bug they are about IS the process timezone, and the harness runs
 * in UTC — the one zone where every version of this code looks correct. A suite
 * that only ever runs in UTC cannot tell a formatter that ignores the process
 * zone from one that happens to agree with it.
 *
 * That is not hypothetical here. Before this ticket, running the whole suite
 * under `TZ=Europe/Paris` passed with AND without the fix, because nothing
 * exercised the calendar-date path at all. The sabotage that was supposed to
 * prove the fix load-bearing proved instead that the tests were absent — the
 * surviving tests being the finding, again. These are those tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { formatCalendarDate, formatInstant, toDateInputValue } from '@/lib/i18n/format';
import type { ReaderPrefs } from '@/lib/i18n/resolve';

/**
 * Zones on both sides of UTC, plus one far enough east that its calendar day is
 * ahead. Paris and Sydney are the two that broke: `2026-03-04` parsed at local
 * midnight lands on 2026-03-03 in UTC for both.
 */
const ZONES = ['UTC', 'America/Vancouver', 'America/Toronto', 'Europe/Paris', 'Australia/Sydney'];

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

/** Run `fn` with the process pretending to be somewhere else. */
function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = original;
  }
}

const CAL = '2026-03-04';
/** 02:30 UTC — the previous evening everywhere in North America. */
const INSTANT = new Date('2026-03-04T02:30:00Z');

describe('formatCalendarDate — a date with no timezone', () => {
  it('renders the same day in every process timezone', () => {
    // THE assertion of this file. `toISOString().slice(0, 10)`, which is what
    // `formatDate` did, gives '2026-03-03' here for Paris and Sydney.
    const rendered = ZONES.map((tz) => inZone(tz, () => formatCalendarDate(CAL, 'en-CA')));
    expect(new Set(rendered).size, `differed by process zone: ${rendered.join(' | ')}`).toBe(1);
    expect(rendered[0]).toContain('4');
    expect(rendered[0]).toContain('2026');
  });

  it('renders the day that was stored, not one either side of it', () => {
    // Pinned loosely on format and exactly on the NUMBER, because the claim is
    // "the fourth", not "spelled this way by this ICU build".
    expect(formatCalendarDate('2026-03-04', 'en-CA', { dateStyle: 'short' })).toMatch(/\b0?4\b/);
    expect(formatCalendarDate('2026-01-01', 'en-CA', { dateStyle: 'short' })).toMatch(/\b0?1\b/);
    expect(formatCalendarDate('2026-12-31', 'en-CA', { dateStyle: 'short' })).toMatch(/\b31\b/);
  });

  it('respects the reader locale for ORDER and language, having no zone to respect', () => {
    expect(formatCalendarDate(CAL, 'fr-CA')).toContain('mars');
    // en-CA and en-US order a numeric date differently; that is the locale doing
    // its job, and it is the only thing allowed to vary here.
    const ca = formatCalendarDate(CAL, 'en-CA', { dateStyle: 'short' });
    const us = formatCalendarDate(CAL, 'en-US', { dateStyle: 'short' });
    expect(ca).not.toBe(us);
  });

  it('renders nothing for an absent or malformed value', () => {
    for (const bad of [null, undefined, '', 'not a date', '2026-3-4', '04/03/2026']) {
      expect(formatCalendarDate(bad as string | null, 'en-CA')).toBe('');
    }
  });

  it('accepts a full timestamp string by taking its date part', () => {
    // Defensive: a caller with `'2026-03-04T00:00:00.000Z'` from somewhere that
    // has not been migrated should still render the 4th rather than nothing.
    expect(formatCalendarDate('2026-03-04T00:00:00.000Z', 'en-CA', { dateStyle: 'short' })).toMatch(
      /\b0?4\b/,
    );
  });
});

describe('formatInstant — a moment, in the reader’s zone', () => {
  const at = (timeZone: string): ReaderPrefs => ({ locale: 'en-CA', timeZone });

  it('shows the reader their own day, which may not be the UTC day', () => {
    // The live bug this ticket fixes, stated as an assertion: 02:30 UTC on the
    // 4th is 18:30 on the 3rd in Vancouver, and `formatDate` showed the 4th.
    const vancouver = formatInstant(INSTANT, at('America/Vancouver'), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(vancouver).toMatch(/\b3\b/);
    expect(vancouver).toMatch(/6:30|18:30/);

    const utc = formatInstant(INSTANT, at('UTC'), { dateStyle: 'medium', timeStyle: 'short' });
    expect(utc).toMatch(/\b4\b/);
    expect(utc).not.toBe(vancouver);
  });

  it('does not depend on the PROCESS timezone, only on the reader’s', () => {
    const rendered = ZONES.map((tz) =>
      inZone(tz, () => formatInstant(INSTANT, at('America/Toronto'))),
    );
    expect(new Set(rendered).size, `differed by process zone: ${rendered.join(' | ')}`).toBe(1);
  });

  it('accepts an ISO string as well as a Date, identically', () => {
    expect(formatInstant('2026-03-04T02:30:00Z', at('UTC'))).toBe(formatInstant(INSTANT, at('UTC')));
  });

  it('renders nothing for absent or unparseable input', () => {
    for (const bad of [null, undefined, 'never', new Date('nope')]) {
      expect(formatInstant(bad as Date | null, at('UTC'))).toBe('');
    }
  });
});

describe('toDateInputValue — never localised, because HTML says so', () => {
  it('is YYYY-MM-DD for every locale and every process zone', () => {
    // If this ever varies, the expense date field goes blank for somebody and
    // saving the form clears their date. There is no error to notice.
    const rendered = ZONES.map((tz) => inZone(tz, () => toDateInputValue(CAL)));
    expect(new Set(rendered)).toEqual(new Set(['2026-03-04']));
  });

  it('passes a calendar date through unchanged', () => {
    expect(toDateInputValue('2026-03-04')).toBe('2026-03-04');
    expect(toDateInputValue('2026-03-04T02:30:00.000Z')).toBe('2026-03-04');
  });

  it('takes the calendar day of an instant IN THE GIVEN ZONE', () => {
    // "Today" for a date picker means today where the reader is. 02:30 UTC is
    // still the 3rd in Vancouver, and a picker opening on tomorrow is a bug
    // somebody reports as "it defaults wrong".
    expect(toDateInputValue(INSTANT, 'UTC')).toBe('2026-03-04');
    expect(toDateInputValue(INSTANT, 'America/Vancouver')).toBe('2026-03-03');
    expect(toDateInputValue(INSTANT, 'Australia/Sydney')).toBe('2026-03-04');
  });

  it('is unaffected by the process timezone when a zone is given', () => {
    const rendered = ZONES.map((tz) =>
      inZone(tz, () => toDateInputValue(INSTANT, 'America/Toronto')),
    );
    expect(new Set(rendered)).toEqual(new Set(['2026-03-03']));
  });

  it('renders nothing for absent or malformed input', () => {
    for (const bad of [null, undefined, '', 'tomorrow', new Date('nope')]) {
      expect(toDateInputValue(bad as string | null)).toBe('');
    }
  });

  it('never emits a localised separator, whatever the default locale becomes', () => {
    // The output is assembled from `formatToParts` rather than laid out by a
    // locale, so this holds by construction. Asserted anyway, because the
    // construction is the thing a future edit would "simplify" back into
    // `Intl.DateTimeFormat(locale, …).format()`.
    expect(toDateInputValue(INSTANT, 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toDateInputValue(CAL)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
