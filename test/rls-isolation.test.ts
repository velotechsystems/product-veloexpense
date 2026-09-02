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
import { withOrg, withoutOrg, withPlatformRead } from '@/lib/tenant/context';

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

  // VX4-1: a module entitlement per org, FIRST. This table decides what a customer
  // is PAYING FOR, so a leak is one tenant reading — or with a broken WITH CHECK,
  // writing — another tenant's commercial terms.
  //
  // And it has to come before every accounting write, because since migration 0022
  // the module gate is in the RLS POLICY as well: `gl_account`,
  // `integration_installation` and `integration_oauth_state` are invisible and
  // unwritable without it. The first placement was further down this hook and the
  // suite failed from its own setup with "new row violates row-level security
  // policy for table gl_account".
  for (const org of [orgA, orgB]) {
    await withOrg(org, (tx) =>
      tx.query(
        `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
         VALUES ($1, 'accounting', true, clock_timestamp())`,
        [org],
      ),
    );
  }
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
  // VX1-1's OTHER three reference tables — legal_entity, business_unit,
  // department — added by VX2-10, and found by the coverage guard it introduced
  // rather than by anybody noticing. They had correct RLS from migration 0002 and
  // no test naming them, for six phases: exactly the state that guard exists to
  // detect, since the policy guard alone would have stayed green forever.
  //
  // Worth isolating on their own merits, not just for the count: together they
  // are a tenant's ORG CHART and legal footprint. One leaked row tells another
  // tenant which countries you operate in, what your subsidiaries are called, and
  // how your business is divided up.
  for (const [org, label] of [
    [orgA, 'A'],
    [orgB, 'B'],
  ] as const) {
    await withOrg(org, async (tx) => {
      await tx.query(
        `INSERT INTO legal_entity (organization_id, name, country, currency_code)
         VALUES ($1, $2, 'CA', 'CAD')`,
        [org, `Entity ${label}`],
      );
      await tx.query(
        'INSERT INTO business_unit (organization_id, name) VALUES ($1, $2)',
        [org, `Unit ${label}`],
      );
      // A parent and a child, so the SELF-REFERENCE is exercised too:
      // `department.parent_department_id` points at `department`, and a
      // hierarchy walk is the shape most likely to escape a tenant if the
      // policy were ever dropped.
      const parent = await tx.query(
        'INSERT INTO department (organization_id, name) VALUES ($1, $2) RETURNING id',
        [org, `Division ${label}`],
      );
      await tx.query(
        `INSERT INTO department (organization_id, name, parent_department_id)
         VALUES ($1, $2, $3)`,
        [org, `Team ${label}`, parent.rows[0].id],
      );
      // VX3-1: a rollup and a leaf, so `gl_account.parent_id` — the second
      // self-reference in this schema — is exercised the same way `department` is.
      // Both orgs deliberately use THE SAME account numbers: a chart of accounts
      // is numbered by convention, so two tenants having 68000/68100 is the normal
      // case, and it is the case where a missing tenant predicate would show up as
      // a picker listing every number twice.
      const rollup = await tx.query(
        `INSERT INTO gl_account (organization_id, number, name, type, is_postable, source)
         VALUES ($1, '68000', $2, 'expense', false, 'MANUAL') RETURNING id`,
        [org, `Travel M&E ${label}`],
      );
      const leaf = await tx.query(
        `INSERT INTO gl_account
             (organization_id, number, name, type, is_postable, source, parent_id)
         VALUES ($1, '68100', $2, 'expense', true, 'MANUAL', $3) RETURNING id`,
        [org, `Travel ${label}`, rollup.rows[0].id],
      );
      await tx.query(
        `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
         VALUES ($1, 'travel', $2, $3)`,
        [org, `Travel ${label}`, leaf.rows[0].id],
      );
      // VX3-3: a connected integration per tenant. Both use the SAME `code`
      // ('main'), because `code` is unique per ORGANIZATION and two tenants
      // naming their connection the same thing is the normal case — and it is the
      // case a missing tenant predicate would surface as a duplicate-key error
      // rather than as a leak, which is a much easier bug to miss.
      const installation = await tx.query(
        `INSERT INTO integration_installation
             (organization_id, integration_slug, code, label, active, config)
         VALUES ($1, 'stub-ledger', 'main', $2, true, $3::jsonb)
         RETURNING id`,
        [org, `Ledger ${label}`, JSON.stringify({ ledgerUrl: `https://${label}.test` })],
      );
      // VX3-8: an in-flight authorisation attempt per tenant. `0020` gives this
      // table a SECOND policy gated on `app.platform_task`, because the OAuth
      // callback arrives with no session and has to find out which tenant it
      // belongs to — so, like `notification_delivery` and `action_token`, it needs
      // both halves proven: that a tenant sees only its own, AND that the hatch is
      // as narrow as it claims. The row it holds is a credential's hash, which is
      // why it is worth more than a box-tick.
      await tx.query(
        `INSERT INTO integration_oauth_state
             (organization_id, installation_id, state_hash, redirect_uri, expires_at,
              created_by_id)
         SELECT $1, $2, $3, $4, clock_timestamp() + interval '10 minutes', id
           FROM app_user WHERE organization_id = $1 LIMIT 1`,
        [
          org,
          installation.rows[0].id,
          (label === 'A' ? 'e' : 'f').repeat(64),
          `https://${label}.test/api/integrations/stub-oauth/callback`,
        ],
      );
    });
  }
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
      // VX2-6: the audit log from migration 0010. The most sensitive table in
      // the schema — it records who did what to whose money, and one leaked
      // entry hands another tenant an actor name, an action and a timestamp.
      // The genesis row of each tenant's chain, so prev_hash is NULL and the
      // one-genesis-per-tenant index is exercised by having two tenants each
      // carry one.
      await tx.query(
        `INSERT INTO audit_entry
           (organization_id, actor_id, actor_name, actor_role, action,
            entity_type, entity_id, details, prev_hash, entry_hash)
         VALUES ($1, $2, $3, 'ADMIN', 'REPORT_SUBMITTED', 'expense_report', $4,
                 $5::jsonb, NULL, $6)`,
        [
          org,
          approver.rows[0].id,
          `Actor ${label}`,
          report,
          JSON.stringify({ totalMinor: '1000' }),
          // A 64-char lowercase-hex string, as audit_entry_hash_shape requires.
          // Not a real hash — this suite tests RLS, not the chain (see
          // test/audit.db.test.ts for that).
          (label === 'A' ? 'a' : 'b').repeat(64),
        ],
      );
      // VX2-7: the notification core from migration 0011 — activity,
      // notification, notification_preference, notification_template.
      //
      // `activity.subject_id` is the reason this block matters more than a
      // box-tick. It is a polymorphic uuid with NO foreign key — it cannot have
      // one — so unlike every other tenant table here there is no FK acting as a
      // second line of defence, and RLS is the whole guard (GAP-AUDIT NT-1).
      const activity = await tx.query(
        `INSERT INTO activity
           (organization_id, subject_type, subject_id, event_type, actor_id, payload)
         VALUES ($1, 'EXPENSE_REPORT', $2, 'APPROVED', $3, $4::jsonb)
         RETURNING id`,
        [org, report, approver.rows[0].id, JSON.stringify({ report: `Report ${label}` })],
      );
      await tx.query(
        `INSERT INTO notification (organization_id, activity_id, recipient_id)
         SELECT $1, $2, id FROM app_user WHERE organization_id = $1 AND email = $3`,
        [org, activity.rows[0].id, owner],
      );
      await tx.query(
        `INSERT INTO notification_preference
           (organization_id, user_id, event_type, channel, enabled)
         SELECT $1, id, 'APPROVED', 'IN_APP', false
           FROM app_user WHERE organization_id = $1 AND email = $2`,
        [org, owner],
      );
      await tx.query(
        `INSERT INTO notification_template
           (organization_id, template_key, channel, body)
         VALUES ($1, 'expense_management.report_approved', 'IN_APP', $2::jsonb)`,
        [org, JSON.stringify({ en: `Wording ${label}` })],
      );
      // VX2-8: the outbox and the approve-link tokens from migration 0012.
      // Both carry a SECOND policy gated on `app.platform_task`, so this block
      // has to prove two things rather than one — that a tenant sees only its
      // own, AND that the hatch is as narrow as it claims. See the
      // `platform_task` cases below.
      const notif = await tx.query(
        `SELECT id FROM notification WHERE organization_id = $1 LIMIT 1`,
        [org],
      );
      const delivery = await tx.query(
        `INSERT INTO notification_delivery
           (organization_id, notification_id, channel, last_error)
         VALUES ($1, $2, 'EMAIL', $3)
         RETURNING id`,
        [org, notif.rows[0].id, `Error ${label}`],
      );
      await tx.query(
        `INSERT INTO action_token
           (organization_id, token_hash, task_id, action, recipient_id, expires_at, delivery_id)
         SELECT $1, $2, t.id, 'APPROVE', $3, now() + interval '5 days', $4
           FROM approval_task t WHERE t.organization_id = $1 LIMIT 1`,
        [
          org,
          // A 64-char lowercase-hex string, as action_token_hash_shape requires.
          (label === 'A' ? 'c' : 'd').repeat(64),
          approver.rows[0].id,
          delivery.rows[0].id,
        ],
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
    const a = await withOrg(orgA, (tx) =>
      tx.query('SELECT label FROM expense_category ORDER BY label'),
    );
    // 'Travel A' arrived with VX3-1's fixture, which needed a category to map to
    // an account. This exact-list pin is why that showed up as a failing test
    // rather than as a silently longer list — worth leaving exact for the same
    // reason.
    expect(a.rows.map((r) => r.label)).toEqual(['Meals A', 'Travel A']);
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
      audit: (await tx.query('SELECT actor_name FROM audit_entry')).rows.map((r) => r.actor_name),
    }));
    expect(a).toEqual({
      ladder: ['Ladder A'],
      signers: ['Signer A'],
      requests: 1,
      tasks: ['Task A'],
      delegations: ['Delegation A'],
      audit: ['Actor A'],
    });

    const none = await withoutOrg(async (tx) => ({
      ladder: (await tx.query('SELECT * FROM approval_policy')).rows.length,
      signers: (await tx.query('SELECT * FROM approval_policy_approver')).rows.length,
      requests: (await tx.query('SELECT * FROM approval_request')).rows.length,
      tasks: (await tx.query('SELECT * FROM approval_task')).rows.length,
      delegations: (await tx.query('SELECT * FROM delegation')).rows.length,
      audit: (await tx.query('SELECT * FROM audit_entry')).rows.length,
    }));
    expect(none).toEqual({
      ladder: 0,
      signers: 0,
      requests: 0,
      tasks: 0,
      delegations: 0,
      audit: 0,
    });
  });

  it('the reference tables — entities, units and departments — are tenant-isolated', async () => {
    const a = await withOrg(orgA, async (tx) => ({
      entities: (await tx.query('SELECT name FROM legal_entity')).rows.map((r) => r.name),
      units: (await tx.query('SELECT name FROM business_unit')).rows.map((r) => r.name),
      departments: (await tx.query('SELECT name FROM department ORDER BY name')).rows.map(
        (r) => r.name,
      ),
    }));
    expect(a).toEqual({
      entities: ['Entity A'],
      units: ['Unit A'],
      departments: ['Division A', 'Team A'],
    });

    const none = await withoutOrg(async (tx) => ({
      entities: (await tx.query('SELECT * FROM legal_entity')).rows.length,
      units: (await tx.query('SELECT * FROM business_unit')).rows.length,
      departments: (await tx.query('SELECT * FROM department')).rows.length,
    }));
    expect(none).toEqual({ entities: 0, units: 0, departments: 0 });
  });

  it('a department hierarchy cannot be walked across tenants', async () => {
    // `department.parent_department_id` references `department`, so the join walk
    // is a table onto ITSELF — and both ends are independently RLS-scoped. The
    // one-row answer is the guarantee: org A sees its own child joined to its own
    // parent and nothing of org B's identically-shaped pair.
    const rows = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT child.name AS child, parent.name AS parent
           FROM department child
           JOIN department parent ON parent.id = child.parent_department_id`,
      ),
    );
    expect(rows.rows).toEqual([{ child: 'Team A', parent: 'Division A' }]);
  });

  it('activities, notifications, preferences and template wording are tenant-isolated', async () => {
    const a = await withOrg(orgA, async (tx) => ({
      activities: (await tx.query("SELECT payload->>'report' AS r FROM activity")).rows.map(
        (r) => r.r,
      ),
      notifications: (await tx.query('SELECT id FROM notification')).rows.length,
      preferences: (await tx.query('SELECT event_type FROM notification_preference')).rows.map(
        (r) => r.event_type,
      ),
      // The one that would be most embarrassing to leak: a tenant's own words.
      wording: (await tx.query("SELECT body->>'en' AS w FROM notification_template")).rows.map(
        (r) => r.w,
      ),
    }));
    expect(a).toEqual({
      activities: ['Report A'],
      notifications: 1,
      preferences: ['APPROVED'],
      wording: ['Wording A'],
    });

    const none = await withoutOrg(async (tx) => ({
      activities: (await tx.query('SELECT * FROM activity')).rows.length,
      notifications: (await tx.query('SELECT * FROM notification')).rows.length,
      preferences: (await tx.query('SELECT * FROM notification_preference')).rows.length,
      wording: (await tx.query('SELECT * FROM notification_template')).rows.length,
    }));
    expect(none).toEqual({ activities: 0, notifications: 0, preferences: 0, wording: 0 });
  });

  it('deliveries and approve-link tokens are tenant-isolated', async () => {
    const a = await withOrg(orgA, async (tx) => ({
      // The failure reason is the sensitive part: an SMTP rejection names an
      // address, and this table is the one place it is stored verbatim.
      deliveries: (await tx.query('SELECT last_error FROM notification_delivery')).rows.map(
        (r) => r.last_error,
      ),
      // The most sensitive row in the schema after audit_entry: a live token hash
      // is one half of a credential that decides money.
      tokens: (await tx.query('SELECT token_hash FROM action_token')).rows.map((r) =>
        (r.token_hash as string).slice(0, 1),
      ),
    }));
    expect(a).toEqual({ deliveries: ['Error A'], tokens: ['c'] });

    const none = await withoutOrg(async (tx) => ({
      deliveries: (await tx.query('SELECT * FROM notification_delivery')).rows.length,
      tokens: (await tx.query('SELECT * FROM action_token')).rows.length,
    }));
    expect(none).toEqual({ deliveries: 0, tokens: 0 });
  });

  it('the platform_task hatch is narrow: due work and live tokens, read-only', async () => {
    // `0012` gives these two tables a SECOND policy so a poller and an
    // approve-link click can work without a tenant. A hatch that turned out to be
    // a master key would be the worst defect in this schema, so it gets its own
    // test rather than riding on the block above.
    // `withPlatformRead` itself, not a hand-rolled equivalent — the helper is
    // what ships, so it is the thing worth testing.
    const hatch = withPlatformRead;

    // (1) It DOES see both tenants' due work — that is the point of it.
    const due = await hatch((tx) =>
      tx.query('SELECT organization_id FROM notification_delivery'),
    );
    expect(due.rows).toHaveLength(2);
    expect(new Set(due.rows.map((r) => r.organization_id))).toEqual(new Set([orgA, orgB]));

    // (2) It does NOT see settled work. Mark one SENT and it disappears from the
    // hatch while staying visible to its tenant.
    await admin.query(
      "UPDATE notification_delivery SET status = 'SENT', sent_at = now() WHERE organization_id = $1",
      [orgA],
    );
    const afterSend = await hatch((tx) =>
      tx.query('SELECT organization_id FROM notification_delivery'),
    );
    expect(afterSend.rows.map((r) => r.organization_id)).toEqual([orgB]);
    expect(
      (await withOrg(orgA, (tx) => tx.query('SELECT status FROM notification_delivery'))).rows,
    ).toEqual([{ status: 'SENT' }]);

    // (3) It is READ-ONLY. `platform_read` is FOR SELECT, so an UPDATE matches no
    // row — RLS filters rather than raising, and zero rows affected IS the
    // refusal.
    const wrote = await hatch((tx) =>
      tx.query("UPDATE notification_delivery SET status = 'CANCELLED'"),
    );
    expect(wrote.rowCount).toBe(0);

    // (4) It sees live tokens and not consumed ones — which is what makes
    // "reject an expired or used token" a row that is absent rather than an `if`.
    expect((await hatch((tx) => tx.query('SELECT id FROM action_token'))).rows).toHaveLength(2);
    await admin.query('UPDATE action_token SET consumed_at = now() WHERE organization_id = $1', [
      orgA,
    ]);
    expect((await hatch((tx) => tx.query('SELECT id FROM action_token'))).rows).toHaveLength(1);
    await admin.query("UPDATE action_token SET expires_at = now() - interval '1 day'");
    expect((await hatch((tx) => tx.query('SELECT id FROM action_token'))).rows).toHaveLength(0);

    // (5) And the flag does NOTHING on any other tenant table. It is not a
    // master key, and adding it to a third table has to be a migration somebody
    // writes on purpose.
    const elsewhere = await hatch(async (tx) => ({
      reports: (await tx.query('SELECT * FROM expense_report')).rows.length,
      audit: (await tx.query('SELECT * FROM audit_entry')).rows.length,
      users: (await tx.query('SELECT * FROM app_user')).rows.length,
      notifications: (await tx.query('SELECT * FROM notification')).rows.length,
    }));
    expect(elsewhere).toEqual({ reports: 0, audit: 0, users: 0, notifications: 0 });
  });

  it('a notification cannot be joined back to another tenant report', async () => {
    // THE test NT-1 asks for, and the reason it is separate from the block
    // above: `activity.subject_id` is a bare uuid with no FK, so this walk —
    // notification -> activity -> (subject_id) -> expense_report — is the exact
    // shape a leaked report id would exploit. The join predicate is
    // `r.id = a.subject_id` with nothing structural forcing the two rows into
    // the same tenant; only the policy on `expense_report` does.
    const rows = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT r.title, a.event_type
           FROM notification n
           JOIN activity a ON a.id = n.activity_id
           JOIN expense_report r ON r.id = a.subject_id`,
      ),
    );
    expect(rows.rows).toEqual([{ title: 'Report A', event_type: 'APPROVED' }]);

    // And the direct attempt: org A asking for org B's report by its real id,
    // through the un-FK'd column. Zero rows, not an error — RLS filters, it does
    // not raise.
    //
    // The id is fetched on the ADMIN connection, not through `withoutOrg`:
    // `withoutOrg` still connects as `veloapp`, which is subject to FORCE RLS,
    // so with no org set it would return zero rows and this lookup would throw
    // on `rows[0]` — proving RLS works and testing nothing about the attack.
    const reportBId = (
      await admin.query("SELECT id FROM expense_report WHERE title = 'Report B'")
    ).rows[0].id as string;
    const crossed = await withOrg(orgA, (tx) =>
      tx.query('SELECT id FROM activity WHERE subject_id = $1', [reportBId]),
    );
    expect(crossed.rows).toHaveLength(0);
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

  it('the chart of accounts is tenant-isolated, and two tenants may share numbers', async () => {
    // VX3-1. Both orgs have 68000 and 68100; each must see exactly its own two.
    const seen = async (org: string) =>
      withOrg(org, async (tx) => ({
        numbers: (await tx.query('SELECT number FROM gl_account ORDER BY number')).rows.map(
          (r) => r.number,
        ),
        names: (await tx.query('SELECT name FROM gl_account ORDER BY number')).rows.map(
          (r) => r.name,
        ),
      }));
    expect(await seen(orgA)).toEqual({
      numbers: ['68000', '68100'],
      names: ['Travel M&E A', 'Travel A'],
    });
    expect(await seen(orgB)).toEqual({
      numbers: ['68000', '68100'],
      names: ['Travel M&E B', 'Travel B'],
    });
    // And nothing at all with the context unset — `withoutOrg` connects as the
    // same non-superuser under FORCE RLS, so every policy body is NULL.
    const blind = await withoutOrg((tx) => tx.query('SELECT count(*)::int AS n FROM gl_account'));
    expect(blind.rows[0].n).toBe(0);
  });

  it('an account hierarchy cannot be walked across tenants', async () => {
    // The same shape as the department walk above, and worth repeating rather
    // than trusting: a rollup/leaf join is exactly what a chart-of-accounts
    // picker does, and both tenants use the same numbers, so a missing predicate
    // produces four rows that look plausible instead of an obvious error.
    const walk = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT child.name AS child, parent.name AS parent
           FROM gl_account child
           JOIN gl_account parent ON parent.id = child.parent_id
          ORDER BY child.number`,
      ),
    );
    expect(walk.rows).toEqual([{ child: 'Travel A', parent: 'Travel M&E A' }]);
  });

  it('a category cannot be mapped to another tenant\'s account', async () => {
    // TN-1: a plain `REFERENCES gl_account(id)` would ALLOW this, because Postgres
    // checks referential integrity with RLS bypassed. `0014` declares the FK as
    // composite through organization_id, which refuses it structurally. This test
    // is the one that fails if anyone ever simplifies that constraint back.
    const foreignAccount = await withOrg(orgB, (tx) =>
      tx.query("SELECT id FROM gl_account WHERE number = '68100'"),
    );
    const foreignId = foreignAccount.rows[0].id as string;
    await expect(
      withOrg(orgA, (tx) =>
        tx.query("UPDATE expense_category SET gl_account_id = $1 WHERE code = 'travel'", [
          foreignId,
        ]),
      ),
    ).rejects.toThrow();
    // And A's own mapping is untouched by the attempt.
    const mapping = await withOrg(orgA, (tx) =>
      tx.query(
        `SELECT g.name FROM expense_category c
           JOIN gl_account g ON g.id = c.gl_account_id WHERE c.code = 'travel'`,
      ),
    );
    expect(mapping.rows[0].name).toBe('Travel A');
  });

  it('nothing may be coded to a rollup account', async () => {
    // Ported guard, VeloLedger 0028: "a line hit 40000 and vanished from the
    // presentation". Enforced by a trigger rather than in the action layer, so it
    // holds for paths nobody has written yet — including this one, which goes
    // straight to SQL.
    const rollup = await withOrg(orgA, (tx) =>
      tx.query("SELECT id FROM gl_account WHERE number = '68000'"),
    );
    await expect(
      withOrg(orgA, (tx) =>
        tx.query("UPDATE expense_category SET gl_account_id = $1 WHERE code = 'travel'", [
          rollup.rows[0].id,
        ]),
      ),
    ).rejects.toThrow(/rollup/i);
  });


  it('integration installations are tenant-isolated, including their config', async () => {
    // VX3-3. The config blob holds credentials, so this is the one isolation
    // assertion in this file where a leak would be a disclosure of somebody's
    // accounting system rather than of their expense data.
    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query(
          'SELECT label, config->>\'ledgerUrl\' AS url FROM integration_installation',
        );
        return r.rows.map((row) => `${row.label} @ ${row.url}`);
      });
    expect(await seen(orgA)).toEqual(['Ledger A @ https://A.test']);
    expect(await seen(orgB)).toEqual(['Ledger B @ https://B.test']);
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM integration_installation'),
    );
    expect(blind.rows[0].n).toBe(0);
  });

  it('authorisation attempts are tenant-isolated, and the hatch is narrow', async () => {
    // VX3-8. The value stored is the sha256 of a state parameter — a credential
    // that, replayed, attaches somebody else's accounting account to this tenant's
    // installation. So both halves matter.
    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query('SELECT state_hash FROM integration_oauth_state');
        return r.rows.map((row) => (row.state_hash as string).slice(0, 1));
      });
    expect(await seen(orgA)).toEqual(['e']);
    expect(await seen(orgB)).toEqual(['f']);
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM integration_oauth_state'),
    );
    expect(blind.rows[0].n).toBe(0);

    // The hatch sees both tenants' LIVE attempts — that is what lets a callback
    // with no session find its tenant — and stops seeing one the moment it is
    // consumed or expired, which is what makes "reject a replay" an absent row
    // rather than an `if`.
    const live = await withPlatformRead((tx) =>
      tx.query('SELECT organization_id FROM integration_oauth_state'),
    );
    expect(live.rows).toHaveLength(2);
    await admin.query(
      'UPDATE integration_oauth_state SET consumed_at = clock_timestamp() WHERE organization_id = $1',
      [orgA],
    );
    const afterConsume = await withPlatformRead((tx) =>
      tx.query('SELECT organization_id FROM integration_oauth_state'),
    );
    expect(afterConsume.rows.map((r) => r.organization_id)).toEqual([orgB]);
    await admin.query(
      "UPDATE integration_oauth_state SET expires_at = clock_timestamp() - interval '1 second'",
    );
    expect(
      (await withPlatformRead((tx) => tx.query('SELECT id FROM integration_oauth_state'))).rows,
    ).toHaveLength(0);
  });

  it('module entitlements are tenant-isolated, in both directions', async () => {
    // VX4-1. This table decides what a customer may USE, so the two halves are
    // "can A read B's terms" and "can A write itself into B's". A tenant able to
    // insert a row for another organization could switch a paid module on for
    // somebody else — or, read the other way, learn what a competitor is buying.
    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query('SELECT organization_id FROM module_entitlement');
        return r.rows.map((row) => row.organization_id as string);
      });
    expect(await seen(orgA)).toEqual([orgA]);
    expect(await seen(orgB)).toEqual([orgB]);

    // An unset context sees nothing, which is what makes a job that forgets to set
    // the tenant fail closed rather than fan out across the estate.
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM module_entitlement'),
    );
    expect(blind.rows[0].n).toBe(0);

    // And WITH CHECK refuses the write.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO module_entitlement (organization_id, module_code, enabled)
           VALUES ($1, 'analytics', true)`,
          [orgB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('WITH CHECK rejects an installation written into another tenant', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO integration_installation
               (organization_id, integration_slug, code, label)
           VALUES ($1, 'stub-ledger', 'smuggled', 'Smuggled')`,
          [orgB],
        ),
      ),
    ).rejects.toThrow();
  });


  it('ledger posts are tenant-isolated, and the platform hatch is narrow', async () => {
    // VX3-4. Both tenants queue a post for their own report; neither sees the
    // other's, and the poller's hatch exposes only DUE work.
    const queued: Record<string, string> = {};
    for (const [org, label] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ] as const) {
      const id = await withOrg(org, async (tx) => {
        const rep = await tx.query(
          `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code,
                                       status, approved_at)
             SELECT $1, u.id, $2, 'CAD', 'APPROVED', clock_timestamp()
               FROM app_user u WHERE u.organization_id = $1 LIMIT 1
           RETURNING id`,
          [org, `Ledger report ${label}`],
        );
        const reportId = rep.rows[0].id as string;
        await tx.query(
          `INSERT INTO integration_post (organization_id, report_id, idempotency_key)
           VALUES ($1, $2, $3)`,
          [org, reportId, `key-${label}`],
        );
        return reportId;
      });
      queued[label] = id;
    }

    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query('SELECT idempotency_key FROM integration_post');
        return r.rows.map((row) => row.idempotency_key as string);
      });
    expect(await seen(orgA)).toEqual(['key-A']);
    expect(await seen(orgB)).toEqual(['key-B']);
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM integration_post'),
    );
    expect(blind.rows[0].n).toBe(0);

    // The hatch sees both tenants' DUE rows — that is its purpose — and stops
    // seeing a row the moment it is no longer due work.
    const due = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM integration_post'),
    );
    expect(due.rows[0].n).toBe(2);
    await withOrg(orgA, (tx) =>
      tx.query(
        `UPDATE integration_post SET status = 'NEEDS_REVIEW' WHERE idempotency_key = 'key-A'`,
      ),
    );
    const afterReview = await withPlatformRead((tx) =>
      tx.query('SELECT idempotency_key FROM integration_post'),
    );
    expect(afterReview.rows.map((r) => r.idempotency_key)).toEqual(['key-B']);
  });

  /* ── budgets (VX4-5, migration 0024) ─────────────────────────────────────
   *
   * Added because the RLS-isolation-COVERAGE guard failed CI on PR #77 with
   * "Tenant tables absent from test/rls-isolation.test.ts: budget
   * budget_period". That is the guard working exactly as intended: a new tenant
   * table whose policy nobody exercises is a policy nobody has checked, and
   * `test/budgets.db.test.ts` asserting isolation in ITS OWN file does not
   * satisfy the gate — deliberately, because this file is the one place a
   * reviewer can read every tenant table's isolation in a single pass.
   */
  it('budgets and their periods are tenant-isolated, and a cross-tenant write is refused', async () => {
    const accountOf = (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query("SELECT id FROM gl_account WHERE number = '68100'");
        return r.rows[0].id as string;
      });
    const accountA = await accountOf(orgA);
    const accountB = await accountOf(orgB);

    // One budget and one period per tenant, with the SAME name and the same
    // dates: identical rows are what make a missing predicate produce plausible
    // duplicates rather than an obvious error.
    for (const [org, account] of [
      [orgA, accountA],
      [orgB, accountB],
    ] as const) {
      await withOrg(org, async (tx) => {
        const b = await tx.query(
          `INSERT INTO budget (organization_id, name, gl_account_id, currency_code, fiscal_year)
           VALUES ($1,'Travel 2026',$2,'CAD',2026) RETURNING id`,
          [org, account],
        );
        await tx.query(
          `INSERT INTO budget_period
             (organization_id, budget_id, starts_on, ends_on, amount_minor)
           VALUES ($1,$2,'2026-01-01','2026-01-31',500000)`,
          [org, b.rows[0].id],
        );
      });
    }

    const seen = async (org: string) =>
      withOrg(org, async (tx) => ({
        budgets: (await tx.query('SELECT count(*)::int AS n FROM budget')).rows[0].n,
        periods: (await tx.query('SELECT count(*)::int AS n FROM budget_period')).rows[0].n,
      }));
    expect(await seen(orgA)).toEqual({ budgets: 1, periods: 1 });
    expect(await seen(orgB)).toEqual({ budgets: 1, periods: 1 });

    // Unset context under FORCE RLS sees nothing on either table.
    const blind = await withoutOrg(async (tx) => ({
      budgets: (await tx.query('SELECT count(*)::int AS n FROM budget')).rows[0].n,
      periods: (await tx.query('SELECT count(*)::int AS n FROM budget_period')).rows[0].n,
    }));
    expect(blind).toEqual({ budgets: 0, periods: 0 });

    // WITH CHECK refuses a write stamped with the other tenant's id.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO budget (organization_id, name, gl_account_id, currency_code, fiscal_year)
           VALUES ($1,'Smuggled',$2,'CAD',2027)`,
          [orgB, accountB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('a budget cannot reference another tenant\'s GL account (TN-1)', async () => {
    // A plain `REFERENCES gl_account(id)` would ALLOW this: Postgres checks
    // referential integrity as the constraint owner with RLS BYPASSED. `0024`
    // declares the FK composite through organization_id, so the refusal is
    // structural rather than a predicate somebody could forget.
    const foreignAccount = await withOrg(orgB, (tx) =>
      tx.query("SELECT id FROM gl_account WHERE number = '68100'"),
    );
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO budget (organization_id, name, gl_account_id, currency_code, fiscal_year)
           VALUES ($1,'Foreign account',$2,'CAD',2028)`,
          [orgA, foreignAccount.rows[0].id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('a ledger post cannot reference another tenant\'s report', async () => {
    // TN-1 again, on a table where the reference decides where money is proposed
    // to move. 0017 declares the FK composite, so this is structural.
    const foreign = await withOrg(orgB, (tx) =>
      tx.query("SELECT id FROM expense_report WHERE title = 'Ledger report B'"),
    );
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO integration_post (organization_id, report_id, idempotency_key)
           VALUES ($1, $2, 'smuggled')`,
          [orgA, foreign.rows[0].id],
        ),
      ),
    ).rejects.toThrow();
  });

});
