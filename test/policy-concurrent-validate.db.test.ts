/**
 * Two validations of one report, at the same time.
 *
 * Own org slug ('race-co'), like every other db suite in this project, because
 * they share one database.
 *
 * ── WHAT THIS IS ABOUT ─────────────────────────────────────────────────────
 *
 * `validateReport` is read-then-write: it SELECTs the report's existing
 * violations, then deletes, updates and inserts to match. Nothing locks the
 * report. Two validations — two browser tabs, or an autosave racing a manual
 * save — both read the same `existing` set, both find the same finding missing,
 * and both insert it.
 *
 * `policy_violation_identity_idx` (0006) means the duplicate ROW was never
 * possible, which is why this was not a data defect. What happened instead is
 * that the loser took a 23505 and its whole transaction aborted: a person saw a
 * failed save on a legitimate action, with nothing to tell them why.
 *
 * Found by reading ExpenseOS upstream review 3 — they hit the same race and
 * fixed it by serializing per report. We did not need to, having the index they
 * lacked; the insert only had to become idempotent under it.
 *
 * ── WHY THIS TEST LOOKS THE WAY IT DOES ────────────────────────────────────
 *
 * `withOrg` opens and commits a transaction, so it cannot express an overlap.
 * These take raw clients instead — `QueryRunner` is `Pick<PoolClient,'query'>`,
 * so a client IS one — and drive the real service on both.
 *
 * The interleave has to be in this order or it deadlocks the test rather than
 * testing anything: B's insert BLOCKS on A's uncommitted row until A commits, so
 * B's promise is started and deliberately not awaited until after A has
 * committed. The `sleep` is what makes B reach the insert first; without it the
 * test can pass by simply running the two in sequence, which proves nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as policy from '@/lib/policy/service';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});
/** The app role, so the clients below are under RLS exactly as the app is. */
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let orgId: string;
let mealsId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A client already inside a transaction, scoped to the tenant. */
async function begin(): Promise<PoolClient> {
  const client = await app.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
  return client;
}

/**
 * THE GUARD THAT MAKES THE INTERLEAVE A FACT RATHER THAN A HOPE.
 *
 * The overlap depends on B reaching its INSERT and blocking on A's uncommitted
 * row before A commits. A sleep is what gives it time to get there — and on a
 * slow runner it may not, in which case A commits first, B's SELECT sees a
 * COMMITTED row, B takes the UPDATE path, and the test PASSES WITHOUT TESTING
 * ANYTHING. Failing open: green whether or not the thing happened, which is the
 * exact defect shape this suite exists to catch.
 *
 * ── AND WHY THIS ASKS POSTGRES RATHER THAN THE PROMISE ────────────────────
 *
 * The first version of this guard asserted that B's promise was still PENDING,
 * and that is not the same question. A promise that has not settled is equally
 * consistent with "blocked on the lock" (what we want) and "has not reached the
 * insert yet" (the vacuous case) — so the check passed in precisely the
 * situation it was written to catch. A weaker instrument for the same blind
 * spot.
 *
 * `pg_stat_activity.wait_event_type = 'Lock'` is the fact itself: that backend
 * is waiting on a lock, right now. Nothing else answers it.
 */
