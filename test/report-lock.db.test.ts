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
 * Same technique as `test/policy-concurrent-validate.db.test.ts` (#129): raw
 * clients, because `withOrg` commits and so cannot express an overlap. The FIRST
 * transaction does its whole job and stays open; the SECOND is started and not
 * awaited; `waitUntilBlocked` asks Postgres — not the promise — whether the
 * second is actually waiting on a lock before the first commits. A run in which
 * the second never blocked did not overlap anything and fails rather than
 * passing vacuously.
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
import { Pool, type PoolClient } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as policy from '@/lib/policy/service';
import { decide } from '@/lib/approvals/engine';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});
/** The app role, so the clients below are under RLS exactly as the app is. */
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let orgId: string;
let categoryId: string;
let submitterId: string;
let managerId: string;
const SUBMITTER = 'sub@lock.test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A client already inside a transaction, scoped to the tenant. */
async function begin(): Promise<PoolClient> {
  const client = await app.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
  return client;
}

async function pidOf(client: PoolClient): Promise<number> {
  return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
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

/**
 * ROLLBACK both, A first (it may be what B is waiting on), then release. A
 * client returned to the pool mid-transaction poisons every later test that
 * draws it — the first run of this suite timed out three tests that way.
 */
async function closeBoth(a: PoolClient, b: PoolClient) {
  await a.query('ROLLBACK').catch(() => {});
  await b.query('ROLLBACK').catch(() => {});
  a.release();
  b.release();
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
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
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
  await app.end();
  await admin.end();
});

describe('a submit and an edit of the same report, overlapping', () => {
  it('an edit that waits behind a submit is REFUSED, and the submitted report is untouched', async () => {
    const { reportId, expenseId } = await draft();
    const before = await reportState(reportId);

    const a = await begin();
    const b = await begin();
    const bPid = await pidOf(b);
    try {
      await lifecycle.submitReport(a, reportId, submitterId);

      const edit = outcome(
        expenses.addLineItem(b, TEST_ACTOR, expenseId, { categoryId, amountMinor: 99_00 }),
      );
      const waitedOn = await waitUntilBlocked(bPid, edit, 'edit behind submit');
      // At the CHECK, on the report row — not at the end, on the audit chain.
      expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
      await a.query('COMMIT');

      const result = await edit;
      if (result.ok) await b.query('COMMIT');
      else await b.query('ROLLBACK');

      expect(result.ok, 'the edit landed on a report that was submitted while it waited').toBe(false);
      expect((result as { error: { code?: string } }).error.code).toBe('NOT_DRAFT');
      expect(await reportState(reportId)).toEqual({ ...before, status: 'SUBMITTED' });
    } finally {
      await closeBoth(a, b);
    }
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

    const a = await begin();
    const b = await begin();
    const bPid = await pidOf(b);
    try {
      await expenses.addLineItem(a, TEST_ACTOR, expenseId, { categoryId, amountMinor: 75_00 });

      const submit = outcome(lifecycle.submitReport(b, reportId, submitterId));
      const waitedOn = await waitUntilBlocked(bPid, submit, 'submit behind edit');
      // At the CHECK, on the report row — not at the end, on the audit chain.
      expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
      await a.query('COMMIT');

      const result = await submit;
      if (result.ok) await b.query('COMMIT');
      else await b.query('ROLLBACK');

      expect(
        result.ok,
        'the submit went through having validated the report without the over-limit line',
      ).toBe(false);
      expect((result as { error: { code?: string } }).error.code).toBe('BLOCKED_BY_POLICY');
      expect((await reportState(reportId)).status).toBe('DRAFT');
    } finally {
      await closeBoth(a, b);
    }
  });
});

describe('an approval and a recall of the same report, overlapping', () => {
  it('a recall that waits behind an approval is REFUSED, and the report stays APPROVED', async () => {
    const { reportId } = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
    const task = await admin.query(
      `SELECT t.id FROM approval_task t JOIN approval_request q ON q.id = t.request_id
        WHERE q.report_id = $1 AND t.status = 'PENDING'`,
      [reportId],
    );
    expect(task.rows).toHaveLength(1);

    const a = await begin();
    const b = await begin();
    const bPid = await pidOf(b);
    try {
      await decide(a, task.rows[0].id as string, managerId, 'APPROVED', {
        receiptViewAcknowledged: true,
      });

      const recall = outcome(lifecycle.recallReport(b, reportId, submitterId, 'changed my mind'));
      const waitedOn = await waitUntilBlocked(bPid, recall, 'recall behind approval');
      // At the CHECK, on the report row — not at the end, on the audit chain.
      expect(waitedOn, 'the second transaction did not wait at its status check').not.toBe('advisory');
      await a.query('COMMIT');

      const result = await recall;
      if (result.ok) await b.query('COMMIT');
      else await b.query('ROLLBACK');

      expect(result.ok, 'the recall put an APPROVED report back into DRAFT').toBe(false);
      expect((result as { error: { code?: string } }).error.code).toBe('WRONG_STATUS');
      expect((await reportState(reportId)).status).toBe('APPROVED');
    } finally {
      await closeBoth(a, b);
    }
  });
});

describe('the other ordering, and the last write', () => {
  it('a decision that waits behind a recall is refused, and the report stays DRAFT', async () => {
    // Pinned for completeness, and said plainly: this one PASSED before the fix
    // too. The task claim (`UPDATE approval_task … AND status = 'PENDING'`)
    // already refused a decision on a task the recall had cancelled. Removing
    // the engine's report lock does not fail it. That lock is there for the
    // ORDER — report row, then tasks — which the recall and the decision used to
    // take in opposite directions; a deadlock needs a timing this suite cannot
    // force deterministically, so it is argued in the code, not proven here.
    const { reportId } = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, submitterId));
    const task = await admin.query(
      `SELECT t.id FROM approval_task t JOIN approval_request q ON q.id = t.request_id
        WHERE q.report_id = $1 AND t.status = 'PENDING'`,
      [reportId],
    );

    const a = await begin();
    const b = await begin();
    const bPid = await pidOf(b);
    try {
      await lifecycle.recallReport(a, reportId, submitterId, 'one more receipt');

      const approve = outcome(
        decide(b, task.rows[0].id as string, managerId, 'APPROVED', { receiptViewAcknowledged: true }),
      );
      await waitUntilBlocked(bPid, approve, 'approval behind recall');
      await a.query('COMMIT');

      const result = await approve;
      if (result.ok) await b.query('COMMIT');
      else await b.query('ROLLBACK');

      expect(result.ok, 'a cancelled task was decided').toBe(false);
      expect((await reportState(reportId)).status).toBe('DRAFT');
    } finally {
      await closeBoth(a, b);
    }
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
