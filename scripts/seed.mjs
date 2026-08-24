/**
 * VX0-9 — seed a demo tenant + a blank tenant. Synthetic data only (no real
 * customer/EINC data). Idempotent: safe to re-run.
 *
 *   demo  (slug 'demo')  → 3 fictional users
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

async function seedUser(orgId, email, displayName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO app_user (organization_id, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, email) DO NOTHING`,
      [orgId, email, displayName],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Starter chart-of-accounts template (per-tenant expense categories).
const STARTER_CATEGORIES = [
  ['meals', 'Meals & Entertainment', '630500', 10],
  ['travel_air', 'Airfare', '640100', 20],
  ['travel_lodging', 'Lodging', '640200', 30],
  ['ground', 'Ground Transportation', '640300', 40],
  ['office', 'Office Supplies', '650100', 50],
  ['software', 'Software & Subscriptions', '650200', 60],
];

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
    for (const [code, label, gl, sort] of STARTER_CATEGORIES) {
      await client.query(
        `INSERT INTO expense_category (organization_id, code, label, gl_account, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organization_id, code) DO NOTHING`,
        [orgId, code, label, gl, sort]);
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
  await seedUser(demoId, 'admin@demo.test', 'Demo Admin');
  await seedUser(demoId, 'manager@demo.test', 'Demo Manager');
  await seedUser(demoId, 'employee@demo.test', 'Demo Employee');

  console.log('Seeded: demo (reference data + 3 users), blank (0 users).');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
