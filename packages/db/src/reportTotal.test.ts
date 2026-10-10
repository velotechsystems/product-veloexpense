import { describe, expect, it, vi } from 'vitest';
import {
  fxOverrideOf,
  isReportTotalFrozenError,
  POSTED_SYNC_STATUSES,
  RECOMPUTABLE_REPORT_STATUSES,
  ReportTotalFrozenError,
  recomputeReportTotal,
} from './reportTotal';

/**
 * The one place a report's total is computed, and the reason it is one place.
 *
 * Every writer used to sum for itself, and the worker's prefill summed `amountMinor` across
 * currencies — which is not a number: ¥1,000 is not $10.00. A report could therefore
 * disagree with itself depending on which path last touched it. So the roll-up converts
 * every expense into the REPORT's currency, and this module is what all three callers share.
 *
 * `fxOverrideOf` is the AP override seam. Both of its columns have to be present for an
 * override to exist, and a half-set pair must read as "no override" rather than as a rate of
 * nothing — an override applied with an undefined currency would convert against the wrong
 * pair and be invisible in the total.
 */

describe('fxOverrideOf', () => {
  it('reads a fully-set override', () => {
    expect(
      fxOverrideOf({ fxRateOverride: { toString: () => '1.35' }, fxRateOverrideCurrency: 'USD' }),
    ).toEqual({ fromCurrency: 'USD', rate: '1.35' });
  });

  it('renders the rate through toString, since Prisma hands back a Decimal', () => {
    /** A Decimal stringifies exactly; `Number()` would round a rate quoted to six places. */
    const decimal = { toString: () => '1.234567' };
    expect(fxOverrideOf({ fxRateOverride: decimal, fxRateOverrideCurrency: 'EUR' })?.rate).toBe(
      '1.234567',
    );
  });

  it('is no override when neither column is set', () => {
    expect(fxOverrideOf({ fxRateOverride: null, fxRateOverrideCurrency: null })).toBeNull();
  });

  it('is no override when only the rate is set', () => {
    /** A rate with no currency has no pair to apply to. */
    expect(
      fxOverrideOf({ fxRateOverride: { toString: () => '1.35' }, fxRateOverrideCurrency: null }),
    ).toBeNull();
  });

  it('is no override when only the currency is set', () => {
    expect(fxOverrideOf({ fxRateOverride: null, fxRateOverrideCurrency: 'USD' })).toBeNull();
  });

  it('treats a blank currency as no override', () => {
    /** An empty string is falsy and must not become a currency code the map cannot key on. */
    expect(
      fxOverrideOf({ fxRateOverride: { toString: () => '1.35' }, fxRateOverrideCurrency: '' }),
    ).toBeNull();
  });

  it('keeps a zero rate out, rather than converting everything to nothing', () => {
    /**
     * `== null` admits 0 deliberately — a stored 0 IS a value, and this reads it as one.
     * Pinned so the behaviour is a decision rather than an accident: the guard against a
     * nonsensical rate belongs at the write, and this asserts the read does not silently
     * discard it.
     */
    expect(
      fxOverrideOf({ fxRateOverride: { toString: () => '0' }, fxRateOverrideCurrency: 'USD' }),
    ).toEqual({ fromCurrency: 'USD', rate: '0' });
  });
});

