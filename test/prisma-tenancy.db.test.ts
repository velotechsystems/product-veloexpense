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
import { afterCommit, db, withTenantDb, withTenantStatements, TenantScopeError, currentTenantId } from '@/lib/db/prisma';

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
      db.expenseCategory.create({ data: { code: 'PRISMA_TEST', label: { en: 'Prisma test' } } }),
    );
    expect(made.organizationId).toBe(A);
  });

  it("naming another tenant is refused by the policy's WITH CHECK", async () => {
    await expect(
      withTenantDb(A, () =>
        db.expenseCategory.create({ data: { code: 'SNEAK', label: { en: 'Sneak' }, organizationId: B } }),
      ),
    ).rejects.toThrow();
    const [row] = (await admin.query("SELECT count(*)::int AS n FROM expense_category WHERE code = 'SNEAK'")).rows;
    expect(row.n).toBe(0);
  });

  it("an update cannot reach the other tenant's rows", async () => {
    const res = await withTenantDb(A, () =>
      db.expenseCategory.updateMany({ where: { organizationId: B }, data: { label: { en: 'hijacked' } } }),
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

  it('reads a timestamp as the instant it is, whatever the database’s time zone', async () => {
    /**
     * The driver adapter ignores a timestamptz's UTC offset when it parses one, so with a
     * session TimeZone other than UTC every DateTime came back off by that offset (four
     * hours, on a database set to America/Toronto). withTenantDb pins the transaction to
     * UTC. Both halves are asserted: the setting itself — which holds wherever this runs,
     * including a CI database already on UTC — and the instant, compared with `pg`'s.
     */
    const zone = await withTenantDb(A, (tx) => tx.$queryRaw<{ z: string }[]>`SELECT current_setting('TimeZone') AS z`);
    expect(zone[0].z).toBe('UTC');
    const row = (await admin.query('SELECT id, created_at FROM expense_category WHERE organization_id = $1 LIMIT 1', [A]))
      .rows[0];
    const viaPrisma = await withTenantDb(A, () =>
      db.expenseCategory.findUnique({ where: { id: row.id }, select: { createdAt: true } }),
    );
    expect(viaPrisma?.createdAt.toISOString()).toBe((row.created_at as Date).toISOString());
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

describe('statement at a time — the worker (w3-02a)', () => {
  /**
   * A receipt job writes the reading's status and then waits on the model. Each write has to
   * be COMMITTED when it returns — the screen and `submit` read it from other connections
   * while the job is still running — and every one of them still runs as the tenant.
   */
  it('commits each write as it returns, visible to another connection before the job ends', async () => {
    const seenMidJob = await withTenantStatements(A, async () => {
      await db.expenseCategory.create({ data: { code: 'STMT_VISIBLE', label: { en: 'Visible' } } });
      const [row] = (
        await admin.query("SELECT count(*)::int AS n FROM expense_category WHERE code = 'STMT_VISIBLE'")
      ).rows;
      return row.n;
    });
    expect(seenMidJob).toBe(1);
  });

  it('runs every statement as the tenant: reads see only it, writes land in it', async () => {
    const out = await withTenantStatements(A, async () => {
      const mine = await db.expenseCategory.findMany({ select: { organizationId: true } });
      const theirs = await db.expenseCategory.count({ where: { organizationId: B } });
      const made = await db.expenseCategory.create({ data: { code: 'STMT_LANDS', label: { en: 'Lands' } } });
      const [s] = await db.$queryRaw<{ s: string }[]>`SELECT current_setting('app.current_org', true) AS s`;
      return { orgs: new Set(mine.map((c) => c.organizationId)), theirs, made: made.organizationId, raw: s.s };
    });
    expect(out.orgs).toEqual(new Set([A]));
    expect(out.theirs).toBe(0);
    expect(out.made).toBe(A);
    expect(out.raw).toBe(A);
  });

  it('db.$transaction(fn) is one real transaction: a throw inside undoes its writes', async () => {
    await expect(
      withTenantStatements(A, () =>
        db.$transaction(async () => {
          await db.expenseCategory.create({ data: { code: 'STMT_ROLLED', label: { en: 'Rolled' } } });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    const [row] = (await admin.query("SELECT count(*)::int AS n FROM expense_category WHERE code = 'STMT_ROLLED'"))
      .rows;
    expect(row.n).toBe(0);
  });

  it('refuses the array form of $transaction, whose operations would already have run', async () => {
    await expect(
      withTenantStatements(A, async () => db.$transaction([db.expenseCategory.count()] as never)),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('names its tenant, and refuses a nested scope or a malformed id', async () => {
    expect(await withTenantStatements(A, async () => currentTenantId())).toBe(A);
    await expect(withTenantStatements(A, () => withTenantStatements(B, async () => 1))).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    await expect(withTenantDb(A, () => withTenantStatements(A, async () => 1))).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    await expect(withTenantStatements('not-a-uuid', async () => 1)).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('ends with the job: db outside it throws again', async () => {
    await withTenantStatements(A, async () => db.expenseCategory.count());
    await expect(async () => db.expenseCategory.findMany()).rejects.toBeInstanceOf(TenantScopeError);
  });
});

describe('afterCommit — handing work to another process (w3-02a)', () => {
  /**
   * A request runs in one transaction; a job it queues must not start before the rows it
   * names are visible to the worker's own connection, and must not be queued at all for
   * rows that were rolled back.
   */
  const count = async (code: string) =>
    (await admin.query('SELECT count(*)::int AS n FROM expense_category WHERE code = $1', [code])).rows[0].n;

  it('runs after the commit, when another connection can already see the write', async () => {
    let seen = -1;
    await withTenantDb(A, async () => {
      await db.expenseCategory.create({ data: { code: 'AC_SEEN', label: { en: 'Seen' } } });
      await afterCommit(async () => {
        seen = await count('AC_SEEN');
      });
      expect(seen).toBe(-1); // not yet: still inside the transaction
    });
    expect(seen).toBe(1);
  });

  it('runs nothing queued by a transaction that rolled back', async () => {
    const ran: string[] = [];
    await expect(
      withTenantDb(A, async () => {
        await db.expenseCategory.create({ data: { code: 'AC_ROLLED', label: { en: 'Rolled' } } });
        await afterCommit(async () => {
          ran.push('job');
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ran).toEqual([]);
    expect(await count('AC_ROLLED')).toBe(0);
  });

  it('runs at once with no transaction to wait for, and never throws at its caller', async () => {
    const ran: string[] = [];
    await afterCommit(async () => {
      ran.push('outside');
    });
    await withTenantStatements(A, () =>
      afterCommit(async () => {
        ran.push('statements');
      }),
    );
    const warn = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      withTenantDb(A, () =>
        afterCommit(async () => {
          throw new Error('queue down');
        }),
      ),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/queue down/);
    warn.mockRestore();
    expect(ran).toEqual(['outside', 'statements']);
  });
});
