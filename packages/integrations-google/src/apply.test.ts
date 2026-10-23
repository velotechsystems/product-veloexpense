// eos batch 4 — ported from ExpenseOS `packages/integrations-google/src/apply.test.ts`
// (67db2e33, #582). VeloExpense, each marked "VeloExpense:" below:
//   · the in-memory database answers VeloExpense's query shapes (the tenant's `google`
//     source found or created, `findFirst` on the link and the job level, a two-row email
//     lookup, the last-admin count);
//   · ExpenseOS's "creating" cases are VeloExpense's "never creates" cases (d84);
//   · status moves one way (d85): an offboarding stamps `deleted_at` and is held for the
//     last active admin, and an ACTIVE account in Google restores nobody;
//   · a recognised title with no level here is a missing level code, not an unmapped title;
//   · the addresses are `example.test`.
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { titleToJobLevelCode } from '@expenseos/db';
import { describe, expect, it, vi } from 'vitest';
import {
  applyDirectoryManager,
  applyDirectoryUserToDb,
  GOOGLE_OWNED_FIELDS,
  GOOGLE_SOURCE_CODE,
  googleSourceIdOf,
} from './apply';
import type { DirectoryUser } from './types';

/**
 * Writing one Directory account onto VeloExpense.
 *
 * This is the sharp end of directory sync: the nightly run comes through here, so anything
 * it writes wrongly is written repeatedly and overwrites whatever a human set. The rules
 * pinned below are each a deliberate decision with a silent failure mode:
 *
 *   1. **Match by Google id first, email second.** The id survives a primary-email change;
 *      matching on email alone made a renamed person a NEW person with no history.
 *   2. **Two live accounts never claim one person.** A person linked to a different Google
 *      account that still exists is a conflict, and nothing is written. Only when that old
 *      account is gone (deleted, address re-issued) is the person re-linked.
 *   3. **Google owns a fixed set of fields, and a blank in Google clears ours.** It is the
 *      source of truth for them. Department, business unit and legal entity are NOT in the
 *      set and are never touched.
 *   4. **What Google names but we cannot resolve is left alone and reported.** A manager
 *      nobody here has, or a title with no job level: guessing would invent an org chart, and
 *      job level drives `managerChain` approver selection.
 *   5. VeloExpense: **nobody is created (d84), and status only moves out (d85).**
 */

const SOURCE_ID = 'src-google';
const NOW = new Date('2026-10-21T02:30:00.000Z');

interface Row {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobLevelId: string | null;
  managerId: string | null;
  employeeStatus: DirectoryUser['employeeStatus'];
  terminationDate: Date | null;
  country: string | null;
  roleId: string;
  deletedAt: Date | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  legalEntityId?: string | null;
  [k: string]: unknown;
}

const row = (over: Partial<Row> & { id: string; email: string }): Row => ({
  firstName: null,
  lastName: null,
  avatarUrl: null,
  jobLevelId: null,
  managerId: null,
  employeeStatus: 'ACTIVE',
  terminationDate: null,
  country: null,
  roleId: SYSTEM_ROLE_IDS.employee,
  deletedAt: null,
  ...over,
});

const mapped = (over: Partial<DirectoryUser> = {}): DirectoryUser => ({
  googleId: 'g-ada',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  avatarUrl: null,
  title: null,
  country: null,
  employeeStatus: 'ACTIVE',
  terminationDate: null,
  managerEmail: null,
  deleted: false,
  ...over,
});

/** The row `mapped()` describes, already in sync — so a test changes one thing. */
const synced = (over: Partial<Row> = {}): Row =>
  row({ id: 'u-ada', email: 'ada@example.test', firstName: 'Ada', lastName: 'Lovelace', ...over });

interface FakeOpts {
  users?: Row[];
  /** [userId, googleId] pairs: the `google` external ids already stored. */
  links?: [string, string][];
  /** Job level codes that have a row. Default: every code resolves. */
  jobLevels?: 'all' | string[];
  /** VeloExpense: whether the tenant already has its `google` source. Default yes. */
  hasSource?: boolean;
}

type EmailWhere = { email?: { equals: string }; id?: { not: string } };

/**
 * An in-memory stand-in for the slice of Prisma `apply.ts` uses. Real enough to answer the
 * queries the way Postgres would (case-insensitive email, unique link per google id), so
 * the tests can assert on the resulting STATE rather than on call shapes.
 */
