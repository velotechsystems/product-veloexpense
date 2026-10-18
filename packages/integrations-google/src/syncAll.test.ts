// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily Directory reconciliation.
 *
 * The properties worth pinning are all about RESILIENCE and REPORTING, because this runs
 * unattended over the whole org:
 *
 *   · **One bad user must not abort the sync.** With 703 people, a single malformed record
 *     aborting the pass means nobody gets reconciled that day — and the failure is a log
 *     line nobody reads.
 *   · **Paging must actually page.** Stopping after the first page silently syncs the first
 *     500 people alphabetically and leaves the rest stale forever.
 *   · **Unmapped job titles must be REPORTED, not swallowed.** A person with no job level
 *     is invisible to a `managerChain` tier walk, so enough of them in one chain routes a
 *     large report past everyone who should have seen it. The tally is how that gets
 *     noticed.
 *   · **Disabled is a status, not an error.** Dev has no service-account key; returning
 *     `error` there would make a normal configuration look broken every night.
 *
 * w5-04 — ported from ExpenseOS `syncAll.test.ts` (1e682dd6). VeloExpense: the credentials
 * are the tenant's and passed in (`null` = not connected = `disabled`); each person is applied
 * on its own `db.$transaction`; `created` is `notFound` (update only, d84), plus `held`,
 * `offboarded` and `missingJobLevels`; there is no GOOGLE_WORKSPACE_CUSTOMER_ID override. The
 * addresses are `example.test`.
 */

const listMock = vi.fn();
const applyMock = vi.fn();

class DisabledError extends Error {}
class ConfigError extends Error {}

vi.mock('./client', () => ({
  GoogleDirectoryDisabledError: DisabledError,
  GoogleDirectoryConfigError: ConfigError,
  isDirectoryDisabled: () => process.env.GOOGLE_DIRECTORY_DISABLED === 'true',
  getDirectoryClient: () => {
    if (process.env.__FAIL_INIT === 'config') throw new ConfigError('no service account');
    if (process.env.__FAIL_INIT === 'disabled') throw new DisabledError('off');
    if (process.env.__FAIL_INIT === 'boom') throw new Error('unexpected');
    return { users: { list: listMock } };
  },
}));

vi.mock('./apply', () => ({
  applyDirectoryUserToDb: (...args: unknown[]) => applyMock(...args),
}));

const { syncAllFromDirectory } = await import('./syncAll');

const user = (email: string, title?: string) => ({
  primaryEmail: email,
  ...(title ? { organizations: [{ primary: true, title }] } : {}),
});

const page = (users: unknown[], nextPageToken?: string) => ({
  data: { users, ...(nextPageToken ? { nextPageToken } : {}) },
});

// VeloExpense: each person runs on `db.$transaction`; the stub hands apply a dummy tx.
const transactions = vi.fn();
const db = {
  $transaction: async <T>(fn: (tx: never) => Promise<T>) => {
    transactions();
    return fn({} as never);
  },
};
const CREDS = { serviceAccountJson: '{}', impersonateEmail: 'admin@example.test' };
const updated = (userId = 'u', extra: Record<string, unknown> = {}) => ({
  outcome: 'updated',
  userId,
  offboarded: false,
  ...extra,
});

beforeEach(() => {
  listMock.mockReset();
  applyMock.mockReset();
  applyMock.mockResolvedValue(updated());
  transactions.mockReset();
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
  delete process.env.__FAIL_INIT;
});
afterEach(() => {
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
  delete process.env.__FAIL_INIT;
});

