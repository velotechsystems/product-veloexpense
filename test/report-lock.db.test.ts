/**
 * The report lock — a decided report cannot be changed by a transaction that
 * started before the decision.
 *
 * Own org slug ('lock-co'), like every other db suite in this project, because
 * they share one database.
 *
 * ── WHAT THIS IS ABOUT ─────────────────────────────────────────────────────
 *
 * Every path that changes a report checks its status first and writes second,
 * and until this suite the check was a plain SELECT. Under READ COMMITTED a plain
 * read takes no lock, so a check could pass against a status that another
 * transaction was in the middle of changing, and the write that followed landed
 * on a report that was no longer in the state the check saw:
 *
 *   · a line added while a submit was in flight landed on a SUBMITTED report,
 *     and its total was rewritten under the approver;
 *   · a submit whose policy pass ran while a line was being added validated the
 *     report WITHOUT that line, and submitted it with it;
 *   · a recall that waited behind an approval flipped the APPROVED report back
 *     to DRAFT — editable, with its posting already queued.
 *
 * ExpenseOS fixed the same family as #511 ("refuse to rewrite a decided report's
 * total") and #515 ("put the determination's writes under the report lock"):
 * lock the report row first, re-read the status under the lock, and make the
 * write itself refuse a status it should never see. That is the shape here.
 *
 * ── HOW THE RACE IS FORCED ─────────────────────────────────────────────────
 *
 * Same technique as `test/policy-concurrent-validate.db.test.ts` (#129): the FIRST
 * transaction does its whole job and stays open; the SECOND is started and not
 * awaited; `waitUntilBlocked` asks Postgres — not the promise — whether the
 * second is actually waiting on a lock before the first commits. A run in which
 * the second never blocked did not overlap anything and fails rather than
 * passing vacuously.
 *
 * w4-00c: the two transactions are the tenant's Prisma transactions (`holdOpen`,
 * `contend`), not raw clients, because a submit, a recall and a decision now start or
 * move ExpenseOS's approval engine, which runs on Prisma in the same transaction
 * (test/support/tenant-tx.ts). Each still commits only when told to, so the overlap is
 * the same one.
 *
 * WHICH lock the second transaction waits on is recorded, not required. Before
 * the fix it is often the audit chain's per-org advisory lock (`lib/audit/chain.ts`)
 * — `addLineItem` checks, inserts the line, and only then queues for the chain, so
 * by the time it waits the damage is already decided. After the fix it is the
 * report row, at the check. Either way the assertion that matters is the OUTCOME:
 * a refusal is only possible if the check itself waited for the first commit.
 * (The first draft of this suite rejected advisory waits as "not testing the
 * report lock", and that rejection is what showed where `addLineItem` queues.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
// w4-00c: the lifecycle starts the approval engine, which needs the tenant's Prisma
// transaction (test/support/tenant-tx.ts) — the same `QueryRunner`, under the same name.
import { seedDefaultFlow, withTenantTx as withOrg } from './support/tenant-tx';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as policy from '@/lib/policy/service';
import { decideThroughEngine } from '@/server/lib/reportLifecycle';
import type { QueryRunner } from '@/lib/db/client';
import type { TenantDb } from '@/lib/db/prisma';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let categoryId: string;
let submitterId: string;
let managerId: string;
const SUBMITTER = 'sub@lock.test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Work<T> = (tx: QueryRunner, db: TenantDb) => Promise<T>;

/**
 * w4-00c: the FIRST transaction — the tenant's, under RLS as the app is. It does `work`, then
 * stays OPEN, holding whatever `work` locked, until `release()`; `committed` settles at COMMIT.
 */
function holdOpen<T>(work: Work<T>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: (v: T) => void;
  let failed!: (e: unknown) => void;
  const done = new Promise<T>((res, rej) => {
    ready = res;
    failed = rej;
  });
  const committed = withOrg(orgId, async (tx, db) => {
    try {
      ready(await work(tx, db));
    } catch (e) {
      failed(e);
      throw e;
    }
    await gate;
  }).catch(() => {});
  return { done, release, committed };
}

/**
 * w4-00c: the SECOND transaction. It reports its backend pid first, so `waitUntilBlocked` can
 * watch it, then runs `work`; `result` settles once it has COMMITTED (`ok`) or rolled back on
 * the error `work` threw.
 */
