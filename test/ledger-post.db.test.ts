/**
 * VX3-4 — the ledger post queue and the adapter contract in use, against a real
 * Postgres. Own org slug ('post-co').
 *
 * ── The tests worth reading ─────────────────────────────────────────────────
 *
 * `an ambiguous failure becomes NEEDS_REVIEW` and `the poller cannot see a
 * NEEDS_REVIEW row` are GAP-AUDIT AC-8, from both sides: the state is reached, and
 * it is unreachable by any automatic path. ExpenseOS writes that same situation as
 * a retryable FAILED row with "do NOT re-post" in its error column and re-posts it
 * five times.
 *
 * `two ambiguous failures in one tenant` exists because the first version of the
 * caller passed '' as the external id, and `0017`'s partial unique index would have
 * made the second one collide and fall back to a retryable status — the one
 * outcome NEEDS_REVIEW exists to prevent.
 *
 * `approving enqueues in the same transaction` is AC-6/AC-7: the hook is on the
 * transition, and it is a row rather than a job.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as outbox from '@/lib/integrations/post-outbox';
import * as integrations from '@/lib/integrations/service';
import { stubControl } from '@/lib/integrations/stub';
import { postOne, drainPosts } from '@/lib/integrations/dispatch';
import { MAX_ATTEMPTS } from '@/lib/outbox/policy';
import { setEntitlement } from '@/lib/modules/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let categoryId: string;
let accountId: string;
const stub = stubControl();

/** An APPROVED report with one coded line, built directly — the approval path has
 *  its own suites, and this file is about what happens after. */
async function approvedReport(title: string, amountMinor = 12345) {
  return withOrg(orgId, async (tx) => {
    const rep = await tx.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code,
                                   status, approved_at, number, total_minor)
       VALUES ($1, $2, $3, 'CAD', 'APPROVED', clock_timestamp(), $4, $5) RETURNING id`,
      [orgId, userId, title, `EXP-${Math.floor(Math.random() * 100000)}`, amountMinor],
    );
    const reportId = rep.rows[0].id as string;
    const exp = await tx.query(
      `INSERT INTO expense (organization_id, report_id, currency_code, merchant, txn_date)
       VALUES ($1, $2, 'CAD', 'Test Merchant', current_date) RETURNING id`,
      [orgId, reportId],
    );
    await tx.query(
      `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor,
                                      description, gl_account_id)
       VALUES ($1, $2, $3, $4, 'a line', $5)`,
      [orgId, exp.rows[0].id, categoryId, amountMinor, accountId],
    );
    await outbox.enqueuePost(tx, reportId);
    return reportId;
  });
}

async function connectStub() {
  return withOrg(orgId, (tx) =>
    integrations.installIntegration(
      tx,
      {
        slug: 'stub-ledger',
        code: 'main',
        label: 'Stub',
        config: { ledgerUrl: 'https://ledger.test', apiToken: 'tok' },
      },
      userId,
    ),
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    // UD-8: AUTOMATIC stated explicitly — this suite is about what happens AFTER a
    // report is enqueued, and the column's new default (AP_QUEUE) would make every
    // row HELD and every assertion about posting vacuous.
    // `test/posting-trigger.db.test.ts` owns the other setting.
    "INSERT INTO organization (slug, name, posting_trigger)"
      + " VALUES ('post-co','Post Co','AUTOMATIC') RETURNING id",
  );
  orgId = o.rows[0].id;

  // VX4-1: ABSENCE MEANS OFF, and since 0022 the gate is in the RLS policy too, so
  // this row has to exist before the gl_account insert below. Placed at the end of
  // this hook first, and the suite failed from its own setup.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
     VALUES ($1, 'accounting', true, clock_timestamp())`,
    [orgId],
  );
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'a@post.test','Ada') RETURNING id",
      [orgId],
    );
    userId = u.rows[0].id;
    const acct = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type, is_postable, source)
       VALUES ($1, '68100', 'Travel', 'expense', true, 'MANUAL') RETURNING id`,
      [orgId],
    );
    accountId = acct.rows[0].id;
    const cat = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
       VALUES ($1,'travel','{"en":"Travel"}',$2) RETURNING id`,
      [orgId, accountId],
    );
    categoryId = cat.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM integration_post');
  await admin.query('DELETE FROM expense_report');
  await admin.query('DELETE FROM integration_installation');
  stub.reset();
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('enqueueing', () => {
  it('queues one row per report, and a second enqueue is harmless', async () => {
    const reportId = await approvedReport('first');
    await withOrg(orgId, (tx) => outbox.enqueuePost(tx, reportId));
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('PENDING');
  });

  it('the idempotency key is derived from the report and never changes', async () => {
    const reportId = await approvedReport('stable');
    const key = await admin.query('SELECT idempotency_key FROM integration_post');
    expect(key.rows[0].idempotency_key).toBe(outbox.idempotencyKeyFor(reportId));
  });
});

