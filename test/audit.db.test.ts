/**
 * VX2-6 — the audit log's STRUCTURAL guarantees, against a real Postgres.
 *
 * Own org slug ('audit-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * This file tests the DATABASE, not a service. The guarantees migration 0010
 * ships are CHECK constraints, two unique indexes and a trigger, and they have
 * to be exercised as Postgres enforces them rather than as a service politely
 * avoids them — because the whole point of an append-only tamper-evident log is
 * that it holds against code that did not go through the writer, including a
 * hand-typed UPDATE during an incident. Same reasoning as VX2-1's constraint
 * tests in test/approvals.db.test.ts.
 *
 * Two of these tests assert properties nobody would think to look for: that
 * sequence GAPS are normal, and that two entries written in one transaction get
 * different timestamps. Both are load-bearing and both are easy to "fix" into
 * bugs later, so they are pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { transaction } from '@/lib/db/client';
import { append, AuditError } from '@/lib/audit/service';
import { verifyChain } from '@/lib/audit/verify';
import type { AuditAction } from '@/lib/audit/actions';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'audit.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL) in the environment. ' +
      'See the local-setup block in HANDOFF.md for the two export lines.',
  );
}
const admin = new Pool({ connectionString: ADMIN_URL });

let orgId: string;
let otherOrgId: string;
let actorId: string;
// VX3-10. The second tenant needs its OWN actor. Until migration 0019 it did
// not: `insertRaw` defaulted every row's actor to `actorId`, a user in the FIRST
// org, and the rows this suite wrote into `audit-co-2` referenced it happily —
// because a single-column `REFERENCES app_user(id)` is checked with RLS bypassed
// and does not care which tenant the target belongs to (GAP-AUDIT TN-1). So this
// suite had been writing a cross-tenant audit row since VX2-6 and nothing
// objected. The composite FK objects, which is the point of it.
let otherActorId: string;

const H = (c: string) => c.repeat(64);

/**
 * Append one entry by RAW SQL, bypassing lib/audit entirely. Named apart from
 * the service's `append` on purpose: the constraint tests below have to reach
 * the database directly, because what they assert is what Postgres refuses — not
 * what the writer politely avoids.
 */
async function insertRaw(
  org: string,
  prevHash: string | null,
  entryHash: string,
  over: Record<string, unknown> = {},
) {
  return withOrg(org, async (tx) => {
    const r = await tx.query(
      `INSERT INTO audit_entry
         (organization_id, actor_id, actor_email, actor_name, actor_role, action,
          entity_type, entity_id, details, ip_address, prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       RETURNING id, sequence, occurred_at`,
      [
        org,
        // The actor defaults to the one belonging to the org being WRITTEN INTO,
        // not to a module-level id that happens to be the first org's. See the
        // note on `otherActorId`.
        over.actorId === undefined ? (org === orgId ? actorId : otherActorId) : over.actorId,
        over.actorEmail ?? null,
        over.actorName ?? 'Ada Admin',
        over.actorRole ?? 'ADMIN',
        over.action ?? 'REPORT_SUBMITTED',
        over.entityType === undefined ? 'expense_report' : over.entityType,
        over.entityId === undefined ? '00000000-0000-4000-8000-000000000001' : over.entityId,
        JSON.stringify(over.details ?? { totalMinor: '1000' }),
        over.ipAddress ?? '198.51.100.7',
        prevHash,
        entryHash,
      ],
    );
    return r.rows[0] as { id: string; sequence: string; occurred_at: Date };
  });
}

/** Wipe this tenant's chain between tests. Uses the purge escape hatch, which
 *  is exactly what a retention job would do — so the cleanup also proves the
 *  hatch works. */
async function clearChain() {
  // ONE statement string, so it runs on ONE pooled connection. A `Pool` acquires
  // a connection per `query()` call, so opening the hatch in one call and
  // deleting in the next would set the flag on a connection that then goes back
  // to the pool while the DELETE runs somewhere else — and the DELETE would hit
  // the append-only trigger. Transaction-local (`true`) so nothing leaks either.
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
}