function contend<T>(work: Work<T>) {
  let tell!: (pid: number) => void;
  const pid = new Promise<number>((r) => (tell = r));
  const result = outcome(
    withOrg(orgId, async (tx, db) => {
      tell((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number);
      return work(tx, db);
    }),
  );
  return { pid, result };
}

/**
 * Resolves (with the lock type) once `pid` is waiting on a lock; throws if
 * `second` settles first — it never overlapped, so the run proves nothing.
 */
async function waitUntilBlocked(
  pid: number,
  second: Promise<unknown>,
  label: string,
): Promise<string> {
  let settled = false;
  void second.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const deadline = Date.now() + 3000;
  for (;;) {
    const r = await admin.query(
      `SELECT a.wait_event_type, a.wait_event, l.locktype
         FROM pg_stat_activity a
         LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
        WHERE a.pid = $1`,
      [pid],
    );
    const row = r.rows[0] as
      | { wait_event_type: string | null; wait_event: string | null; locktype: string | null }
      | undefined;
    if (row?.wait_event_type === 'Lock') return row.locktype ?? 'unknown';
    if (settled) {
      throw new Error(
        `${label}: the second transaction completed without ever blocking — it did not ` +
          'overlap the first, so this run proves nothing about the race.',
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: the second transaction never blocked within 3s.`);
    }
    await sleep(25);
  }
}

/** Settle a promise into a value or the error it threw, for asserting after COMMIT. */
async function outcome<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

async function draft(amountMinor = 10_00): Promise<{ reportId: string; expenseId: string }> {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, { title: 'Lock', currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return { reportId: report.id as string, expenseId: expense.id as string };
  });
}

async function reportState(reportId: string) {
  const r = await admin.query(
    `SELECT rep.status, rep.total_minor::text AS total,
            (SELECT count(*)::int FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
              WHERE e.report_id = rep.id) AS lines
       FROM expense_report rep WHERE rep.id = $1`,
    [reportId],
  );
  return r.rows[0] as { status: string; total: string; lines: number };
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('lock-co','Lock Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  // w4-00c: the default approval flow a provisioned tenant starts with (d54); without it a
  // submit is refused (d58).
  await seedDefaultFlow(orgId);
  await withOrg(orgId, async (tx) => {
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@lock.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    managerId = m.rows[0].id;
    const s = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id)
       VALUES ($1,$2,'Sub',$3) RETURNING id`,
      [orgId, SUBMITTER, managerId],
    );
    submitterId = s.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM expense_policy WHERE organization_id = $1', [orgId]);
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('a submit and an edit of the same report, overlapping', () => {
  it('an edit that waits behind a submit is REFUSED, and the submitted report is untouched', async () => {
    const { reportId, expenseId } = await draft();
    const before = await reportState(reportId);

    const a = holdOpen((tx) => lifecycle.submitReport(tx, reportId, submitterId));
    await a.done;
    const b = contend((tx) =>
      expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 99_00 }),
    );
    const waitedOn = await waitUntilBlocked(await b.pid, b.result, 'edit behind submit');
    // At the CHECK, on the report row — not at the end, on the audit chain.
    expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
    a.release();
    await a.committed;

    const result = await b.result;
    expect(result.ok, 'the edit landed on a report that was submitted while it waited').toBe(false);
    expect((result as { error: { code?: string } }).error.code).toBe('NOT_DRAFT');
    expect(await reportState(reportId)).toEqual({ ...before, status: 'SUBMITTED' });
  });

  it("a submit that waits behind an edit validates the report WITH that edit's line", async () => {
    // A BLOCK rule the existing line is under and the incoming line is over.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: 50_00 },
      }),
    );
    const { reportId, expenseId } = await draft(10_00);

    const a = holdOpen((tx) =>
      expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 75_00 }),
    );
    await a.done;
    const b = contend((tx) => lifecycle.submitReport(tx, reportId, submitterId));
    const waitedOn = await waitUntilBlocked(await b.pid, b.result, 'submit behind edit');
    // At the CHECK, on the report row — not at the end, on the audit chain.
    expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
    a.release();
    await a.committed;

    const result = await b.result;
    expect(
      result.ok,
      'the submit went through having validated the report without the over-limit line',
    ).toBe(false);
    expect((result as { error: { code?: string } }).error.code).toBe('BLOCKED_BY_POLICY');
    expect((await reportState(reportId)).status).toBe('DRAFT');
  });
});

