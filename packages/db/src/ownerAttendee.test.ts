import { describe, expect, it, vi } from 'vitest';
import {
  type ClaimantSnapshot,
  claimantDisplayName,
  ensureClaimantAttendee,
  lockClaimantSnapshot,
  shouldAddClaimant,
} from './ownerAttendee';

/**
 * The claimant-as-first-attendee rule, without a database.
 *
 * The db suite pins the lock and the real reads; this one pins the two pure pieces — the
 * name and the transition table — and the one guard that must hold before any read: a
 * snapshot this module did not issue is refused, so the lock cannot be skipped.
 */

const EXPENSE_ID = '0192f000-0000-7000-8000-000000000001';

/** A transaction stub that records every property it is asked for, and answers the reads
 *  `lockClaimantSnapshot` / `ensureClaimantAttendee` make with the values given. */
function fakeTx(answers: {
  lockRows?: Array<{ id: string }>;
  requiringLines?: number[];
  attendees?: number;
  owner?: { firstName: string | null; lastName: string | null; email: string };
}) {
  const touched: string[] = [];
  const lineCounts = [...(answers.requiringLines ?? [])];
  const create = vi.fn(async () => ({ id: 'new-attendee-id' }));
  const impl = {
    $queryRaw: vi.fn(async () => answers.lockRows ?? [{ id: EXPENSE_ID }]),
    expenseLineItem: { count: vi.fn(async () => lineCounts.shift() ?? 0) },
    expenseAttendee: { count: vi.fn(async () => answers.attendees ?? 0), create },
    expense: {
      findUniqueOrThrow: vi.fn(async () => ({
        owner: answers.owner ?? { firstName: 'QA', lastName: 'Employee', email: 'qa@test.invalid' },
      })),
    },
  };
  const tx = new Proxy(impl, {
    get(target, prop, receiver) {
      touched.push(String(prop));
      return Reflect.get(target, prop, receiver);
    },
  });
  return { tx: tx as never, touched, create };
}

describe('claimantDisplayName', () => {
  const email = 'qa.employee@test.invalid';

  it.each([
    ['first and last', { firstName: 'QA', lastName: 'Employee' }, 'QA Employee'],
    ['first name only', { firstName: 'Cher', lastName: null }, 'Cher'],
    ['last name only', { firstName: null, lastName: 'Prince' }, 'Prince'],
    ['both null → email', { firstName: null, lastName: null }, email],
    ['both empty → email', { firstName: '', lastName: '' }, email],
    ['whitespace-only parts → email', { firstName: '  ', lastName: '\t ' }, email],
    ['each part trimmed', { firstName: '  QA ', lastName: ' Employee  ' }, 'QA Employee'],
    ['an empty part is dropped, not a double space', { firstName: 'QA', lastName: '  ' }, 'QA'],
    [
      'accented names unchanged',
      { firstName: 'Zoë', lastName: 'Lefèvre-Tremblay' },
      'Zoë Lefèvre-Tremblay',
    ],
    ['CJK names unchanged', { firstName: '李', lastName: '小龍' }, '李 小龍'],
    ['RTL names unchanged', { firstName: 'مريم', lastName: 'الحسيني' }, 'مريم الحسيني'],
  ])('%s', (_label, parts, expected) => {
    expect(claimantDisplayName({ ...parts, email })).toBe(expected);
  });

  it('falls back to the TRIMMED email', () => {
    expect(claimantDisplayName({ firstName: null, lastName: null, email: '  a@b.invalid ' })).toBe(
      'a@b.invalid',
    );
  });

  it('clamps a long name to the 200-character attendee bound', () => {
    const out = claimantDisplayName({
      firstName: 'A'.repeat(150),
      lastName: 'B'.repeat(150),
      email,
    });
    expect(out).toHaveLength(200);
    expect(out).toBe(`${'A'.repeat(150)} ${'B'.repeat(49)}`);
  });

  it('clamps a long email fallback to 200', () => {
    const long = `${'x'.repeat(250)}@test.invalid`;
    expect(claimantDisplayName({ firstName: null, lastName: null, email: long })).toBe(
      'x'.repeat(200),
    );
  });

  it('never splits a surrogate pair at the clamp', () => {
    const out = claimantDisplayName({ firstName: `${'a'.repeat(199)}😀`, lastName: null, email });
    expect(out).toBe('a'.repeat(199));
  });

  it('does not end on the space the clamp landed after', () => {
    const out = claimantDisplayName({ firstName: 'A'.repeat(199), lastName: 'Zed', email });
    expect(out).toBe('A'.repeat(199));
  });

  it('exactly 200 is kept whole', () => {
    expect(claimantDisplayName({ firstName: 'A'.repeat(200), lastName: null, email })).toBe(
      'A'.repeat(200),
    );
  });
});

