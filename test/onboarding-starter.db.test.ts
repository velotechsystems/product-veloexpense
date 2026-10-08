/**
 * VX5-4 — what a tenant can do the moment it exists.
 *
 * The test that matters here is the FIRST one: a tenant created by signup is
 * walked through recording an expense, because that walk is how the defect was
 * found. It stopped at `addLineItem` with `CATEGORY_NOT_FOUND` — a customer who
 * had just signed up could not record a single expense.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import { STARTER_CATEGORIES, seedStarterCategories } from '@/lib/onboarding/starter';
import { setupStatus, SETUP_ITEMS } from '@/lib/onboarding/setup';
import * as expenses from '@/lib/expenses/service';
import { submitReport } from '@/lib/expenses/lifecycle';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let adminUserId: string;

beforeEach(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  const org = await createOrganization({
    name: 'Fresh Co',
    slug: 'fresh',
    adminEmail: 'founder@fresh.test',
    adminName: 'Founder',
  });
  orgId = org.organizationId;
  adminUserId = org.adminUserId;
});

afterAll(async () => {
  await admin.end();
});

const state = (status: Awaited<ReturnType<typeof setupStatus>>, item: (typeof SETUP_ITEMS)[number]) =>
  status.items.find((i) => i.item === item)!;

describe('a tenant that has just been created', () => {
  /* THE WALK. Every step of it, in the order somebody does it. */
  it('can record an expense — which it could not before this ticket', async () => {
    await withOrg(orgId, async (tx) => {
      const report = await expenses.createReport(tx, 'founder@fresh.test', {
        title: 'First trip',
        currencyCode: 'CAD',
      });
      const actor = { id: adminUserId, name: 'Founder', role: 'ADMIN' };
      const expense = await expenses.addExpense(tx, actor, report.id, {
        merchant: 'Taxi',
        txnDate: '2026-09-01',
        currencyCode: 'CAD',
      });
      const categories = await expenses.listCategories(tx);
      expect(categories.length, 'a new tenant has categories to choose from').toBeGreaterThan(0);

      // The line that used to throw CATEGORY_NOT_FOUND.
      const line = await expenses.addLineItem(tx, actor, expense.id, {
        description: 'Fare',
        amountMinor: 1000,
        categoryId: categories[0].id,
      });
      expect(line.id).toBeTruthy();
    });
  });

  it('seeds exactly the starter list, once, and says so in the genesis audit row', async () => {
    const rows = await withOrg(orgId, (tx) =>
      tx.query("SELECT code, label ->> 'en' AS label, sort_order FROM expense_category ORDER BY sort_order"),
    );
    expect(rows.rows.map((r) => [r.code, r.label, r.sort_order])).toEqual(
      STARTER_CATEGORIES.map((c) => [...c]),
    );

    const genesis = await admin.query(
      "SELECT details FROM audit_entry WHERE action = 'ORGANIZATION_CREATED'",
    );
    expect(genesis.rows[0].details).toMatchObject({
      seeded_categories: STARTER_CATEGORIES.length,
    });
  });

  it('seeding again writes nothing and does not disturb a renamed category', async () => {
    await withOrg(orgId, (tx) =>
      tx.query(`UPDATE expense_category SET label = '{"en":"Client dinners"}' WHERE code = 'meals'`),
    );
    const wrote = await withOrg(orgId, (tx) => seedStarterCategories(tx));
    expect(wrote).toBe(0);
    const label = await withOrg(orgId, (tx) =>
      tx.query("SELECT label ->> 'en' AS label FROM expense_category WHERE code = 'meals'"),
    );
    expect(label.rows[0].label).toBe('Client dinners');
  });

  /* Still cannot SUBMIT, and that is the design rather than a gap: the founder
   * is the only active administrator, so step 1 has no eligible approver and
   * self-approval is off. Asserted so that turning that default on becomes a
   * deliberate act with a failing test attached, rather than a quiet edit. */
  it('cannot submit while the founder is alone, and the checklist says why first', async () => {
    await expect(
      withOrg(orgId, async (tx) => {
        const report = await expenses.createReport(tx, 'founder@fresh.test', {
          title: 'Alone',
          currencyCode: 'CAD',
        });
        const actor = { id: adminUserId, name: 'Founder', role: 'ADMIN' };
        const expense = await expenses.addExpense(tx, actor, report.id, {
          merchant: 'Taxi',
          txnDate: '2026-09-01',
          currencyCode: 'CAD',
        });
        const categories = await expenses.listCategories(tx);
        await expenses.addLineItem(tx, actor, expense.id, {
          description: 'Fare',
          amountMinor: 1000,
          categoryId: categories[0].id,
        });
        return submitReport(tx, report.id, adminUserId);
      }),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });

    const status = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(state(status, 'APPROVER').done).toBe(false);
    expect(status.memberCount).toBe(1);
  });
});

