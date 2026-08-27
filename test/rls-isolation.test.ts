/**
 * VX0-6 — the RLS isolation GATE. Runs against a real Postgres (the VeloExpense
 * test DB) with migrations applied. Nothing stacks onto feature work until this
 * is green in CI.
 *
 * Proves: (1) a tenant sees only its own rows, (2) WITH CHECK rejects a
 * cross-tenant write, (3) an unset context sees nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg, withoutOrg } from '@/lib/tenant/context';

// Admin (superuser) connection for setup/teardown only. veloapp deliberately
// cannot TRUNCATE (RLS/privilege), so reset state via ADMIN_DATABASE_URL
// (falls back to DATABASE_URL for local convenience).
const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgA: string;
let orgB: string;

beforeAll(async () => {
  // idempotent: wipe prior test data so reruns don't collide on unique slugs
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await withoutOrg(async (tx) => {
    const a = await tx.query(
      "INSERT INTO organization (slug, name) VALUES ('org-a','Org A') RETURNING id",
    );
    const b = await tx.query(
      "INSERT INTO organization (slug, name) VALUES ('org-b','Org B') RETURNING id",
    );
    orgA = a.rows[0].id;
    orgB = b.rows[0].id;
  });
  await withOrg(orgA, (tx) =>
    tx.query("INSERT INTO app_user (organization_id, email) VALUES ($1,'a@x.com')", [orgA]),
  );
  await withOrg(orgB, (tx) =>
    tx.query("INSERT INTO app_user (organization_id, email) VALUES ($1,'b@x.com')", [orgB]),
  );
  // VX1-1: a reference table (expense_category) per org, to prove the new
  // tenant tables are isolated too.
  await withOrg(orgA, (tx) =>
    tx.query("INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals A')", [orgA]),
  );
  await withOrg(orgB, (tx) =>
    tx.query("INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals B')", [orgB]),
  );
  // VX1-3: an expense report per org (submitter resolved within the org via subquery).
  const reportA = await withOrg(orgA, (tx) =>
    tx.query(
      `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
         SELECT $1, 'Report A', 'CAD', id FROM app_user WHERE organization_id = $1 LIMIT 1
       RETURNING id`,
      [orgA],
    ),
  );
  const reportB = await withOrg(orgB, (tx) =>
    tx.query(
      `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
         SELECT $1, 'Report B', 'CAD', id FROM app_user WHERE organization_id = $1 LIMIT 1
       RETURNING id`,
      [orgB],
    ),
  );
  // VX1-7: a policy rule and a raised violation per org — the two tables added
  // by migration 0006. CI's RLS-coverage guard requires every tenant table to
  // appear here, and a violation carries the message text of a finding, which
  // is exactly the sort of row that must never cross a tenant boundary.
  for (const [org, report, label] of [
    [orgA, reportA.rows[0].id, 'A'],
    [orgB, reportB.rows[0].id, 'B'],
  ] as const) {
    await withOrg(org, async (tx) => {
      const rule = await tx.query(
        `INSERT INTO expense_policy (organization_id, kind, severity, params)
         VALUES ($1, 'PER_TRANSACTION_LIMIT', 'WARNING', '{"thresholdMinor": 5000}'::jsonb)
         RETURNING id`,
        [org],
      );
      await tx.query(
        `INSERT INTO policy_violation
           (organization_id, report_id, policy_id, rule_code, severity, message)
         VALUES ($1, $2, $3, 'PER_TRANSACTION_LIMIT', 'WARNING', $4)`,
        [org, report, rule.rows[0].id, `Violation ${label}`],
      );
      // VX1-8: a transition event (migration 0007). An audit trail that leaked
      // across tenants would expose who submitted what, and when.
      await tx.query(
        `INSERT INTO expense_report_event
           (organization_id, report_id, action, from_status, to_status, actor_id, note)
         SELECT $1, $2, 'SUBMIT', 'DRAFT', 'SUBMITTED', id, $3
           FROM app_user WHERE organization_id = $1 LIMIT 1`,
        [org, report, `Event ${label}`],
      );
      // VX1-9: the rest of the report tree from migration 0003 — expense,
      // expense_line_item and receipt. They were covered only transitively
      // (through expense_report) until now; the guard counts tables, not trees.
      const expense = await tx.query(
        `INSERT INTO expense (organization_id, report_id, merchant, currency_code)
         VALUES ($1, $2, $3, 'CAD') RETURNING id`,
        [org, report, `Merchant ${label}`],
      );
      await tx.query(
        `INSERT INTO expense_line_item
           (organization_id, expense_id, category_id, amount_minor, description)
         SELECT $1, $2, id, 1000, $3 FROM expense_category WHERE organization_id = $1 LIMIT 1`,
        [org, expense.rows[0].id, `Line ${label}`],
      );
      await tx.query(
        `INSERT INTO receipt
           (organization_id, expense_id, s3_key, filename, content_type, size_bytes,
            status, uploaded_by_id)
         SELECT $1, $2, $3, $4, 'application/pdf', 10, 'STORED', id
           FROM app_user WHERE organization_id = $1 LIMIT 1`,
        [org, expense.rows[0].id, `org/${org}/receipts/x/${label}.pdf`, `receipt-${label}.pdf`],
      );
      // VX2-1: the approval schema from migration 0008 — approval_policy,
      // approval_request, approval_task, delegation. A leaked ladder would tell
      // one tenant another's spending thresholds; a leaked request or task would
      // expose who approves whose money, and a leaked delegation who is away.
      const owner = label === 'A' ? 'a@x.com' : 'b@x.com';
      const approver = await tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role)
         VALUES ($1, $2, $3, 'MANAGER') RETURNING id`,
        [org, `approver-${label.toLowerCase()}@x.com`, `Approver ${label}`],
      );
      const rung = await tx.query(
        `INSERT INTO approval_policy (organization_id, name, sequence, threshold_minor)
         VALUES ($1, $2, 1, 0) RETURNING id`,
        [org, `Ladder ${label}`],
      );
      await tx.query(
        `INSERT INTO approval_policy_approver
           (organization_id, policy_id, position, approver_kind, manager_level, display_name)
         VALUES ($1, $2, 1, 'MANAGER', 1, $3)`,
        [org, rung.rows[0].id, `Signer ${label}`],
      );
      const request = await tx.query(
        `INSERT INTO approval_request
           (organization_id, report_id, policy_snapshot, total_steps,
            subject_total_minor, subject_currency_code, opened_by_id)
         SELECT $1, $2, $3::jsonb, 1, 1000, 'CAD', id
           FROM app_user WHERE organization_id = $1 AND email = $4
         RETURNING id`,
        [org, report, JSON.stringify([{ step: 1, name: `Ladder ${label}` }]), owner],
      );
      await tx.query(
        `INSERT INTO approval_task
           (organization_id, request_id, step, assignee_id, note)
         VALUES ($1, $2, 1, $3, $4)`,
        [org, request.rows[0].id, approver.rows[0].id, `Task ${label}`],
      );
      await tx.query(
        `INSERT INTO delegation
           (organization_id, from_user_id, to_user_id, starts_on, created_by_id, note)
         SELECT $1, $2, id, DATE '2026-09-01', $2, $3
           FROM app_user WHERE organization_id = $1 AND email = $4`,
        [org, approver.rows[0].id, `Delegation ${label}`, owner],
      );
    });
  }
});

afterAll(async () => {
  await admin.end();
});

describe('RLS tenant isolation', () => {
  it('a tenant sees only its own rows', async () => {
    // Two users per org since VX2-1: the submitter, and the approver a
    // delegation needs a second person for. Sorted because the guarantee is
    // WHICH rows are visible, not what order an unordered SELECT returns them in.
    const rows = await withOrg(orgA, (tx) => tx.query('SELECT email FROM app_user'));
    expect(rows.rows.map((r) => r.email).sort()).toEqual(['a@x.com', 'approver-a@x.com']);
  });

  it('WITH CHECK rejects a cross-tenant insert', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.query("INSERT INTO app_user (organization_id, email) VALUES ($1,'evil@x.com')", [orgB]),
      ),
    ).rejects.toThrow();
  });

  it('unset context sees zero rows', async () => {
    const rows = await withoutOrg((tx) => tx.query('SELECT * FROM app_user'));
    expect(rows.rows).toHaveLength(0);
  });

  it('reference tables are tenant-isolated (expense_category)', async () => {
    const a = await withOrg(orgA, (tx) => tx.query('SELECT label FROM expense_category'));
    expect(a.rows.map((r) => r.label)).toEqual(['Meals A']);
    const none = await withoutOrg((tx) => tx.query('SELECT * FROM expense_category'));
    expect(none.rows).toHaveLength(0);
  });

  it('expense reports are tenant-isolated', async () => {
    const a = await withOrg(orgA, (tx) => tx.query('SELECT title FROM expense_report'));
    expect(a.rows.map((r) => r.title)).toEqual(['Report A']);
    const none = await withoutOrg((tx) => tx.query('SELECT * FROM expense_report'));
    expect(none.rows).toHaveLength(0);
  });

  it('policy rules are tenant-isolated (expense_policy)', async () => {
    const a = await withOrg(orgA, (tx) => tx.query('SELECT id FROM expense_policy'));
    expect(a.rows).toHaveLength(1);
    const b = await withOrg(orgB, (tx) => tx.query('SELECT id FROM expense_policy'));
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
    const none = await withoutOrg((tx) => tx.query('SELECT * FROM expense_policy'));
    expect(none.rows).toHaveLength(0);
  });

  it('policy violations are tenant-isolated (policy_violation)', async () => {
    const a = await withOrg(orgA, (tx) => tx.query('SELECT message FROM policy_violation'));
    expect(a.rows.map((r) => r.message)).toEqual(['Violation A']);
    const none = await withoutOrg((tx) => tx.query('SELECT * FROM policy_violation'));
    expect(none.rows).toHaveLength(0);
  });

  it('report events are tenant-isolated (expense_report_event)', async () => {
    const a = await withOrg(orgA, (tx) => tx.query('SELECT note FROM expense_report_event'));
    expect(a.rows.map((r) => r.note)).toEqual(['Event A']);
    const none = await withoutOrg((tx) => tx.query('SELECT * FROM expense_report_event'));
    expect(none.rows).toHaveLength(0);
  });

  it('expenses, line items and receipts are tenant-isolated', async () => {
    const a = await withOrg(orgA, async (tx) => ({
      expenses: (await tx.query('SELECT merchant FROM expense')).rows.map((r) => r.merchant),
      lines: (await tx.query('SELECT description FROM expense_line_item')).rows.map(
        (r) => r.description,
      ),
      receipts: (await tx.query('SELECT filename FROM receipt')).rows.map((r) => r.filename),
    }));
    expect(a).toEqual({
      expenses: ['Merchant A'],
      lines: ['Line A'],
      receipts: ['receipt-A.pdf'],
    });

    const none = await withoutOrg(async (tx) => ({
      expenses: (await tx.query('SELECT * FROM expense')).rows.length,
      lines: (await tx.query('SELECT * FROM expense_line_item')).rows.length,
      receipts: (await tx.query('SELECT * FROM receipt')).rows.length,
    }));
    expect(none).toEqual({ expenses: 0, lines: 0, receipts: 0 });
  });

  it('a joined read cannot walk from one tenant to another', async () => {
    // The join is the shape that leaks in a poorly-scoped ORM: line item ->
    // expense -> report. Every hop is independently RLS-scoped, so org A's
    // context sees exactly its own chain and nothing of B's.
    const rows = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT r.title, e.merchant, li.description
           FROM expense_line_item li
           JOIN expense e ON e.id = li.expense_id
           JOIN expense_report r ON r.id = e.report_id`,
      ),
    );
    expect(rows.rows).toEqual([{ title: 'Report A', merchant: 'Merchant A', description: 'Line A' }]);
  });

  it('approval ladders, signers, runs, tasks and delegations are tenant-isolated', async () => {
    const a = await withOrg(orgA, async (tx) => ({
      ladder: (await tx.query('SELECT name FROM approval_policy')).rows.map((r) => r.name),
      signers: (await tx.query('SELECT display_name FROM approval_policy_approver')).rows.map(
        (r) => r.display_name,
      ),
      requests: (await tx.query('SELECT id FROM approval_request')).rows.length,
      tasks: (await tx.query('SELECT note FROM approval_task')).rows.map((r) => r.note),
      delegations: (await tx.query('SELECT note FROM delegation')).rows.map((r) => r.note),
    }));
    expect(a).toEqual({
      ladder: ['Ladder A'],
      signers: ['Signer A'],
      requests: 1,
      tasks: ['Task A'],
      delegations: ['Delegation A'],
    });

    const none = await withoutOrg(async (tx) => ({
      ladder: (await tx.query('SELECT * FROM approval_policy')).rows.length,
      signers: (await tx.query('SELECT * FROM approval_policy_approver')).rows.length,
      requests: (await tx.query('SELECT * FROM approval_request')).rows.length,
      tasks: (await tx.query('SELECT * FROM approval_task')).rows.length,
      delegations: (await tx.query('SELECT * FROM delegation')).rows.length,
    }));
    expect(none).toEqual({ ladder: 0, signers: 0, requests: 0, tasks: 0, delegations: 0 });
  });

  it('an approval task cannot be joined back to another tenant report', async () => {
    // The Phase-2 shape of the join-walk test above: task -> request -> report.
    // Every hop is independently RLS-scoped, so org A sees its own chain only.
    const rows = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT r.title, t.note
           FROM approval_task t
           JOIN approval_request q ON q.id = t.request_id
           JOIN expense_report r ON r.id = q.report_id`,
      ),
    );
    expect(rows.rows).toEqual([{ title: 'Report A', note: 'Task A' }]);
  });

  it('an approval signer cannot be joined to another tenant ladder', async () => {
    const rows = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT p.name, ap.display_name
           FROM approval_policy_approver ap
           JOIN approval_policy p ON p.id = ap.policy_id`,
      ),
    );
    expect(rows.rows).toEqual([{ name: 'Ladder A', display_name: 'Signer A' }]);
  });

  it('WITH CHECK rejects a cross-tenant approval request', async () => {
    // The row bodies come from what org A can actually SEE, and only the
    // organization_id is org B's. Selecting org B's rows instead would prove
    // nothing: RLS hides them, the SELECT returns nothing, and the INSERT
    // succeeds vacuously without ever reaching WITH CHECK.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO approval_request
             (organization_id, report_id, policy_snapshot, total_steps,
              subject_total_minor, subject_currency_code, opened_by_id)
           SELECT $1, r.id, '[]'::jsonb, 1, 1000, 'CAD', u.id
             FROM expense_report r, app_user u
            LIMIT 1`,
          [orgB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('WITH CHECK rejects a cross-tenant violation insert', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO policy_violation (organization_id, report_id, rule_code, severity, message)
             SELECT $1, id, 'CATEGORY_ACTIVE', 'BLOCK', 'leaked'
               FROM expense_report LIMIT 1`,
          [orgB],
        ),
      ),
    ).rejects.toThrow();
  });
});