function fakeDb(opts: FakeOpts = {}) {
  const users = (opts.users ?? []).map((u) => ({ ...u }));
  const links = (opts.links ?? []).map(([userId, sourceValue], i) => ({
    id: `link-${i}`,
    userId,
    sourceId: SOURCE_ID,
    sourceValue,
  }));
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  let seq = 0;
  const matchEmail = (where: EmailWhere) =>
    users.filter(
      (u) =>
        u.email.toLowerCase() === where.email?.equals.toLowerCase() &&
        (!where.id || u.id !== where.id.not),
    );

  const db = {
    // VeloExpense: per tenant — found, else created.
    externalIdSource: {
      findFirst: vi.fn(async () => ((opts.hasSource ?? true) ? { id: SOURCE_ID } : null)),
      create: vi.fn(async () => ({ id: SOURCE_ID })),
    },
    jobLevel: {
      findFirst: vi.fn(async ({ where }: { where: { code: string } }) =>
        (opts.jobLevels ?? 'all') === 'all' || (opts.jobLevels as string[]).includes(where.code)
          ? { id: `lvl-${where.code}` }
          : null,
      ),
    },
    userExternalId: {
      findFirst: vi.fn(async ({ where }: { where: { sourceId: string; sourceValue: string } }) => {
        const l = links.find((x) => x.sourceId === where.sourceId && x.sourceValue === where.sourceValue);
        return l ? { userId: l.userId } : null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; sourceId: string } }) => {
        for (let i = links.length - 1; i >= 0; i--) {
          if (links[i].userId === where.userId && links[i].sourceId === where.sourceId) {
            links.splice(i, 1);
          }
        }
        return {};
      }),
      create: vi.fn(
        async ({ data }: { data: { sourceId: string; sourceValue: string; userId: string } }) => {
          if (links.some((l) => l.sourceId === data.sourceId && l.sourceValue === data.sourceValue))
            throw new Error('P2002 unique link');
          links.push({ id: `link-new-${++seq}`, ...data });
          return {};
        },
      ),
    },
    user: {
      findMany: vi.fn(
        async ({ where, select, take }: { where: EmailWhere; select: Record<string, unknown>; take?: number }) =>
          matchEmail(where)
            .slice(0, take ?? Infinity)
            .map((u) =>
              select.externalIds
                ? {
                    id: u.id,
                    externalIds: links
                      .filter((l) => l.userId === u.id && l.sourceId === SOURCE_ID)
                      .map((l) => ({ id: l.id, sourceValue: l.sourceValue })),
                  }
                : { id: u.id },
            ),
      ),
      findFirst: vi.fn(async ({ where }: { where: EmailWhere }) => {
        const u = matchEmail(where)[0];
        return u ? { id: u.id } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('not found');
        return { ...u };
      }),
      // VeloExpense: the last-admin rule's count of OTHER active admins.
      count: vi.fn(
        async ({ where }: { where: { roleId: string; id: { not: string } } }) =>
          users.filter(
            (u) =>
              u.roleId === where.roleId &&
              u.employeeStatus === 'ACTIVE' &&
              u.deletedAt === null &&
              u.id !== where.id.not,
          ).length,
      ),
      create: vi.fn(),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
          const u = users.find((x) => x.id === where.id);
          if (u) Object.assign(u, data);
          return {};
        },
      ),
    },
  };
  return {
    db: db as never,
    spies: db,
    users,
    links,
    updates,
    user: (id: string) => users.find((u) => u.id === id),
    linksOf: (id: string) => links.filter((l) => l.userId === id).map((l) => l.sourceValue),
  };
}

const MAPPED_LEVEL = titleToJobLevelCode('Senior Engineer');
const UNMAPPED_TITLE = 'Zebra Wrangler';

describe('preconditions', () => {
  it('pins that the fixtures mean what they say', () => {
    // The title tests depend on one title mapping and one not; if the rules change, these
    // fail here rather than as a confusing outcome below.
    expect(MAPPED_LEVEL).not.toBeNull();
    expect(titleToJobLevelCode(UNMAPPED_TITLE)).toBeNull();
  });

  it('refuses a payload with no email or no google id', async () => {
    // Both are join keys. Writing without one would create an unmatchable person.
    const { db } = fakeDb();
    await expect(applyDirectoryUserToDb(db, mapped({ email: '' }))).rejects.toThrow(/email/);
    await expect(applyDirectoryUserToDb(db, mapped({ googleId: '' }))).rejects.toThrow(/googleId/);
  });
});