describe('syncAllFromDirectory — configuration', () => {
  it('returns `disabled` when directory sync is switched off', async () => {
    // This is dev's normal state. It must not read as a failure.
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toEqual({
      status: 'disabled',
      scanned: 0,
      updated: 0,
      notFound: 0,
      held: 0,
      offboarded: [],
      errors: 0,
      unmappedTitles: [],
      missingJobLevels: [],
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('VeloExpense: returns `disabled` for a tenant that has not connected', async () => {
    // A tenant that never turned the sync on is not a failure either.
    expect((await syncAllFromDirectory(db, null)).status).toBe('disabled');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns `disabled` when the client itself reports disabled', async () => {
    process.env.__FAIL_INIT = 'disabled';
    expect((await syncAllFromDirectory(db, CREDS)).status).toBe('disabled');
  });

  it('returns `error` with the config message when credentials are missing', async () => {
    // Distinguishable from `disabled`: somebody meant to enable this and it is misconfigured.
    process.env.__FAIL_INIT = 'config';
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.message).toContain('no service account');
  });

  it('returns `error` rather than throwing on an unexpected init failure', async () => {
    // The caller is a cron handler; a throw there is an unhandled rejection.
    process.env.__FAIL_INIT = 'boom';
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.message).toContain('init failed');
  });
});

describe('syncAllFromDirectory — paging', () => {
  it('follows nextPageToken to the end', async () => {
    listMock
      .mockResolvedValueOnce(page([user('a@example.test')], 'tok-2'))
      .mockResolvedValueOnce(page([user('b@example.test')]));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock.mock.calls[1][0]).toMatchObject({ pageToken: 'tok-2' });
    expect(res.scanned).toBe(2);
  });

  it('clamps the page size into the API range of 1..500', async () => {
    listMock.mockResolvedValue(page([]));
    await syncAllFromDirectory(db, CREDS, { pageSize: 9999 });
    expect(listMock.mock.calls[0][0]).toMatchObject({ maxResults: 500 });
    listMock.mockClear();
    await syncAllFromDirectory(db, CREDS, { pageSize: 0 });
    expect(listMock.mock.calls[0][0]).toMatchObject({ maxResults: 1 });
  });

  it('defaults the customer to my_customer, and honours an explicit one', async () => {
    // VeloExpense: no env override — `my_customer` is the impersonated admin's own Workspace,
    // which per tenant is the right one.
    listMock.mockResolvedValue(page([]));
    await syncAllFromDirectory(db, CREDS);
    expect(listMock.mock.calls[0][0]).toMatchObject({ customer: 'my_customer' });
    listMock.mockClear();
    await syncAllFromDirectory(db, CREDS, { customer: 'C0123' });
    expect(listMock.mock.calls[0][0]).toMatchObject({ customer: 'C0123' });
  });

  it('stops and reports partial counts when a page request fails', async () => {
    // Partial progress is real and must be reported honestly — claiming `completed` after
    // a failed page would hide that most of the org was never reconciled.
    listMock
      .mockResolvedValueOnce(page([user('a@example.test')], 'tok-2'))
      .mockRejectedValueOnce(new Error('429 rate limited'));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.scanned).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.message).toContain('429 rate limited');
  });

  it('handles a page with no users array at all', async () => {
    listMock.mockResolvedValue({ data: {} });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({ status: 'completed', scanned: 0 });
  });
});

