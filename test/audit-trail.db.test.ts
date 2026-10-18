// @vitest-environment node
/**
 * w5-06 — the audit trail router (`server/routers/audit.ts`), against a real Postgres.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/audit.db.test.ts` (1e682dd6), with the
 * filter cases of its mock-level `audit.test.ts` brought here: the router is SQL on
 * VeloExpense's `audit_entry`, so what each filter MEANS is only provable against the table.
 * VeloExpense, each marked:
 *   · two tenants, called as a request does (`caller`, by email and organization), so every
 *     read runs under the tenant's RLS — one tenant's chain is invisible to another;
 *   · pages on `sequence`, the chain's own order, where ExpenseOS pages on its UUIDv7 id;
 *   · retention is the tenant's own (w5-07, d82): read, set, refused below the floor, and
 *     gated on platform settings, as ExpenseOS's `retention` / `setRetention`;
 *   · a purge is simulated as VeloExpense's purge will make one — rows removed under
 *     `app.audit_purge` and the tenant's watermark set — and the verify still passes, and
 *     says so.
 */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { append } from '@/lib/audit/service';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';
const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
let A: string;
let B: string;
let bossId: string;
type AuditCaller = ReturnType<typeof import('@/server/routers/_app').appRouter.createCaller>['audit'];
let as: (email: string, org?: string) => AuditCaller;
const boss = () => as('boss@audit-a.test');

/** One entry in tenant A, by the founding admin. */
async function entry(action: 'REPORT_EDITED' | 'REPORT_DELETED' | 'BRANDING_COLOR_SET', extra: {
  entityId?: string;
  ip?: string;
  org?: string;
} = {}) {
  return withOrg(extra.org ?? A, (tx) =>
    append(
      tx,
      { id: extra.org && extra.org !== A ? null : bossId, email: extra.org && extra.org !== A ? 'x@b.test' : null, name: extra.org && extra.org !== A ? 'B person' : 'Boss Person', role: 'System Administrator' },
      {
        action,
        entityType: extra.entityId ? 'EXPENSE_REPORT' : null,
        entityId: extra.entityId ?? null,
        ipAddress: extra.ip ?? null,
        details: { n: 1 },
      },
    ),
  );
}

beforeAll(async () => {
  const { createOrganization } = await import('@/lib/onboarding/provision');
  const { createCallerFactory } = await import('@/server/trpc');
  const { appRouter } = await import('@/server/routers/_app');
  const { db } = await import('@/lib/db/prisma');
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Audit A', slug: 'audit-a', adminEmail: 'boss@audit-a.test', adminName: 'Boss Person' }))
    .organizationId;
  B = (await createOrganization({ name: 'Audit B', slug: 'audit-b', adminEmail: 'boss@audit-b.test', adminName: 'Other' }))
    .organizationId;
  bossId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@audit-a.test'`)).rows[0].id;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'emp@audit-a.test', 'Emp', $2)`,
    [A, EMPLOYEE],
  );
  as = (email, org = A) =>
    createCallerFactory(appRouter)({
      session: null,
      db,
      rbac: null,
      caller: { email, organizationId: org },
    }).audit;

  // A known shape on top of whatever provisioning wrote: 6 entries in A, 1 in B.
  await entry('REPORT_EDITED', { entityId: '11111111-1111-4111-8111-111111111111', ip: '198.51.100.7' });
  await entry('REPORT_DELETED', { entityId: '22222222-2222-4222-8222-222222222222' });
  await entry('BRANDING_COLOR_SET');
  await entry('REPORT_EDITED');
  await entry('REPORT_EDITED');
  await entry('BRANDING_COLOR_SET', { ip: '203.0.113.9' });
  await entry('REPORT_EDITED', { org: B });
});

afterAll(async () => {
  await admin.end();
});