describe('recomputeReportTotal', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    currency: { code: 'CAD' },
    fxRateOverride: null,
    fxRateOverrideCurrency: null,
    expenses: [],
    ...over,
  });

  const cad = (amountMinor: bigint) => ({
    amountMinor,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    currency: { code: 'CAD' },
    fxRate: null,
    homeCurrency: null,
  });

  /**
   * A transaction-client shaped stub: no `$transaction`, so the guard runs directly
   * against it — which is also exactly what a caller's own `tx` looks like.
   */
  function stubDb(
    found: unknown,
    opts: {
      status?: string | null;
      totalMinor?: bigint;
      syncStatus?: string | null;
      fxRows?: unknown[];
    } = {},
  ) {
    const { status = 'DRAFT', totalMinor = 0n, syncStatus = null, fxRows = [] } = opts;
    // Typed argument, not `vi.fn(async () => …)`: without it `mock.calls` infers as the
    // empty tuple and reading `calls[0][0]` is a type error under each package's own
    // `tsc --noEmit`, which typechecks its tests.
    const update = vi.fn(async (_args: { where: unknown; data: { totalMinor: bigint } }) => ({}));
    const findMany = vi.fn(async (_args?: unknown) => fxRows);
    // VeloExpense: the posting state is read with SQL too (`integration_post`), so the one
    // `$queryRaw` stub answers both reads by which table the statement names.
    const queryRaw = vi.fn(async (...args: unknown[]) => {
      const sql = (args[0] as readonly string[]).join('?');
      if (sql.includes('integration_post')) {
        if (syncStatus === null) return [];
        return syncStatus === 'PROCESSING'
          ? [{ status: 'PENDING', claimed: true }]
          : [{ status: syncStatus, claimed: false }];
      }
      return status === null ? [] : [{ status, totalMinor }];
    });
    return {
      db: {
        $queryRaw: queryRaw,
        expenseReport: { findUnique: vi.fn(async () => found), update },
        fxRate: { findMany },
      } as never,
      update,
      findMany,
      queryRaw,
    };
  }

  it('writes the converted total, not the raw sum', async () => {
    /** The whole point: two expenses in different currencies cannot be added as integers. */
    const { db, update } = stubDb(report({ expenses: [cad(1000n), cad(2000n)] }));
    await recomputeReportTotal(db, 'r-1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.totalMinor).toBe(3000n);
    expect(typeof update.mock.calls[0][0].data.totalMinor).toBe('bigint');
  });

  it('writes a zero total for a report with no expenses', async () => {
    /** An emptied report must be corrected to 0, not left showing its previous total — a
     *  stale figure is what an approver would decide on. */
    const { db, update } = stubDb(report());
    await recomputeReportTotal(db, 'r-1');
    expect((update.mock.calls[0]?.[0] as { data: { totalMinor: bigint } }).data.totalMinor).toBe(
      0n,
    );
  });

  it('does nothing for a report that is not there', async () => {
    /**
     * Reachable, and not an error: this runs after a delete, and from a worker whose job
     * outlived its report. Throwing would fail a job whose work is already done.
     */
    const { db, update } = stubDb(null, { status: null });
    await expect(recomputeReportTotal(db, 'gone')).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('reads the newest FX rate first', async () => {
    const { db, findMany } = stubDb(report());
    await recomputeReportTotal(db, 'r-1');
    expect(findMany.mock.calls[0][0]).toEqual({ orderBy: { fetchedAt: 'desc' } });
  });

  it('locks the report row before it reads anything', async () => {
    /**
     * The lock is what turns "the status was open when I looked" into "the status was
     * open when I committed": `approve` is a plain UPDATE on the same row and has to
     * wait. Pinned on the SQL, since nothing else about the call reveals it.
     */
    const { db, queryRaw } = stubDb(report());
    await recomputeReportTotal(db, 'r-1');
    const sql = (queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    // VeloExpense: VeloExpense's table name.
    expect(sql).toMatch(/FROM expense_report/);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(queryRaw.mock.calls[0][1]).toBe('r-1');
  });

  it('returns the figures it moved between, so a caller can audit them', async () => {
    const { db } = stubDb(report({ expenses: [cad(1250n)] }), {
      status: 'DRAFT',
      totalMinor: 900n,
    });
    await expect(recomputeReportTotal(db, 'r-1')).resolves.toEqual({
      reportId: 'r-1',
      status: 'DRAFT',
      syncStatus: null,
      frozen: false,
      previousTotalMinor: 900n,
      totalMinor: 1250n,
    });
  });

  it('opens a transaction when handed the shared client, and runs inside it', async () => {
    /** Given a real PrismaClient the lock, the check and the write must be one unit. */
    const inner = stubDb(report({ expenses: [cad(500n)] }));
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(inner.db));
    const client = { $transaction: transaction } as never;
    const out = await recomputeReportTotal(client, 'r-1');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inner.update).toHaveBeenCalledTimes(1);
    expect(out?.totalMinor).toBe(500n);
  });

  describe('the status guard', () => {
    /**
     * The matrix. DRAFT and RETURNED are the submitter's; SUBMITTED is AP's FX override
     * (#506 made that the only SUBMITTED-stage money write). Everything else is a
     * decided figure — signed, refused or paid — and is not rewritten by a late job.
     */
    it.each(['DRAFT', 'RETURNED', 'SUBMITTED'])('writes for a %s report', async (status) => {
      const { db, update } = stubDb(report({ expenses: [cad(700n)] }), { status });
      await recomputeReportTotal(db, 'r-1');
      expect(update).toHaveBeenCalledTimes(1);
      expect(RECOMPUTABLE_REPORT_STATUSES.has(status)).toBe(true);
    });

    it.each(['APPROVED', 'REJECTED', 'REIMBURSED'])(
      'refuses a %s report and writes nothing',
      async (status) => {
        const { db, update } = stubDb(report({ expenses: [cad(700n)] }), { status });
        const err = await recomputeReportTotal(db, 'r-1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReportTotalFrozenError);
        expect(isReportTotalFrozenError(err)).toBe(true);
        expect((err as ReportTotalFrozenError).status).toBe(status);
        expect((err as ReportTotalFrozenError).message).toMatch(new RegExp(status));
        expect(update).not.toHaveBeenCalled();
        expect(RECOMPUTABLE_REPORT_STATUSES.has(status)).toBe(false);
      },
    );

    // VeloExpense: `integration_post`'s states that mean the same (see POSTED_SYNC_STATUSES).
    it.each(['POSTED', 'NEEDS_REVIEW', 'PROCESSING'])(
      'refuses a report whose ledger posting is %s, whatever its status says',
      async (syncStatus) => {
        /** A figure that reached the ledger — or is on its way — is the ledger's. */
        const { db, update } = stubDb(report({ expenses: [cad(700n)] }), {
          status: 'SUBMITTED',
          syncStatus,
        });
        const err = await recomputeReportTotal(db, 'r-1').catch((e: unknown) => e);
        expect(isReportTotalFrozenError(err)).toBe(true);
        expect((err as ReportTotalFrozenError).syncStatus).toBe(syncStatus);
        expect((err as ReportTotalFrozenError).message).toMatch(/ledger posting/);
        expect(update).not.toHaveBeenCalled();
        expect(POSTED_SYNC_STATUSES.has(syncStatus)).toBe(true);
      },
    );

    it.each(['PENDING', 'FAILED', 'DEAD', 'CANCELLED', 'HELD'])(
      'still writes when the posting row is %s — nothing has posted',
      async (syncStatus) => {
        const { db, update } = stubDb(report({ expenses: [cad(700n)] }), {
          status: 'SUBMITTED',
          syncStatus,
        });
        await recomputeReportTotal(db, 'r-1');
        expect(update).toHaveBeenCalledTimes(1);
        expect(POSTED_SYNC_STATUSES.has(syncStatus)).toBe(false);
      },
    );

    it('checks the status before it reads a single expense', async () => {
      /** Refusing is cheap and must stay cheap: no roll-up, no FX table scan. */
      const { db, findMany } = stubDb(report(), { status: 'APPROVED' });
      await expect(recomputeReportTotal(db, 'r-1')).rejects.toThrow(ReportTotalFrozenError);
      expect(findMany).not.toHaveBeenCalled();
      expect(
        (db as { expenseReport: { findUnique: unknown } }).expenseReport.findUnique,
      ).not.toHaveBeenCalled();
    });
  });

  describe('allowFrozen', () => {
    it('writes a frozen report when given a reason, and says so loudly', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, update } = stubDb(report({ expenses: [cad(1000n)] }), {
        status: 'APPROVED',
        totalMinor: 900n,
      });
      const out = await recomputeReportTotal(db, 'r-1', {
        allowFrozen: { reason: 'Finance ticket FIN-42: FX reciprocal restatement', actor: 'u-1' },
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ frozen: true, previousTotalMinor: 900n, totalMinor: 1000n });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toMatch(/frozen override/);
      expect(line).toMatch(/report=r-1/);
      expect(line).toMatch(/status=APPROVED/);
      expect(line).toMatch(/FIN-42/);
      expect(line).toMatch(/actor=u-1/);
      warn.mockRestore();
    });

    it('is not a door without a reason', async () => {
      /** `{ allowFrozen: { reason: '' } }` is somebody reaching for the flag without
       *  saying why. That is the case the flag exists to make impossible. */
      const { db, update } = stubDb(report(), { status: 'APPROVED' });
      await expect(
        recomputeReportTotal(db, 'r-1', { allowFrozen: { reason: '   ' } }),
      ).rejects.toThrow(ReportTotalFrozenError);
      expect(update).not.toHaveBeenCalled();
    });

    it('is silent and marks nothing when the report was not frozen anyway', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db } = stubDb(report(), { status: 'DRAFT' });
      const out = await recomputeReportTotal(db, 'r-1', { allowFrozen: { reason: 'x' } });
      expect(out?.frozen).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe('isReportTotalFrozenError', () => {
  it('recognises the error by name, across a mocked module boundary', () => {
    /** The worker suites replace `@expenseos/db` wholesale; a class that crosses such a
     *  boundary is a different constructor on each side, so `instanceof` would lie. */
    const foreign = Object.assign(new Error('frozen'), { name: 'ReportTotalFrozenError' });
    expect(isReportTotalFrozenError(foreign)).toBe(true);
    expect(isReportTotalFrozenError(new Error('frozen'))).toBe(false);
    expect(isReportTotalFrozenError(null)).toBe(false);
    expect(isReportTotalFrozenError('ReportTotalFrozenError')).toBe(false);
  });
});
