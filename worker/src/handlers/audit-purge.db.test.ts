// @vitest-environment node
/**
 * w5-07 — `audit.purge` and `notification.prune`, against a real Postgres.
 *
 * Ported from ExpenseOS `audit-purge.db.test.ts`, `audit-purge.test.ts` and
 * `notification-prune.test.ts` (1e682dd6). ExpenseOS's unit cases assert on the Prisma calls
 * the handler makes; VeloExpense's handler is SQL on `audit_entry` and `organization`, so each
 * of those claims is asserted on the tables instead. Time is moved, not rows: the handler takes
 * `now`, and running it years ahead makes the rows already written old enough.
 *
 * VeloExpense: two tenants, because the chain, the retention window and the watermark are all
 * per tenant (0010, 0075) — a purge in one must not touch the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { append } from '@/lib/audit/service';
import { verifyChain } from '@/lib/audit/verify';
import { inTenant } from '../lib/tenant';
import { handleAuditPurge } from './audit-purge';
import { DEFAULT_RETENTION_DAYS, handleNotificationPrune } from './notification-prune';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const YEAR = 365.25 * 24 * 60 * 60 * 1000;
let A: string;
let B: string;
let bossA: string;
let bossB: string;

const yearsAhead = (n: number) => new Date(Date.now() + n * YEAR);
const purge = (org: string, now: Date, maxPerRun?: number) =>
  inTenant({ organizationId: org }, () => handleAuditPurge({ organizationId: org }, { now, maxPerRun }));

async function write(org: string, actor: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await withOrg(org, (tx) =>
      append(tx, { id: actor, name: 'Boss', role: 'System Administrator' }, { action: 'REPORT_EDITED', details: { i } }),
    );
  }
}

async function chain(org: string) {
  return (
    await admin.query(
      `SELECT sequence::text AS sequence, action, entry_hash, prev_hash FROM audit_entry
        WHERE organization_id = $1 ORDER BY sequence`,
      [org],
    )
  ).rows as Array<{ sequence: string; action: string; entry_hash: string; prev_hash: string | null }>;
}

async function watermark(org: string) {
  return (
    await admin.query(
      `SELECT audit_purged_through_sequence::text AS through, audit_purged_head_hash AS hash,
              audit_purged_count AS count, audit_purged_at AS at
         FROM organization WHERE id = $1`,
      [org],
    )
  ).rows[0] as { through: string | null; hash: string | null; count: number | null; at: Date | null };
}

beforeAll(async () => {
  const { createOrganization } = await import('@/lib/onboarding/provision');
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Purge A', slug: 'purge-a', adminEmail: 'boss@purge-a.test', adminName: 'Boss' })).organizationId;
  B = (await createOrganization({ name: 'Purge B', slug: 'purge-b', adminEmail: 'boss@purge-b.test', adminName: 'Boss' })).organizationId;
  bossA = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@purge-a.test'`)).rows[0].id;
  bossB = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@purge-b.test'`)).rows[0].id;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(async () => {
  // Fresh chains and no watermark, per case.
  await admin.query('BEGIN');
  await admin.query(`SELECT set_config('app.audit_purge', 'on', true)`);
  await admin.query('DELETE FROM audit_entry');
  await admin.query(
    `UPDATE organization SET audit_purged_through_sequence = NULL, audit_purged_head_hash = NULL,
            audit_purged_count = NULL, audit_purged_at = NULL, audit_retention_years = NULL`,
  );
  await admin.query('COMMIT');
  await write(A, bossA, 5);
  await write(B, bossB, 3);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await admin.end();
});

describe('what is eligible', () => {
  it('purges nothing inside the window — and writes no watermark, deletes nothing and audits nothing', async () => {
    const r = await purge(A, new Date());
    expect(r.purgedCount).toBe(0);
    expect((await chain(A)).length).toBe(5);
    expect((await watermark(A)).through).toBeNull();
  });

  it('puts the cutoff seven years back by default', async () => {
    expect((await purge(A, yearsAhead(6.9))).purgedCount).toBe(0);
    const r = await purge(A, yearsAhead(7.1));
    expect(r.retentionYears).toBe(7);
    expect(r.purgedCount).toBe(5);
  });

  it("honours a longer retention the tenant set, and only that tenant's", async () => {
    await admin.query(`UPDATE organization SET audit_retention_years = 10 WHERE id = $1`, [A]);
    expect((await purge(A, yearsAhead(8))).purgedCount).toBe(0);
    // B kept the floor, so the same day purges B.
    expect((await purge(B, yearsAhead(8))).purgedCount).toBe(3);
    expect((await purge(A, yearsAhead(10.1))).purgedCount).toBe(5);
  });

  it('never deletes a row before its own stamped horizon — and stops the purge there, at the chain', async () => {
    // VeloExpense's writer stamps no expiry, so one is stamped by hand on the third row. The
    // purge may not skip it and delete the rows after it: that would cut the chain in the
    // middle, where no watermark reconciles it.
    const rows = await chain(A);
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('app.audit_purge', 'on', true)`);
    await admin.query(`UPDATE audit_entry SET expires_at = now() + interval '100 years' WHERE sequence = $1`, [rows[2].sequence]);
    await admin.query('COMMIT');
    const r = await purge(A, yearsAhead(8));
    expect(r.purgedCount).toBe(2);
    expect((await chain(A)).map((x) => x.sequence).slice(0, 3)).toEqual(
      [rows[2].sequence, rows[3].sequence, rows[4].sequence],
    );
  });

  it('refuses a retention below the SOX floor at the database too', async () => {
    await expect(admin.query(`UPDATE organization SET audit_retention_years = 6 WHERE id = $1`, [A])).rejects.toThrow(
      /audit_retention_bounds|check constraint/i,
    );
  });
});

describe('the watermark', () => {
  it('describes the last row it deleted, which is the prevHash the survivor carries', async () => {
    // Two survivors: rows written after the purge's own cutoff.
    const before = await chain(A);
    const r = await purge(A, yearsAhead(8), 3);
    expect(r.purgedCount).toBe(3);
    const wm = await watermark(A);
    expect(wm).toMatchObject({ through: before[2].sequence, hash: before[2].entry_hash, count: 3 });
    expect(wm.at).toBeInstanceOf(Date);
    const survivors = await chain(A);
    expect(survivors[0].prev_hash).toBe(before[2].entry_hash);
  });

  it('keeps the chain verifiable across the purge boundary', async () => {
    await purge(A, yearsAhead(8), 3);
    const result = await withOrg(A, (tx) => verifyChain(tx));
    expect(result.ok).toBe(true);
  });
});

describe('the batch', () => {
  it('caps a run, says it was capped, and the next run carries on from the watermark', async () => {
    const first = await purge(A, yearsAhead(8), 2);
    expect(first).toMatchObject({ purgedCount: 2, truncated: true });
    const second = await purge(A, yearsAhead(8), 2);
    expect(second).toMatchObject({ purgedCount: 2, truncated: true });
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });
});

describe('the audit row it writes', () => {
  it('is written after the delete, so it is never inside its own purged range, and states what it did', async () => {
    const r = await purge(A, yearsAhead(8));
    const rows = await chain(A);
    // Everything the purge could reach is gone; what is left is its own row.
    expect(rows.map((x) => x.action)).toEqual(['AUDIT_PURGED']);
    const details = (
      await admin.query(`SELECT details, actor_name FROM audit_entry WHERE organization_id = $1 AND action = 'AUDIT_PURGED'`, [A])
    ).rows[0];
    expect(details.actor_name).toBe('system:audit.purge');
    expect(details.details).toMatchObject({ retentionYears: 7, purgedCount: r.purgedCount, truncated: false });
    expect(typeof details.details.cutoff).toBe('string');
    expect(typeof details.details.purgedThrough).toBe('string');
  });
});

describe('one tenant at a time', () => {
  it("purges only the tenant it runs as, and sets only that tenant's watermark", async () => {
    await purge(A, yearsAhead(8));
    expect((await chain(B)).length).toBe(3);
    expect((await watermark(B)).through).toBeNull();
  });
});

describe('notification.prune', () => {
  async function notifications(org: string, ageDays: number[]) {
    const user = (await admin.query(`SELECT id FROM app_user WHERE organization_id = $1 LIMIT 1`, [org])).rows[0].id;
    for (const age of ageDays) {
      const act = (
        await admin.query(
          `INSERT INTO activity (organization_id, subject_type, subject_id, event_type, actor_id)
           VALUES ($1, 'EXPENSE_REPORT', gen_random_uuid(), 'COMMENT', $2) RETURNING id`,
          [org, user],
        )
      ).rows[0].id;
      const n = (
        await admin.query(
          `INSERT INTO notification (organization_id, activity_id, recipient_id, created_at)
           VALUES ($1, $2, $3, now() - make_interval(days => $4)) RETURNING id`,
          [org, act, user, age],
        )
      ).rows[0].id;
      await admin.query(
        `INSERT INTO notification_delivery (organization_id, notification_id, channel) VALUES ($1, $2, 'EMAIL')`,
        [org, n],
      );
    }
  }
  const count = async (table: string, org: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [org])).rows[0].n as number;

  beforeEach(async () => {
    await admin.query('DELETE FROM notification_delivery');
    await admin.query('DELETE FROM notification');
    await admin.query('DELETE FROM activity');
  });

  it('deletes by age against a cutoff in the past, keeps the activity, and names the count', async () => {
    await notifications(A, [1, 89, 91, 400]);
    const removed = await inTenant({ organizationId: A }, () => handleNotificationPrune({ organizationId: A }));
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(removed).toBe(2);
    expect(await count('notification', A)).toBe(2);
    // Activities are intentionally kept — they are the history.
    expect(await count('activity', A)).toBe(4);
    // VeloExpense: the delivery rows go with their notification.
    expect(await count('notification_delivery', A)).toBe(2);
  });

  it('touches only the tenant it runs as', async () => {
    await notifications(A, [200]);
    await notifications(B, [200]);
    await inTenant({ organizationId: A }, () => handleNotificationPrune({ organizationId: A }));
    expect(await count('notification', A)).toBe(0);
    expect(await count('notification', B)).toBe(1);
  });
});