beforeAll(async () => {
  // TRUNCATE does not fire row-level DELETE triggers, so the append-only
  // trigger does not block the suite's own setup. That is not luck — it is why
  // a row trigger is the right tool here and a rule on DELETE would not be.
  await admin.query('TRUNCATE app_user, organization CASCADE');
  // No ORDER BY on a RETURNING clause — Postgres does not allow it, and the
  // rows are matched by slug below anyway.
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('audit-co','Audit Co'), ('audit-co-2','Audit Co 2')
     RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'audit-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'audit-co-2').id;
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'ada@audit.test','Ada Admin','ADMIN') RETURNING id`,
      [orgId],
    );
    actorId = u.rows[0].id;
  });
  await withOrg(otherOrgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'bob@audit2.test','Bob Admin','ADMIN') RETURNING id`,
      [otherOrgId],
    );
    otherActorId = u.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

/* ── append-only ───────────────────────────────────────────────────────────── */

describe('append-only', () => {
  it('refuses an UPDATE and a DELETE', async () => {
    await clearChain();
    const row = await insertRaw(orgId, null, H('a'));
    await expect(
      withOrg(orgId, (tx) =>
        tx.query('UPDATE audit_entry SET action = $2 WHERE id = $1', [row.id, 'TAMPERED']),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withOrg(orgId, (tx) => tx.query('DELETE FROM audit_entry WHERE id = $1', [row.id])),
    ).rejects.toThrow(/append-only/);
    // Still there, unchanged.
    const after = await withOrg(orgId, (tx) =>
      tx.query('SELECT action FROM audit_entry WHERE id = $1', [row.id]),
    );
    expect(after.rows[0].action).toBe('REPORT_SUBMITTED');
  });

  it('lets a retention purge through when the session says so', async () => {
    // The one door, and it has to be opened deliberately. A purge is an
    // auditable act; it must not be reachable by a stray UPDATE.
    await clearChain();
    const row = await insertRaw(orgId, null, H('a'));
    await withOrg(orgId, async (tx) => {
      await tx.query("SELECT set_config('app.audit_purge', 'on', true)");
      await tx.query('DELETE FROM audit_entry WHERE id = $1', [row.id]);
    });
    const left = await withOrg(orgId, (tx) => tx.query('SELECT 1 FROM audit_entry'));
    expect(left.rows).toHaveLength(0);
  });

  it('closes the door again after the purge transaction ends', async () => {
    // set_config(..., true) is transaction-local, so the hatch cannot leak into
    // the next request on a pooled connection. Asserted because the whole
    // guarantee rests on it.
    await clearChain();
    const row = await insertRaw(orgId, null, H('a'));
    await withOrg(orgId, async (tx) => {
      await tx.query("SELECT set_config('app.audit_purge', 'on', true)");
    });
    await expect(
      withOrg(orgId, (tx) => tx.query('DELETE FROM audit_entry WHERE id = $1', [row.id])),
    ).rejects.toThrow(/append-only/);
  });
});

/* ── the chain cannot fork ─────────────────────────────────────────────────── */

describe('fork resistance', () => {
  it('allows exactly one genesis row per tenant', async () => {
    await clearChain();
    await insertRaw(orgId, null, H('a'));
    await expect(insertRaw(orgId, null, H('b'))).rejects.toThrow(/audit_entry_one_genesis_idx/);
  });

  it('refuses two rows claiming the same predecessor', async () => {
    // This IS what a fork is. ExpenseOS prevents it with an advisory lock alone,
    // which is application discipline; the index makes it impossible even for a
    // code path that forgot the lock.
    await clearChain();
    await insertRaw(orgId, null, H('a'));
    await insertRaw(orgId, H('a'), H('b'));
    await expect(insertRaw(orgId, H('a'), H('c'))).rejects.toThrow(/audit_entry_no_fork_idx/);
  });

  it('scopes both rules PER TENANT, not globally', async () => {
    // The control that gives the two tests above their meaning: a build with a
    // global unique index would pass both of them and break every tenant after
    // the first. Two tenants each get a genesis row, and each may reference the
    // same hash value as its predecessor.
    await clearChain();
    await insertRaw(orgId, null, H('a'));
    await insertRaw(otherOrgId, null, H('a'));
    await insertRaw(orgId, H('a'), H('b'));
    await expect(insertRaw(otherOrgId, H('a'), H('b'))).resolves.toBeTruthy();
  });
});

/* ── column constraints ───────────────────────────────────────────────────── */

describe('constraints', () => {
  it('requires a 64-char lowercase-hex entry hash', async () => {
    await clearChain();
    await expect(insertRaw(orgId, null, 'not-a-hash')).rejects.toThrow(/audit_entry_hash_shape/);
    await expect(insertRaw(orgId, null, H('A'))).rejects.toThrow(/audit_entry_hash_shape/);
    await expect(insertRaw(orgId, null, 'a'.repeat(63))).rejects.toThrow(/audit_entry_hash_shape/);
  });

  it('refuses an actor that is both internal and external', async () => {
    await clearChain();
    await expect(
      insertRaw(orgId, null, H('a'), { actorEmail: 'ext@vendor.test' }),
    ).rejects.toThrow(/audit_entry_actor_exclusive/);
  });

  it('accepts an external actor with no app_user row', async () => {
    // VX2-8's approve-link needs this: an external approver decides, and the
    // audit has to record who without inventing a user.
    await clearChain();
    const row = await insertRaw(orgId, null, H('a'), {
      actorId: null,
      actorEmail: 'ext@vendor.test',
      actorName: 'ext@vendor.test',
      actorRole: 'EXTERNAL',
    });
    expect(row.id).toBeTruthy();
  });

  it('requires an entity reference to be both columns or neither', async () => {
    await clearChain();
    await expect(
      insertRaw(orgId, null, H('a'), { entityId: null }),
    ).rejects.toThrow(/audit_entry_entity_complete/);
    await expect(
      insertRaw(orgId, null, H('b'), { entityType: null }),
    ).rejects.toThrow(/audit_entry_entity_complete/);
    await expect(
      insertRaw(orgId, null, H('c'), { entityType: null, entityId: null }),
    ).resolves.toBeTruthy();
  });

  it('refuses a blank actor name or action', async () => {
    await clearChain();
    await expect(insertRaw(orgId, null, H('a'), { actorName: '   ' })).rejects.toThrow(
      /audit_entry_actor_name_present/,
    );
    await expect(insertRaw(orgId, null, H('b'), { action: '' })).rejects.toThrow(
      /audit_entry_action_present/,
    );
  });

  it('refuses to hard-delete an actor who has written entries', async () => {
    // ON DELETE RESTRICT, and it is load-bearing rather than tidy: actor_id is
    // INSIDE the hash, so SET NULL would permanently break verification of every
    // row that actor wrote. Employees are soft-deleted in normal operation.
    await clearChain();
    await insertRaw(orgId, null, H('a'));
    await expect(admin.query('DELETE FROM app_user WHERE id = $1', [actorId])).rejects.toThrow(
      /audit_entry_actor_id_fkey|violates foreign key/,
    );
  });

  it('pairs the purge watermark columns and checks the hash shape', async () => {
    await expect(
      admin.query(
        'UPDATE organization SET audit_purged_through_sequence = 5 WHERE id = $1',
        [orgId],
      ),
    ).rejects.toThrow(/organization_audit_watermark_complete/);
    await expect(
      admin.query(
        `UPDATE organization
            SET audit_purged_through_sequence = 5, audit_purged_head_hash = 'nope'
          WHERE id = $1`,
        [orgId],
      ),
    ).rejects.toThrow(/organization_audit_watermark_shape/);
    await expect(
      admin.query(
        `UPDATE organization
            SET audit_purged_through_sequence = 5, audit_purged_head_hash = $2
          WHERE id = $1`,
        [orgId, H('a')],
      ),
    ).resolves.toBeTruthy();
    await admin.query(
      `UPDATE organization
          SET audit_purged_through_sequence = NULL, audit_purged_head_hash = NULL
        WHERE id = $1`,
      [orgId],
    );
  });
});

/* ── two properties that look like bugs and are not ───────────────────────── */

describe('sequence and time semantics', () => {
  it('leaves GAPS in sequence after a rolled-back append — and that is correct', async () => {
    /**
     * Pinned so nobody "fixes" it. A sequence is non-transactional: a rolled-back
     * INSERT consumes a value and never fills it, so gaps are normal operation.
     *
     * That matters because a gap is ALSO what a deleted row leaves behind, and
     * the two are indistinguishable by sequence alone. Deletion is caught by the
     * HASH — the next surviving row's prev_hash stops matching — so the verifier
     * must never treat contiguity as a signal, and an admin must never be told
     * that a missing number is tampering. See GAP-AUDIT AU-6.
     */
    await clearChain();
    const first = await insertRaw(orgId, null, H('a'));
    // A failing append still consumes a sequence value.
    await expect(insertRaw(orgId, H('a'), 'not-a-hash')).rejects.toThrow();
    const second = await insertRaw(orgId, H('a'), H('b'));
    expect(Number(second.sequence)).toBeGreaterThan(Number(first.sequence) + 1);
  });

  it('gives two entries in ONE transaction different timestamps', async () => {
    /**
     * Because occurred_at defaults to clock_timestamp(), not now(). now() is
     * transaction-START time, so a single transaction writing several audit rows
     * — the normal case, since one state change can emit more than one entry —
     * would stamp them all identically and their order would be unrecoverable
     * from this column.
     *
     * TWO things make this test trustworthy, and the first version had neither:
     *
     * 1. The comparison happens INSIDE Postgres. `timestamptz` keeps
     *    microseconds; a JS `Date` truncates to milliseconds. Two inserts under
     *    a millisecond apart therefore produce identical `toISOString()` output
     *    while the stored values differ, so asserting in JS tested the driver's
     *    precision rather than the column's default.
     * 2. An explicit `pg_sleep` between the inserts, so the difference is
     *    guaranteed rather than merely likely — and so the contrast below is
     *    airtight: however long the transaction runs, `now()` does not move.
     */
    await clearChain();
    const out = await withOrg(orgId, async (tx) => {
      const insert = (prev: string | null, hash: string) =>
        tx.query(
          `INSERT INTO audit_entry
             (organization_id, actor_id, actor_name, actor_role, action, prev_hash, entry_hash)
           VALUES ($1, $2, 'Ada Admin', 'ADMIN', 'X', $3, $4)`,
          [orgId, actorId, prev, hash],
        );
      const before = await tx.query('SELECT now() AS t');
      await insert(null, H('a'));
      await tx.query('SELECT pg_sleep(0.005)');
      await insert(H('a'), H('b'));
      const after = await tx.query('SELECT now() AS t');
      const cmp = await tx.query(
        `SELECT count(DISTINCT occurred_at)::int AS distinct_ts, count(*)::int AS n
           FROM audit_entry`,
      );
      return {
        cmp: cmp.rows[0] as { distinct_ts: number; n: number },
        before: before.rows[0].t as Date,
        after: after.rows[0].t as Date,
      };
    });
    // Two rows, two distinct timestamps.
    expect(out.cmp).toEqual({ distinct_ts: 2, n: 2 });
    // And the trap that avoids: now() did not advance across the same span, so a
    // now() default would have collapsed both rows onto one instant.
    expect(out.before.getTime()).toBe(out.after.getTime());
  });
});

/* ── the writer and the verifier ──────────────────────────────────────────── */

const ADA = { id: '', name: 'Ada Admin', role: 'ADMIN' };

/** Run one statement with the append-only hatch open — i.e. simulate exactly the
 *  thing the chain exists to detect: somebody with database access editing or
 *  removing a row by hand. */
async function tamper(sql: string, params: unknown[] = []) {
  await withOrg(orgId, async (tx) => {
    await tx.query("SELECT set_config('app.audit_purge', 'on', true)");
    await tx.query(sql, params);
  });
}

/**
 * An action name for a test that is about the CHAIN, not about the action.
 *
 * `AuditInput.action` is typed as `AuditAction` (the registry, #100) so a typo in
 * production is a compile error. These tests deliberately use names no product
 * code writes — 'X', 'A_ONE', 'ONE' — because what they pin is that hashing,
 * ordering, tenant isolation and the BigInt refusal do not care WHICH action a
 * row carries. Saying that with a named helper rather than a bare `as` makes the
 * intent legible: this is a deliberate escape, not an unfixed type error.
 */
const arbitraryAction = (name: string) => name as AuditAction;

describe('append', () => {
  it('writes a genesis row and then links to it', async () => {
    await clearChain();
    const first = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('REPORT_SUBMITTED') }),
    );
    expect(first.prevHash).toBeNull();
    const second = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('REPORT_APPROVED') }),
    );
    expect(second.prevHash).toBe(first.entryHash);
    const v = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(v).toMatchObject({ ok: true, scanned: 2 });
  });

  it('starts a SEPARATE chain for a second tenant', async () => {
    /**
     * THE multi-tenancy test, and the one a verbatim port of ExpenseOS fails.
     * Their head read is `ORDER BY id DESC LIMIT 1` with no tenant predicate, so
     * tenant B's first entry would chain onto tenant A's head — and then
     * verifying either tenant would require reading the other's rows, which RLS
     * forbids. See GAP-AUDIT AU-1.
     */
    await clearChain();
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('A_ONE') }));
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('A_TWO') }));
    const b = await withOrg(otherOrgId, (tx) =>
      append(tx, { id: null, email: 'ext@vendor.test', name: 'Ext', role: 'EXTERNAL' }, {
        action: arbitraryAction('B_ONE'),
      }),
    );
    // B's first row is a GENESIS row, not a link onto A's head.
    expect(b.prevHash).toBeNull();
    // Both chains verify on their own, seeing only their own rows.
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true, scanned: 2 });
    expect(await withOrg(otherOrgId, (tx) => verifyChain(tx))).toMatchObject({
      ok: true,
      scanned: 1,
    });
  });

  it('round-trips details, ip and an external actor through the hash', async () => {
    // Verification recomputes from what the database returns, so every column in
    // the payload has to survive the round trip byte-identically — a jsonb key
    // reorder, an inet normalization or a timestamp truncation would all show up
    // here as an entry-hash mismatch.
    await clearChain();
    await withOrg(orgId, (tx) =>
      append(
        tx,
        { id: null, email: 'ext@vendor.test', name: 'External Signer', role: 'EXTERNAL' },
        {
          action: arbitraryAction('REPORT_APPROVED'),
          entityType: 'expense_report',
          entityId: '00000000-0000-4000-8000-00000000000a',
          // Keys deliberately out of alphabetical order, and an amount as a
          // STRING as AU-5 requires.
          details: { totalMinor: '123456', currency: 'CAD', nested: { b: 1, a: [2, 3] } },
          ipAddress: '203.0.113.42',
          requestId: '00000000-0000-4000-8000-00000000000b',
          userAgent: 'vitest',
        },
      ),
    );
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true, scanned: 1 });
  });

  it('refuses a BigInt in details, inside the transaction', async () => {
    await clearChain();
    await expect(
      withOrg(orgId, (tx) =>
        append(tx, { ...ADA, id: actorId }, {
          action: arbitraryAction('X'),
          details: { totalMinor: 100000n } as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toThrow(/BigInt/);
    // Nothing was written — the throw happened before the INSERT.
    const left = await withOrg(orgId, (tx) => tx.query('SELECT 1 FROM audit_entry'));
    expect(left.rows).toHaveLength(0);
  });

  it('rejects a malformed actor or entity reference with a sentence', async () => {
    await clearChain();
    const bad = (actor: Parameters<typeof append>[1], input: Parameters<typeof append>[2]) =>
      withOrg(orgId, (tx) => append(tx, actor, input));
    await expect(
      bad({ id: actorId, email: 'both@x.test', name: 'N', role: 'ADMIN' }, { action: arbitraryAction('X') }),
    ).rejects.toBeInstanceOf(AuditError);
    await expect(bad({ id: null, name: 'N', role: 'ADMIN' }, { action: arbitraryAction('X') })).rejects.toBeInstanceOf(
      AuditError,
    );
    await expect(bad({ ...ADA, id: actorId }, { action: arbitraryAction('  ') })).rejects.toBeInstanceOf(AuditError);
    await expect(
      bad({ ...ADA, id: actorId }, { action: arbitraryAction('X'), entityType: 'expense_report' }),
    ).rejects.toBeInstanceOf(AuditError);
  });

  it('refuses to write outside a tenant context', async () => {
    // An audit append with no app.current_org is a caller bug. Saying so beats
    // an RLS policy violation, which is what would happen otherwise.
    await expect(
      transaction((tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('X') })),
    ).rejects.toThrow(/no tenant context/);
  });
});

describe('verifyChain', () => {
  it('detects an edited row and names it', async () => {
    await clearChain();
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('ONE') }));
    const target = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('TWO') }),
    );
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('THREE') }));

    await tamper('UPDATE audit_entry SET action = $2 WHERE id = $1', [target.id, 'TAMPERED']);

    const v = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toBe('entry-hash-mismatch');
    // Diagnostics have to identify the row, or an admin cannot act on them.
    expect(v.at.id).toBe(target.id);
    expect(v.at.recomputedEntry).not.toBe(v.at.storedEntry);
    // …and it stopped AT the bad row rather than plowing on.
    expect(v.scanned).toBe(1);
  });

  it('detects a removed middle row', async () => {
    // The chain's whole job. Sequence contiguity would NOT catch this reliably —
    // gaps are normal — so the prev_hash link is what does the work.
    await clearChain();
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('ONE') }));
    const middle = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('TWO') }),
    );
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('THREE') }));

    await tamper('DELETE FROM audit_entry WHERE id = $1', [middle.id]);

    const v = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(v).toMatchObject({ ok: false, reason: 'prev-hash-mismatch', scanned: 1 });
  });

  it('reconciles a retention purge through the stored watermark', async () => {
    /**
     * GAP-AUDIT AU-4. After a purge the oldest surviving row's prev_hash points
     * at a row that no longer exists, which is indistinguishable from tampering.
     * ExpenseOS passes the watermark per call because its chain is global; ours
     * is stored per tenant, so verification needs no special argument.
     */
    await clearChain();
    const one = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('ONE') }),
    );
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('TWO') }));

    await tamper('DELETE FROM audit_entry WHERE id = $1', [one.id]);

    // Without the watermark this reads as tampering — correctly, because from
    // the verifier's side it is exactly what tampering looks like.
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({
      ok: false,
      reason: 'prev-hash-mismatch',
    });

    await admin.query(
      `UPDATE organization
          SET audit_purged_through_sequence = $2, audit_purged_head_hash = $3
        WHERE id = $1`,
      [orgId, one.sequence, one.entryHash],
    );
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true, scanned: 1 });

    await admin.query(
      `UPDATE organization
          SET audit_purged_through_sequence = NULL, audit_purged_head_hash = NULL
        WHERE id = $1`,
      [orgId],
    );
  });

  it('proves integrity AT a window boundary, not just inside it', async () => {
    // A window starting mid-chain reads the row before it to seed the expected
    // prev_hash. Without that, a verify of rows 2..3 would happily accept a
    // forged row 2.
    await clearChain();
    await withOrg(orgId, (tx) => append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('ONE') }));
    const two = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('TWO') }),
    );
    const three = await withOrg(orgId, (tx) =>
      append(tx, { ...ADA, id: actorId }, { action: arbitraryAction('THREE') }),
    );

    expect(
      await withOrg(orgId, (tx) => verifyChain(tx, { fromSequence: two.sequence })),
    ).toMatchObject({ ok: true, scanned: 2, firstSequence: two.sequence });

    await tamper('UPDATE audit_entry SET action = $2 WHERE id = $1', [two.id, 'FORGED']);
    // The window still catches it, because the seed came from row one.
    expect(
      await withOrg(orgId, (tx) => verifyChain(tx, { fromSequence: two.sequence })),
    ).toMatchObject({ ok: false, reason: 'entry-hash-mismatch' });
    expect(three.prevHash).toBe(two.entryHash);
  });

  it('walks a chain longer than one batch', async () => {
    // The paging cursor is off-by-one bait: a batch boundary that re-reads or
    // skips a row would either double-count or break the prev_hash link.
    await clearChain();
    for (let i = 0; i < 7; i += 1) {
      await withOrg(orgId, (tx) =>
        append(tx, { ...ADA, id: actorId }, { action: arbitraryAction(`E${i}`) }),
      );
    }
    expect(await withOrg(orgId, (tx) => verifyChain(tx, { batchSize: 2 }))).toMatchObject({
      ok: true,
      scanned: 7,
    });
  });

  it('is ok on an empty chain', async () => {
    await clearChain();
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({
      ok: true,
      scanned: 0,
      firstSequence: null,
    });
  });
});