describe('syncAllFromDirectory — per-user resilience', () => {
  it('counts not-found, held and updated separately, and names who was offboarded', async () => {
    // VeloExpense: ExpenseOS's `created` is `notFound` — update only (d84).
    listMock.mockResolvedValue(
      page([user('a@example.test'), user('b@example.test'), user('c@example.test'), user('d@example.test')]),
    );
    applyMock
      .mockResolvedValueOnce({ outcome: 'not-found' })
      .mockResolvedValueOnce(updated('u2'))
      .mockResolvedValueOnce(updated('u3', { offboarded: true }))
      .mockResolvedValueOnce({ outcome: 'held', userId: 'u4', reason: 'last-admin' });
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({
      status: 'completed',
      scanned: 4,
      notFound: 1,
      updated: 2,
      held: 1,
      offboarded: ['u3'],
    });
    // One transaction per person.
    expect(transactions).toHaveBeenCalledTimes(4);
  });

  it('keeps going after one user fails', async () => {
    /**
     * The whole point. One malformed record out of hundreds must cost one error, not the
     * night's reconciliation.
     */
    listMock.mockResolvedValue(page([user('a@example.test'), user('b@example.test'), user('c@example.test')]));
    applyMock
      .mockResolvedValueOnce(updated('u1'))
      .mockRejectedValueOnce(new Error('FK violation'))
      .mockResolvedValueOnce(updated('u3'));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({ status: 'completed', scanned: 3, updated: 2, errors: 1 });
  });

  it('counts a user with no email as an error without calling apply', async () => {
    listMock.mockResolvedValue(page([{ organizations: [] }]));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res).toMatchObject({ scanned: 1, errors: 1 });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('reports each outcome through onUser', async () => {
    listMock.mockResolvedValue(page([user('a@example.test'), user('b@example.test')]));
    applyMock
      .mockResolvedValueOnce({ outcome: 'not-found' })
      .mockRejectedValueOnce(new Error('nope'));
    const events: unknown[] = [];
    await syncAllFromDirectory(db, CREDS, { onUser: (e) => events.push(e) });
    expect(events).toEqual([
      { email: 'a@example.test', outcome: 'not-found' },
      { email: 'b@example.test', outcome: 'error', error: 'nope' },
    ]);
  });
});

describe('syncAllFromDirectory — unmapped job titles', () => {
  it('tallies unrecognised titles, most common first', async () => {
    /**
     * Not a log line: a person with no job level is invisible to a `managerChain` tier
     * walk, so this list is how a routing hole gets found before it routes a $100k report
     * past everyone.
     */
    // Titles chosen because `titleToJobLevelCode` genuinely does not recognise them. It
    // is more capable than it looks — "Chief Vibes Officer" maps to E4 via the
    // "Chief … Officer" rule and "Head of Snacks" to E1 via "Head of", so neither is an
    // example of an unmapped title.
    listMock.mockResolvedValue(
      page([
        user('a@example.test', 'Barista'),
        user('b@example.test', 'Barista'),
        user('c@example.test', 'Zebra Wrangler'),
      ]),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.unmappedTitles).toEqual([
      { title: 'Barista', count: 2 },
      { title: 'Zebra Wrangler', count: 1 },
    ]);
  });

  it('breaks a count tie alphabetically, so the report is stable', async () => {
    listMock.mockResolvedValue(
      page([user('a@example.test', 'Zebra Wrangler'), user('b@example.test', 'Aardvark Herder')]),
    );
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.unmappedTitles.map((t) => t.title)).toEqual(['Aardvark Herder', 'Zebra Wrangler']);
  });

  it('does not tally a title that DOES map', async () => {
    listMock.mockResolvedValue(page([user('a@example.test', 'Senior Engineer')]));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.unmappedTitles).toEqual([]);
  });

  it('reports the tally even when the sync fails part way', async () => {
    // The titles seen so far are still useful; discarding them on failure wastes the pass.
    listMock
      .mockResolvedValueOnce(page([user('a@example.test', 'Barista')], 'tok'))
      .mockRejectedValueOnce(new Error('boom'));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.status).toBe('error');
    expect(res.unmappedTitles).toEqual([{ title: 'Barista', count: 1 }]);
  });
});

describe('syncAllFromDirectory — job levels the tenant lacks (VeloExpense)', () => {
  it('tallies codes a title mapped to that this tenant has no level for', async () => {
    // A VeloExpense tenant builds its own ladder (0050), so a recognised title can still land
    // nowhere — and the person is just as invisible to a tier walk.
    listMock.mockResolvedValue(page([user('a@example.test'), user('b@example.test'), user('c@example.test')]));
    applyMock
      .mockResolvedValueOnce(updated('u1', { missingLevelCode: 'M3' }))
      .mockResolvedValueOnce(updated('u2', { missingLevelCode: 'M3' }))
      .mockResolvedValueOnce(updated('u3', { missingLevelCode: 'IC4' }));
    const res = await syncAllFromDirectory(db, CREDS);
    expect(res.missingJobLevels).toEqual([
      { code: 'M3', count: 2 },
      { code: 'IC4', count: 1 },
    ]);
  });
});
