import { describe, expect, it } from 'vitest';
import { auditDiff } from './diff';

/**
 * The audit rows for an edit used to say `{ fields: ['merchant', 'date', 'subtotalMinor'] }`
 * — the keys the CLIENT SENT. A form that posts its whole model on save therefore recorded
 * every field as edited on every save, and no row anywhere carried a value, so a reviewer
 * could see that the merchant was touched and never what it had been (UAT A12).
 *
 * These pin the two properties that fixes: only real changes are reported, and both sides
 * of each one are recorded in a shape the Jsonb column can actually hold.
 */

describe('auditDiff', () => {
  it('reports only the fields that genuinely differ', () => {
    const d = auditDiff(
      { merchant: 'Adobe', purpose: 'Design tools', subtotalMinor: 7419n },
      { merchant: 'Adobe Inc.', purpose: 'Design tools' },
    );
    expect(d.fields).toEqual(['merchant']);
    expect(d.changed.merchant).toEqual({ from: 'Adobe', to: 'Adobe Inc.' });
    expect(d.unchanged).toBe(false);
  });

  it('says so when a save changed nothing at all', () => {
    /**
     * The case the old detail shape could not express. "Opened it and pressed Save" and
     * "corrected the amount" produced identical audit rows, which is most of what made
     * an edit log unreadable.
     */
    const d = auditDiff({ merchant: 'Adobe' }, { merchant: 'Adobe' });
    expect(d.unchanged).toBe(true);
    expect(d.fields).toEqual([]);
    expect(d.changed).toEqual({});
  });

  it('skips an omitted field rather than recording it as cleared', () => {
    // `undefined` means "leave untouched" in every one of these tRPC inputs. Recording it
    // as a change to null would invent an edit nobody made.
    const d = auditDiff({ merchant: 'Adobe', purpose: 'p' }, { merchant: undefined });
    expect(d.unchanged).toBe(true);
  });

  it('records an explicit null, because clearing a field IS an edit', () => {
    const d = auditDiff({ purpose: 'Design tools' }, { purpose: null });
    expect(d.changed.purpose).toEqual({ from: 'Design tools', to: null });
  });

  it('does not report a bigint column as changed when the client sent its string form', () => {
    // tRPC accepts `z.union([z.bigint(), z.string()])` for minor units, so the same amount
    // arrives in two shapes. Flagging that as an edit would fill the log with non-events.
    expect(auditDiff({ subtotalMinor: 7419n }, { subtotalMinor: '7419' }).unchanged).toBe(true);
    expect(auditDiff({ subtotalMinor: 7419n }, { subtotalMinor: '7420' }).fields).toEqual([
      'subtotalMinor',
    ]);
  });

  it('renders values the Jsonb column can hold', () => {
    /**
     * Prisma hands back `Date`, `bigint` and `Decimal`. `JSON.stringify` changes the shape
     * of the first two silently and THROWS on the third — a throw inside an audited
     * transaction would roll back the user's edit over a logging detail.
     */
    const d = auditDiff(
      { date: new Date('2026-08-15T00:00:00.000Z'), subtotalMinor: 1n },
      { date: new Date('2026-08-16T00:00:00.000Z'), subtotalMinor: 2n },
    );
    expect(d.changed.date).toEqual({
      from: '2026-08-15T00:00:00.000Z',
      to: '2026-08-16T00:00:00.000Z',
    });
    expect(d.changed.subtotalMinor).toEqual({ from: '1', to: '2' });
    expect(() => JSON.stringify(d)).not.toThrow();
  });

  it('treats an equal Date as unchanged even though the instances differ', () => {
    const d = auditDiff(
      { date: new Date('2026-08-15T00:00:00.000Z') },
      { date: new Date('2026-08-15T00:00:00.000Z') },
    );
    expect(d.unchanged).toBe(true);
  });

  it('compares structures by value, not by identity', () => {
    const before = { attendees: [{ name: 'Ada' }] };
    expect(auditDiff(before, { attendees: [{ name: 'Ada' }] }).unchanged).toBe(true);
    expect(auditDiff(before, { attendees: [{ name: 'Grace' }] }).fields).toEqual(['attendees']);
  });

  it('logs THAT a redacted field changed without logging what it became', () => {
    // The change is the auditable fact; the value is not ours to copy into a second table.
    const d = auditDiff({ secret: 'old' }, { secret: 'new' }, { redact: ['secret'] });
    expect(d.fields).toEqual(['secret']);
    expect(d.changed.secret).toEqual({ from: '[redacted]', to: '[redacted]' });
  });

  it('does not report a redacted field that did not change', () => {
    expect(auditDiff({ secret: 'x' }, { secret: 'x' }, { redact: ['secret'] }).unchanged).toBe(
      true,
    );
  });

  it('handles a field the row does not have yet', () => {
    // A column added by a migration, on a row written before it.
    expect(auditDiff({}, { placeText: 'Toronto' }).changed.placeText).toEqual({
      from: null,
      to: 'Toronto',
    });
  });
});
