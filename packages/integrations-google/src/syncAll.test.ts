// eos batch 4 — ported from ExpenseOS `packages/integrations-google/src/syncAll.test.ts`
// (67db2e33, #582). VeloExpense, each marked "VeloExpense:" below:
//   · the credentials are the tenant's and passed in (`null` = not connected = `disabled`),
//     and the platform's GOOGLE_DIRECTORY_DISABLED switch still turns every tenant off —
//     ExpenseOS's `loadDirectorySettings` is not ported;
//   · each person is applied, and each manager resolved, on its own `db.$transaction`;
//   · the customer is `my_customer` unless the caller passes one;
//   · nobody is created (d84): ExpenseOS's `created` is `notFound` here, which is counted and
//     leaves no item; a held offboarding (the last admin) is a SKIPPED item; the people
//     offboarded and the missing level codes are reported;
//   · the addresses are `example.test`.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult } from './apply';
import type { DirectoryUser } from './types';

/**
 * The nightly Directory reconciliation.
 *
 * The properties worth pinning are about ORDER, RESILIENCE and REPORTING, because this runs
 * unattended over the whole org:
 *
 *   · **Both listings are read in full before anything is written.** Which Google ids are
 *     live decides a re-link versus a conflict, and a deleted account may share an address
 *     with a live one — neither can be judged a page at a time. A listing failure therefore
 *     fails the run with NOTHING written, rather than half a reconciliation.
 *   · **Paging must actually page.** Stopping after the first page silently syncs the first
 *     500 people alphabetically and leaves the rest stale forever.
 *   · **A deleted account never terminates a live address's owner.** Google lists deleted
 *     accounts for ~20 days; their addresses get re-issued.
 *   · **Managers are a second pass.** Otherwise a manager listed after their report is not
 *     found on the first night.
 *   · **One bad person must not abort the run**, and unmapped titles / unresolved managers
 *     are REPORTED, not swallowed — a person with no job level is invisible to a
 *     `managerChain` tier walk.
 *   · **Disabled is a status, not an error.** Returning `error` for a deliberately-off
 *     integration would make a normal configuration look broken every night.
 */

const h = vi.hoisted(() => ({
  list: vi.fn(),
  getClient: vi.fn(),
  apply: vi.fn(),
  manager: vi.fn(),
  sourceId: vi.fn(async () => 'src-google'),
}));

vi.mock('./client', () => {
  class GoogleDirectoryConfigError extends Error {}
  class GoogleDirectoryDisabledError extends Error {}
  return {
    GoogleDirectoryConfigError,
    GoogleDirectoryDisabledError,
    getDirectoryClient: h.getClient,
    isDirectoryDisabled: () => process.env.GOOGLE_DIRECTORY_DISABLED === 'true',
  };
});
vi.mock('./apply', () => ({
  applyDirectoryUserToDb: h.apply,
  applyDirectoryManager: h.manager,
  googleSourceIdOf: h.sourceId,
}));

const { syncAllFromDirectory } = await import('./syncAll');
const { GoogleDirectoryConfigError, GoogleDirectoryDisabledError } = (await import('./client')) as unknown as {
  GoogleDirectoryConfigError: new (m: string) => Error;
  GoogleDirectoryDisabledError: new (m: string) => Error;
};

// VeloExpense: each person runs on `db.$transaction`; the stub hands every call one tx.
const TX = { tx: true } as never;
const transactions = vi.fn();
const db = {
  $transaction: async <T>(fn: (tx: never) => Promise<T>) => {
    transactions();
    return fn(TX);
  },
};
const CREDS = { serviceAccountJson: '{}', impersonateEmail: 'admin@example.test' };

/** A raw Directory user, as `users.list` returns it. */
const g = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id,
  primaryEmail: email,
  ...over,
});
const page = (users: unknown[], nextPageToken?: string) => ({
  data: { users, ...(nextPageToken ? { nextPageToken } : {}) },
});

