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
    });
  }
});

afterAll(async () => {
  await admin.end();
});

describe('RLS tenant isolation', () => {
  it('a tenant sees only its own rows', async () => {
    const rows = await withOrg(orgA, (tx) => tx.query('SELECT email FROM app_user'));
    expect(rows.rows.map((r) => r.email)).toEqual(['a@x.com']);
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
