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

/**
 * UD-8: the demo tenant posts on approval, stated EXPLICITLY rather than taken
 * from the column default — which is now AP_QUEUE for a new organization.
 *
 * This is a deliberate divergence from what a real new tenant gets, and the
 * reason is that the seed is the fixture for the whole e2e suite. Ten specs
 * across VX3-4, VX3-9 and VX4-1 approve a report and then assert something about
 * what reached the ledger; under AP_QUEUE every one of them would be asserting
 * about a row nobody released, and the ledger-queue screen's main path would
 * never be exercised. `e2e/ap-queue.spec.ts` flips this tenant to AP_QUEUE and
 * covers the other half, which is a better division than making eight specs
 * press a release button that is not their subject.
 *
 * Set on the UPDATE branch too: a re-seed after somebody flipped the setting in
 * the UI must put the fixture back, or the suite's behaviour depends on what the
 * last person clicked.
 */
async function upsertOrg(client, slug, name) {
  const r = await client.query(
    `INSERT INTO organization (slug, name, posting_trigger) VALUES ($1, $2, 'AUTOMATIC')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
                                        posting_trigger = EXCLUDED.posting_trigger
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
async function seedReportingLine(orgId, opts = {}) {
  // ── VX3-9a made this multi-tenant, and it was TWO bugs, not one ────────────
  //
  // It was written for the demo tenant and hardcoded to it: `le.name = 'Demo Co
  // Inc.'` and a chain of `*@demo.test` addresses. Called for a second tenant it
  // matched nothing it should and something it should not.
  //
  // And every lookup relied on RLS for its tenant scoping — no `organization_id`
  // predicate anywhere. That is fine while the seed runs as `veloapp` (which
  // HANDOFF §3 says to do) and wrong the moment anybody runs it as a superuser,
  // because a superuser bypasses RLS even under FORCE: the subqueries then see
  // every tenant and pick the first row they find. Which is exactly what happened
  // — the second tenant's users were assigned the DEMO tenant's business unit.
  //
  // It failed loudly rather than silently, and the reason is VX3-10: the composite
  // foreign key refused
  //   Key (organization_id, business_unit_id)=(second, <demo's unit>)
  // A single-column `REFERENCES business_unit(id)` would have ACCEPTED it, and the
  // second tenant would have quietly carried a pointer into another tenant's org
  // chart. That is the exact case TN-1 was about, caught in practice.
  //
  // So: explicit `organization_id` predicates throughout, correct under any role.
  const entityName = opts.entityName ?? 'Demo Co Inc.';
  const chain = opts.chain ?? [
    ['manager@demo.test', 'admin@demo.test'],
    ['employee@demo.test', 'manager@demo.test'],
    ['admin@demo.test', 'owner@demo.test'],
  ];

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
        WHERE u.organization_id  = $1
          AND d.organization_id  = $1
          AND bu.organization_id = $1
          AND le.organization_id = $1
          AND d.name  = 'General & Admin'
          AND bu.name = 'Head Office'
          AND le.name = $2`,
      [orgId, entityName],
    );
    // employee → manager → admin → owner in the demo tenant. Three levels, so
    // manager_level 2 and 3 mean something, and every user except the top of the
    // chain has an approver.
    for (const [child, parent] of chain) {
      await client.query(
        `UPDATE app_user
            SET manager_id = (SELECT id FROM app_user
                               WHERE organization_id = $1 AND email = $3),
                updated_at = now()
          WHERE organization_id = $1 AND email = $2`,
        [orgId, child, parent],
      );
    }
    // The top of the chain is still the top, and in a two-person tenant the only
    // other ADMIN reports to them — so without this the owner cannot submit an
    // expense at all. That is the AP-14 dead end, and in a DEMO tenant it reads as
    // a broken product rather than as the control it is. Enabled here deliberately,
    // per-tenant, and OFF by default everywhere else (see migration 0009).
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

/**
 * VX4-1 — entitle a tenant to a module.
 *
 * ABSENCE MEANS OFF (migration `0021`), so a seeded tenant that is supposed to be
 * able to use the accounting screens needs a row. There is no default-on set and
 * deliberately so: the failure mode of a missing row is "a feature is
 * unavailable", and the failure mode of an assumed default is "a tenant is using
 * something nobody sold them".
 *
 * `blank` deliberately gets NOTHING, and that is the point of it: it is the tenant
 * that shows what a freshly created organization looks like before anybody
 * provisions it, which is exactly what Phase 5's self-serve onboarding has to fill
 * in.
 */
async function seedModule(orgId, moduleCode) {
  const client = await pool.connect();
  try {
    // A TENANT TABLE, so the tenant context has to be set — the first version of
    // this function skipped the transaction and `set_config`, and RLS's WITH CHECK
    // refused the row: "new row violates row-level security policy for table
    // module_entitlement". Every other helper in this file already had the shape;
    // this one just did not copy it.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
       VALUES ($1, $2, true, clock_timestamp())
       ON CONFLICT (organization_id, module_code)
       DO UPDATE SET enabled = true,
                     enabled_at = COALESCE(module_entitlement.enabled_at, clock_timestamp()),
                     updated_at = clock_timestamp()`,
      [orgId, moduleCode],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedReferenceData(orgId, entityName = 'Demo Co Inc.') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO business_unit (organization_id, name) VALUES ($1, 'Head Office')
         ON CONFLICT (organization_id, name) DO NOTHING`, [orgId]);
    await client.query(
      `INSERT INTO legal_entity (organization_id, name, country, currency_code)
         VALUES ($1, $2, 'CA', 'CAD')
         ON CONFLICT (organization_id, name) DO NOTHING`, [orgId, entityName]);
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

  await seedModule(demoId, 'accounting');
  // VX4-5 part 3a: `0025` puts app_module_enabled('budgets') into every budget
  // table's policy, so without this the demo tenant cannot see or write a budget.
  await seedModule(demoId, 'budgets');
  // VX4-6a: available as of this ticket. Enabled here so the demo tenant matches
  // what the build can serve — the screen arrives in 6b and will find it on.
  await seedModule(demoId, 'analytics');
  // VX4-8 part 4. The demo tenant gets compliance so `/admin/compliance` has
  // something to show and `e2e/compliance-flow.spec.ts` has a tenant to sweep.
  await seedModule(demoId, 'compliance');
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

  // ── VX3-9a: a SECOND populated tenant, on a DIFFERENT ledger ───────────────
  //
  // The point of the phase's exit criterion: two tenants side by side, each
  // posting to its own far end, neither seeing the other's. `blank` stays blank —
  // a genuinely empty tenant is worth keeping for from-scratch testing — so this
  // is a third org rather than a repurposing of it.
  //
  // Two users, not four: this tenant exists to post, and posting needs a
  // submitter plus somebody above them who can approve (AP-14 — the person at the
  // top of the chain cannot approve their own spend).
  const secondId = await (async () => {
    const client = await pool.connect();
    try {
      return await upsertOrg(client, 'second', 'Second Co');
    } finally {
      client.release();
    }
  })();
  // Both seeded tenants get accounting, so the two-tenant ledger e2e keeps
  // working. The phase's exit criterion — tenants with DIFFERENT module sets — is
  // proved by toggling one off inside a test rather than by seed asymmetry, so
  // that a spec asserting "off" cannot silently depend on the seed staying that
  // way.
  await seedModule(secondId, 'accounting');
  await seedModule(secondId, 'budgets');
  await seedModule(secondId, 'analytics');
  // The SECOND tenant gets it too, so the scheduled sweep touches more than one
  // organization — a per-tenant sweep tested against one tenant proves nothing
  // about the loop.
  await seedModule(secondId, 'compliance');
  await seedReferenceData(secondId, 'Second Co Ltd.');
  await seedUser(secondId, 'owner@second.test', 'Second Owner', { role: 'ADMIN', title: 'Owner' });
  await seedUser(secondId, 'admin@second.test', 'Second Admin', { role: 'ADMIN', title: 'Controller' });
  await seedReportingLine(secondId, {
    entityName: 'Second Co Ltd.',
    // Two people: the controller reports to the owner, so the owner can approve
    // the controller's spend and the sole-approver flag covers the owner's own.
    chain: [['admin@second.test', 'owner@second.test']],
  });

  // ── NO LEDGER IS SEEDED, and the reason is worth writing down ──────────────
  //
  // The first version of this did seed one, and it would have broken every read.
  // A `secret`-typed config field is encrypted ON WRITE by `lib/crypto/secrets.ts`
  // — TypeScript this `.mjs` seed cannot import — and `decryptSecret` REFUSES an
  // unmarked value rather than trusting it (deliberately: AC-4 is about ExpenseOS
  // tolerating cleartext). So a seeded plaintext `apiKey` is not "insecure but
  // working", it is a row that throws the moment the app touches it, and the e2e
  // would have failed with a crypto error rather than anything about ledgers.
  // Verified rather than assumed: `decryptSecret('seed-only-not-a-real-key')`
  // throws.
  //
  // Duplicating the envelope here would put AES-GCM in a second place and invite
  // drift. So `e2e/ledger-flow.spec.ts` CONNECTS each tenant's ledger through the
  // real connect form instead — which uses the shipping encryption path and, as a
  // bonus, is the first coverage the connect screen has ever had.

  console.log(
    'Seeded: demo (accounting module + reference data + 4 users: owner/admin/manager/employee, reporting line wired,' +
      ' sole-approver self-approval enabled), second (accounting module + reference data' +
      ' + 2 users), blank (0 users, NO modules — a fresh org before provisioning).' +
      ' No ledger is connected — the e2e connects one per tenant.',
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