describe('googleSourceIdOf', () => {
  it('creates the `google` external-id source, so a tenant that never had one still works', async () => {
    // VeloExpense: the source is the tenant's own (unique per tenant, 0072): found, else created.
    const { db, spies } = fakeDb({ hasSource: false });
    expect(await googleSourceIdOf(db)).toBe(SOURCE_ID);
    expect(spies.externalIdSource.findFirst).toHaveBeenCalledWith({
      where: { code: GOOGLE_SOURCE_CODE },
      select: { id: true },
    });
    expect(spies.externalIdSource.create).toHaveBeenCalledWith({
      data: {
        code: 'google',
        label: { en: 'Google Workspace', 'fr-CA': 'Google Workspace' },
      },
      select: { id: true },
    });
  });

  it('reuses the tenant\'s source when it has one', async () => {
    const { db, spies } = fakeDb();
    expect(await googleSourceIdOf(db)).toBe(SOURCE_ID);
    expect(spies.externalIdSource.create).not.toHaveBeenCalled();
  });

  it('is skipped when the caller already resolved it', async () => {
    // The nightly sync resolves it once instead of once per person.
    const { db, spies } = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
    await applyDirectoryUserToDb(db, mapped(), { googleSourceId: SOURCE_ID });
    expect(spies.externalIdSource.findFirst).not.toHaveBeenCalled();
  });
});

describe('applyDirectoryUserToDb — matching', () => {
  it('matches by the linked google id first, even when the email changed', async () => {
    // A primary-email change in Google. Matching on email would create a second person.
    const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
    const out = await applyDirectoryUserToDb(f.db, mapped({ email: 'ada.l@example.test' }));
    expect(out).toMatchObject({ outcome: 'updated', userId: 'u-ada', linked: false });
    expect(f.user('u-ada')?.email).toBe('ada.l@example.test');
    expect(out.changes.email).toEqual({ from: 'ada@example.test', to: 'ada.l@example.test' });
  });

  it('falls back to a case-insensitive email match, and links the account', async () => {
    const f = fakeDb({ users: [synced({ email: 'Ada@Example.test' })] });
    const out = await applyDirectoryUserToDb(f.db, mapped());
    expect(out).toMatchObject({
      outcome: 'updated',
      userId: 'u-ada',
      linked: true,
      relinked: false,
    });
    expect(f.linksOf('u-ada')).toEqual(['g-ada']);
  });

  it('reports a link alone as `updated` with no field changes', async () => {
    // Linking IS a change — the next run matches by id — so it is not "unchanged".
    const f = fakeDb({ users: [synced()] });
    const out = await applyDirectoryUserToDb(f.db, mapped());
    expect(out).toMatchObject({ outcome: 'updated', linked: true, changes: {} });
    expect(f.updates).toEqual([]);
  });

  it('does not re-create a link the person already has', async () => {
    // Found by the link itself: writing it again would hit the unique (source, value).
    const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
    const out = await applyDirectoryUserToDb(f.db, mapped());
    expect(out.outcome).toBe('unchanged');
    expect(f.spies.userExternalId.create).not.toHaveBeenCalled();
  });

  it('refuses when the email belongs to somebody linked to another LIVE account', async () => {
    /**
     * Two live Google accounts claiming one person. Re-linking would silently move the
     * person's identity between accounts on alternate runs; writing either profile would
     * be a guess. Nothing is written and the conflict is reported for a human.
     */
    const f = fakeDb({ users: [synced({ firstName: 'Old' })], links: [['u-ada', 'g-other']] });
    const out = await applyDirectoryUserToDb(f.db, mapped(), {
      activeGoogleIds: new Set(['g-ada', 'g-other']),
    });
    expect(out).toMatchObject({ outcome: 'conflict', userId: 'u-ada', linked: false, changes: {} });
    expect(out.message).toContain('g-other');
    expect(f.linksOf('u-ada')).toEqual(['g-other']);
    expect(f.updates).toEqual([]);
    expect(f.user('u-ada')?.firstName).toBe('Old');
  });

  it('treats an unknown live set as "still live" — a single refresh never re-links', async () => {
    // The sign-in refresh sees one account; it cannot know the old one is gone.
    const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-other']] });
    const out = await applyDirectoryUserToDb(f.db, mapped());
    expect(out.outcome).toBe('conflict');
    expect(f.spies.userExternalId.deleteMany).not.toHaveBeenCalled();
  });

  it('re-links a person whose old Google account no longer exists', async () => {
    // The old account was deleted and the address re-issued to a new account for the
    // same human. Refusing would orphan them from Google forever.
    const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-old']] });
    const out = await applyDirectoryUserToDb(f.db, mapped(), {
      activeGoogleIds: new Set(['g-ada']),
    });
    expect(out).toMatchObject({ outcome: 'updated', linked: true, relinked: true });
    expect(f.linksOf('u-ada')).toEqual(['g-ada']);
    expect(f.spies.userExternalId.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-ada', sourceId: SOURCE_ID },
    });
  });

  it('skips the email match when the caller forbids it', async () => {
    // A deleted account whose address is live again must not terminate its new owner.
    const f = fakeDb({ users: [synced()] });
    const out = await applyDirectoryUserToDb(f.db, mapped({ deleted: true }), {
      allowEmailMatch: false,
    });
    expect(out).toMatchObject({ outcome: 'skipped', userId: null });
    expect(out.message).toMatch(/Deleted in Google/);
    expect(f.updates).toEqual([]);
    expect(f.links).toEqual([]);
  });

  it('refuses a match on two people whose emails differ only in case', async () => {
    // VeloExpense: the email is unique per tenant AS WRITTEN (0001), so `Ada@x` and `ada@x`
    // can both exist. Guessing which one Google means would write one person's profile
    // onto the other.
    const f = fakeDb({ users: [synced({ email: 'Ada@Example.test' }), row({ id: 'u-ada2', email: 'ada@example.test' })] });
    const out = await applyDirectoryUserToDb(f.db, mapped());
    expect(out).toMatchObject({ outcome: 'conflict', userId: null, changes: {} });
    expect(out.message).toMatch(/different letter cases/);
    expect(f.links).toEqual([]);
    expect(f.updates).toEqual([]);
  });
});

