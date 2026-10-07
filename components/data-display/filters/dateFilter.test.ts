import { describe, expect, it } from 'vitest';
import { formatDateFilterValue, parseLastNDays, resolveDateFilter } from './dateFilter';

// Fixed "now": Wed 2026-06-17 14:30 local.
const NOW = new Date(2026, 5, 17, 14, 30, 0);
const iso = (d?: Date) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : undefined);

describe('resolveDateFilter — absolute ops', () => {
  it('on → the whole calendar day [day, day+1)', () => {
    const w = resolveDateFilter('on', '2026-06-10', NOW);
    expect(iso(w.gte)).toBe('2026-6-10');
    expect(iso(w.lt)).toBe('2026-6-11');
  });

  it('before → lt start of day, no lower bound', () => {
    const w = resolveDateFilter('before', '2026-06-10', NOW);
    expect(w.gte).toBeUndefined();
    expect(iso(w.lt)).toBe('2026-6-10');
  });

  it('after → gte start of day, no upper bound', () => {
    const w = resolveDateFilter('after', '2026-06-10', NOW);
    expect(iso(w.gte)).toBe('2026-6-10');
    expect(w.lt).toBeUndefined();
  });

  it('between → inclusive of both endpoint days', () => {
    const w = resolveDateFilter('between', '2026-06-01..2026-06-30', NOW);
    expect(iso(w.gte)).toBe('2026-6-1');
    expect(iso(w.lt)).toBe('2026-7-1');
  });

  it('ignores a half-typed / malformed value', () => {
    expect(resolveDateFilter('on', '', NOW)).toEqual({});
    expect(resolveDateFilter('on', '2026-13', NOW)).toEqual({});
    expect(resolveDateFilter('between', '..2026-06-30', NOW).gte).toBeUndefined();
  });
});

describe('resolveDateFilter — relative presets', () => {
  it('today → [today, tomorrow)', () => {
    const w = resolveDateFilter('within', 'today', NOW);
    expect(iso(w.gte)).toBe('2026-6-17');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('yesterday → [yesterday, today)', () => {
    const w = resolveDateFilter('within', 'yesterday', NOW);
    expect(iso(w.gte)).toBe('2026-6-16');
    expect(iso(w.lt)).toBe('2026-6-17');
  });

  it('last7 includes today → [today-6, tomorrow)', () => {
    const w = resolveDateFilter('within', 'last7', NOW);
    expect(iso(w.gte)).toBe('2026-6-11');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('mtd → [month start, tomorrow)', () => {
    const w = resolveDateFilter('within', 'mtd', NOW);
    expect(iso(w.gte)).toBe('2026-6-1');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('qtd → [quarter start, tomorrow) (Q2 starts in April)', () => {
    const w = resolveDateFilter('within', 'qtd', NOW);
    expect(iso(w.gte)).toBe('2026-4-1');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('ytd → [Jan 1, tomorrow)', () => {
    const w = resolveDateFilter('within', 'ytd', NOW);
    expect(iso(w.gte)).toBe('2026-1-1');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('thisMonth → the full calendar month', () => {
    const w = resolveDateFilter('within', 'thisMonth', NOW);
    expect(iso(w.gte)).toBe('2026-6-1');
    expect(iso(w.lt)).toBe('2026-7-1');
  });

  it('lastMonth → the prior full calendar month', () => {
    const w = resolveDateFilter('within', 'lastMonth', NOW);
    expect(iso(w.gte)).toBe('2026-5-1');
    expect(iso(w.lt)).toBe('2026-6-1');
  });

  it('lastYear → the prior full calendar year', () => {
    const w = resolveDateFilter('within', 'lastYear', NOW);
    expect(iso(w.gte)).toBe('2025-1-1');
    expect(iso(w.lt)).toBe('2026-1-1');
  });

  it('last12mo → [same day twelve months back, tomorrow)', () => {
    /**
     * A ROLLING year, which is none of the three windows next to it: `ytd` is January to
     * today, `lastYear` is the previous calendar year, and `lastNdays:365` drifts by a day
     * every leap year — which reads as a bug on a report somebody runs monthly.
     */
    const w = resolveDateFilter('within', 'last12mo', NOW);
    expect(iso(w.gte)).toBe('2025-6-17');
    expect(iso(w.lt)).toBe('2026-6-18');
  });

  it('last12mo clamps to the last day of a shorter target month', () => {
    // 31 March minus twelve months is 31 March; 31 May minus THREE would be 31 February,
    // and `Date` rolls that forward into March. The clamp is what stops a window starting
    // in the wrong month.
    const w = resolveDateFilter('within', 'last12mo', new Date(2024, 1, 29, 10, 0, 0));
    expect(iso(w.gte)).toBe('2023-2-28');
  });

  it('custom lastNdays:14 → [today-13, tomorrow)', () => {
    const w = resolveDateFilter('within', 'lastNdays:14', NOW);
    expect(iso(w.gte)).toBe('2026-6-4');
    expect(iso(w.lt)).toBe('2026-6-18');
  });
});

describe('parseLastNDays', () => {
  it('parses a valid positive N', () => {
    expect(parseLastNDays('lastNdays:30')).toBe(30);
  });
  it('rejects non-matching / non-positive values', () => {
    expect(parseLastNDays('ytd')).toBeNull();
    expect(parseLastNDays('lastNdays:0')).toBeNull();
    expect(parseLastNDays('lastNdays:abc')).toBeNull();
  });
});

describe('formatDateFilterValue', () => {
  it('renders preset labels', () => {
    expect(formatDateFilterValue('within', 'ytd')).toBe('Year to date');
    expect(formatDateFilterValue('within', 'lastNdays:45')).toBe('Last 45 days');
  });
  it('renders a range with an arrow', () => {
    expect(formatDateFilterValue('between', '2026-06-01..2026-06-30')).toBe(
      '2026-06-01 → 2026-06-30',
    );
  });
  it('renders absolute values verbatim, placeholder when blank', () => {
    expect(formatDateFilterValue('on', '2026-06-10')).toBe('2026-06-10');
    expect(formatDateFilterValue('on', '')).toBe('…');
  });
});
