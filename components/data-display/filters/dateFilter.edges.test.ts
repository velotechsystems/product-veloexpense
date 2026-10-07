import { describe, expect, it } from 'vitest';
import {
  DATE_PRESETS,
  formatDateFilterValue,
  parseLastNDays,
  resolveDateFilter,
} from './dateFilter';

/**
 * The date filter's malformed-input and boundary branches.
 *
 * `dateFilter.test.ts` covers the happy presets; this covers what reaches the
 * function from a half-typed clause or a hand-edited saved view, which is where a
 * silently-wrong window comes from. Two rules carry weight:
 *
 *   · An unparseable value resolves to an EMPTY window, not to a partial one. A
 *     `{ gte }` with no `lt` from a half-typed "between" would quietly widen the
 *     filter to "everything since", and the pill would still read as a range.
 *   · `between` is inclusive of its end day, so the exclusive `lt` is end+1. Off by
 *     one here drops every row dated on the last day of the range the user picked.
 */

const now = new Date(2026, 7, 21, 14, 30); // 2026-08-21, local

describe('parseLastNDays', () => {
  it('reads the custom token', () => {
    expect(parseLastNDays('lastNdays:14')).toBe(14);
  });

  it('rejects a token that is not the custom one', () => {
    expect(parseLastNDays('last7')).toBeNull();
    expect(parseLastNDays('')).toBeNull();
  });

  it('rejects a non-positive or non-numeric count', () => {
    // A zero-day window matches nothing; a NaN one silently matches everything.
    for (const bad of ['lastNdays:0', 'lastNdays:-3', 'lastNdays:abc', 'lastNdays:']) {
      expect(parseLastNDays(bad), bad).toBeNull();
    }
  });

  it('accepts a single day', () => {
    expect(parseLastNDays('lastNdays:1')).toBe(1);
  });
});

describe('every shipped preset resolves', () => {
  /**
   * `resolveWithin`'s final `default: return {}` is the same branch a hand-edited saved view
   * with a nonsense token lands on — correct there, and silently catastrophic for a token
   * this list SHIPS. A preset added to `DATE_PRESETS` without a matching `case` resolves to
   * an unbounded all-time query while the pill goes on reading "Last 3 months": the reader
   * is told the list is narrowed and it is not, which is the one failure mode a filter must
   * never have.
   *
   * Nothing else pins this. The happy-path tests name their tokens one at a time, so they
   * cannot notice a thirteenth.
   */
  it('gives every token in the dropdown a bounded window', () => {
    for (const preset of DATE_PRESETS) {
      const w = resolveDateFilter('within', preset.value, now);
      expect(w.gte, preset.value).toBeInstanceOf(Date);
      expect(w.lt, preset.value).toBeInstanceOf(Date);
      // A backwards window matches nothing and reads as an empty list, not as a bug.
      expect((w.lt as Date).getTime(), preset.value).toBeGreaterThan((w.gte as Date).getTime());
    }
  });

  it('names every token in the dropdown on the pill', () => {
    // The other half of the same promise: a token with no label falls back to the raw
    // string, and the pill reads `last90` instead of "Last 90 days".
    for (const preset of DATE_PRESETS) {
      expect(formatDateFilterValue('within', preset.value), preset.value).toBe(preset.label);
    }
  });
});

describe('resolveDateFilter — malformed input', () => {
  it('resolves an unknown preset to an empty window', () => {
    // A hand-edited saved view can carry a token this build no longer knows.
    expect(resolveDateFilter('within', 'lastCentury', now)).toEqual({});
  });

  it('resolves an unknown operator to an empty window', () => {
    expect(resolveDateFilter('sometime', '2026-08-21', now)).toEqual({});
  });

  it('resolves a malformed day to an empty window', () => {
    for (const bad of ['', '2026-8-1', '21/08/2026', 'yesterday', '2026-08']) {
      expect(resolveDateFilter('on', bad, now), bad).toEqual({});
    }
  });

  it('tolerates surrounding whitespace on a day', () => {
    expect(resolveDateFilter('on', '  2026-08-21  ', now)).toEqual({
      gte: new Date(2026, 7, 21),
      lt: new Date(2026, 7, 22),
    });
  });
});