describe('applyDirectoryUserToDb — never creating (VeloExpense, d84)', () => {
  /**
   * ExpenseOS creates an unknown person with the employee role. VeloExpense never does: a
   * person joins a tenant by invitation and takes a paid seat, and a nightly job minting
   * seats from a Workspace is the wrong place for that decision.
   */
  it('reports an account nobody here matches as not-found, and writes nothing', async () => {
    const f = fakeDb();
    const out = await applyDirectoryUserToDb(f.db, mapped({ country: 'CA' }));
    expect(out).toEqual({
      outcome: 'not-found',
      userId: null,
      linked: false,
      relinked: false,
      changes: {},
      message: 'Not a person here; people join by invitation.',
    });
    expect(f.spies.user.create).not.toHaveBeenCalled();
    expect(f.users).toEqual([]);
    expect(f.links).toEqual([]);
  });

  it('skips a deleted account nobody here ever had', async () => {
    const f = fakeDb();
    const out = await applyDirectoryUserToDb(f.db, mapped({ deleted: true, employeeStatus: 'TERMINATED' }));
    expect(out).toMatchObject({ outcome: 'skipped', userId: null });
    expect(out.message).toMatch(/Deleted in Google/);
    expect(f.spies.user.create).not.toHaveBeenCalled();
  });

  it('does not create when email matching is off, whoever holds the address', async () => {
    // ExpenseOS refuses a create into a taken address as a conflict; VeloExpense never
    // reaches a create at all.
    const f = fakeDb({ users: [synced()] });
    const out = await applyDirectoryUserToDb(f.db, mapped({ email: 'ADA@example.test' }), {
      allowEmailMatch: false,
    });
    expect(out.outcome).toBe('not-found');
    expect(f.spies.user.create).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
  });
});

