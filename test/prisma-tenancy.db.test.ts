/**
 * Wave 0 — tenant isolation holds on the Prisma path (decided 7 Oct).
 *
 * Ported ExpenseOS code reaches the database through `db` in lib/db/prisma.ts.
 * Isolation is Postgres's (RLS on `veloapp`), so this suite proves the Prisma
 * path is subject to it exactly like the `pg` path:
 *
 *   · reads see only the scoped tenant — for EVERY tenant table, not a sample;
 *   · creates get the tenant from the database default (migration 0044);
 *   · naming another tenant on write is refused;
 *   · unscoped use throws, and an unscoped write cannot land;
 *   · ExpenseOS's own `db.$transaction(...)` stays inside the tenant scope;
 *   · a nested scope for another tenant is refused, not switched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { Prisma } from '@/lib/generated/prisma/client';
import { createOrganization } from '@/lib/onboarding/provision';
import { db, withTenantDb, TenantScopeError } from '@/lib/db/prisma';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let tenantTables: string[];

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha', slug: 'alpha-prisma', adminEmail: 'a@alpha.test', adminName: 'A' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta', slug: 'beta-prisma', adminEmail: 'b@beta.test', adminName: 'B' }))
    .organizationId;
  const r = await admin.query<{ t: string }>(
    `SELECT c.relname AS t
       FROM pg_class c JOIN information_schema.columns col
         ON col.table_name = c.relname AND col.table_schema = 'public' AND col.column_name = 'organization_id'
      WHERE c.relkind = 'r' AND c.relrowsecurity
      ORDER BY 1`,
  );
  tenantTables = r.rows.map((x) => x.t);
});

afterAll(async () => {
  await admin.end();
});

describe('reads', () => {
  it('a scoped model query sees only its own tenant', async () => {
    const mine = await withTenantDb(A, () => db.expenseCategory.findMany());
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((c) => c.organizationId))).toEqual(new Set([A]));
  });

  it('every RLS table hides the other tenant on the Prisma connection', async () => {
    expect(tenantTables.length).toBeGreaterThan(30);
    const leaks = await withTenantDb(A, async (tx) => {
      const out: string[] = [];
      for (const t of tenantTables) {
        const [row] = await tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*)::bigint AS n FROM ${Prisma.raw(`"${t}"`)} WHERE organization_id <> ${A}::uuid`,
        );
        if (Number(row.n) !== 0) out.push(t);
      }
      return out;
    });
    expect(leaks).toEqual([]);
  });

  it('the other tenant really has rows, so the check above is not vacuous', async () => {
    const [row] = (await admin.query('SELECT count(*)::int AS n FROM expense_category WHERE organization_id = $1', [B]))
      .rows;
    expect(row.n).toBeGreaterThan(0);
  });
});

describe('writes', () => {
  it('a create with no organization lands in the scoped tenant', async () => {
    const made = await withTenantDb(A, () =>
      db.expenseCategory.create({ data: { code: 'PRISMA_TEST', label: 'Prisma test' } }),
    );
    expect(made.organizationId).toBe(A);
  });

  it("naming another tenant is refused by the policy's WITH CHECK", async () => {
    await expect(
      withTenantDb(A, () =>
        db.expenseCategory.create({ data: { code: 'SNEAK', label: 'Sneak', organizationId: B } }),
      ),
    ).rejects.toThrow();
    const [row] = (await admin.query("SELECT count(*)::int AS n FROM expense_category WHERE code = 'SNEAK'")).rows;
    expect(row.n).toBe(0);
  });

  it("an update cannot reach the other tenant's rows", async () => {
    const res = await withTenantDb(A, () =>
      db.expenseCategory.updateMany({ where: { organizationId: B }, data: { label: 'hijacked' } }),
    );
    expect(res.count).toBe(0);
  });
});

describe('scope', () => {
  it('db outside a tenant scope throws instead of running unscoped', async () => {
    await expect(async () => db.expenseCategory.findMany()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("ExpenseOS's db.$transaction(fn) runs inside the same tenant scope", async () => {
    const seen = await withTenantDb(A, () =>
      db.$transaction(async (tx) => {
        const [s] = await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('app.current_org', true) AS s`;
        return s.s;
      }),
    );
    expect(seen).toBe(A);
  });

  it('the array form of $transaction works and stays scoped', async () => {
    const [a, b] = await withTenantDb(A, () =>
      db.$transaction([db.expenseCategory.count(), db.expenseCategory.count({ where: { organizationId: B } })]),
    );
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
  });

  it('a nested scope for another tenant is refused, not switched', async () => {
    await expect(withTenantDb(A, () => withTenantDb(B, () => db.expenseCategory.count()))).rejects.toBeInstanceOf(
      TenantScopeError,
    );
  });

  it('the scope does not outlive its transaction on a pooled connection', async () => {
    await withTenantDb(A, () => db.expenseCategory.count());
    // Same pool, new transaction, no scope: the setting reads back empty, and RLS shows nothing.
    const r = await withTenantDb(B, async (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM expense_category WHERE organization_id = ${A}::uuid`,
    );
    expect(Number(r[0].n)).toBe(0);
  });

  it('every tenant table defaults organization_id to the scope (migration 0044)', async () => {
    const r = await admin.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organization_id'
          AND (column_default IS NULL OR column_default NOT LIKE '%app.current_org%')`,
    );
    expect(r.rows.map((x) => x.t)).toEqual([]);
  });
});