describe('shouldAddClaimant', () => {
  const rows: Array<[boolean, boolean, number, boolean]> = [];
  for (const had of [false, true]) {
    for (const has of [false, true]) {
      for (const count of [0, 1, 3]) {
        rows.push([had, has, count, !had && has && count === 0]);
      }
    }
  }

  it('covers the full 12-row table, with exactly one true row', () => {
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r[3])).toEqual([[false, true, 0, true]]);
  });

  it.each(rows)('had=%s has=%s attendees=%s → %s', (had, has, count, expected) => {
    expect(
      shouldAddClaimant({ hadRequiringLine: had, hasRequiringLine: has, attendeeCount: count }),
    ).toBe(expected);
  });
});

describe('ensureClaimantAttendee', () => {
  it('rejects a snapshot lockClaimantSnapshot did not issue, before touching the transaction', async () => {
    const { tx, touched } = fakeTx({});
    const forged = {
      expenseId: EXPENSE_ID,
      hadRequiringLine: false,
    } as unknown as ClaimantSnapshot;
    await expect(ensureClaimantAttendee(tx, forged)).rejects.toThrow(/not issued/);
    expect(touched).toEqual([]);
  });

  it('rejects a copy of an issued snapshot', async () => {
    const { tx } = fakeTx({ requiringLines: [0] });
    const real = await lockClaimantSnapshot(tx, EXPENSE_ID);
    const copy = { ...real } as ClaimantSnapshot;
    const { tx: tx2, touched } = fakeTx({});
    await expect(ensureClaimantAttendee(tx2, copy)).rejects.toThrow(/not issued/);
    expect(touched).toEqual([]);
  });

  it('issues a frozen snapshot, so "before" cannot be flipped after the lock', async () => {
    const { tx } = fakeTx({ requiringLines: [1] });
    const snap = await lockClaimantSnapshot(tx, EXPENSE_ID);
    expect(snap).toMatchObject({ expenseId: EXPENSE_ID, hadRequiringLine: true });
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('refuses to issue a snapshot for an expense that does not exist', async () => {
    const { tx } = fakeTx({ lockRows: [] });
    await expect(lockClaimantSnapshot(tx, EXPENSE_ID)).rejects.toThrow(/not found/);
  });

  it('writes nothing and reads nothing more when a requiring line already existed', async () => {
    const { tx, create } = fakeTx({ requiringLines: [1] });
    const snap = await lockClaimantSnapshot(tx, EXPENSE_ID);
    const { tx: after, touched } = fakeTx({});
    expect(await ensureClaimantAttendee(after, snap)).toBeNull();
    expect(touched).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('inserts the owner as an internal attendee on the transition, and returns the id', async () => {
    const { tx, create } = fakeTx({
      requiringLines: [0, 1],
      attendees: 0,
      owner: { firstName: ' Zoë ', lastName: null, email: 'z@test.invalid' },
    });
    const snap = await lockClaimantSnapshot(tx, EXPENSE_ID);
    expect(await ensureClaimantAttendee(tx, snap)).toBe('new-attendee-id');
    expect(create).toHaveBeenCalledWith({
      data: { expenseId: EXPENSE_ID, name: 'Zoë', company: null, isExternal: false },
      select: { id: true },
    });
  });
});