/** Live accounts, then deleted ones — one page each. */
function listing(live: unknown[], deleted: unknown[] = []) {
  h.list.mockImplementation(async (params: { showDeleted?: string }) =>
    params.showDeleted === 'true' ? page(deleted) : page(live),
  );
}

const result = (over: Partial<ApplyResult> = {}): ApplyResult => ({
  outcome: 'unchanged',
  userId: 'u1',
  linked: false,
  relinked: false,
  changes: {},
  ...over,
});

/** The DirectoryUser `apply` was called with, by call index. */
const appliedAccount = (i: number) => h.apply.mock.calls[i][1] as DirectoryUser;
const appliedOptions = (i: number) => h.apply.mock.calls[i][2];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
  h.getClient.mockReturnValue({ users: { list: h.list } });
  h.apply.mockImplementation(async (_db: unknown, account: DirectoryUser) =>
    result({ userId: `u-${account.googleId}` }),
  );
  h.manager.mockResolvedValue({ unresolved: false });
  listing([]);
});
afterEach(() => {
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
});

describe('syncAllFromDirectory — switched off or broken before it starts', () => {
  it('returns `disabled` with the reason, without listing, when the platform switch is off', async () => {
    // This is dev's and CI's normal state. It must not read as a failure.
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({ status: 'disabled', items: [], offboarded: [] });
    expect(res.message).toMatch(/GOOGLE_DIRECTORY_DISABLED/);
    expect(res.counts.scanned).toBe(0);
    expect(h.getClient).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it('VeloExpense: returns `disabled` for a tenant that has not connected', async () => {
    const res = await syncAllFromDirectory(db, null);
    expect(res).toMatchObject({ status: 'disabled', message: 'Google Workspace is not connected.' });
    expect(h.getClient).not.toHaveBeenCalled();
  });

  it("builds the client from the tenant's credentials", async () => {
    await syncAllFromDirectory(db, CREDS);
    expect(h.getClient).toHaveBeenCalledWith(CREDS);
  });

  it('VeloExpense: uses an injected client, for a test, without building one', async () => {
    const list = vi.fn(async () => ({ data: { users: [] } }));
    await syncAllFromDirectory(db, null, { client: { users: { list } } });
    expect(h.getClient).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('returns `error` with the config message when the key is bad', async () => {
    // Distinguishable from `disabled`: somebody meant to enable this and it is misconfigured.
    h.getClient.mockImplementation(() => {
      throw new GoogleDirectoryConfigError('The service account key is not valid JSON');
    });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({
      status: 'error',
      message: 'The service account key is not valid JSON',
    });
  });

  it('returns `disabled` when the client refuses as switched off', async () => {
    h.getClient.mockImplementation(() => {
      throw new GoogleDirectoryDisabledError('off');
    });
    expect((await syncAllFromDirectory(db, CREDS)).status).toBe('disabled');
  });

  it('returns `error` rather than throwing on an unexpected init failure', async () => {
    // The caller is a cron handler; a throw there is an unhandled rejection.
    h.getClient.mockImplementation(() => {
      throw new Error('unexpected');
    });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.message).toBe('init failed: Error: unexpected');
  });
});

describe('syncAllFromDirectory — listing', () => {
  it('lists live accounts, then deleted ones, for the impersonated admin\'s own Workspace', async () => {
    // VeloExpense: `my_customer` — per tenant that is the right one (no platform override).
    await syncAllFromDirectory(db, CREDS);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.list.mock.calls[0][0]).toEqual({
      customer: 'my_customer',
      maxResults: 500,
      pageToken: undefined,
      projection: 'full',
      orderBy: 'email',
    });
    expect(h.list.mock.calls[1][0]).toMatchObject({ customer: 'my_customer', showDeleted: 'true' });
  });

  it('VeloExpense: lists the customer the caller names', async () => {
    await syncAllFromDirectory(db, CREDS, { customer: 'C0123' });
    expect(h.list.mock.calls[0][0]).toMatchObject({ customer: 'C0123' });
  });

  it('follows nextPageToken to the end of BOTH listings', async () => {
    h.list
      .mockResolvedValueOnce(page([g('1', 'a@example.test')], 'live-2'))
      .mockResolvedValueOnce(page([g('2', 'b@example.test')]))
      .mockResolvedValueOnce(page([g('3', 'c@example.test')], 'gone-2'))
      .mockResolvedValueOnce(page([g('4', 'd@example.test')]));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(h.list).toHaveBeenCalledTimes(4);
    expect(h.list.mock.calls[1][0]).toMatchObject({ pageToken: 'live-2' });
    expect(h.list.mock.calls[3][0]).toMatchObject({ pageToken: 'gone-2', showDeleted: 'true' });
    expect(res.counts).toMatchObject({ scanned: 4, active: 2, deleted: 2 });
  });

  it('clamps the page size into the API range of 1..500', async () => {
    await syncAllFromDirectory(db, CREDS, { pageSize: 9999 });
    expect(h.list.mock.calls[0][0]).toMatchObject({ maxResults: 500 });
    h.list.mockClear();
    await syncAllFromDirectory(db, CREDS, { pageSize: 0 });
    expect(h.list.mock.calls[0][0]).toMatchObject({ maxResults: 1 });
  });

  it('handles a page with no users array at all', async () => {
    h.list.mockResolvedValue({ data: {} });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({ status: 'completed', items: [] });
    expect(res.counts.scanned).toBe(0);
  });

  it.each([
    ['the live listing', 1],
    ['the deleted listing', 3],
  ])('fails before ANY write when %s fails part way', async (_label, failingCall) => {
    /**
     * Judging re-link vs conflict needs the full live set. A run that wrote the first page
     * and then failed would have made those calls on partial knowledge.
     */
    let call = 0;
    h.list.mockImplementation(async () => {
      call += 1;
      if (call === failingCall + 1) throw new Error('429 rate limited');
      return page(
        [g(`id-${call}`, `p${call}@example.test`)],
        call < 2 || call === 3 ? `t${call}` : undefined,
      );
    });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.message).toBe('directory.users.list failed: 429 rate limited');
    expect(res.counts.scanned).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.manager).not.toHaveBeenCalled();
    expect(h.sourceId).not.toHaveBeenCalled();
  });

  it('quotes a non-Error listing failure', async () => {
    h.list.mockRejectedValue('quota');
    expect((await syncAllFromDirectory(db, CREDS)).message).toBe('directory.users.list failed: quota');
  });
});