describe('the log', () => {
  it('returns the newest entries first, in chain order', async () => {
    const { items } = await boss().list({ limit: 3 });
    expect(items.map((i) => i.action)).toEqual(['BRANDING_COLOR_SET', 'REPORT_EDITED', 'REPORT_EDITED']);
    const seqs = items.map((i) => BigInt(i.sequence));
    expect(seqs[0] > seqs[1] && seqs[1] > seqs[2]).toBe(true);
  });

  it('pages with the cursor without repeating or dropping a row', async () => {
    const all = (await boss().list({ limit: 200 })).items.map((i) => i.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<AuditCaller['list']>> = await boss().list({ limit: 2, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it("shows only this tenant's chain", async () => {
    // VeloExpense: per tenant, under RLS.
    const mine = (await boss().list({ limit: 200 })).items;
    expect(mine.every((i) => i.actorName !== 'B person')).toBe(true);
    const theirs = (await as('boss@audit-b.test', B).list({ limit: 200 })).items;
    expect(theirs.some((i) => i.actorName === 'B person')).toBe(true);
    expect(theirs.some((i) => i.actorName === 'Boss Person')).toBe(false);
  });
});

describe('filters', () => {
  const actions = async (filters: Parameters<AuditCaller['list']>[0]) =>
    (await boss().list(filters)).items.map((i) => i.action);

  it('filters by action, exactly and by exclusion', async () => {
    expect(new Set(await actions({ filters: [{ field: 'action', op: 'equals', value: 'REPORT_DELETED' }] }))).toEqual(
      new Set(['REPORT_DELETED']),
    );
    expect(await actions({ filters: [{ field: 'action', op: 'doesNotEqual', value: 'REPORT_EDITED' }] })).not.toContain(
      'REPORT_EDITED',
    );
  });

  it('chases an action namespace by prefix, and treats % and _ as themselves', async () => {
    const pre = await actions({ filters: [{ field: 'action', op: 'startsWith', value: 'REPORT_' }] });
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((a) => a.startsWith('REPORT_'))).toBe(true);
    // `_` would match any character if it were not escaped.
    expect(await actions({ filters: [{ field: 'action', op: 'startsWith', value: 'REPORT%' }] })).toEqual([]);
  });

  it('matches an actor by snapshot name or by id, and a substring against the name only', async () => {
    expect((await actions({ filters: [{ field: 'actor', op: 'equals', value: 'Boss Person' }] })).length).toBeGreaterThan(0);
    expect((await actions({ filters: [{ field: 'actor', op: 'equals', value: bossId }] })).length).toBeGreaterThan(0);
    expect((await actions({ filters: [{ field: 'actor', op: 'contains', value: 'oss pers' }] })).length).toBeGreaterThan(0);
    expect(await actions({ filters: [{ field: 'actor', op: 'contains', value: bossId.slice(0, 8) }] })).toEqual([]);
  });

  it('accepts a real uuid entityId, and drops one that is not a uuid instead of throwing', async () => {
    expect(
      await actions({ filters: [{ field: 'entityId', op: 'equals', value: '22222222-2222-4222-8222-222222222222' }] }),
    ).toEqual(['REPORT_DELETED']);
    const all = (await boss().list({ limit: 200 })).items.length;
    expect((await actions({ limit: 200, filters: [{ field: 'entityId', op: 'equals', value: 'not-a-uuid' }] })).length).toBe(all);
  });

  it('filters by address', async () => {
    expect(await actions({ filters: [{ field: 'ipAddress', op: 'equals', value: '198.51.100.7' }] })).toEqual(['REPORT_EDITED']);
    expect(await actions({ filters: [{ field: 'ipAddress', op: 'contains', value: '203.0' }] })).toEqual(['BRANDING_COLOR_SET']);
  });

  it('makes before exclusive and after inclusive, and drops an unparseable date', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(await actions({ filters: [{ field: 'date', op: 'after', value: future }] })).toEqual([]);
    const all = (await boss().list({ limit: 200 })).items.length;
    expect((await actions({ limit: 200, filters: [{ field: 'date', op: 'before', value: future }] })).length).toBe(all);
    expect((await actions({ limit: 200, filters: [{ field: 'date', op: 'after', value: 'tuesday' }] })).length).toBe(all);
  });

  it('ANDs several filters together', async () => {
    expect(
      await actions({
        filters: [
          { field: 'action', op: 'equals', value: 'BRANDING_COLOR_SET' },
          { field: 'ipAddress', op: 'equals', value: '203.0.113.9' },
        ],
      }),
    ).toEqual(['BRANDING_COLOR_SET']);
  });

  it('offers the actions and entity types the log actually contains', async () => {
    const facets = await boss().facets();
    expect(facets.actions).toEqual(expect.arrayContaining(['REPORT_EDITED', 'REPORT_DELETED', 'BRANDING_COLOR_SET']));
    expect(facets.entityTypes).toContain('EXPENSE_REPORT');
  });
});

describe('stats', () => {
  it('counts the entries, spans the window, and states the 7-year floor', async () => {
    const s = await boss().stats();
    expect(s.total).toBeGreaterThanOrEqual(6);
    expect(s.oldestAt).toBeInstanceOf(Date);
    expect(s.retentionYears).toBe(7);
    expect(s.lastPurge).toBeNull();
  });
});

describe('verify', () => {
  it('reports a clean chain, and records the verification it performed', async () => {
    const before = (await boss().list({ limit: 200 })).items.length;
    const r = await boss().verify({});
    expect(r).toMatchObject({ ok: true, purgeAware: false });
    expect(r.scanned).toBe(before);
    const [newest] = (await boss().list({ limit: 1 })).items;
    // VeloExpense: the chain records an entity type only with an id (0010), so ExpenseOS's
    // `entityType: 'Audit'` is kept in the details by the writer.
    expect(newest).toMatchObject({ action: 'AUDIT_CHAIN_VERIFIED', entityType: null });
    expect(newest.details).toMatchObject({ ok: true, scanned: before, entityType: 'Audit' });
  });

  it('verifies nothing rather than the whole table when a day window is empty', async () => {
    const r = await as('boss@audit-b.test', B).verify({ lastDays: 1 });
    expect(r.ok).toBe(true);
  });

  it('names the entry and the kind of break when a row was edited', async () => {
    const victim = (await boss().list({ limit: 200 })).items.find((i) => i.action === 'REPORT_DELETED')!;
    await admin.query(
      `BEGIN; SELECT set_config('app.audit_purge', 'on', true);
       UPDATE audit_entry SET details = '{"n":2}' WHERE id = '${victim.id}'; COMMIT;`,
    ).catch(async () => {
      // The append-only trigger refuses an UPDATE even under the purge flag; a raw edit
      // needs the trigger out of the way, which is exactly what tampering looks like.
      await admin.query(`ALTER TABLE audit_entry DISABLE TRIGGER USER`);
      await admin.query(`UPDATE audit_entry SET details = '{"n":2}' WHERE id = $1`, [victim.id]);
      await admin.query(`ALTER TABLE audit_entry ENABLE TRIGGER USER`);
    });
    const r = await boss().verify({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('entry-hash-mismatch');
    expect(r.at.id).toBe(victim.id);
  });
});

describe('a purged head', () => {
  it('still verifies across the purge boundary, and says so', async () => {
    // B's chain, so A's deliberate break above does not interfere. Purged as VeloExpense's
    // purge will purge: the oldest rows deleted under app.audit_purge, the watermark set to
    // the last one's hash.
    const rows = (
      await admin.query(
        `SELECT id, sequence, entry_hash FROM audit_entry WHERE organization_id = $1 ORDER BY sequence`,
        [B],
      )
    ).rows as Array<{ id: string; sequence: string; entry_hash: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const cut = rows[0];
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('app.audit_purge', 'on', true)`);
    await admin.query(`DELETE FROM audit_entry WHERE id = $1`, [cut.id]);
    await admin.query(
      `UPDATE organization SET audit_purged_through_sequence = $2, audit_purged_head_hash = $3 WHERE id = $1`,
      [B, cut.sequence, cut.entry_hash],
    );
    await admin.query('COMMIT');

    const caller = as('boss@audit-b.test', B);
    const s = await caller.stats();
    // A watermark written by hand here, as one from before 0075 would be: no count, no time.
    expect(s.lastPurge).toEqual({
      purgedThroughSequence: cut.sequence,
      lastPurgedEntryHash: cut.entry_hash,
      purgedCount: null,
      runAt: null,
    });
    const r = await caller.verify({});
    expect(r).toMatchObject({ ok: true, purgeAware: true });
  });
});

describe('retention', () => {
  it('reads the floor as the default until the tenant chooses', async () => {
    await expect(boss().retention()).resolves.toMatchObject({ years: 7, isDefault: true });
  });

  it("sets the tenant's own window, audits the change, and the stats report it", async () => {
    await expect(boss().setRetention({ years: 10 })).resolves.toEqual({ years: 10 });
    await expect(boss().retention()).resolves.toMatchObject({ years: 10, isDefault: false });
    expect((await boss().stats()).retentionYears).toBe(10);
    const [newest] = (await boss().list({ limit: 1 })).items;
    expect(newest.action).toBe('AUDIT_RETENTION_CHANGED');
    expect(newest.details).toMatchObject({ years: 10 });
    // Another tenant is untouched.
    await expect(as('boss@audit-b.test', B).retention()).resolves.toMatchObject({ years: 7, isDefault: true });
  });

  it('refuses to shorten retention below the SOX floor', async () => {
    await expect(boss().setRetention({ years: 6 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('who may do what', () => {
  it('gates reads on audit.read and verification on its own permission', async () => {
    const emp = as('emp@audit-a.test');
    await expect(emp.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(emp.stats()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(emp.verify({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(emp.retention()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(emp.setRetention({ years: 9 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The permissions are the ones named, not a role check by another name.
    expect(P.audit.read).toBe('audit.read');
    expect(P.audit.chainVerify).toBe('audit.chain.verify');
  });
});
