/**
 * Wave 1 — migration 0046, the starter categories' traits for tenants created before
 * `seedStarterCategories` set them.
 *
 * Run as the APP role on purpose. `expense_category` forces row-level security on its
 * owner, and on RDS the master login that runs migrations is the owner and not a
 * superuser — so RLS binds it exactly as it binds `veloapp`. The local test database
 * runs migrations as `postgres`, which bypasses RLS and would make a migration that
 * updates nothing on RDS look correct here. Running the file as `veloapp` reproduces
 * RDS's conditions; the second case shows what the per-tenant loop is for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createOrganization } from '@/lib/onboarding/provision';
import { STARTER_CATEGORY_TRAITS } from '@/lib/onboarding/starter';

const MIGRATION = readFileSync('prisma/migrations/0046_starter_category_traits/migration.sql', 'utf8');
const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let A: string;
let B: string;

/** Put a tenant's starter rows back to migration 0045's defaults, as before this change. */
const asBefore0046 = (org: string) =>
  admin.query(
    `UPDATE expense_category
        SET icon = NULL, color = NULL, itc_gst_hst_rate = 100, itc_qst_rate = 100, accepts_tip = false
      WHERE organization_id = $1`,
    [org],
  );

const traitsOf = async (org: string) =>
  Object.fromEntries(
    (
      await admin.query(
        `SELECT code, icon, color, itc_gst_hst_rate, itc_qst_rate, accepts_tip
           FROM expense_category WHERE organization_id = $1`,
        [org],
      )
    ).rows.map((r) => [r.code, r]),
  );

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha Traits', slug: 'alpha-traits', adminEmail: 'a@alpha.test', adminName: 'A' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta Traits', slug: 'beta-traits', adminEmail: 'b@beta.test', adminName: 'B' }))
    .organizationId;
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('migration 0046', () => {
  it('sets every tenant’s untouched starter rows, under RLS, as the migration role is on RDS', async () => {
    await asBefore0046(A);
    await asBefore0046(B);
    await app.query(MIGRATION);
    for (const org of [A, B]) {
      const rows = await traitsOf(org);
      for (const [code, t] of Object.entries(STARTER_CATEGORY_TRAITS)) {
        expect(rows[code], `${org} ${code}`).toMatchObject({
          icon: t.icon,
          color: t.color,
          itc_gst_hst_rate: t.itcGstHstRate,
          itc_qst_rate: t.itcQstRate,
          accepts_tip: t.acceptsTip,
        });
      }
    }
  });

  it('would change nothing under RLS without the per-tenant scope — which is why it loops', async () => {
    await asBefore0046(A);
    const r = await app.query(`UPDATE expense_category SET color = '#000000' WHERE code = 'meals'`);
    expect(r.rowCount).toBe(0);
    await app.query(MIGRATION); // and restore
  });

  it('leaves a row an admin has changed alone, and still sets the others', async () => {
    await asBefore0046(A);
    await admin.query(
      `UPDATE expense_category SET itc_gst_hst_rate = 75 WHERE organization_id = $1 AND code = 'meals'`,
      [A],
    );
    await app.query(MIGRATION);
    const rows = await traitsOf(A);
    expect(rows.meals).toMatchObject({ itc_gst_hst_rate: 75, icon: null, color: null, accepts_tip: false });
    expect(rows.ground).toMatchObject({ accepts_tip: true, icon: STARTER_CATEGORY_TRAITS.ground.icon });
  });

  it('leaves the app with no tenant scope afterwards', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(MIGRATION);
      const r = await c.query(`SELECT current_setting('app.current_org', true) AS org`);
      expect(r.rows[0].org ?? '').toBe('');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