/** w4-00c: the report's pending engine task. */
async function pendingTask(reportId: string): Promise<string[]> {
  const task = await admin.query(
    `SELECT t.id FROM approval_instance_task t JOIN approval_instance i ON i.id = t.instance_id
      WHERE i.subject_id = $1 AND t.status = 'PENDING'`,
    [reportId],
  );
  return task.rows.map((r) => r.id as string);
}

describe('an approval and a recall of the same report, overlapping', () => {
  it('a recall that waits behind an approval is REFUSED, and the report stays APPROVED', async () => {
    const { reportId } = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
    const tasks = await pendingTask(reportId);
    expect(tasks).toHaveLength(1);

    const a = holdOpen((_tx, db) =>
      decideThroughEngine(db, {
        taskId: tasks[0],
        actorId: managerId,
        approve: true,
        note: null,
        mayOverride: false,
      }),
    );
    await a.done;
    const b = contend((tx) => lifecycle.recallReport(tx, reportId, submitterId, 'changed my mind'));
    const waitedOn = await waitUntilBlocked(await b.pid, b.result, 'recall behind approval');
    // At the CHECK, on the report row — not at the end, on the audit chain.
    expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
    a.release();
    await a.committed;

    const result = await b.result;
    expect(result.ok, 'the recall put an APPROVED report back into DRAFT').toBe(false);
    expect((result as { error: { code?: string } }).error.code).toBe('WRONG_STATUS');
    expect((await reportState(reportId)).status).toBe('APPROVED');
  });
});

describe('the other ordering, and the last write', () => {
  it('a decision that waits behind a recall is refused, and the report stays DRAFT', async () => {
    // Pinned for completeness, and said plainly: this one PASSED before the fix
    // too. The task claim (`UPDATE … AND status = 'PENDING'`) already refused a
    // decision on a task the recall had cancelled. Removing the report lock does
    // not fail it. That lock is there for the ORDER — report row, then tasks —
    // which the recall and the decision used to take in opposite directions; a
    // deadlock needs a timing this suite cannot force deterministically, so it is
    // argued in the code, not proven here.
    // w4-00c: the decision now waits at the lock in `decideThroughEngine`, and is refused
    // there, under the lock, as withdrawn (the recall SKIPPED its task).
    const { reportId } = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
    const tasks = await pendingTask(reportId);

    const a = holdOpen((tx) => lifecycle.recallReport(tx, reportId, submitterId, 'one more receipt'));
    await a.done;
    const b = contend((_tx, db) =>
      decideThroughEngine(db, {
        taskId: tasks[0],
        actorId: managerId,
        approve: true,
        note: null,
        mayOverride: false,
      }),
    );
    await waitUntilBlocked(await b.pid, b.result, 'approval behind recall');
    a.release();
    await a.committed;

    const result = await b.result;
    expect(result.ok, 'a cancelled task was decided').toBe(false);
    expect((result as { error: { code?: string } }).error.code).toBe('TASK_NOT_FOUND');
    expect((await reportState(reportId)).status).toBe('DRAFT');
  });

  it('the total WRITE refuses a report that is not a DRAFT, whoever calls it', async () => {
    // Every caller of `recomputeReportTotal` passes `assertDraft` first, so no
    // product path reaches this today. It is the last write on every edit path,
    // and the one place a guard covers a caller written tomorrow without the gate
    // — ExpenseOS #511's argument. Called directly here, as that caller would.
    const { reportId } = await draft(10_00);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
    // Change the lines underneath, so a recompute WOULD move the figure.
    await admin.query(
      `UPDATE expense_line_item SET amount_minor = 9900
        WHERE expense_id IN (SELECT id FROM expense WHERE report_id = $1)`,
      [reportId],
    );

    const err = await withOrg(orgId, (tx) => expenses.recomputeReportTotal(tx, reportId)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('NOT_DRAFT');
    expect((await reportState(reportId)).total).toBe('1000');
  });
});
