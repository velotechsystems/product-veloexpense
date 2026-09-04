/**
 * UD-11 — the diff itself. Pure, so no database; `test/expense-audit.db.test.ts`
 * is the regression guard that matters, because the "from" side has to come out
 * of a real row.
 *
 * Every case upstream's `packages/audit/src/diff.test.ts` pins is pinned here,
 * plus the three our row-vs-row shape introduces (ignored columns, the key union,
 * and surviving `canonical()` rather than only `JSON.stringify`).
 */
import { describe, it, expect } from 'vitest';
import { auditDiff, auditSnapshot, IGNORED_COLUMNS } from '@/lib/audit/diff';
import { canonical } from '@/lib/audit/canonical';

describe('auditDiff', () => {
  it('reports only the fields that genuinely differ', () => {
    const d = auditDiff(
      { merchant: 'Adobe', notes: 'Design tools', amount_minor: '7419' },
      { merchant: 'Adobe Inc.', notes: 'Design tools', amount_minor: '7419' },
    );
    expect(d.fields).toEqual(['merchant']);
    expect(d.changed.merchant).toEqual({ from: 'Adobe', to: 'Adobe Inc.' });
    expect(d.unchanged).toBe(false);
  });

  it('says so when a save changed nothing at all', () => {
    // The case the old detail shape could not express. "Opened it and pressed
    // Save" and "corrected the amount" produced identical rows, which is most of
    // what made an edit log unreadable.
    const d = auditDiff({ merchant: 'Adobe' }, { merchant: 'Adobe' });
    expect(d.unchanged).toBe(true);
    expect(d.fields).toEqual([]);
    expect(d.changed).toEqual({});
  });

  it('records an explicit null, because clearing a field IS an edit', () => {
    expect(auditDiff({ notes: 'Design tools' }, { notes: null }).changed.notes).toEqual({
      from: 'Design tools',
      to: null,
    });
  });

  it('skips a column the caller did not select rather than calling it cleared', () => {
    // `undefined` on the after side means "not selected", not "set to null".
    // Recording it as a change would invent an edit nobody made.
    expect(auditDiff({ merchant: 'Adobe', notes: 'p' }, { merchant: undefined }).unchanged).toBe(
      true,
    );
  });

  it('does not report a minor-unit column as changed when handed the bigint form', () => {
    // `pg` returns bigint columns as strings; a caller may hand us a real bigint
    // for the same amount. Flagging that would fill the log with non-events.
    expect(auditDiff({ amount_minor: '7419' }, { amount_minor: 7419n }).unchanged).toBe(true);
    expect(auditDiff({ amount_minor: '7419' }, { amount_minor: 7420n }).fields).toEqual([
      'amount_minor',
    ]);
  });

  it('treats an equal Date as unchanged even though the instances differ', () => {
    expect(
      auditDiff(
        { txn_date: new Date('2026-08-15T00:00:00.000Z') },
        { txn_date: new Date('2026-08-15T00:00:00.000Z') },
      ).unchanged,
    ).toBe(true);
  });

  it('compares structures by value, not by identity', () => {
    const before = { data: { attendees: ['Ada'] } };
    expect(auditDiff(before, { data: { attendees: ['Ada'] } }).unchanged).toBe(true);
    expect(auditDiff(before, { data: { attendees: ['Grace'] } }).fields).toEqual(['data']);
  });

  it('logs THAT a redacted field changed without logging what it became', () => {
    const d = auditDiff({ secret: 'old' }, { secret: 'new' }, { redact: ['secret'] });
    expect(d.fields).toEqual(['secret']);
    expect(d.changed.secret).toEqual({ from: '[redacted]', to: '[redacted]' });
  });

  it('does not report a redacted field that did not change', () => {
    expect(auditDiff({ secret: 'x' }, { secret: 'x' }, { redact: ['secret'] }).unchanged).toBe(true);
  });

  /* ── ours, from the row-vs-row shape ─────────────────────────────────────── */

  /**
   * `updated_at` moves on every write. Without the default ignore list,
   * `unchanged` would always be false and the flag would be a lie rather than a
   * signal — which is the whole reason the flag exists.
   */
  it('ignores updated_at, so a no-op save still reads as unchanged', () => {
    const d = auditDiff(
      { merchant: 'Adobe', updated_at: new Date('2026-09-01T00:00:00.000Z') },
      { merchant: 'Adobe', updated_at: new Date('2026-09-04T00:00:00.000Z') },
    );
    expect(d.unchanged).toBe(true);
  });

  /**
   * `total_minor` is rewritten by `recomputeReportTotal` after every line-item
   * change. Reporting it on the REPORT would log the same event twice, the second
   * time against the wrong row.
   */
  it('ignores the derived report total', () => {
    expect(IGNORED_COLUMNS).toContain('total_minor');
    expect(auditDiff({ total_minor: '100' }, { total_minor: '4100' }).unchanged).toBe(true);
  });

  it('diffs over the UNION of both rows, so a new column arriving is a change', () => {
    // A column added by a migration, on a row written before it.
    expect(auditDiff({}, { txn_date: '2026-09-04' }).changed.txn_date).toEqual({
      from: null,
      to: '2026-09-04',
    });
  });

  /**
   * The trap that is sharper here than upstream. Their `details` is outside the
   * hash payload; ours is INSIDE it (AU-3), so a diff also has to survive
   * `canonical()` — which throws on BigInt, inside the transaction recording the
   * user's edit (AU-5). A throw there rolls back the edit over a logging detail.
   */
  it('produces details that survive canonical(), bigints included', () => {
    const d = auditDiff({ amount_minor: '100' }, { amount_minor: 4100n });
    expect(() => canonical(d)).not.toThrow();
    expect(d.changed.amount_minor).toEqual({ from: '100', to: '4100' });
  });

  it('produces details that survive canonical() when a Date changed', () => {
    const d = auditDiff(
      { txn_date: new Date('2026-08-15T00:00:00.000Z') },
      { txn_date: new Date('2026-08-16T00:00:00.000Z') },
    );
    expect(() => canonical(d)).not.toThrow();
    expect(d.changed.txn_date).toEqual({
      from: '2026-08-15T00:00:00.000Z',
      to: '2026-08-16T00:00:00.000Z',
    });
  });

  it('names its fields in a stable order, so two identical edits hash alike', () => {
    // `details` is in the hash payload. `canonical()` sorts object keys but not
    // array members, and `fields` is an array.
    const a = auditDiff({ b: 1, a: 1 }, { b: 2, a: 2 });
    const b = auditDiff({ a: 1, b: 1 }, { a: 2, b: 2 });
    expect(a.fields).toEqual(['a', 'b']);
    expect(canonical(a)).toBe(canonical(b));
  });
});

describe('auditSnapshot', () => {
  it('renders the row that is about to stop existing', () => {
    const s = auditSnapshot({
      id: 'x',
      amount_minor: 4100n,
      description: 'Taxi',
      updated_at: new Date(),
    });
    expect(s).toEqual({ id: 'x', amount_minor: '4100', description: 'Taxi' });
    expect(() => canonical(s)).not.toThrow();
  });

  it('redacts what it is told to, and keeps the field', () => {
    expect(auditSnapshot({ secret: 'x', keep: 'y' }, { redact: ['secret'] })).toEqual({
      secret: '[redacted]',
      keep: 'y',
    });
  });
});