async function waitUntilBlocked(
  admin: Pool,
  pid: number,
  second: Promise<unknown>,
  label: string,
): Promise<void> {
  /* `state = 'idle in transaction'` is NOT the finished signal, and an earlier
   * version of this used it and failed immediately: that is simply the backend's
   * state BETWEEN statements, which a client issuing queries one at a time is in
   * constantly. What distinguishes the vacuous run is the PROMISE settling before
   * a lock wait is ever observed. */
  let settled = false;
  void second.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  const deadline = Date.now() + 3000;
  for (;;) {
    const r = await admin.query(
      'SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    const row = r.rows[0] as { wait_event_type: string | null; state: string } | undefined;
    if (row?.wait_event_type === 'Lock') return;
    if (settled) {
      throw new Error(
        `${label}: the second validation completed without ever blocking — it did not overlap ` +
          'the first, so this run proves nothing about the race.',
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: the second validation never blocked within 3s (last wait_event_type: ` +
          `${row?.wait_event_type ?? 'none'}, state: ${row?.state ?? 'gone'}).`,
      );
    }
    await sleep(25);
  }
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('race-co','Race Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    await tx.query(
      "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'r@race.test','R')",
      [orgId],
    );
    const meals = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    mealsId = meals.rows[0].id;
    await policy.createPolicy(tx, {
      kind: 'PER_TRANSACTION_LIMIT',
      severity: 'WARNING',
      params: { thresholdMinor: 50_00 },
    });
  });
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

/** A report with one line over the limit, so validation has something to insert. */
async function draftOverLimit(): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, 'r@race.test', {
      title: 'Race subject',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'Race Merchant',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, {
      categoryId: mealsId,
      amountMinor: 75_00,
    });
    return report.id as string;
  });
}

async function violationCount(reportId: string): Promise<number> {
  const r = await admin.query('SELECT count(*)::int AS n FROM policy_violation WHERE report_id = $1', [
    reportId,
  ]);
  return r.rows[0].n as number;
}

describe('two validations of the same report, overlapping', () => {
  it('both succeed, and leave exactly one violation', async () => {
    const reportId = await draftOverLimit();

    const a = await begin();
    const b = await begin();
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    try {
      // A validates and holds its transaction open.
      const first = await policy.validateReport(a, reportId);
      expect(first.violations).toHaveLength(1);

      // B validates against the same pre-insert snapshot. Started, NOT awaited:
      // its insert blocks on A's uncommitted row.
      const second = policy.validateReport(b, reportId);
      await waitUntilBlocked(admin, bPid, second, 'both succeed');

      await a.query('COMMIT');
      // B now unblocks. Before the ON CONFLICT clause this rejected with 23505
      // and B's whole transaction was aborted.
      await expect(second).resolves.toBeTruthy();
      await b.query('COMMIT');
    } finally {
      /* ROLLBACK BEFORE RELEASE. node-pg does not reset a connection on release,
       * so a client returned mid-transaction goes back into the pool still
       * holding its locks. An earlier version of this file released without
       * rolling back; the moment an assertion threw, the next test blocked on the
       * abandoned lock and failed as a 5s timeout — a failure that looks nothing
       * like its cause. `.catch()` because the transaction may already be gone. */
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }

    expect(await violationCount(reportId)).toBe(1);
  });

  it('the surviving row is intact, not a half-written one', async () => {
    // The conflict path takes DO UPDATE, so it must leave the same row a single
    // validation would have. A test that only counted rows would pass against an
    // insert that wrote nulls over the message.
    const reportId = await draftOverLimit();

    const a = await begin();
    const b = await begin();
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    try {
      await policy.validateReport(a, reportId);
      const second = policy.validateReport(b, reportId);
      await waitUntilBlocked(admin, bPid, second, 'row is intact');
      await a.query('COMMIT');
      await second;
      await b.query('COMMIT');
    } finally {
      /* ROLLBACK BEFORE RELEASE. node-pg does not reset a connection on release,
       * so a client returned mid-transaction goes back into the pool still
       * holding its locks. An earlier version of this file released without
       * rolling back; the moment an assertion threw, the next test blocked on the
       * abandoned lock and failed as a 5s timeout — a failure that looks nothing
       * like its cause. `.catch()` because the transaction may already be gone. */
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }

    const r = await admin.query(
      `SELECT rule_code, severity, message, message_code, policy_id, data
         FROM policy_violation WHERE report_id = $1`,
      [reportId],
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.rule_code).toBe('PER_TRANSACTION_LIMIT');
    expect(row.severity).toBe('WARNING');
    expect(row.message).toBeTruthy();
    expect(row.message_code).toBeTruthy();
    expect(row.policy_id).toBeTruthy();
    expect(row.data).toBeTruthy();
  });

  it('a sequential re-validation still produces exactly one — the non-race control', async () => {
    // The vacuity guard. Both tests above would pass against a validate that
    // never inserted anything at all.
    const reportId = await draftOverLimit();
    await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    expect(await violationCount(reportId)).toBe(1);
    await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    expect(await violationCount(reportId)).toBe(1);
  });
});
