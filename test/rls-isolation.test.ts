/**
 * VX0-6 — the RLS isolation GATE. Runs against a real Postgres (the VeloExpense
 * test DB) with migrations applied. Nothing stacks onto feature work until this
 * is green in CI.
 *
 * Proves: (1) a tenant sees only its own rows, (2) WITH CHECK rejects a
 * cross-tenant write, (3) an unset context sees nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { withOrg, withoutOrg } from '@/lib/tenant/context';

let orgA: string;
let orgB: string;

beforeAll(async () => {
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
});