describe('syncAllFromDirectory — live and deleted accounts', () => {
  it('passes the live id set, the resolved source and NO manager resolution to pass 1', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test')]);
    await syncAllFromDirectory(db, CREDS);
    // VeloExpense: no `allowCreate` (nobody is created, d84); the clock is passed through.
    expect(appliedOptions(0)).toEqual({
      resolveManager: false,
      activeGoogleIds: new Set(['1', '2']),
      googleSourceId: 'src-google',
      allowEmailMatch: true,
      now: undefined,
    });
    expect(h.sourceId).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0][0]).toBe(TX);
  });

  it('applies deleted accounts as TERMINATED', async () => {
    listing([g('1', 'a@example.test')], [g('9', 'gone@example.test', { deletionTime: '2026-09-01T00:00:00Z' })]);
    await syncAllFromDirectory(db, CREDS);
    expect(appliedAccount(1)).toMatchObject({
      googleId: '9',
      deleted: true,
      employeeStatus: 'TERMINATED',
    });
    expect(appliedOptions(1)).toMatchObject({ allowEmailMatch: true });
  });

  it('does not email-match a deleted account whose address is live again', async () => {
    // The address was re-issued to a new account. Matching it would terminate whoever
    // owns it now.
    listing([g('new', 'ada@example.test')], [g('old', 'ada@example.test')]);
    await syncAllFromDirectory(db, CREDS);
    expect(appliedOptions(1)).toMatchObject({ allowEmailMatch: false });
  });

  it('drops a deleted account whose id is also live — the live one wins', async () => {
    // Google can list an account in both views mid-restore.
    listing([g('1', 'a@example.test')], [g('1', 'a@example.test'), g('2', 'b@example.test')]);
    const res = await syncAllFromDirectory(db, CREDS);
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(appliedAccount(0).deleted).toBe(false);
    expect(appliedAccount(1).googleId).toBe('2');
    expect(res.counts).toMatchObject({ scanned: 2, active: 1, deleted: 1 });
  });

  it('records no item for a deleted account nobody here ever had', async () => {
    // Noise, not news: every departure for 20 days would otherwise fill the report.
    listing([], [g('9', 'gone@example.test')]);
    h.apply.mockResolvedValue(
      result({
        outcome: 'skipped',
        userId: null,
        message: 'Deleted in Google and never known here.',
      }),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items).toEqual([]);
    expect(res.counts.skipped).toBe(1);
  });

  it('records a SKIPPED item for a live account that could not be applied', async () => {
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(result({ outcome: 'skipped', userId: null, message: 'why' }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items).toEqual([
      {
        outcome: 'SKIPPED',
        userId: null,
        googleId: '1',
        email: 'a@example.test',
        fields: {},
        message: 'why',
      },
    ]);
  });
});