describe('resolveDateFilter — between', () => {
  it('makes the end day inclusive', () => {
    /**
     * The user picked "1st to 21st" and expects the 21st included, so the exclusive
     * upper bound is the 22nd. Off by one here silently drops the last day.
     */
    expect(resolveDateFilter('between', '2026-08-01..2026-08-21', now)).toEqual({
      gte: new Date(2026, 7, 1),
      lt: new Date(2026, 7, 22),
    });
  });

  it('handles a single-day range', () => {
    expect(resolveDateFilter('between', '2026-08-21..2026-08-21', now)).toEqual({
      gte: new Date(2026, 7, 21),
      lt: new Date(2026, 7, 22),
    });
  });

  it('returns only the bound it could parse while half-typed', () => {
    // The editor calls this on every keystroke; an open-ended bound is correct here.
    expect(resolveDateFilter('between', '2026-08-01..', now)).toEqual({
      gte: new Date(2026, 7, 1),
    });
    expect(resolveDateFilter('between', '..2026-08-21', now)).toEqual({
      lt: new Date(2026, 7, 22),
    });
  });

  it('returns an empty window for an entirely blank range', () => {
    expect(resolveDateFilter('between', '..', now)).toEqual({});
    expect(resolveDateFilter('between', '', now)).toEqual({});
  });

  it('ignores an unparseable half', () => {
    expect(resolveDateFilter('between', 'garbage..2026-08-21', now)).toEqual({
      lt: new Date(2026, 7, 22),
    });
  });
});

describe('resolveDateFilter — one-sided operators', () => {
  it('makes before exclusive of the named day', () => {
    expect(resolveDateFilter('before', '2026-08-21', now)).toEqual({ lt: new Date(2026, 7, 21) });
  });

  it('makes after inclusive of the named day', () => {
    expect(resolveDateFilter('after', '2026-08-21', now)).toEqual({ gte: new Date(2026, 7, 21) });
  });
});

describe('resolveDateFilter — relative windows', () => {
  it('counts today as one of the last N days', () => {
    // "Last 7 days" on the 21st spans the 15th through the 21st, not the 14th.
    expect(resolveDateFilter('within', 'lastNdays:7', now)).toEqual({
      gte: new Date(2026, 7, 15),
      lt: new Date(2026, 7, 22),
    });
  });

  it('treats a one-day custom window as today', () => {
    expect(resolveDateFilter('within', 'lastNdays:1', now)).toEqual({
      gte: new Date(2026, 7, 21),
      lt: new Date(2026, 7, 22),
    });
  });

  it('crosses a month boundary correctly', () => {
    const early = new Date(2026, 7, 3, 9, 0);
    expect(resolveDateFilter('within', 'lastNdays:7', early)).toEqual({
      gte: new Date(2026, 6, 28),
      lt: new Date(2026, 7, 4),
    });
  });

  it('bounds a completed period on both sides', () => {
    // lastMonth must not run to "now" — it is a closed window.
    expect(resolveDateFilter('within', 'lastMonth', now)).toEqual({
      gte: new Date(2026, 6, 1),
      lt: new Date(2026, 7, 1),
    });
    expect(resolveDateFilter('within', 'lastYear', now)).toEqual({
      gte: new Date(2025, 0, 1),
      lt: new Date(2026, 0, 1),
    });
  });

  it('runs a to-date period up to the end of today', () => {
    expect(resolveDateFilter('within', 'qtd', now)).toEqual({
      gte: new Date(2026, 6, 1),
      lt: new Date(2026, 7, 22),
    });
  });

  it('ignores the time of day on `now`', () => {
    // Two calls in the same day must produce the same window, or a cached count
    // stops matching the rows beside it.
    const morning = new Date(2026, 7, 21, 1, 0);
    const evening = new Date(2026, 7, 21, 23, 59);
    expect(resolveDateFilter('within', 'today', morning)).toEqual(
      resolveDateFilter('within', 'today', evening),
    );
  });
});

describe('formatDateFilterValue', () => {
  it('names a custom window by its count', () => {
    expect(formatDateFilterValue('within', 'lastNdays:14')).toBe('Last 14 days');
  });

  it('uses the preset label', () => {
    expect(formatDateFilterValue('within', 'last7')).toBe('Last 7 days');
  });

  it('falls back to the raw token for an unknown preset', () => {
    // Better than blank: it shows the user what their saved view actually holds.
    expect(formatDateFilterValue('within', 'lastCentury')).toBe('lastCentury');
  });

  it('renders a range with an arrow', () => {
    expect(formatDateFilterValue('between', '2026-08-01..2026-08-21')).toBe(
      '2026-08-01 → 2026-08-21',
    );
  });

  it('marks a missing half of a range with an ellipsis', () => {
    expect(formatDateFilterValue('between', '2026-08-01..')).toBe('2026-08-01 → …');
    expect(formatDateFilterValue('between', '..2026-08-21')).toBe('… → 2026-08-21');
  });

  it('collapses an entirely empty range to one ellipsis', () => {
    expect(formatDateFilterValue('between', '..')).toBe('…');
    expect(formatDateFilterValue('between', '')).toBe('…');
  });

  it('shows an ellipsis rather than nothing for a blank single day', () => {
    // An empty pill reads as a rendering bug rather than as an unfinished clause.
    expect(formatDateFilterValue('on', '')).toBe('…');
  });

  it('shows the raw day otherwise', () => {
    expect(formatDateFilterValue('on', '2026-08-21')).toBe('2026-08-21');
  });
});