describe('applyDirectoryUserToDb — the fields Google owns', () => {
  it('writes only the fields that differ, and reports from/to', async () => {
    const f = fakeDb({ users: [synced({ avatarUrl: 'old.jpg' })], links: [['u-ada', 'g-ada']] });
    const out = await applyDirectoryUserToDb(
      f.db,
      mapped({ firstName: 'Augusta', avatarUrl: 'new.jpg' }),
    );
    expect(out.outcome).toBe('updated');
    expect(f.updates).toEqual([
      { id: 'u-ada', data: { firstName: 'Augusta', avatarUrl: 'new.jpg' } },
    ]);
    expect(out.changes).toEqual({
      firstName: { from: 'Ada', to: 'Augusta' },
      avatarUrl: { from: 'old.jpg', to: 'new.jpg' },
    });
  });

  it('CLEARS a field Google leaves blank', async () => {
    /**
     * Google is the source of truth for these. Leaving a value Google no longer has would
     * keep a stale name or country forever — the old "absent means don't change" rule is
     * exactly what let renamed people keep their old surname.
     */
    const f = fakeDb({
      users: [synced({ avatarUrl: 'a.jpg', country: 'CA', lastName: 'Lovelace' })],
      links: [['u-ada', 'g-ada']],
    });
    const out = await applyDirectoryUserToDb(f.db, mapped({ lastName: null }));
    expect(f.user('u-ada')).toMatchObject({ avatarUrl: null, country: null, lastName: null });
    expect(out.changes.country).toEqual({ from: 'CA', to: null });
  });

  describe('status (VeloExpense: one way, d85)', () => {
    it('offboards a terminated account: status, termination date and deleted_at, as ISO strings', async () => {
      // A terminated employee must not stay ACTIVE: sign-in, every request and the seat meter
      // read `deleted_at` (0071), and the offboarding roll-up keys on the status.
      const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
      const when = new Date('2026-07-31T00:00:00.000Z');
      const out = await applyDirectoryUserToDb(
        f.db,
        mapped({ employeeStatus: 'TERMINATED', terminationDate: when }),
        { now: NOW },
      );
      expect(f.user('u-ada')).toMatchObject({
        employeeStatus: 'TERMINATED',
        terminationDate: when,
        deletedAt: NOW,
      });
      expect(out.changes.terminationDate).toEqual({ from: null, to: '2026-07-31T00:00:00.000Z' });
      expect(out.changes.employeeStatus).toEqual({ from: 'ACTIVE', to: 'TERMINATED' });
      expect(out.offboarded).toBe(true);
    });

    it('deactivates a suspended account without inventing a termination date', async () => {
      const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ employeeStatus: 'DEACTIVATED' }), {
        now: NOW,
      });
      expect(f.user('u-ada')).toMatchObject({ employeeStatus: 'DEACTIVATED', deletedAt: NOW, terminationDate: null });
      expect(out.changes).not.toHaveProperty('terminationDate');
    });

    it('compares dates by value: a person already offboarded is not offboarded again', async () => {
      const when = new Date('2026-07-31T00:00:00.000Z');
      const gone = new Date('2026-08-01T00:00:00.000Z');
      const same = fakeDb({
        users: [synced({ employeeStatus: 'TERMINATED', terminationDate: new Date(when), deletedAt: gone })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(
        same.db,
        mapped({ employeeStatus: 'TERMINATED', terminationDate: when }),
        { now: NOW },
      );
      // A fresh Date with the same instant is not a change; comparing references would
      // rewrite every terminated person every night.
      expect(out.outcome).toBe('unchanged');
      expect(out.offboarded).toBeUndefined();
      expect(same.user('u-ada')?.deletedAt).toEqual(gone);
    });

    it('never restores anybody: an ACTIVE account leaves a leaver as they are', async () => {
      /**
       * ExpenseOS writes ACTIVE back and clears the termination date. VeloExpense does not:
       * reactivating takes a seat back, which `users.reactivate` caps, and that is an
       * administrator's decision, not a sync's.
       */
      const when = new Date('2026-07-31T00:00:00.000Z');
      const f = fakeDb({
        users: [synced({ employeeStatus: 'TERMINATED', terminationDate: when, deletedAt: when })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped());
      expect(f.user('u-ada')).toMatchObject({ employeeStatus: 'TERMINATED', terminationDate: when, deletedAt: when });
      expect(out.changes).not.toHaveProperty('employeeStatus');
      expect(out.changes).not.toHaveProperty('terminationDate');
    });

    it('never clears ON_LEAVE, which Google cannot express', async () => {
      const f = fakeDb({ users: [synced({ employeeStatus: 'ON_LEAVE' })], links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped());
      expect(f.user('u-ada')?.employeeStatus).toBe('ON_LEAVE');
      expect(out.outcome).toBe('unchanged');
    });

    it("HOLDS the offboarding of the tenant's last active administrator, writing nothing", async () => {
      // A tenant nobody can administer cannot fix the sync that locked it out.
      const f = fakeDb({
        users: [synced({ roleId: SYSTEM_ROLE_IDS.admin, firstName: 'Old' })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped({ employeeStatus: 'DEACTIVATED' }));
      expect(out).toMatchObject({ outcome: 'held', userId: 'u-ada', changes: {} });
      expect(out.message).toMatch(/last active administrator/);
      expect(f.updates).toEqual([]);
      expect(f.user('u-ada')).toMatchObject({ employeeStatus: 'ACTIVE', deletedAt: null, firstName: 'Old' });
    });

    it('offboards an administrator while another active one remains', async () => {
      const f = fakeDb({
        users: [
          synced({ roleId: SYSTEM_ROLE_IDS.admin }),
          row({ id: 'u-grace', email: 'grace@example.test', roleId: SYSTEM_ROLE_IDS.admin }),
        ],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped({ employeeStatus: 'DEACTIVATED' }), {
        now: NOW,
      });
      expect(out).toMatchObject({ outcome: 'updated', offboarded: true });
      expect(f.user('u-ada')?.deletedAt).toEqual(NOW);
    });
  });

  it('leaves a country that is not two letters, and reports it', async () => {
    // VeloExpense: `app_user.country` is held to ISO-2 by a CHECK (0055); writing Google's
    // free text would fail the person's whole apply.
    const f = fakeDb({ users: [synced({ country: 'CA' })], links: [['u-ada', 'g-ada']] });
    const out = await applyDirectoryUserToDb(f.db, mapped({ country: 'CAN' }));
    expect(f.user('u-ada')?.country).toBe('CA');
    expect(out.message).toBe('Country "CAN" is not a country code; left unchanged.');
  });

  it('never writes department, business unit or legal entity', async () => {
    // VeloExpense owns department, business unit and legal entity. A second writer here is how 27 duplicate departments happened.
    const f = fakeDb({
      users: [
        row({
          id: 'u-ada',
          email: 'old@example.test',
          departmentId: 'd',
          businessUnitId: 'b',
          legalEntityId: 'l',
        }),
      ],
      links: [['u-ada', 'g-ada']],
    });
    await applyDirectoryUserToDb(
      f.db,
      mapped({ title: 'Senior Engineer', country: 'US', employeeStatus: 'DEACTIVATED' }),
      { now: NOW },
    );
    for (const { data } of f.updates) {
      // VeloExpense: plus `deletedAt`, which an offboarding stamps (d85).
      for (const k of Object.keys(data)) expect([...GOOGLE_OWNED_FIELDS, 'deletedAt']).toContain(k);
      expect(data).not.toHaveProperty('departmentId');
      expect(data).not.toHaveProperty('businessUnitId');
      expect(data).not.toHaveProperty('legalEntityId');
    }
    expect(f.user('u-ada')).toMatchObject({
      departmentId: 'd',
      businessUnitId: 'b',
      legalEntityId: 'l',
    });
  });

  it('is idempotent: a second apply of the same account changes nothing', async () => {
    // VeloExpense: a person matched by email (nobody is created, d84).
    const f = fakeDb({ users: [row({ id: 'u-ada', email: 'ada@example.test' })] });
    const account = mapped({ title: 'Senior Engineer', country: 'CA', avatarUrl: 'a.jpg' });
    await applyDirectoryUserToDb(f.db, account);
    const writes = f.updates.length;
    const again = await applyDirectoryUserToDb(f.db, account);
    expect(again).toMatchObject({ outcome: 'unchanged', changes: {}, linked: false });
    expect(again.message).toBeUndefined();
    expect(f.updates.length).toBe(writes);
  });

  describe('email', () => {
    it("keeps ours when Google's new primary belongs to another person here", async () => {
      // Writing it would violate the unique email; reporting it lets somebody merge.
      const f = fakeDb({
        users: [synced(), row({ id: 'u-other', email: 'ada.l@example.test' })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped({ email: 'ada.l@example.test' }));
      expect(out).toMatchObject({ outcome: 'unchanged', emailConflict: true });
      expect(out.message).toBe('Kept ada@example.test: ada.l@example.test belongs to another person here.');
      expect(f.user('u-ada')?.email).toBe('ada@example.test');
    });
  });

  describe('job level', () => {
    it('sets the level when the title maps to a known code', async () => {
      const f = fakeDb({ users: [synced()], links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ title: 'Senior Engineer' }));
      expect(f.user('u-ada')?.jobLevelId).toBe(`lvl-${MAPPED_LEVEL}`);
      expect(out.titleUnmapped).toBeUndefined();
    });

    it('clears the level when Google has no title', async () => {
      const f = fakeDb({ users: [synced({ jobLevelId: 'lvl-x' })], links: [['u-ada', 'g-ada']] });
      await applyDirectoryUserToDb(f.db, mapped({ title: null }));
      expect(f.user('u-ada')?.jobLevelId).toBeNull();
    });

    it('LEAVES the level for a title no rule recognises, and reports it', async () => {
      /**
       * Job level drives `managerChain` approver selection. Inventing a rung from free text
       * would hand somebody approval authority; dropping theirs would route their spend
       * past everybody who should see it. So: unchanged, and on the report.
       */
      const f = fakeDb({ users: [synced({ jobLevelId: 'lvl-x' })], links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ title: UNMAPPED_TITLE }));
      expect(f.user('u-ada')?.jobLevelId).toBe('lvl-x');
      expect(out).toMatchObject({ outcome: 'unchanged', titleUnmapped: true });
      expect(out.message).toBe(`Title "${UNMAPPED_TITLE}" maps to no job level.`);
      expect(f.spies.jobLevel.findFirst).not.toHaveBeenCalled();
    });

    it('LEAVES the level when the code maps but no JobLevel row exists', async () => {
      // VeloExpense: a tenant builds its own ladder (0050), so a recognised title can land on
      // a code this tenant has no level for. Same answer — leave it — and report the CODE.
      const f = fakeDb({
        users: [synced({ jobLevelId: 'lvl-x' })],
        links: [['u-ada', 'g-ada']],
        jobLevels: [],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped({ title: 'Senior Engineer' }));
      expect(f.user('u-ada')?.jobLevelId).toBe('lvl-x');
      expect(out.missingLevelCode).toBe(MAPPED_LEVEL);
      expect(out.titleUnmapped).toBeUndefined();
      expect(out.message).toBe(`Title "Senior Engineer" maps to ${MAPPED_LEVEL}, which has no job level here.`);
    });
  });

  describe('manager', () => {
    const people = () => [
      synced({ managerId: 'u-old' }),
      row({ id: 'u-grace', email: 'grace@example.test' }),
      row({ id: 'u-old', email: 'old@example.test' }),
    ];

    it('links a manager we already have, matched case-insensitively', async () => {
      const f = fakeDb({ users: people(), links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ managerEmail: 'Grace@Example.test' }));
      expect(f.user('u-ada')?.managerId).toBe('u-grace');
      expect(out.changes.managerId).toEqual({ from: 'u-old', to: 'u-grace' });
    });

    it('clears the manager when Google names none', async () => {
      // Google is the source of truth for the reporting line.
      const f = fakeDb({ users: people(), links: [['u-ada', 'g-ada']] });
      await applyDirectoryUserToDb(f.db, mapped({ managerEmail: null }));
      expect(f.user('u-ada')?.managerId).toBeNull();
    });

    it('LEAVES the manager when Google names somebody we do not have', async () => {
      /**
       * It used to create a placeholder person. That made Directory able to conjure
       * people: an address just merged away, or an alias left behind by somebody who has
       * gone, came straight back as a new user. Leaving the link is recoverable; a phantom
       * employee is not obviously wrong until somebody counts.
       */
      const f = fakeDb({ users: people(), links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ managerEmail: 'nobody@example.test' }));
      expect(f.user('u-ada')?.managerId).toBe('u-old');
      expect(f.users).toHaveLength(3);
      expect(out).toMatchObject({ outcome: 'unchanged', managerUnresolved: true });
      expect(out.message).toBe('Manager nobody@example.test is not a person here.');
    });

    it('LEAVES the manager rather than write a one-person cycle', async () => {
      // The approval chain walk would loop on a person who manages themselves.
      const f = fakeDb({ users: people(), links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ managerEmail: 'ada@example.test' }));
      expect(f.user('u-ada')?.managerId).toBe('u-old');
      expect(out.managerUnresolved).toBe(true);
    });

    it('LEAVES the manager when two people hold the address in different cases', async () => {
      // VeloExpense: see the email rule above — refused rather than guessed.
      const f = fakeDb({
        users: [...people(), row({ id: 'u-grace2', email: 'Grace@example.test' })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(f.db, mapped({ managerEmail: 'grace@example.test' }));
      expect(f.user('u-ada')?.managerId).toBe('u-old');
      expect(out.managerUnresolved).toBe(true);
    });

    it('does not touch the manager when told to resolve it later', async () => {
      // The nightly sync's pass 1: a manager listed after their report does not exist yet.
      const f = fakeDb({ users: people(), links: [['u-ada', 'g-ada']] });
      const out = await applyDirectoryUserToDb(f.db, mapped({ managerEmail: null }), {
        resolveManager: false,
      });
      expect(f.user('u-ada')?.managerId).toBe('u-old');
      expect(out.outcome).toBe('unchanged');
      expect(out.managerUnresolved).toBeUndefined();
    });

    it('joins every note into one message', async () => {
      const f = fakeDb({
        users: [synced(), row({ id: 'u-other', email: 'taken@example.test' })],
        links: [['u-ada', 'g-ada']],
      });
      const out = await applyDirectoryUserToDb(
        f.db,
        mapped({ email: 'taken@example.test', managerEmail: 'ghost@example.test', title: UNMAPPED_TITLE }),
      );
      expect(out.message).toBe(
        `Kept ada@example.test: taken@example.test belongs to another person here. Manager ghost@example.test is not a person here. Title "${UNMAPPED_TITLE}" maps to no job level.`,
      );
      expect(out).toMatchObject({
        emailConflict: true,
        managerUnresolved: true,
        titleUnmapped: true,
      });
    });
  });
});

describe('applyDirectoryManager', () => {
  /**
   * The nightly sync's second pass, run once every person exists — so a manager listed
   * after their report is found on the first night, not the second.
   */
  const people = () => [synced({ managerId: null }), row({ id: 'u-grace', email: 'grace@example.test' })];

  it('writes the manager and returns the change', async () => {
    const f = fakeDb({ users: people() });
    expect(await applyDirectoryManager(f.db, 'u-ada', 'grace@example.test')).toEqual({
      change: { from: null, to: 'u-grace' },
      unresolved: false,
    });
    expect(f.user('u-ada')?.managerId).toBe('u-grace');
  });

  it('writes nothing when the manager is already right', async () => {
    const f = fakeDb({ users: [synced({ managerId: 'u-grace' }), people()[1]] });
    expect(await applyDirectoryManager(f.db, 'u-ada', 'grace@example.test')).toEqual({
      unresolved: false,
    });
    expect(f.updates).toEqual([]);
  });

  it('clears the manager when Google names none', async () => {
    const f = fakeDb({ users: [synced({ managerId: 'u-grace' }), people()[1]] });
    expect(await applyDirectoryManager(f.db, 'u-ada', null)).toEqual({
      change: { from: 'u-grace', to: null },
      unresolved: false,
    });
  });

  it('reports an unknown or self manager as unresolved, writing nothing', async () => {
    const f = fakeDb({ users: [synced({ managerId: 'u-grace' }), people()[1]] });
    expect(await applyDirectoryManager(f.db, 'u-ada', 'nobody@example.test')).toEqual({
      unresolved: true,
    });
    expect(await applyDirectoryManager(f.db, 'u-ada', 'ada@example.test')).toEqual({ unresolved: true });
    expect(f.updates).toEqual([]);
  });

  it('treats a missing current manager as null', async () => {
    const f = fakeDb({ users: [{ ...synced(), managerId: undefined as never }] });
    expect(await applyDirectoryManager(f.db, 'u-ada', null)).toEqual({ unresolved: false });
  });
});