describe('syncAllFromDirectory — outcomes and counts', () => {
  it('reports every outcome but unchanged, and counts each', async () => {
    listing([
      g('1', 'notfound@example.test'),
      g('2', 'updated@example.test'),
      g('3', 'linked@example.test'),
      g('4', 'relinked@example.test'),
      g('5', 'conflict@example.test'),
      g('6', 'same@example.test'),
    ]);
    h.apply
      // VeloExpense: nobody is created (d84) — an account nobody here has is not-found.
      .mockResolvedValueOnce(result({ outcome: 'not-found', userId: null }))
      .mockResolvedValueOnce(
        result({
          outcome: 'updated',
          userId: 'u2',
          changes: { country: { from: 'US', to: 'CA' } },
        }),
      )
      .mockResolvedValueOnce(result({ outcome: 'updated', userId: 'u3', linked: true }))
      .mockResolvedValueOnce(
        result({ outcome: 'updated', userId: 'u4', linked: true, relinked: true }),
      )
      .mockResolvedValueOnce(result({ outcome: 'conflict', userId: 'u5', message: 'two accounts' }))
      .mockResolvedValueOnce(result({ outcome: 'unchanged', userId: 'u6' }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('completed');
    expect(res.counts).toMatchObject({
      scanned: 6,
      active: 6,
      deleted: 0,
      notFound: 1,
      updated: 3,
      unchanged: 1,
      linked: 2,
      relinked: 1,
      conflicts: 1,
      skipped: 0,
      errors: 0,
    });
    // VeloExpense: not-found leaves no item — counted, not news.
    expect(res.items.map((i) => [i.email, i.outcome])).toEqual([
      ['updated@example.test', 'UPDATED'],
      ['linked@example.test', 'LINKED'],
      ['relinked@example.test', 'LINKED'],
      ['conflict@example.test', 'CONFLICT'],
    ]);
    expect(res.items[0].fields).toEqual({ country: { from: 'US', to: 'CA' } });
    expect(res.items[2].message).toBe('Re-linked from a Google account that no longer exists.');
    expect(res.items[3].message).toBe('two accounts');
  });

  it('appends the re-link note to an existing message', async () => {
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(
      result({
        outcome: 'updated',
        linked: true,
        relinked: true,
        changes: { lastName: { from: 'X', to: 'Y' } },
        message: 'Manager m@example.test is not a person here.',
      }),
    );
    const [item] = (await syncAllFromDirectory(db, CREDS)).items;
    expect(item.outcome).toBe('UPDATED');
    expect(item.message).toBe(
      'Manager m@example.test is not a person here. Re-linked from a Google account that no longer exists.',
    );
  });

  it('reports an unchanged account that carries a note as SKIPPED', async () => {
    // Nothing changed, but something is worth a look (email kept, title unmapped…).
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(
      result({ outcome: 'unchanged', emailConflict: true, message: 'Kept' }),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items).toEqual([
      {
        outcome: 'SKIPPED',
        userId: 'u1',
        googleId: '1',
        email: 'a@example.test',
        fields: {},
        message: 'Kept',
      },
    ]);
    expect(res.counts.unchanged).toBe(1);
  });

  it('keeps going after one person fails', async () => {
    /**
     * The whole point. One malformed record out of hundreds must cost one error, not the
     * night's reconciliation.
     */
    listing([g('1', 'a@example.test'), g('2', 'b@example.test'), g('3', 'c@example.test')]);
    h.apply
      .mockResolvedValueOnce(result({ userId: 'u1' }))
      .mockRejectedValueOnce(new Error('FK violation'))
      .mockRejectedValueOnce('odd');
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('completed');
    expect(res.counts).toMatchObject({ scanned: 3, unchanged: 1, errors: 2 });
    expect(res.items).toEqual([
      {
        outcome: 'ERROR',
        userId: null,
        googleId: '2',
        email: 'b@example.test',
        fields: {},
        message: 'FK violation',
      },
      {
        outcome: 'ERROR',
        userId: null,
        googleId: '3',
        email: 'c@example.test',
        fields: {},
        message: 'odd',
      },
    ]);
  });

  it('counts an account with no id or email as an error without applying it', async () => {
    listing([{ organizations: [] }, g('', 'noid@example.test')]);
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts).toMatchObject({ scanned: 2, errors: 2 });
    expect(res.items.map((i) => i.email)).toEqual(['(unknown)', 'noid@example.test']);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('heart-beats through onProgress every 50 people and once at the end', async () => {
    // The worker marks a run stale when it stops beating; 120 people must not look dead.
    listing(Array.from({ length: 120 }, (_, i) => g(`${i}`, `p${i}@example.test`)));
    const onProgress = vi.fn();
    await syncAllFromDirectory(db, CREDS, { onProgress });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([50, 100, 120]);
  });

  it('heart-beats once even for an empty directory', async () => {
    const onProgress = vi.fn();
    await syncAllFromDirectory(db, CREDS, { onProgress });
    expect(onProgress).toHaveBeenCalledWith(0);
  });
});

describe('syncAllFromDirectory — pass 2: managers', () => {
  it('resolves managers only after every person has been applied', async () => {
    // A manager listed after their report must be found on the FIRST night.
    listing([
      g('1', 'report@example.test', { relations: [{ type: 'manager', value: 'Boss@example.test' }] }),
      g('2', 'boss@example.test'),
    ]);
    const order: string[] = [];
    h.apply.mockImplementation(async (_d: unknown, a: DirectoryUser) => {
      order.push(`apply:${a.email}`);
      return result({ userId: `u-${a.googleId}` });
    });
    h.manager.mockImplementation(async (_d: unknown, userId: string) => {
      order.push(`manager:${userId}`);
      return { unresolved: false };
    });
    await syncAllFromDirectory(db, CREDS);
    expect(order).toEqual(['apply:report@example.test', 'apply:boss@example.test', 'manager:u-1', 'manager:u-2']);
    expect(h.manager).toHaveBeenCalledWith(TX, 'u-1', 'boss@example.test');
    expect(h.manager).toHaveBeenCalledWith(TX, 'u-2', null);
  });

  it('skips managers for conflicts, skips and errors', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test'), g('3', 'c@example.test')]);
    h.apply
      .mockResolvedValueOnce(result({ outcome: 'conflict', userId: 'u1' }))
      .mockResolvedValueOnce(result({ outcome: 'skipped', userId: null }))
      .mockRejectedValueOnce(new Error('x'));
    // VeloExpense: and for not-found and held (see below).
    await syncAllFromDirectory(db, CREDS);
    expect(h.manager).not.toHaveBeenCalled();
  });

  it('leaves a deleted account’s manager alone', async () => {
    /**
     * Google drops a deleted account's manager relation. Clearing it here would strand the
     * leaver's cards and open reports, which the offboarding roll-up moves TO that manager.
     */
    listing([g('1', 'a@example.test')], [g('9', 'gone@example.test')]);
    h.apply.mockImplementation(async (_d: unknown, a: DirectoryUser) =>
      result({ userId: `u-${a.googleId}` }),
    );
    h.manager.mockResolvedValue({ unresolved: false });
    await syncAllFromDirectory(db, CREDS);
    expect(h.manager).toHaveBeenCalledTimes(1);
    expect(h.manager).toHaveBeenCalledWith(TX, 'u-1', null);
  });

  it('turns an unchanged person into UPDATED when only the manager changed', async () => {
    listing([g('1', 'a@example.test')]);
    h.manager.mockResolvedValue({ change: { from: null, to: 'u-boss' }, unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items).toEqual([
      {
        outcome: 'UPDATED',
        userId: 'u-1',
        googleId: '1',
        email: 'a@example.test',
        fields: { managerId: { from: null, to: 'u-boss' } },
      },
    ]);
    expect(res.counts).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it('upgrades a noted-but-unchanged SKIPPED item to UPDATED', async () => {
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(
      result({ userId: 'u-1', message: 'Title "X" maps to no job level.' }),
    );
    h.manager.mockResolvedValue({ change: { from: 'u-a', to: 'u-b' }, unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items[0]).toMatchObject({
      outcome: 'UPDATED',
      message: 'Title "X" maps to no job level.',
      fields: { managerId: { from: 'u-a', to: 'u-b' } },
    });
    expect(res.counts).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it('upgrades a LINKED item to UPDATED without double counting', async () => {
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(result({ outcome: 'updated', userId: 'u-1', linked: true }));
    h.manager.mockResolvedValue({ change: { from: null, to: 'u-b' }, unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items[0].outcome).toBe('UPDATED');
    expect(res.counts).toMatchObject({ updated: 1, linked: 1, unchanged: 0 });
  });

  it('adds the manager to an item that already changed', async () => {
    // VeloExpense: an UPDATED person (ExpenseOS uses a CREATED one, which cannot happen here).
    listing([g('1', 'a@example.test')]);
    h.apply.mockResolvedValue(
      result({
        outcome: 'updated',
        userId: 'u-1',
        changes: { firstName: { from: 'Z', to: 'A' } },
      }),
    );
    h.manager.mockResolvedValue({ change: { from: null, to: 'u-b' }, unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.items[0]).toMatchObject({
      outcome: 'UPDATED',
      fields: { firstName: { from: 'Z', to: 'A' }, managerId: { from: null, to: 'u-b' } },
    });
    expect(res.counts).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it('counts an unresolved manager and keeps going', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test')]);
    h.manager
      .mockResolvedValueOnce({ unresolved: true })
      .mockResolvedValueOnce({ unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts.managersUnresolved).toBe(1);
    expect(res.items).toEqual([]);
  });

  it('records a manager failure as an error and keeps going', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test')]);
    h.manager
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockRejectedValueOnce('odd')
      .mockResolvedValue({ unresolved: false });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts.errors).toBe(2);
    expect(res.items).toEqual([
      {
        outcome: 'ERROR',
        userId: 'u-1',
        googleId: '1',
        email: 'a@example.test',
        fields: {},
        message: 'manager: deadlock',
      },
      {
        outcome: 'ERROR',
        userId: 'u-2',
        googleId: '2',
        email: 'b@example.test',
        fields: {},
        message: 'manager: odd',
      },
    ]);
  });
});

describe('syncAllFromDirectory — unmapped job titles', () => {
  it('tallies titles apply could not map, most common first, ties alphabetical', async () => {
    /**
     * Not a log line: a person with no job level is invisible to a `managerChain` tier
     * walk, so this list is how a routing hole gets found before it routes a $100k report
     * past everyone.
     */
    const titled = (id: string, title: string) =>
      g(id, `${id}@example.test`, { organizations: [{ primary: true, title }] });
    listing([
      titled('1', 'Zebra Wrangler'),
      titled('2', 'Barista'),
      titled('3', 'Barista'),
      titled('4', 'Aardvark Herder'),
      titled('5', 'Senior Engineer'),
    ]);
    h.apply.mockImplementation(async (_d: unknown, a: DirectoryUser) =>
      result({ userId: `u-${a.googleId}`, titleUnmapped: a.title !== 'Senior Engineer' }),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts.unmappedTitles).toEqual([
      { title: 'Barista', count: 2 },
      { title: 'Aardvark Herder', count: 1 },
      { title: 'Zebra Wrangler', count: 1 },
    ]);
  });
});

describe('syncAllFromDirectory — VeloExpense: update only, one way (d84, d85)', () => {
  it('counts not-found accounts and records no item for them', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test')]);
    h.apply.mockResolvedValue(result({ outcome: 'not-found', userId: null }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts).toMatchObject({ notFound: 2, updated: 0 });
    expect(res.items).toEqual([]);
    expect(h.manager).not.toHaveBeenCalled();
  });

  it('records a held offboarding as a SKIPPED item with its reason, and resolves no manager', async () => {
    listing([g('1', 'admin@example.test', { suspended: true })]);
    h.apply.mockResolvedValue(
      result({ outcome: 'held', userId: 'u-1', message: 'Google offboarded the last active administrator here; held, not written.' }),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts.held).toBe(1);
    expect(res.items).toEqual([
      {
        outcome: 'SKIPPED',
        userId: 'u-1',
        googleId: '1',
        email: 'admin@example.test',
        fields: {},
        message: 'Google offboarded the last active administrator here; held, not written.',
      },
    ]);
    expect(h.manager).not.toHaveBeenCalled();
  });

  it('collects the people it offboarded, for the summary audit row', async () => {
    listing([g('1', 'a@example.test', { archived: true }), g('2', 'b@example.test')]);
    h.apply
      .mockResolvedValueOnce(result({ outcome: 'updated', userId: 'u-1', offboarded: true, changes: { employeeStatus: { from: 'ACTIVE', to: 'TERMINATED' } } }))
      .mockResolvedValueOnce(result({ userId: 'u-2' }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.offboarded).toEqual(['u-1']);
  });

  it('tallies level codes this tenant has no job level for, most common first', async () => {
    listing([g('1', 'a@example.test'), g('2', 'b@example.test'), g('3', 'c@example.test')]);
    h.apply
      .mockResolvedValueOnce(result({ userId: 'u-1', missingLevelCode: 'L5' }))
      .mockResolvedValueOnce(result({ userId: 'u-2', missingLevelCode: 'L7' }))
      .mockResolvedValueOnce(result({ userId: 'u-3', missingLevelCode: 'L7' }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.counts.missingJobLevels).toEqual([
      { code: 'L7', count: 2 },
      { code: 'L5', count: 1 },
    ]);
  });

  it('applies each person, and resolves each manager, on its own transaction', async () => {
    // One person's failure rolls back that person only.
    listing([g('1', 'a@example.test'), g('2', 'b@example.test')]);
    await syncAllFromDirectory(db, CREDS);
    // 1 for the source id, 2 applies, 2 managers.
    expect(transactions).toHaveBeenCalledTimes(5);
  });

  it('passes its clock to apply, so a test can fix the offboarding time', async () => {
    listing([g('1', 'a@example.test')]);
    const now = new Date('2026-10-21T02:30:00Z');
    await syncAllFromDirectory(db, CREDS, { now });
    expect(appliedOptions(0)).toMatchObject({ now });
  });
});
