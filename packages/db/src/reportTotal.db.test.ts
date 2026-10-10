// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The status guard on `recomputeReportTotal`, against a real Postgres.
 *
 * The unit suite pins the matrix; this one pins the two things a stub cannot show:
 * that the enum values the guard names are the enum values the schema has, and that
 * the `FOR UPDATE` actually serialises against a concurrent approval — in BOTH orders.
 * A guard that reads the status without the lock passes every unit test and still
 * lets `approve` land between the check and the write.
 *
 * VeloExpense: the cases are ExpenseOS's; the harness is VeloExpense's. There is no shared
 * client outside a tenant here — every query runs in a tenant transaction
 * (`withTenantDb`) — so `run(fn)` opens one, and each place ExpenseOS uses its shared
 * client to start an independent transaction (`db.$transaction`, a bare
 * `db.expenseReport.update`) opens its own. The NetSuite satellite is VeloExpense's
 * `integration_post`, in its own states (see POSTED_SYNC_STATUSES).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 'pending' if `p` has not settled within `ms`, else its outcome. */
async function settledWithin(p: Promise<unknown>, ms: number) {
  return Promise.race([
    p.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    sleep(ms).then(() => 'pending' as const),
  ]);
}

describe.skipIf(!process.env.DATABASE_URL)('recomputeReportTotal status guard (db)', () => {
  /** VeloExpense: one tenant transaction per call (see the header). */
  let run: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  let admin: import('pg').Pool;
  let orgId: string;
  let recomputeReportTotal: typeof import('./reportTotal').recomputeReportTotal;
  let isReportTotalFrozenError: typeof import('./reportTotal').isReportTotalFrozenError;
  let userId: string;
  let currencyId: string;

  /** A report with one CAD 10.00 line and a deliberately wrong stored total. */
  async function reportIn(status: string, totalMinor = 999n): Promise<string> {
    return run(async (db) => {
      const r = await db.expenseReport.create({
        data: {
          title: `total-guard ${status} ${Date.now()}`,
          submitterId: userId,
          currencyId,
          // VeloExpense: a REIMBURSED report must carry its payment stamp (a CHECK), which
          // the Prisma view does not describe — so it is created APPROVED and stamped below.
          status: status === 'REIMBURSED' ? 'APPROVED' : status,
          totalMinor,
        },
        select: { id: true },
      });
      await db.expense.create({
        data: { reportId: r.id, ownerId: userId, currencyId, date: new Date(), amountMinor: 1000n },
        select: { id: true },
      });
      return r.id;
    }).then(async (id) => {
      if (status === 'REIMBURSED') {
        await admin.query(
          `UPDATE expense_report SET status = 'REIMBURSED', reimbursed_at = now(), reimbursed_by_id = submitter_id WHERE id = $1`,
          [id],
        );
      }
      return id;
    });
  }

  const totalOf = async (id: string) =>
    run(async (db) => (await db.expenseReport.findUniqueOrThrow({ where: { id }, select: { totalMinor: true } }))
      .totalMinor as bigint);

  /** VeloExpense: a ledger-posting row for the report, in `integration_post`'s states. */
  const postingIn = async (reportId: string, status: string, claimed = false) => {
    await admin.query(
      `INSERT INTO integration_post (organization_id, report_id, status, idempotency_key, claimed_at, posted_at, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        reportId,
        status,
        `total-guard-${reportId}`,
        claimed ? new Date() : null,
        status === 'POSTED' ? new Date() : null,
        status === 'POSTED' ? '12345' : null,
      ],
    );
  };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    const { withTenantDb } = await import('@/lib/db/prisma');
    ({ recomputeReportTotal, isReportTotalFrozenError } = await import('./reportTotal'));
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    orgId = (await admin.query(`INSERT INTO organization (slug, name) VALUES ('total-guard', 'Total Guard') RETURNING id`))
      .rows[0].id;
    userId = (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name) VALUES ($1, 'sub@total-guard.test', 'Sub') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    run = (fn) => withTenantDb(orgId, fn);
    // VeloExpense: a currency is keyed by its code.
    currencyId = 'CAD';
  });

  afterAll(async () => {
    await admin.end();
  });

  it.each(['DRAFT', 'RETURNED', 'SUBMITTED'])('rewrites the total of a %s report', async (s) => {
    const id = await reportIn(s);
    const out = await run((db) => recomputeReportTotal(db, id));
    expect(out).toMatchObject({ status: s, frozen: false, previousTotalMinor: 999n });
    expect(await totalOf(id)).toBe(1000n);
  });

  it.each(['APPROVED', 'REJECTED', 'REIMBURSED'])(
    'refuses a %s report and leaves the stored figure alone',
    async (s) => {
      const id = await reportIn(s);
      const err = await run((db) => recomputeReportTotal(db, id)).catch((e: unknown) => e);
      expect(isReportTotalFrozenError(err)).toBe(true);
      expect(await totalOf(id)).toBe(999n);
    },
  );

  it('refuses a report the ledger already holds, even while its status is still open', async () => {
    /** The satellite is the ledger's word; the status column is ours. The ledger wins. */
    const id = await reportIn('SUBMITTED');
    await postingIn(id, 'POSTED');
    const err = await run((db) => recomputeReportTotal(db, id)).catch((e: unknown) => e);
    expect(isReportTotalFrozenError(err)).toBe(true);
    expect((err as { syncStatus: string | null }).syncStatus).toBe('POSTED');
    expect(await totalOf(id)).toBe(999n);
  });

  // VeloExpense: a claimed PENDING row is the payload in flight — ExpenseOS's PROCESSING.
  it('refuses a report whose posting a worker has claimed', async () => {
    const id = await reportIn('SUBMITTED');
    await postingIn(id, 'PENDING', true);
    const err = await run((db) => recomputeReportTotal(db, id)).catch((e: unknown) => e);
    expect((err as { syncStatus: string | null }).syncStatus).toBe('PROCESSING');
    expect(await totalOf(id)).toBe(999n);
  });

  it('writes a queued-but-unposted report — PENDING has not reached the ledger', async () => {
    const id = await reportIn('SUBMITTED');
    await postingIn(id, 'PENDING');
    await run((db) => recomputeReportTotal(db, id));
    expect(await totalOf(id)).toBe(1000n);
  });

  it('runs inside a transaction the caller already holds', async () => {
    const id = await reportIn('DRAFT');
    const out = await run(async (tx: any) => recomputeReportTotal(tx, id));
    expect(out?.totalMinor).toBe(1000n);
    expect(await totalOf(id)).toBe(1000n);
  });

  it('restates a frozen report only through allowFrozen, and reports what it did', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await reportIn('APPROVED');
    const out = await run((db) => recomputeReportTotal(db, id, {
      allowFrozen: { reason: 'db-test: Finance-approved restatement', actor: 'test' },
    }));
    expect(out).toMatchObject({ frozen: true, previousTotalMinor: 999n, totalMinor: 1000n });
    expect(await totalOf(id)).toBe(1000n);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  describe('against a concurrent approval', () => {
    it('waits for an in-flight approval and then refuses — never writes under it', async () => {
      /**
       * Order 1: the approval holds the row when the recompute arrives. Without the
       * lock the recompute would read SUBMITTED (READ COMMITTED never shows the
       * uncommitted UPDATE), write, and the approval would commit over a total the
       * approver never saw. With it, the recompute blocks, then sees APPROVED.
       */
      const id = await reportIn('SUBMITTED');
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const approval = run(async (tx: any) => {
        // VeloExpense: VeloExpense's table name.
        await tx.$queryRaw`SELECT id FROM expense_report WHERE id = ${id}::uuid FOR UPDATE`;
        await held;
        await tx.expenseReport.update({ where: { id }, data: { status: 'APPROVED' } });
      });
      // Give the approval time to take the lock before the recompute asks for it.
      await sleep(100);
      const recompute = run((db) => recomputeReportTotal(db, id));
      expect(await settledWithin(recompute, 400)).toBe('pending');
      release();
      await approval;
      const err = await recompute.catch((e: unknown) => e);
      expect(isReportTotalFrozenError(err)).toBe(true);
      expect((err as { status: string }).status).toBe('APPROVED');
      expect(await totalOf(id)).toBe(999n);
    });

    it('makes an approval wait for a recompute in progress, so it decides on the new total', async () => {
      /**
       * Order 2: the recompute holds the row. The approval's plain UPDATE queues behind
       * it, lands after the commit, and the record the approval closed is the one with
       * the recomputed figure — the two never interleave.
       */
      const id = await reportIn('SUBMITTED');
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const recompute = run(async (tx: any) => {
        const out = await recomputeReportTotal(tx, id);
        await held;
        return out;
      });
      await sleep(100);
      const approval = run((db) =>
        db.expenseReport.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } }),
      );
      expect(await settledWithin(approval, 400)).toBe('pending');
      release();
      const out = await recompute;
      await approval;
      expect(out?.totalMinor).toBe(1000n);
      const row = await run((db) =>
        db.expenseReport.findUniqueOrThrow({
          where: { id },
          select: { status: true, totalMinor: true },
        }),
      );
      expect(row).toEqual({ status: 'APPROVED', totalMinor: 1000n });
    });
  });
});
