/**
 * VX0-9 — seed a demo tenant + a blank tenant. Synthetic data only (no real
 * customer/EINC data). Idempotent: safe to re-run.
 *
 *   demo  (slug 'demo')  → 4 fictional users
 *   blank (slug 'blank') → 0 users (a clean tenant for from-scratch testing)
 *
 * Uses DATABASE_URL (the veloapp non-superuser role). Organization has no RLS;
 * app_user rows are inserted inside a transaction with app.current_org set, so
 * the RLS WITH CHECK is satisfied — exercising the real tenant path.
 *
 * Run:  DATABASE_URL=postgres://veloapp:velo@localhost:5433/veloexpense node scripts/seed.mjs
 */
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function upsertOrg(client, slug, name) {
  const r = await client.query(
    `INSERT INTO organization (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [slug, name],
  );
  return r.rows[0].id;
}

async function seedUser(orgId, email, displayName, employee = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO app_user (organization_id, email, display_name, title, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, email)
         DO UPDATE SET display_name = EXCLUDED.display_name,
                       title        = EXCLUDED.title,
                       role         = EXCLUDED.role,
                       updated_at   = now()`,
      [orgId, email, displayName, employee.title ?? null, employee.role ?? 'EMPLOYEE'],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * VX1-2 — give the demo tenant a reporting line and org placement so the admin
 * directory has something to show: employee → manager → admin, all placed in
 * the seeded department / business unit / legal entity. Idempotent.
 */
async function seedReportingLine(orgId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `UPDATE app_user u
          SET department_id    = d.id,
              business_unit_id = bu.id,
              legal_entity_id  = le.id,
              updated_at       = now()
         FROM department d, business_unit bu, legal_entity le
        WHERE d.name = 'General & Admin'
          AND bu.name = 'Head Office'
          AND le.name = 'Demo Co Inc.'`,
    );
    await client.query(
      `UPDATE app_user
          SET manager_id = (SELECT id FROM app_user WHERE email = 'admin@demo.test'),
              updated_at = now()
        WHERE email = 'manager@demo.test'`,
    );
    await client.query(
      `UPDATE app_user
          SET manager_id = (SELECT id FROM app_user WHERE email = 'manager@demo.test'),
              updated_at = now()
        WHERE email = 'employee@demo.test'`,
    );
    // employee → manager → admin → owner. Three levels, so manager_level 2 and 3
    // mean something in a demo, and every user except the owner has an approver.
    await client.query(
      `UPDATE app_user
          SET manager_id = (SELECT id FROM app_user WHERE email = 'owner@demo.test'),
              updated_at = now()
        WHERE email = 'admin@demo.test'`,
    );
    // The owner is still the top of the chain, and the only other ADMIN reports
    // to them — so without this the owner cannot submit an expense at all. That
    // is the AP-14 dead end, and in a DEMO tenant it reads as a broken product
    // rather than as the control it is. Enabled here deliberately, per-tenant,
    // and OFF by default everywhere else (see migration 0009).
    await client.query(
      `UPDATE organization
          SET allow_sole_approver_self_approval = true, updated_at = now()
        WHERE id = $1`,
      [orgId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Starter expense categories, and the account each posts to.
//
// The comment here used to call this "starter chart-of-accounts template", which
// it never was — these are CATEGORIES, and their old `gl_account` values
// (630500, 640100, …) were invented numbers matching no chart anywhere. VX3-1
// built the actual chart (migration 0014, template `na-expense-claims`), so the
// fourth column is now an account NUMBER in that template and the seed resolves
// it to a real `gl_account` row.
//
// Note travel_air / travel_lodging / ground all post to 68100: a chart of
// accounts is not a category list, and three ways of travelling are one line in
// the general ledger. Meals go to 68200 instead because they are 50% deductible
// in Canada and travel is not.
const STARTER_CATEGORIES = [
  ['meals', 'Meals & Entertainment', '68200', 10],
  ['travel_air', 'Airfare', '68100', 20],
  ['travel_lodging', 'Lodging', '68100', 30],
  ['ground', 'Ground Transportation', '68100', 40],
  ['office', 'Office Supplies', '67100', 50],
  ['software', 'Software & Subscriptions', '66100', 60],
];

/** The starter template every seeded tenant gets. */
const COA_TEMPLATE = 'na-expense-claims';

/**
 * ONE fixed demo exchange rate (VX3-2).
 *
 * `fx_rate` is GLOBAL reference data and migration 0015 deliberately seeds none:
 * a plausible-looking rate in a global table is worse than an absent one, because
 * it is stale from the moment it is written and nothing says so. This is the
 * DEMO seed, so a fixed, obviously-round rate on a fixed date is the right thing —
 * it makes cross-currency policy checks work in the demo tenant and in the e2e,
 * and it is recognisable as a fixture rather than mistakable for market data.
 *
 * Only USD->CAD is inserted. CAD->USD is DERIVED by lib/policy/rates.ts, which is
 * PE-7's fix: ExpenseOS stored one direction and looked up forward-only, so a
 * tenant whose policy currency was USD found every CAD amount unconvertible.
 * Seeding one direction here means the derivation is exercised by default rather
 * than only by a unit test.
 */
const DEMO_FX = { base: 'USD', quote: 'CAD', rate: '1.35000000', asOf: '2026-01-01' };

async function seedReferenceData(orgId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO business_unit (organization_id, name) VALUES ($1, 'Head Office')
         ON CONFLICT (organization_id, name) DO NOTHING`, [orgId]);
    await client.query(
      `INSERT INTO legal_entity (organization_id, name, country, currency_code)
         VALUES ($1, 'Demo Co Inc.', 'CA', 'CAD')
         ON CONFLICT (organization_id, name) DO NOTHING`, [orgId]);
    await client.query(
      `INSERT INTO department (organization_id, name) VALUES ($1, 'General & Admin')
         ON CONFLICT (organization_id, name) DO NOTHING`, [orgId]);
    // ── One demo FX rate, and the tenant's policy currency ───────────────────
    // Global table, so ON CONFLICT DO NOTHING rather than an update: two tenants
    // seeded in one run must not fight over it, and a real rate loaded later must
    // not be overwritten by this fixture.
    await client.query(
      `INSERT INTO fx_rate (base, quote, rate, as_of, source)
         VALUES ($1, $2, $3, $4, 'SEED')
         ON CONFLICT (base, quote, as_of) DO NOTHING`,
      [DEMO_FX.base, DEMO_FX.quote, DEMO_FX.rate, DEMO_FX.asOf]);
    // CAD explicitly rather than by relying on the column default, so the seed
    // states the demo tenant's intent instead of inheriting it.
    await client.query(
      "UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1", [orgId]);

    // ── Chart of accounts, before the categories that map into it ────────────
    // Two passes exactly as lib/accounts/service.ts does it, for the same reason:
    // a template is a tree, and the parents have to exist before parent_id can be
    // resolved. Idempotent — the whole seed is re-run after every test truncate,
    // so it must not care whether the accounts are already there.
    await client.query(
      `INSERT INTO gl_account
           (organization_id, number, name, type, sub_type, is_postable, source, source_template)
       SELECT $1, a.number, a.name, a.type, a.sub_type, a.is_postable, 'TEMPLATE', a.template_key
         FROM coa_template_account a
        WHERE a.template_key = $2
       ON CONFLICT (organization_id, number) DO NOTHING`,
      [orgId, COA_TEMPLATE]);
    // Comma-join, not a JOIN inside FROM: an UPDATE's target table cannot be
    // referenced from a FROM join condition. See lib/accounts/service.ts.
    await client.query(
      `UPDATE gl_account g
          SET parent_id = p.id
         FROM coa_template_account a, gl_account p
        WHERE a.template_key = $2
          AND g.organization_id = $1
          AND g.number = a.number
          AND a.parent_number IS NOT NULL
          AND p.number = a.parent_number
          AND p.organization_id = g.organization_id
          AND g.parent_id IS NULL`,
      [orgId, COA_TEMPLATE]);

    for (const [code, label, glNumber, sort] of STARTER_CATEGORIES) {
      await client.query(
        `INSERT INTO expense_category (organization_id, code, label, sort_order, gl_account_id)
           VALUES ($1, $2, $3, $4, (SELECT id FROM gl_account
                                     WHERE organization_id = $1 AND number = $5))
           ON CONFLICT (organization_id, code)
           DO UPDATE SET gl_account_id = EXCLUDED.gl_account_id`,
        [orgId, code, label, sort, glNumber]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const client = await pool.connect();
  let demoId;
  try {
    demoId = await upsertOrg(client, 'demo', 'Demo Co');
    await upsertOrg(client, 'blank', 'Blank Co');
  } finally {
    client.release();
  }

  await seedReferenceData(demoId);
  // FOUR users, not three. `owner@demo.test` was added when VX2-3 made a submit
  // open an approval run: submitting routes the ladder, and admin@demo.test —
  // who the e2e signs in as — was the TOP of the reporting line, so their own
  // reports had nobody to approve them. The e2e failed on it, correctly.
  //
  // This is GAP-AUDIT AP-14 arriving in practice rather than in theory: the
  // person at the top of the chain cannot approve their own spend, and in a
  // one-admin tenant there is nobody else. A demo tenant needs someone above
  // the controller for the same reason a real company does.
  await seedUser(demoId, 'owner@demo.test', 'Demo Owner', { role: 'ADMIN', title: 'Owner' });
  await seedUser(demoId, 'admin@demo.test', 'Demo Admin', { role: 'ADMIN', title: 'Controller' });
  await seedUser(demoId, 'manager@demo.test', 'Demo Manager', { role: 'MANAGER', title: 'Finance Manager' });
  await seedUser(demoId, 'employee@demo.test', 'Demo Employee', { role: 'EMPLOYEE', title: 'Analyst' });
  await seedReportingLine(demoId);

  console.log(
    'Seeded: demo (reference data + 4 users: owner/admin/manager/employee, reporting line wired,' +
      ' sole-approver self-approval enabled), blank (0 users).',
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
