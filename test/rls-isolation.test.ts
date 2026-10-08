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
import {
  withOrg,
  withoutOrg,
  withInviteLookup,
  withPlatformRead,
  withSignupContext,
} from '@/lib/tenant/context';

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
         VALUES ($1, 'accounting', true, clock_timestamp()),
                ($1, 'budgets',    true, clock_timestamp())`,
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
    tx.query(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals A"}')`, [orgA]),
  );
  await withOrg(orgB, (tx) =>
    tx.query(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals B"}')`, [orgB]),
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
        "INSERT INTO business_unit (organization_id, label) VALUES ($1, jsonb_build_object('en', $2::text))",
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
         VALUES ($1, 'travel', jsonb_build_object('en', $2::text), $3)`,
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
      tx.query("SELECT label ->> 'en' AS label FROM expense_category ORDER BY label ->> 'en'"),
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
      units: (await tx.query("SELECT label ->> 'en' AS name FROM business_unit")).rows.map((r) => r.name),
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
    // EVERY visible row belongs to the asking tenant — not "there is exactly one".
    // The count form broke the day VX4-5 part 3a entitled a second module, which
    // is a test asserting the fixture rather than the property. `not.toHaveLength(0)`
    // is what stops the new form passing vacuously on an empty read.
    for (const org of [orgA, orgB]) {
      const rows = await seen(org);
      expect(rows).not.toHaveLength(0);
      expect([...new Set(rows)]).toEqual([org]);
    }

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

  /* ── budget alerts (VX4-5 part 3a, migration 0025) ───────────────────────
   *
   * Placed AFTER the two budget tests above, which assert exact row counts —
   * anything creating a budget earlier in this file would break them. The
   * ordering is load-bearing and this comment is the warning.
   */
  it('budget alert thresholds, recipients and claims are tenant-isolated', async () => {
    const setUp = (org: string) =>
      withOrg(org, async (tx) => {
        const b = await tx.query(
          `SELECT id FROM budget WHERE name = 'Travel 2026'`,
        );
        const p = await tx.query('SELECT id FROM budget_period WHERE budget_id = $1', [
          b.rows[0].id,
        ]);
        const t = await tx.query(
          `INSERT INTO budget_alert_threshold (organization_id, budget_id, threshold_bp)
           VALUES ($1,$2,9000) RETURNING id`,
          [org, b.rows[0].id],
        );
        const u = await tx.query('SELECT id FROM app_user LIMIT 1');
        await tx.query(
          `INSERT INTO budget_alert_recipient (organization_id, threshold_id, user_id)
           VALUES ($1,$2,$3)`,
          [org, t.rows[0].id, u.rows[0].id],
        );
        await tx.query(
          `INSERT INTO budget_alert_claim
             (organization_id, period_id, threshold_bp, used_minor, amount_minor)
           VALUES ($1,$2,9000,450000,500000)`,
          [org, p.rows[0].id],
        );
        return { budgetId: b.rows[0].id as string, thresholdId: t.rows[0].id as string };
      });
    const a = await setUp(orgA);
    await setUp(orgB);

    const counts = (org: string) =>
      withOrg(org, async (tx) => ({
        thresholds: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_threshold'))
          .rows[0].n,
        recipients: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_recipient'))
          .rows[0].n,
        claims: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_claim')).rows[0].n,
      }));
    expect(await counts(orgA)).toEqual({ thresholds: 1, recipients: 1, claims: 1 });
    expect(await counts(orgB)).toEqual({ thresholds: 1, recipients: 1, claims: 1 });

    const blind = await withoutOrg(async (tx) => ({
      thresholds: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_threshold'))
        .rows[0].n,
      claims: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_claim')).rows[0].n,
    }));
    expect(blind).toEqual({ thresholds: 0, claims: 0 });

    // TN-1: a recipient row cannot point at another tenant's threshold, and the
    // refusal is the composite FK rather than a predicate somebody could forget.
    const ownUser = await withOrg(orgB, (tx) => tx.query('SELECT id FROM app_user LIMIT 1'));
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO budget_alert_recipient (organization_id, threshold_id, user_id)
           VALUES ($1,$2,$3)`,
          [orgB, a.thresholdId, ownUser.rows[0].id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('turning the budgets module off makes every budget table unreadable (0025)', async () => {
    // The gate `0024` should have carried. `app_module_enabled('budgets')` is in
    // the policy body, so this is true for every code path rather than for the
    // ones somebody remembered — MT-3's whole point.
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'budgets'`,
      [orgA],
    );
    try {
      const gated = await withOrg(orgA, async (tx) => ({
        budgets: (await tx.query('SELECT count(*)::int AS n FROM budget')).rows[0].n,
        periods: (await tx.query('SELECT count(*)::int AS n FROM budget_period')).rows[0].n,
        thresholds: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_threshold'))
          .rows[0].n,
        claims: (await tx.query('SELECT count(*)::int AS n FROM budget_alert_claim')).rows[0].n,
      }));
      expect(gated).toEqual({ budgets: 0, periods: 0, thresholds: 0, claims: 0 });
      // And the other tenant is untouched, so this is the MODULE gate and not a
      // tenant predicate that happens to be failing.
      const other = await withOrg(orgB, (tx) =>
        tx.query('SELECT count(*)::int AS n FROM budget'),
      );
      expect(other.rows[0].n).toBe(1);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'budgets'`,
        [orgA],
      );
    }
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

  /* ── fraud flags (VX4-8 part 2, migration 0031) ───────────────────────────
   *
   * Here because CI's RLS-isolation-COVERAGE guard requires it — a new tenant
   * table nobody exercises here is a policy nobody has checked. Same reason
   * `budget` and `budget_period` were added on PR #77.
   */
  it('fraud flags are tenant-isolated, and a flag cannot name another tenant\'s report', async () => {
    const reportOf = async (org: string, title: string) => {
      const r = await withOrg(org, (tx) =>
        tx.query('SELECT id FROM expense_report WHERE title = $1', [title]),
      );
      return r.rows[0].id as string;
    };
    const reportA = await reportOf(orgA, 'Ledger report A');
    const reportB = await reportOf(orgB, 'Ledger report B');

    for (const [org, reportId, key] of [
      [orgA, reportA, 'DUPLICATE:a'],
      [orgB, reportB, 'DUPLICATE:b'],
    ] as const) {
      await withOrg(org, (tx) =>
        tx.query(
          `INSERT INTO fraud_flag (organization_id, rule_code, message_code, report_id, finding_key)
           VALUES ($1, 'DUPLICATE', 'DUPLICATE_SAME_REPORT', $2, $3)`,
          [org, reportId, key],
        ),
      );
    }

    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query('SELECT finding_key FROM fraud_flag ORDER BY finding_key');
        return r.rows.map((row) => row.finding_key as string);
      });
    expect(await seen(orgA)).toEqual(['DUPLICATE:a']);
    expect(await seen(orgB)).toEqual(['DUPLICATE:b']);
    const blind = await withoutOrg((tx) => tx.query('SELECT count(*)::int AS n FROM fraud_flag'));
    expect(blind.rows[0].n).toBe(0);

    // THE SAME finding_key in both tenants is legal, and that is the point of
    // scoping the unique key to the organization. Upstream's `dedupeKey` is
    // globally unique; this insert is the one their schema would refuse.
    await withOrg(orgA, (tx) =>
      tx.query(
        `INSERT INTO fraud_flag (organization_id, rule_code, message_code, report_id, finding_key)
         VALUES ($1, 'DUPLICATE', 'DUPLICATE_SAME_REPORT', $2, 'DUPLICATE:shared')`,
        [orgA, reportA],
      ),
    );
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO fraud_flag (organization_id, rule_code, message_code, report_id, finding_key)
           VALUES ($1, 'DUPLICATE', 'DUPLICATE_SAME_REPORT', $2, 'DUPLICATE:shared')`,
          [orgB, reportB],
        ),
      ),
    ).resolves.toBeDefined();

    // TN-1: the composite FK refuses another tenant's report even though the
    // referential check runs with RLS bypassed.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO fraud_flag (organization_id, rule_code, message_code, report_id, finding_key)
           VALUES ($1, 'DUPLICATE', 'DUPLICATE_SAME_REPORT', $2, 'DUPLICATE:smuggled')`,
          [orgA, reportB],
        ),
      ),
    ).rejects.toThrow();
  });

  /* ── control evaluation (VX4-8 part 3, migration 0032) ────────────────────
   *
   * Two more tenant tables, here for the coverage guard. The interesting one is
   * `control_finding.subject_id`, which has NO foreign key on purpose — a run is
   * a snapshot handed to an auditor and must not lose rows when its subject is
   * deleted. So the isolation assertion for it is RLS ONLY, and that is worth
   * asserting explicitly rather than assuming: the composite FK that protects
   * every other reference in this schema is deliberately absent here, and RLS is
   * all there is.
   */
  it('control runs and their findings are tenant-isolated', async () => {
    const runs: Record<string, string> = {};
    for (const [org, label] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ] as const) {
      runs[label] = await withOrg(org, async (tx) => {
        const r = await tx.query(
          `INSERT INTO control_evaluation_run
             (organization_id, period_start, period_end)
           VALUES ($1, now() - interval '90 days', now()) RETURNING id`,
          [org],
        );
        const runId = r.rows[0].id as string;
        await tx.query(
          `INSERT INTO control_finding
             (organization_id, run_id, control_code, severity, subject_type, subject_label,
              message_code)
           VALUES ($1, $2, 'GL_MAPPING_GAP', 'INFO', 'expense_category', $3, 'GL_MAPPING_GAP')`,
          [org, runId, `cat-${label}`],
        );
        return runId;
      });
    }

    const seen = async (org: string) =>
      withOrg(org, async (tx) => {
        const r = await tx.query('SELECT subject_label FROM control_finding');
        return r.rows.map((row) => row.subject_label as string);
      });
    expect(await seen(orgA)).toEqual(['cat-A']);
    expect(await seen(orgB)).toEqual(['cat-B']);
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM control_finding'),
    );
    expect(blind.rows[0].n).toBe(0);
    const blindRuns = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM control_evaluation_run'),
    );
    expect(blindRuns.rows[0].n).toBe(0);

    // The run reference IS composite and enforced — it is our own row, not a
    // subject that may legitimately disappear.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO control_finding
             (organization_id, run_id, control_code, severity, subject_type, message_code)
           VALUES ($1, $2, 'GL_MAPPING_GAP', 'INFO', 'expense_category', 'GL_MAPPING_GAP')`,
          [orgA, runs.B],
        ),
      ),
    ).rejects.toThrow();

    // And a finding's subject id is NOT constrained, by design: an arbitrary uuid
    // is accepted, because a snapshot has to survive its subject.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO control_finding
             (organization_id, run_id, control_code, severity, subject_type, subject_id,
              message_code)
           VALUES ($1, $2, 'STALE_DRAFT', 'WARNING', 'expense_report',
                   '00000000-0000-4000-8000-00000000dead', 'STALE_DRAFT')`,
          [orgA, runs.A],
        ),
      ),
    ).resolves.toBeDefined();
  });

  /* ── the module_entitlement hatch (VX4-8 part 4, migration 0033) ──────────
   *
   * The fourth `platform_read` policy, and the first on something that is not a
   * work table — a scheduled compliance scan has no due row to find its tenants
   * by, so it asks which tenants are entitled. Asserted here because a hatch
   * nobody exercises is a hatch nobody has checked, and because the interesting
   * half is what it CANNOT see.
   */
  it('a platform task can list entitled tenants, and nothing else', async () => {
    // Both tenants have `accounting` from the fixture; give A a disabled one.
    await admin.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled)
       VALUES ($1, 'compliance', false)
       ON CONFLICT (organization_id, module_code) DO UPDATE SET enabled = false`,
      [orgA],
    );
    await admin.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
       VALUES ($1, 'compliance', true, clock_timestamp())
       ON CONFLICT (organization_id, module_code) DO UPDATE SET enabled = true`,
      [orgB],
    );

    const seen = await withPlatformRead(async (tx) => {
      const r = await tx.query(
        `SELECT organization_id FROM module_entitlement WHERE module_code = 'compliance'`,
      );
      return r.rows.map((row) => row.organization_id as string);
    });
    // ENABLED ONLY. A's disabled row is invisible even to the hatch, so a
    // platform task cannot count who turned something off.
    expect(seen).toEqual([orgB]);

    // AND IT CANNOT WRITE — but not by throwing, which is what the first version
    // of this test asserted and got wrong.
    //
    // The 0033 policy is `FOR SELECT`, so it grants nothing to an UPDATE; the
    // `tenant_isolation` policy is the one that applies, and with no
    // `app.current_org` its USING clause matches no row. So the statement
    // SUCCEEDS and changes nothing. That is the correct outcome and the more
    // useful thing to know: a forbidden write under RLS is a no-op, not an error,
    // so code that checks only for a thrown exception would believe it had
    // written. `rowCount` is what says otherwise — which is why every write in
    // this codebase that must affect a row checks it (`claimPost`, `releaseHold`,
    // `recordVerdict`).
    const attempted = await withPlatformRead((tx) =>
      tx.query(`UPDATE module_entitlement SET enabled = false WHERE organization_id = $1`, [orgB]),
    );
    expect(attempted.rowCount).toBe(0);
    const unchanged = await admin.query(
      `SELECT enabled FROM module_entitlement
        WHERE organization_id = $1 AND module_code = 'compliance'`,
      [orgB],
    );
    expect(unchanged.rows[0].enabled).toBe(true);

    // With no tenant context and no hatch, nothing at all.
    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM module_entitlement'),
    );
    expect(blind.rows[0].n).toBe(0);
  });

  /* ── the signup, which has no tenant at all (VX5-2, migration 0035) ───────
   *
   * `signup` carries `organization_id`, so both CI guards demand it appear
   * here. What it does NOT carry is a `tenant_isolation` policy, and that is
   * deliberate: a signup row is PLATFORM data — an email address belonging to
   * somebody who is not a customer yet and may never be — so the claim being
   * asserted below is stronger than isolation. Not "org A cannot see org B's
   * signup" but "NO tenant can see ANY signup, including the one that created
   * it".
   *
   * That distinction is the reason this block exists rather than a line in the
   * table list. The coverage guard can prove a table is named; it cannot tell
   * the difference between a table whose tenant policy is absent on purpose and
   * one whose tenant policy somebody forgot. The assertions here are what says
   * which of the two this is — and they are what would fail if a later
   * migration "fixed" the omission by adding a tenant policy.
   *
   * The gates themselves — that `app.signup_task` finds a live row and cannot
   * consume it, that `app.signup_consume` can — are exercised in
   * test/signup.db.test.ts. This block is only about who is shut out.
   */
  it('signups belong to no tenant: invisible from every org, including their own', async () => {
    const liveHash = 'a'.repeat(64);
    const consumedHash = 'b'.repeat(64);

    // Two rows, written as superuser so the fixture does not depend on the very
    // gates under test. One PENDING and one CONSUMED — and the consumed one
    // names orgA, which is the interesting row: orgA exists BECAUSE of it.
    await admin.query(
      `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at)
       VALUES ('pending@x.com', 'Pending Co', 'pending-co', $1, clock_timestamp() + interval '1 day')`,
      [liveHash],
    );
    await admin.query(
      `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at,
                           consumed_at, organization_id)
       VALUES ('founder@x.com', 'Org A', 'org-a', $1, clock_timestamp() + interval '1 day',
               clock_timestamp(), $2)`,
      [consumedHash, orgA],
    );

    // POSITIVE CONTROL FIRST. Every count below is zero, and a zero is also what
    // a fixture that failed to insert would produce — so prove the rows are
    // there and findable by the one context entitled to find them before
    // reading anything into the zeros.
    const underGate = await withSignupContext((tx) =>
      tx.query('SELECT count(*)::int AS n FROM signup'),
    );
    expect(underGate.rows[0].n).toBe(1); // the live one; consumed rows leave the gate's view

    // ── the claim ──
    // orgA is the tenant that this signup created. It still cannot see it.
    const fromOwnOrg = await withOrg(orgA, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM signup WHERE organization_id = $1', [orgA]),
    );
    expect(fromOwnOrg.rows[0].n).toBe(0);

    for (const org of [orgA, orgB]) {
      const seen = await withOrg(org, (tx) =>
        tx.query('SELECT count(*)::int AS n FROM signup'),
      );
      expect(seen.rows[0].n).toBe(0);
    }

    // Not by email either — a tenant cannot probe for whether an address has
    // signed up, which is the shape a leak here would actually take.
    const probed = await withOrg(orgB, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM signup WHERE email = $1', ['pending@x.com']),
    );
    expect(probed.rows[0].n).toBe(0);

    // No context, nothing.
    const blind = await withoutOrg((tx) => tx.query('SELECT count(*)::int AS n FROM signup'));
    expect(blind.rows[0].n).toBe(0);

    // AND NOT THROUGH THE OTHER HATCH. `app.platform_task` is set by the
    // delivery poller and the approve-link handler; 0035 deliberately did not
    // reuse it. This is the assertion that would fail if somebody later widened
    // that flag instead of adding a new one.
    const viaPlatform = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM signup'),
    );
    expect(viaPlatform.rows[0].n).toBe(0);

    // ── and no tenant may write one ──
    // INSERT throws: with no policy granting INSERT under `app.current_org`,
    // the WITH CHECK of every applicable policy fails.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at)
           VALUES ('smuggled@x.com', 'Smuggled', 'smuggled', $1,
                   clock_timestamp() + interval '1 day')`,
          ['c'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // UPDATE does NOT throw — it matches nothing and reports it, the same no-op
    // the module_entitlement hatch shows above. A caller checking only for an
    // exception would believe it had consumed somebody's signup.
    const attempted = await withOrg(orgA, (tx) =>
      tx.query('UPDATE signup SET consumed_at = clock_timestamp() WHERE token_hash = $1', [
        liveHash,
      ]),
    );
    expect(attempted.rowCount).toBe(0);
    const stillPending = await admin.query(
      'SELECT consumed_at FROM signup WHERE token_hash = $1',
      [liveHash],
    );
    expect(stillPending.rows[0].consumed_at).toBeNull();

    // DELETE likewise: there is no DELETE policy at all, for anyone. A signup is
    // consumed or it expires; nothing removes it but the retention job.
    const deleted = await withOrg(orgA, (tx) =>
      tx.query('DELETE FROM signup WHERE token_hash = $1', [liveHash]),
    );
    expect(deleted.rowCount).toBe(0);

    await admin.query('DELETE FROM signup');
  });

  /* ── invitations (VX5-3, migration 0036) ──────────────────────────────────
   *
   * `invite` is tenant data, unlike `signup` — an invitation belongs to the
   * organization that sent it — so the ordinary claim applies and is asserted
   * first: org A cannot see org B's.
   *
   * The interesting half is the HATCH. `app.invite_lookup` exists so that
   * somebody signing in with no session can be told which tenant their token
   * belongs to, which means it can, by construction, see live invites in EVERY
   * organization. `resolveInviteTenant`'s rule is that the caller takes nothing
   * from it but the tenant id — and a rule in a comment is a rule until somebody
   * reads one more column. What can be asserted, and is, is that the hatch shows
   * only LIVE rows and cannot write.
   */
  it('invitations are tenant-isolated, and a cross-tenant one is refused', async () => {
    const [inviterA] = (
      await withOrg(orgA, (tx) => tx.query('SELECT id FROM app_user LIMIT 1'))
    ).rows.map((r) => r.id as string);
    const [inviterB] = (
      await withOrg(orgB, (tx) => tx.query('SELECT id FROM app_user LIMIT 1'))
    ).rows.map((r) => r.id as string);

    const mint = async (org: string, inviter: string, email: string, hash: string) =>
      withOrg(org, (tx) =>
        tx.query(
          `INSERT INTO invite (organization_id, email, token_hash, role, invited_by_id, expires_at)
           VALUES ($1, $2, $3, 'EMPLOYEE', $4, clock_timestamp() + interval '7 days')
           RETURNING id`,
          [org, email, hash, inviter],
        ),
      );
    const a = await mint(orgA, inviterA, 'newcomer@a.test', 'a'.repeat(64));
    await mint(orgB, inviterB, 'newcomer@b.test', 'b'.repeat(64));

    for (const [org, expected] of [
      [orgA, 'newcomer@a.test'],
      [orgB, 'newcomer@b.test'],
    ] as const) {
      const seen = await withOrg(org, (tx) => tx.query('SELECT email FROM invite'));
      expect(seen.rows.map((r) => r.email)).toEqual([expected]);
    }

    // Not by token hash either: knowing another tenant's token is not a way to
    // read their invitation from inside your own.
    const byHash = await withOrg(orgB, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM invite WHERE token_hash = $1', ['a'.repeat(64)]),
    );
    expect(byHash.rows[0].n).toBe(0);

    // WITH CHECK refuses an invitation written into another tenant.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO invite (organization_id, email, token_hash, role, invited_by_id, expires_at)
           VALUES ($1, 'smuggled@b.test', $2, 'ADMIN', $3, clock_timestamp() + interval '7 days')`,
          [orgB, 'c'.repeat(64), inviterB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // And TN-1: the composite FK refuses another tenant's inviter even inside
    // the right organization, because referential integrity is checked with RLS
    // BYPASSED and a plain `REFERENCES app_user(id)` would have accepted it.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO invite (organization_id, email, token_hash, role, invited_by_id, expires_at)
           VALUES ($1, 'crossed@a.test', $2, 'EMPLOYEE', $3, clock_timestamp() + interval '7 days')`,
          [orgA, 'd'.repeat(64), inviterB],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);

    /* ── the hatch ──────────────────────────────────────────────────────────*/
    // It sees both tenants' live invitations, which is the price of answering
    // "which tenant is this token in" before any tenant is known.
    const live = await withInviteLookup((tx) =>
      tx.query('SELECT count(*)::int AS n FROM invite'),
    );
    expect(live.rows[0].n).toBe(2);

    // But only LIVE ones. Revoke A's and it leaves the hatch's view entirely —
    // the same "unknown, spent and expired are one case" the policy exists for.
    await withOrg(orgA, (tx) =>
      tx.query('UPDATE invite SET revoked_at = clock_timestamp() WHERE id = $1', [a.rows[0].id]),
    );
    const afterRevoke = await withInviteLookup((tx) =>
      tx.query('SELECT organization_id FROM invite'),
    );
    expect(afterRevoke.rows.map((r) => r.organization_id)).toEqual([orgB]);

    // AND IT CANNOT WRITE. `invite_lookup` is FOR SELECT, so an UPDATE falls to
    // `tenant_isolation`, which matches nothing with no `app.current_org` — a
    // silent no-op rather than an error, which is why `rowCount` is the
    // assertion and a thrown exception is not.
    const attempted = await withInviteLookup((tx) =>
      tx.query("UPDATE invite SET role = 'ADMIN' WHERE organization_id = $1", [orgB]),
    );
    expect(attempted.rowCount).toBe(0);

    // With no context and no hatch, nothing at all.
    const blind = await withoutOrg((tx) => tx.query('SELECT count(*)::int AS n FROM invite'));
    expect(blind.rows[0].n).toBe(0);

    await admin.query('DELETE FROM invite');
  });

  /* ── subscriptions (VX5-8, migration 0037) ────────────────────────────────
   *
   * The ordinary tenant claim, plus the hatch — and the hatch here is a DIFFERENT
   * shape from `invite`'s, so it is asserted differently.
   *
   * `subscription_platform_read` hangs off `app.platform_task`, the flag 0012
   * introduced and 0033 reused, because its two callers are background paths: the
   * sweep that moves an expired trial to LAPSED, and the webhook handler that
   * arrives holding a provider reference and no tenant. Unlike `app.invite_lookup`
   * it does NOT narrow on liveness — a cancelled subscription is exactly what a
   * late webhook is about — so the property worth pinning is the other one: it is
   * FOR SELECT, so the sweep cannot write across tenants even though it can read
   * across them. One bug in a cross-tenant UPDATE cancels everybody.
   */
  it('subscriptions are tenant-isolated, and the platform hatch cannot write', async () => {
    const start = async (org: string, plan: string) =>
      withOrg(org, (tx) =>
        tx.query(
          `INSERT INTO subscription (organization_id, plan_code, status, trial_ends_at)
           VALUES ($1, $2, 'TRIALING', clock_timestamp() + interval '30 days')
           RETURNING id`,
          [org, plan],
        ),
      );
    const a = await start(orgA, 'STARTER');
    await start(orgB, 'TEAM');

    for (const [org, expected] of [
      [orgA, 'STARTER'],
      [orgB, 'TEAM'],
    ] as const) {
      const seen = await withOrg(org, (tx) => tx.query('SELECT plan_code FROM subscription'));
      expect(seen.rows.map((r) => r.plan_code)).toEqual([expected]);
    }

    // WITH CHECK: org B cannot write a row belonging to org A, even naming it.
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO subscription (organization_id, plan_code, status, trial_ends_at)
           VALUES ($1, 'SCALE', 'TRIALING', clock_timestamp() + interval '30 days')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // ONE LIVE SUBSCRIPTION PER TENANT, enforced by the partial unique index
    // rather than by whichever code path checks first.
    await expect(start(orgA, 'TEAM')).rejects.toThrow(/duplicate key|unique/i);

    /* ── the hatch ──────────────────────────────────────────────────────────*/
    const both = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription'),
    );
    expect(both.rows[0].n).toBe(2);

    // FOR SELECT only. An UPDATE falls through to `tenant_isolation`, which
    // matches nothing with no `app.current_org` — a silent no-op, so `rowCount`
    // is the assertion and a thrown error is not.
    const attempted = await withPlatformRead((tx) =>
      tx.query("UPDATE subscription SET status = 'CANCELLED', cancelled_at = clock_timestamp()"),
    );
    expect(attempted.rowCount).toBe(0);

    // And unlike the invite hatch, a CANCELLED row stays visible to it — a late
    // webhook about a subscription that has ended is precisely the case the sweep
    // and the handler have to be able to see.
    await withOrg(orgA, (tx) =>
      tx.query(
        `UPDATE subscription SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
                                 trial_ends_at = NULL WHERE id = $1`,
        [a.rows[0].id],
      ),
    );
    const afterCancel = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription'),
    );
    expect(afterCancel.rows[0].n).toBe(2);

    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription'),
    );
    expect(blind.rows[0].n).toBe(0);

    await admin.query('DELETE FROM subscription');
  });

  /* ── meter readings (VX5-9, migration 0038) ───────────────────────────────
   *
   * The ordinary tenant claim, and then the ABSENCE of a hatch, which is the
   * interesting half.
   *
   * `subscription` has a platform read policy because a webhook arrives holding a
   * provider reference and no tenant — a genuinely tenant-less question. Counting
   * seats never is: the sweep fans out per tenant and sets `app.current_org` for
   * each. So this table has `tenant_isolation` and nothing else, and the assertion
   * that keeps it that way is that `app.platform_task` buys NOTHING here. A hatch
   * added later "for an invoice screen" would be a cross-tenant read of billing
   * quantities, and this is the test it would have to delete.
   */
  it('meter readings are tenant-isolated, and no platform flag opens them', async () => {
    const write = async (org: string, meter: string, quantity: number) =>
      withOrg(org, (tx) =>
        tx.query(
          `INSERT INTO subscription_meter_reading
             (organization_id, meter, plan_code, period_start, period_end, quantity)
           VALUES ($1, $2, 'STARTER', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', $3)`,
          [org, meter, quantity],
        ),
      );
    await write(orgA, 'SEAT', 7);
    await write(orgB, 'SEAT', 3);

    for (const [org, expected] of [
      [orgA, '7'],
      [orgB, '3'],
    ] as const) {
      const seen = await withOrg(org, (tx) =>
        tx.query('SELECT quantity FROM subscription_meter_reading'),
      );
      expect(seen.rows.map((r) => r.quantity)).toEqual([expected]);
    }

    // WITH CHECK: naming another tenant does not write there.
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO subscription_meter_reading
             (organization_id, meter, plan_code, period_start, period_end, quantity)
           VALUES ($1, 'TENANT', 'STARTER', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 1)`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // One reading per tenant per meter per period — the index that makes the
    // sweep safe to re-run rather than a check somebody has to remember.
    await expect(write(orgA, 'SEAT', 9)).rejects.toThrow(/duplicate key|unique/i);

    // NO HATCH. `app.platform_task` opens `subscription`; it must not open this.
    const viaPlatform = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription_meter_reading'),
    );
    expect(viaPlatform.rows[0].n).toBe(0);

    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription_meter_reading'),
    );
    expect(blind.rows[0].n).toBe(0);

    await admin.query('DELETE FROM subscription_meter_reading');
  });

  /* ── External IDs (the Wave 1 business-unit port, migration 0047) ─────────
   *
   * ExpenseOS's `ExternalIdSource` and `BusinessUnitExternalId`, made per tenant.
   * The ordinary claim for both, no hatch, and the composite FKs pinned
   * concretely: Postgres checks referential integrity with RLS BYPASSED, so a
   * single-column reference would let an alias name another tenant's source or
   * business unit.
   */
  it("external-id sources and business-unit aliases are tenant-isolated, and cannot name another tenant's rows", async () => {
    await admin.query('DELETE FROM business_unit_external_id');
    await admin.query('DELETE FROM external_id_source');
    const seed = async (org: string, value: string) =>
      withOrg(org, async (tx) => {
        const bu = (await tx.query("SELECT id FROM business_unit LIMIT 1")).rows[0].id as string;
        const src = (
          await tx.query(
            `INSERT INTO external_id_source (organization_id, code, label)
             VALUES ($1, 'ledger', '{"en":"Ledger"}') RETURNING id`,
            [org],
          )
        ).rows[0].id as string;
        await tx.query(
          `INSERT INTO business_unit_external_id (organization_id, source_id, source_value, business_unit_id)
           VALUES ($1, $2, $3, $4)`,
          [org, src, value, bu],
        );
        return { bu, src };
      });
    const a = await seed(orgA, 'A-1');
    const b = await seed(orgB, 'B-1');

    for (const [org, expected] of [
      [orgA, 'A-1'],
      [orgB, 'B-1'],
    ] as const) {
      const seen = await withOrg(org, async (tx) => ({
        sources: (await tx.query('SELECT code FROM external_id_source')).rows.map((r) => r.code),
        aliases: (await tx.query('SELECT source_value FROM business_unit_external_id')).rows.map(
          (r) => r.source_value,
        ),
      }));
      expect(seen).toEqual({ sources: ['ledger'], aliases: [expected] });
    }

    // WITH CHECK: naming another tenant does not write there.
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO external_id_source (organization_id, code, label) VALUES ($1, 'x', '{"en":"X"}')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // The composite FKs: B cannot point an alias at A's source, or at A's unit.
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO business_unit_external_id (organization_id, source_id, source_value, business_unit_id)
           VALUES ($1, $2, 'B-2', $3)`,
          [orgB, a.src, b.bu],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO business_unit_external_id (organization_id, source_id, source_value, business_unit_id)
           VALUES ($1, $2, 'B-3', $3)`,
          [orgB, b.src, a.bu],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);

    // NO HATCH, and nothing without a tenant.
    for (const table of ['external_id_source', 'business_unit_external_id']) {
      const viaPlatform = await withPlatformRead((tx) =>
        tx.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(viaPlatform.rows[0].n).toBe(0);
      const blind = await withoutOrg((tx) => tx.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(blind.rows[0].n).toBe(0);
    }

    await admin.query('DELETE FROM business_unit_external_id');
    await admin.query('DELETE FROM external_id_source');
  });

  /* ── export requests (VX5-12, migration 0041) ─────────────────────────────
   *
   * The ordinary tenant claim, and then the two things specific to this table,
   * both of which matter more than usual because of WHAT the row points at:
   * `data_key` is the storage key of an archive holding every expense, every
   * approver decision and every employee's name and email a tenant has. A
   * cross-tenant read here is not a leak of metadata; it is a map to the whole
   * dataset.
   *
   * NO HATCH, and its absence is the decision — same reasoning as the meter
   * readings above. The purge fans out per tenant with `app.current_org` set, so
   * nothing ever needs to see across tenants.
   *
   * AND THE COMPOSITE FK, which `test/tenant-fk.db.test.ts` demands generically
   * and this pins concretely: Postgres checks referential integrity with RLS
   * BYPASSED, so a single-column `requested_by_id` would happily accept another
   * tenant's user — an export attributed to somebody who does not work there.
   */
  it('export requests are tenant-isolated, and cannot name another tenant\'s user', async () => {
    const userOf = async (org: string) =>
      (
        await withOrg(org, (tx) =>
          tx.query('SELECT id FROM app_user WHERE organization_id = $1 LIMIT 1', [org]),
        )
      ).rows[0].id as string;

    // Clean at the START as well as the end. A previous FAILING run of this test
    // never reaches its own cleanup, and the leftover rows then break the
    // in-flight assertion on the next run — a test that poisons itself, which is
    // the same shape as the seed's `deleted_at` problem this ticket also fixed.
    await admin.query('DELETE FROM tenant_export');

    const [userA, userB] = [await userOf(orgA), await userOf(orgB)];
    const request = async (org: string, user: string) =>
      withOrg(org, (tx) =>
        tx.query(
          `INSERT INTO tenant_export (organization_id, requested_by_id, expires_at)
           VALUES ($1, $2, now() + interval '7 days')`,
          [org, user],
        ),
      );

    await request(orgA, userA);
    await request(orgB, userB);

    for (const org of [orgA, orgB]) {
      const seen = await withOrg(org, (tx) =>
        tx.query('SELECT organization_id FROM tenant_export'),
      );
      expect(seen.rows.map((r) => r.organization_id)).toEqual([org]);
    }

    /* WITH CHECK: naming another tenant does not write there.
     *
     * Written out rather than reusing `request`, because `request` puts the same
     * org in the GUC and in the column and so cannot express this at all. My
     * first version here was `expect(request(orgA, userA) && request(orgB, userA))`
     * — which awaits only the second, fires the first as an unhandled promise,
     * and asserts nothing about WITH CHECK. */
    await expect(
      withOrg(orgB, (tx) =>
        tx.query(
          `INSERT INTO tenant_export (organization_id, requested_by_id, expires_at)
           VALUES ($1, $2, now() + interval '7 days')`,
          [orgA, userA],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // ONE IN FLIGHT PER TENANT. The partial unique index, and the reason it is in
    // the database rather than in a handler: the caller is a button, and a button
    // with no feedback gets pressed four times — which would be four full-dataset
    // reads against the same pool.
    await expect(request(orgA, userA)).rejects.toThrow(/duplicate key|unique/i);

    // THE COMPOSITE FK. Tenant B's own transaction, naming tenant A's user: RLS
    // is satisfied (the row is B's) and the FK is what has to refuse it.
    await admin.query('DELETE FROM tenant_export');
    await expect(request(orgB, userA)).rejects.toThrow(/foreign key|violates/i);

    // NO HATCH, in either direction.
    const viaPlatform = await withPlatformRead((tx) =>
      tx.query('SELECT count(*)::int AS n FROM tenant_export'),
    );
    expect(viaPlatform.rows[0].n).toBe(0);

    const blind = await withoutOrg((tx) =>
      tx.query('SELECT count(*)::int AS n FROM tenant_export'),
    );
    expect(blind.rows[0].n).toBe(0);

    await admin.query('DELETE FROM tenant_export');
  });

});