describe('the setup checklist', () => {
  it('starts with categories done and everything else outstanding', async () => {
    const status = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(state(status, 'CATEGORIES').done).toBe(true);
    expect(state(status, 'CATEGORIES').count).toBe(STARTER_CATEGORIES.length);
    for (const item of SETUP_ITEMS.filter((i) => i !== 'CATEGORIES')) {
      expect(state(status, item).done, `${item} should start outstanding`).toBe(false);
    }
    expect(status.complete).toBe(false);
  });

  /* The founder IS an admin, so "an approver exists" is satisfied by the person
   * who cannot approve their own report. The item counts TWO. */
  it('is not satisfied by the founder being an admin', async () => {
    const alone = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(state(alone, 'APPROVER').count).toBe(1);
    expect(state(alone, 'APPROVER').done).toBe(false);

    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'boss@fresh.test', 'MANAGER')`,
        [orgId],
      ),
    );
    const joined = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(state(joined, 'APPROVER').done).toBe(true);
  });

  it('does not count somebody who has been deactivated', async () => {
    const boss = await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'boss@fresh.test', 'ADMIN')
         RETURNING id`,
        [orgId],
      ),
    );
    expect(state(await withOrg(orgId, (tx) => setupStatus(tx)), 'APPROVER').done).toBe(true);
    await admin.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [
      boss.rows[0].id,
    ]);
    expect(state(await withOrg(orgId, (tx) => setupStatus(tx)), 'APPROVER').done).toBe(false);
  });

  it('an EMPLOYEE does not make the tenant able to approve anything', async () => {
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'staff@fresh.test', 'EMPLOYEE')`,
        [orgId],
      ),
    );
    const status = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(status.memberCount).toBe(2);
    expect(state(status, 'APPROVER').done).toBe(false);
  });

  it('completes when every item is satisfied, and only then', async () => {
    await withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'boss@fresh.test', 'MANAGER')`,
        [orgId],
      );
      await tx.query(
        `INSERT INTO approval_policy (organization_id, name, sequence) VALUES ($1, 'Standard', 1)`,
        [orgId],
      );
      await tx.query(
        `INSERT INTO expense_policy (organization_id, kind, severity, params)
         VALUES ($1, 'RECEIPT_REQUIRED', 'BLOCK', '{"thresholdMinor":5000}'::jsonb)`,
        [orgId],
      );
      await tx.query(
        `INSERT INTO department (organization_id, name) VALUES ($1, 'Finance')`,
        [orgId],
      );
    });
    const nearly = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(nearly.complete).toBe(false);
    expect(state(nearly, 'BRANDING').done).toBe(false);

    await withOrg(orgId, (tx) =>
      tx.query("UPDATE organization SET brand_color = '#663399' WHERE id = $1", [orgId]),
    );
    const done = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(done.complete).toBe(true);
    expect(done.items.every((i) => i.done)).toBe(true);
  });

  it('cannot see another tenant when counting', async () => {
    const other = await createOrganization({
      name: 'Globex',
      slug: 'globex',
      adminEmail: 'founder@globex.test',
    });
    await withOrg(other.organizationId, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'boss@globex.test', 'ADMIN')`,
        [other.organizationId],
      ),
    );
    // Globex now has two admins. Fresh Co still has one, and its checklist must
    // not notice — the counts are plain `count(*)` under `tenant_isolation`, and
    // this is what says so.
    const fresh = await withOrg(orgId, (tx) => setupStatus(tx));
    expect(fresh.memberCount).toBe(1);
    expect(state(fresh, 'APPROVER').done).toBe(false);
  });
});

describe('the hand-kept copy in scripts/seed.mjs', () => {
  /* UD-9's lesson: this codebase has had three duplicated lists and every one was
   * found by a test rather than by somebody noticing. `scripts/seed.mjs` cannot
   * import this module — it is plain node run against the repo, with no TS
   * resolution — so the duplicate is deliberate, and this is what pins it. */
  it('agrees with STARTER_CATEGORIES on every code and label', () => {
    const seed = readFileSync('scripts/seed.mjs', 'utf8');
    const block = seed.slice(seed.indexOf('const STARTER_CATEGORIES'));
    for (const [code, label] of STARTER_CATEGORIES) {
      expect(block, `seed.mjs should carry ${code}`).toContain(`'${code}'`);
      expect(block, `seed.mjs should label ${code} the same way`).toContain(`'${label}'`);
    }
  });
});