describe('requeueing after a configuration fix (VX4-1 part 2)', () => {
  /**
   * A post skipped for a CONFIGURATION reason — nothing connected, two ledgers
   * claiming one capability, the accounting module off — backs off an hour without
   * burning an attempt. Right for the poller, wrong for the admin who just fixed
   * the configuration and is told the queue "drains on its own". The e2e caught
   * that promise being false; this pins the predicate.
   */
  it('makes a backed-off PENDING row due, and leaves a FAILED one alone', async () => {
    const pending = await approvedReport('waiting on configuration');
    const failed = await approvedReport('refused by a far end');
    await admin.query(
      `UPDATE integration_post
          SET next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [pending],
    );
    // A FAILED row backed off because a real far end refused it. Its retry
    // schedule is not a configuration change's business.
    await admin.query(
      `UPDATE integration_post
          SET status = 'FAILED', attempts = 1, last_error = 'the ledger said no',
              next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [failed],
    );

    const moved = await withOrg(orgId, (tx) => outbox.requeueWaitingPosts(tx));
    expect(moved).toBe(1);

    const rows = await admin.query(
      `SELECT report_id, status, next_attempt_at <= clock_timestamp() AS due
         FROM integration_post WHERE report_id = ANY($1)`,
      [[pending, failed]],
    );
    const byReport = new Map(rows.rows.map((r) => [r.report_id, r]));
    expect(byReport.get(pending)!.due).toBe(true);
    expect(byReport.get(failed)!.due).toBe(false);
    expect(byReport.get(failed)!.status).toBe('FAILED');
  });

  it('CONNECTING a ledger clears the backoff, and it is the service that does it', async () => {
    // AC-24's open half. A tenant has approvals waiting from before it connected —
    // VX3-4 made sure of that — each skipped with an hour's backoff. Connecting IS
    // the fix, so the wait ends with it.
    //
    // Asserted through `installIntegration` rather than through a screen, because
    // the whole point of moving the nudge into the service was that the edge is
    // where a caller forgets it.
    const reportId = await approvedReport('waiting for a ledger');
    await admin.query(
      `UPDATE integration_post SET next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [reportId],
    );
    await admin.query('DELETE FROM integration_installation');

    await withOrg(orgId, (tx) =>
      integrations.installIntegration(
        tx,
        {
          slug: 'stub-ledger',
          code: 'after-the-fact',
          label: 'Connected late',
          config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
        },
        userId,
      ),
    );

    const due = await admin.query(
      `SELECT next_attempt_at <= clock_timestamp() AS due FROM integration_post
        WHERE report_id = $1`,
      [reportId],
    );
    expect(due.rows[0].due).toBe(true);
  });

  it('DISCONNECTING clears it too, because disconnecting can be the fix', async () => {
    // Two adapters claiming one capability make the posting path refuse to choose
    // (AC-22), and the way out is to disconnect one — at which point the queue
    // should move rather than wait out an hour it spent being ambiguous.
    const installed = await withOrg(orgId, (tx) =>
      integrations.installIntegration(
        tx,
        {
          slug: 'stub-ledger',
          code: 'to-disconnect',
          label: 'On the way out',
          config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
        },
        userId,
      ),
    );
    const reportId = await approvedReport('waiting on an ambiguity');
    await admin.query(
      `UPDATE integration_post SET next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [reportId],
    );

    await withOrg(orgId, (tx) => integrations.disconnect(tx, installed.id));

    const due = await admin.query(
      `SELECT next_attempt_at <= clock_timestamp() AS due FROM integration_post
        WHERE report_id = $1`,
      [reportId],
    );
    expect(due.rows[0].due).toBe(true);
  });

  it('and TURNING THE MODULE ON does it from the service, not from the screen', async () => {
    // The path VX4-1 part 2 originally hooked at the edge. Asserted through
    // `setEntitlement` because that is where it lives now: an e2e already covers the
    // button, and what needs pinning is that a caller who is NOT the button gets it.
    const reportId = await approvedReport('waiting on a module');
    await withOrg(orgId, (tx) =>
      setEntitlement(tx, 'accounting', false, { id: userId, name: 'Ada', role: 'ADMIN' }),
    );
    await admin.query(
      `UPDATE integration_post SET next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [reportId],
    );

    await withOrg(orgId, (tx) =>
      setEntitlement(tx, 'accounting', true, { id: userId, name: 'Ada', role: 'ADMIN' }),
    );

    const due = await admin.query(
      `SELECT next_attempt_at <= clock_timestamp() AS due FROM integration_post
        WHERE report_id = $1`,
      [reportId],
    );
    expect(due.rows[0].due).toBe(true);
  });

  it('does not touch a row another poller has CLAIMED', async () => {
    // A claimed row is in flight. Moving its schedule under the process holding it
    // is how a double-post starts.
    const reportId = await approvedReport('in flight');
    await admin.query(
      `UPDATE integration_post
          SET claimed_at = clock_timestamp(), claimed_by = 'someone-else',
              next_attempt_at = clock_timestamp() + interval '1 hour'
        WHERE report_id = $1`,
      [reportId],
    );
    expect(await withOrg(orgId, (tx) => outbox.requeueWaitingPosts(tx))).toBe(0);
  });
});

describe('posting', () => {
  it('posts a queued report and records the ledger id', async () => {
    const installed = await connectStub();
    const reportId = await approvedReport('to post');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(await postOne(orgId, queue[0].id)).toBe('POSTED');

    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('POSTED');
    expect(after[0].external_id).toBe(`stub-${reportId}`);
    expect(after[0].installation_id).toBe(installed.id);
    expect(after[0].posted_at).toBeInstanceOf(Date);

    // And the adapter got a vendor-neutral report with the SNAPSHOT account.
    const posted = stub.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].report.lines[0].glAccountNumber).toBe('68100');
    expect(posted[0].report.currencyCode).toBe('CAD');
  });

  it('does NOT burn an attempt when nothing is connected', async () => {
    // A tenant that connects a ledger next week must find last week's approvals
    // still waiting, not already DEAD.
    const reportId = await approvedReport('nothing connected');
    expect(reportId).toBeTruthy();
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(await postOne(orgId, queue[0].id)).toBe('SKIPPED');
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('PENDING');
    expect(after[0].attempts).toBe(0);
    expect(after[0].last_error).toMatch(/No accounting integration is connected/);
  });

  it('a REFUSED failure stays retryable and backs off', async () => {
    // VX3-7 FIXED A DEFECT THIS TEST USED TO ENCODE. It asserted NEEDS_REVIEW
    // with a comment explaining that "only the VeloLedger adapter can say
    // definitely not applied" — which was true, and was the bug: `dispatch.ts`
    // imported the classifier from `lib/integrations/veloledger.ts` by name, so
    // EVERY other adapter's refusal became NEEDS_REVIEW, a state no automatic
    // path retries. A QuickBooks tenant with a mistyped key would have needed a
    // human to clear every report, one at a time, for a 401.
    //
    // The classifier is now `isDefinitelyNotApplied` on the CONTRACT, and this
    // test drives the STUB — deliberately not VeloLedger, because an assertion
    // that passes only for the adapter the mechanism was written around proves
    // nothing about the mechanism.
    await connectStub();
    await approvedReport('refused');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    stub.failNext('the ledger refused this bill', true);
    expect(await postOne(orgId, queue[0].id)).toBe('FAILED');
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('FAILED');
    // Retryable, and it HAS spent an attempt — a refusal that never backs off is
    // a hot loop against somebody's ledger.
    expect(after[0].attempts).toBe(1);
    expect(after[0].next_attempt_at).toBeInstanceOf(Date);
    expect(after[0].external_id).toBeNull();
  });

  it('an adapter that throws a BARE error is still treated as ambiguous', async () => {
    // The fail-safe default, and the reason the fix did not simply trust
    // adapters. An adapter wrapping a vendor SDK may let one of that SDK's own
    // error types escape; core cannot know whether it applied, so it must assume
    // it might have. Forgetting to wrap costs a human one click. Guessing wrong
    // in the other direction costs a duplicated bill.
    await connectStub();
    await approvedReport('bare throw');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    stub.failNextBare('something escaped the SDK');
    expect(await postOne(orgId, queue[0].id)).toBe('NEEDS_REVIEW');
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('NEEDS_REVIEW');
    expect(after[0].external_id).toBeNull();
  });

  it('an ambiguous failure becomes NEEDS_REVIEW with NO external id — AC-8', async () => {
    await connectStub();
    await approvedReport('ambiguous');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    stub.failNext('connection reset');
    await postOne(orgId, queue[0].id);
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('NEEDS_REVIEW');
    expect(after[0].external_id).toBeNull();
    expect(after[0].last_error).toMatch(/may or may not have accepted/);
  });

  it('two ambiguous failures in one tenant do not collide', async () => {
    // The bug the first version had: '' as the external id, and 0017's partial
    // unique index makes the second write fail, dropping the row back to a
    // RETRYABLE status — the one outcome this state exists to prevent.
    await connectStub();
    await approvedReport('ambiguous one');
    await approvedReport('ambiguous two');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(queue).toHaveLength(2);
    stub.failNext('connection reset');
    await postOne(orgId, queue[0].id);
    stub.failNext('connection reset');
    await postOne(orgId, queue[1].id);
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after.map((r) => r.status)).toEqual(['NEEDS_REVIEW', 'NEEDS_REVIEW']);
  });

  it('THE POLLER CANNOT SEE a NEEDS_REVIEW row', async () => {
    // Not "does not select" — cannot see. 0017's platform_read policy does not
    // match the status, so a future change that forgot to exclude it still cannot
    // reach it.
    await connectStub();
    await approvedReport('needs review');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    stub.failNext('connection reset');
    await postOne(orgId, queue[0].id);
    expect(await outbox.duePosts()).toEqual([]);
    expect(await drainPosts()).toMatchObject({ claimed: 0, posted: 0 });
  });

  it('a claimed row cannot be claimed twice', async () => {
    await connectStub();
    await approvedReport('raced');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const first = await withOrg(orgId, (tx) => outbox.claimPost(tx, queue[0].id));
    const second = await withOrg(orgId, (tx) => outbox.claimPost(tx, queue[0].id));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('goes DEAD after the attempt budget, and a human can retry it', async () => {
    await connectStub();
    await approvedReport('doomed');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await withOrg(orgId, (tx) => outbox.markFailed(tx, queue[0].id, `attempt ${i + 1}`));
    }
    let after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('DEAD');
    expect(after[0].attempts).toBe(MAX_ATTEMPTS);

    await withOrg(orgId, (tx) => outbox.retryNow(tx, queue[0].id));
    after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('PENDING');
    expect(after[0].attempts).toBe(0);
    // last_error is KEPT — it is the only record of why the row was stuck, and
    // clearing it on retry loses the diagnosis just as somebody starts looking.
    expect(after[0].last_error).toMatch(/attempt 5/);
  });

  it('a cancelled post is withheld, and is not posted by a drain', async () => {
    await connectStub();
    await approvedReport('withheld');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await withOrg(orgId, (tx) => outbox.cancelPost(tx, queue[0].id, 'duplicate claim'));
    expect(await drainPosts()).toMatchObject({ posted: 0, claimed: 0 });
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('CANCELLED');
  });

  it('refuses to cancel something already posted', async () => {
    await connectStub();
    await approvedReport('done');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await postOne(orgId, queue[0].id);
    await expect(
      withOrg(orgId, (tx) => outbox.cancelPost(tx, queue[0].id, 'too late')),
    ).rejects.toThrow(/already posted/);
  });
});

/**
 * The Toronto-day defect: a report is booked on the TENANT'S calendar day of its
 * approval, not the UTC day.
 *
 * The VeloLedger adapter used to compute `approvedAt.toISOString().slice(0, 10)`,
 * so in Toronto everything approved after 20:00 EDT (19:00 EST) was booked on the
 * next day — and on the last day of a month, in the next accounting period. It
 * failed nothing: the bill drafted, the period resolved, the journal posted. The
 * day is now computed here, by the dispatcher, from `organization.default_timezone`,
 * and the adapter is handed only the day (`PostableReport.postingDate`).
 *
 * Every case below is 23:30 local on a day whose UTC date is already the next
 * one, which is the only shape that tells the two answers apart. The month-end
 * case is the one a customer would find; the two DST cases are there because a
 * fixed -04:00 offset would pass the first and fail them.
 */
describe("the posting date is the TENANT'S day, not the UTC day", () => {
  afterEach(async () => {
    // The suite's other tests assume the column's default.
    await admin.query("UPDATE organization SET default_timezone = 'UTC' WHERE id = $1", [orgId]);
  });

  it.each([
    // zone,                approved_at (UTC),         the day it is booked on
    ['America/Toronto', '2026-10-01T03:30:00Z', '2026-09-30'], // 23:30 EDT, last day of September
    ['America/Vancouver', '2026-10-01T06:30:00Z', '2026-09-30'], // 23:30 PDT, same month-end
    ['America/Toronto', '2026-03-09T03:30:00Z', '2026-03-08'], // 23:30 EDT, the day DST began
    ['America/Toronto', '2026-11-02T04:30:00Z', '2026-11-01'], // 23:30 EST, the day DST ended
    ['UTC', '2026-10-01T03:30:00Z', '2026-10-01'], // a tenant that never set a zone: unchanged
  ])('%s, approved at %s, is booked on %s', async (zone, approvedAt, day) => {
    await connectStub();
    const reportId = await approvedReport(`booked in ${zone}`);
    await admin.query('UPDATE organization SET default_timezone = $2 WHERE id = $1', [orgId, zone]);
    await admin.query('UPDATE expense_report SET approved_at = $2 WHERE id = $1', [reportId, approvedAt]);

    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(await postOne(orgId, queue[0].id)).toBe('POSTED');
    expect(stub.posted()[0].report.postingDate).toBe(day);
  });
});

describe('draining', () => {
  it('posts everything due and reports what it did', async () => {
    await connectStub();
    await approvedReport('one');
    await approvedReport('two');
    const result = await drainPosts();
    expect(result).toMatchObject({ claimed: 2, posted: 2, failed: 0, needsReview: 0 });
    expect(stub.posted()).toHaveLength(2);
    expect(await withOrg(orgId, (tx) => outbox.queueSummary(tx))).toMatchObject({ POSTED: 2 });
  });

  it('a second drain posts nothing — the queue is drained, not re-sent', async () => {
    await connectStub();
    await approvedReport('once only');
    await drainPosts();
    expect(await drainPosts()).toMatchObject({ claimed: 0, posted: 0 });
    expect(stub.posted()).toHaveLength(1);
  });
});

describe('the dry run (VX3-6)', () => {
  it('reports what would post, and writes nothing', async () => {
    await connectStub();
    await approvedReport('previewed', 4200);
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const result = await withOrg(orgId, (tx) => outbox.dryRun(tx, queue[0].id));
    expect(result?.problems).toEqual([]);
    expect(result?.lines).toHaveLength(1);
    expect(result?.lines[0].glAccountNumber).toBe('68100');
    expect(result?.totalMinor).toBe('4200');
    // Nothing sent, nothing changed.
    expect(stub.posted()).toEqual([]);
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('names an unmapped category as the reason it would not post', async () => {
    await connectStub();
    const reportId = await approvedReport('unmapped');
    // Clear both the snapshot and the category mapping, which is what an
    // unmapped line actually looks like.
    await admin.query('UPDATE expense_line_item SET gl_account_id = NULL');
    await admin.query('UPDATE expense_category SET gl_account_id = NULL');
    expect(reportId).toBeTruthy();
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const result = await withOrg(orgId, (tx) => outbox.dryRun(tx, queue[0].id));
    expect(result?.problems.join(' ')).toMatch(/no GL account/);
    expect(result?.lines[0].glAccountNumber).toBeNull();
  });

  /**
   * AC-10's actual guarantee, and nothing pinned it until a sabotage went looking.
   *
   * The account is SNAPSHOTTED on the line when the line is filed; the category's
   * current account is only a fallback for a line written before `0014`. So
   * `coalesce(line, category)` — in that order — is what makes a report post to
   * the account it was coded to when it was filed, rather than to wherever its
   * category points months later.
   *
   * The order is load-bearing HERE and immaterial in `lib/integrations/coding.ts`,
   * which only asks whether either is present: `coalesce(a,b) IS NULL` is the same
   * question as `coalesce(b,a) IS NULL`. Flipping the order there failed no test
   * and correctly so. Flipping it here changes which account the money lands in,
   * silently, months after anyone would connect the two.
   */
  it('posts to the account the line was CODED to, not the category as it stands now', async () => {
    await connectStub();
    const reportId = await approvedReport('re-mapped since');
    expect(reportId).toBeTruthy();

    // The admin re-points the category at a different account after the fact.
    const moved = await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO gl_account (organization_id, number, name, type, is_postable, source)
         VALUES ($1,'68999','Travel (new)','expense',true,'MANUAL') RETURNING id`,
        [orgId],
      ),
    );
    await admin.query('UPDATE expense_category SET gl_account_id = $1 WHERE id = $2', [
      moved.rows[0].id,
      categoryId,
    ]);

    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const result = await withOrg(orgId, (tx) => outbox.dryRun(tx, queue[0].id));
    expect(result?.lines[0].glAccountNumber).toBe('68100');

    // And the same account is what actually reaches the ledger.
    await postOne(orgId, queue[0].id);
    expect(stub.posted()[0].report.lines[0].glAccountNumber).toBe('68100');

    await admin.query('UPDATE expense_category SET gl_account_id = $1 WHERE id = $2', [
      accountId,
      categoryId,
    ]);
  });

  it('says so when it has already been sent', async () => {
    await connectStub();
    await approvedReport('already gone');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await postOne(orgId, queue[0].id);
    const result = await withOrg(orgId, (tx) => outbox.dryRun(tx, queue[0].id));
    expect(result?.problems.join(' ')).toMatch(/already been sent/);
  });

  it('returns null for a post that does not exist', async () => {
    expect(
      await withOrg(orgId, (tx) =>
        outbox.dryRun(tx, '00000000-0000-0000-0000-000000000000'),
      ),
    ).toBeNull();
  });
});
