/**
 * VX3-10 — the TENANT FOREIGN KEY gate. Closes GAP-AUDIT TN-1.
 *
 * Postgres runs referential-integrity checks as the constraint's owner WITH
 * ROW-LEVEL SECURITY BYPASSED. So `REFERENCES app_user(id)` scopes nothing to a
 * tenant: before migration `0019`, org A could set `expense_report.submitter_id`
 * to a user id belonging to org B and Postgres accepted the row.
 *
 * There is no disclosure in that — a read back through the reference returns
 * nothing, because RLS still filters the target. What it leaves is an integrity
 * hole and a row that looks mapped and joins to nothing:
 *
 *     gl_account_id set: true, resolvable: false
 *
 * which is worse than it sounds, because AC-14's mapping-gap control counts
 * categories where the account is NULL — and a cross-tenant reference is NOT
 * null, so it reads as CORRECTLY MAPPED to the very check meant to find the
 * unmapped ones.
 *
 * TWO KINDS OF TEST LIVE HERE, and the split is the point:
 *
 *   1. A GENERATED assertion that walks `pg_constraint` and requires EVERY
 *      tenant-to-tenant foreign key to be composite through `organization_id`.
 *      Forty-two hand-written assertions would have covered the same ground on
 *      the day they were written and rotted the moment somebody added the
 *      forty-third FK. This one cannot rot: a new weakly-declared FK fails it
 *      without anybody remembering this file exists. (CI carries the same query
 *      as a build step, so it also fails before the suite even runs.)
 *
 *   2. BEHAVIOURAL cases on representative constraints, driven straight through
 *      SQL with no action layer, no trigger and — in one case — no RLS at all.
 *      The generated assertion proves the constraints are SHAPED right; these
 *      prove they BEHAVE right, including that `0019` preserved every ON DELETE
 *      action rather than quietly flattening them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let reportA: string;
let reportB: string;
let expenseA: string;
let receiptA: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const orgs = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('fk-a','FK A'), ('fk-b','FK B')
     RETURNING id, slug`,
  );
  orgA = orgs.rows.find((r) => r.slug === 'fk-a').id;
  orgB = orgs.rows.find((r) => r.slug === 'fk-b').id;

  for (const [org, label] of [
    [orgA, 'A'],
    [orgB, 'B'],
  ] as const) {
    await withOrg(org, async (tx) => {
      const u = await tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role)
         VALUES ($1, $2, $3, 'ADMIN') RETURNING id`,
        [org, `fk-${label.toLowerCase()}@x.com`, `User ${label}`],
      );
      const r = await tx.query(
        `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
         VALUES ($1, $2, 'CAD', $3) RETURNING id`,
        [org, `Report ${label}`, u.rows[0].id],
      );
      const e = await tx.query(
        `INSERT INTO expense (organization_id, report_id, merchant, currency_code)
         VALUES ($1, $2, $3, 'CAD') RETURNING id`,
        [org, r.rows[0].id, `Merchant ${label}`],
      );
      const rec = await tx.query(
        `INSERT INTO receipt
             (organization_id, expense_id, s3_key, filename, content_type, size_bytes,
              status, uploaded_by_id)
         VALUES ($1, $2, $3, $4, 'application/pdf', 10, 'STORED', $5)
         RETURNING id`,
        [
          org,
          e.rows[0].id,
          `org/${org}/receipts/x/${label}.pdf`,
          `receipt-${label}.pdf`,
          u.rows[0].id,
        ],
      );
      if (label === 'A') {
        userA = u.rows[0].id;
        reportA = r.rows[0].id;
        expenseA = e.rows[0].id;
        receiptA = rec.rows[0].id;
      } else {
        userB = u.rows[0].id;
        reportB = r.rows[0].id;
      }
    });
  }
});

afterAll(async () => {
  await admin.end();
});

/**
 * Every foreign key whose source AND target are both tenant tables, with a
 * verdict on whether it is composite THROUGH `organization_id`.
 *
 * The verdict is deliberately not `cardinality(conkey) > 1`. A two-column FK
 * that happens to include some other column would pass that and guard nothing;
 * what makes a cross-tenant reference impossible is specifically that
 * `organization_id` is one of the referencing columns AND that the column it
 * lines up with on the target side is the target's own `organization_id`. So the
 * query finds the ORDINAL POSITION of organization_id in `conkey` and checks
 * that `confkey` carries the target's organization_id at the SAME position.
 */
const TENANT_FK_QUERY = `
WITH tenant AS (
  SELECT c.oid, c.relname,
         (SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
             AND NOT a.attisdropped) AS org_attnum
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
                  AND NOT a.attisdropped)
)
SELECT k.conname                                    AS name,
       src.relname                                  AS source_table,
       tgt.relname                                  AS target_table,
       cardinality(k.conkey)                        AS columns,
       array_position(k.conkey, src.org_attnum)     AS org_position,
       (
         array_position(k.conkey, src.org_attnum) IS NOT NULL
         AND k.confkey[array_position(k.conkey, src.org_attnum)] = tgt.org_attnum
       )                                            AS composite
FROM pg_constraint k
JOIN tenant src ON src.oid = k.conrelid
JOIN tenant tgt ON tgt.oid = k.confrelid
WHERE k.contype = 'f'
ORDER BY src.relname, k.conname`;

describe('tenant foreign keys are composite (TN-1)', () => {
  it('every tenant-to-tenant foreign key is composite through organization_id', async () => {
    const { rows } = await admin.query(TENANT_FK_QUERY);

    // Guard the guard. If the enumeration ever returns nothing — a renamed
    // catalogue column, a schema moved out of `public`, a typo in the CTE — the
    // offender list below would be empty and this test would pass while
    // asserting nothing at all. The schema has 49 of these today; the floor is
    // set low enough not to need editing every phase, and high enough that a
    // broken query cannot slip past it.
    expect(rows.length).toBeGreaterThan(40);

    const weak = rows
      .filter((r) => !r.composite)
      .map((r) => `${r.source_table}.${r.name} -> ${r.target_table} (${r.columns} column(s))`);

    // The message matters here: whoever breaks this will be somebody who added a
    // table, and the fix is a one-line change they need to be TOLD, not sent to
    // read a migration comment for.
    expect(
      weak,
      weak.length === 0
        ? ''
        : `These foreign keys accept another tenant's row, because Postgres checks ` +
            `referential integrity with RLS bypassed. Declare each one as\n` +
            `  FOREIGN KEY (organization_id, <col>) REFERENCES <target> (organization_id, id)\n` +
            `which needs UNIQUE (organization_id, id) on the target. See migration 0019.\n` +
            `Weak:\n  ${weak.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the composite keys the FKs depend on are real unique constraints', async () => {
    // A composite FK cannot be declared without `UNIQUE (organization_id, id)` on
    // its target, so this is guaranteed today — but it is the thing a future
    // migration is most likely to try to DROP as redundant (the primary key on
    // `id` looks like it already covers it). Naming it makes that attempt fail
    // here rather than in a migration that half-applies.
    const { rows } = await admin.query(`
      SELECT DISTINCT tgt.relname AS target
      FROM pg_constraint k
      JOIN pg_class src ON src.oid = k.conrelid
      JOIN pg_class tgt ON tgt.oid = k.confrelid
      WHERE k.contype = 'f' AND cardinality(k.conkey) > 1
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = tgt.oid AND a.attname = 'organization_id'
                      AND NOT a.attisdropped)`);
    expect(rows.length).toBeGreaterThan(10);

    for (const { target } of rows) {
      const uniq = await admin.query(
        `SELECT 1
           FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid
          WHERE c.relname = $1 AND k.contype IN ('u','p')
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                   FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum = ANY (k.conkey))
                = ARRAY['id','organization_id']`,
        [target],
      );
      expect(uniq.rows, `${target} is missing UNIQUE (organization_id, id)`).toHaveLength(1);
    }
  });
});

describe('a tenant cannot reference another tenant (behavioural)', () => {
  it('refuses another tenant\'s submitter on a report', async () => {
    // Straight SQL inside the tenant's own context. No action layer, no
    // `assertDraft`, no trigger — so what refuses this is the constraint and
    // nothing else. Before `0019` this INSERT was ACCEPTED.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
           VALUES ($1, 'Smuggled', 'CAD', $2)`,
          [orgA, userB],
        ),
      ),
    ).rejects.toThrow(/expense_report_submitter_id_fkey|violates foreign key/i);
  });

  it('refuses it on the ADMIN connection too, where RLS does not apply at all', async () => {
    // The strongest form of the claim, and the reason a composite key was chosen
    // over a trigger or a policy. This connection is the superuser: RLS is not
    // merely satisfied here, it is BYPASSED. A guard built on policies would let
    // this through; a constraint does not care who is asking.
    await expect(
      admin.query(
        `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
         VALUES ($1, 'Smuggled by admin', 'CAD', $2)`,
        [orgA, userB],
      ),
    ).rejects.toThrow(/violates foreign key/i);
  });

  it('refuses another tenant\'s report on an expense, and its own is fine', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.query(
          `INSERT INTO expense (organization_id, report_id, merchant, currency_code)
           VALUES ($1, $2, 'Smuggled', 'CAD')`,
          [orgA, reportB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key/i);

    // The other half, and not a formality: a constraint that refused everything
    // would pass every test above. Org A's own report must still work.
    const ok = await withOrg(orgA, (tx) =>
      tx.query(
        `INSERT INTO expense (organization_id, report_id, merchant, currency_code)
         VALUES ($1, $2, 'Legitimate', 'CAD') RETURNING id`,
        [orgA, reportA],
      ),
    );
    expect(ok.rows).toHaveLength(1);
  });

  it('refuses another tenant\'s manager, on a self-referencing FK', async () => {
    // `app_user.manager_id` points at `app_user`. A self-reference is the shape
    // where the composite rewrite is easiest to get wrong, because source and
    // target share a table and the org column looks like it must already match.
    await expect(
      withOrg(orgA, (tx) =>
        tx.query('UPDATE app_user SET manager_id = $1 WHERE id = $2', [userB, userA]),
      ),
    ).rejects.toThrow(/violates foreign key/i);
  });

  it('leaves nullable references nullable (MATCH SIMPLE)', async () => {
    // Every one of these FKs is MATCH SIMPLE, which is the default and what we
    // want: with a NULL in any referencing column the constraint is SKIPPED. If
    // the migration had said MATCH FULL, an optional reference would have become
    // mandatory the moment `organization_id` was added to it — which on a table
    // like `app_user` would mean nobody could exist without a manager.
    const ok = await withOrg(orgA, (tx) =>
      tx.query(
        'UPDATE app_user SET manager_id = NULL, department_id = NULL WHERE id = $1',
        [userA],
      ),
    );
    expect(ok.rowCount).toBe(1);
  });
});

describe('0019 preserved every ON DELETE action', () => {
  it('CASCADE still cascades (expense_report -> expense)', async () => {
    const before = await admin.query('SELECT count(*)::int AS n FROM expense WHERE report_id = $1', [
      reportA,
    ]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    await admin.query('DELETE FROM expense_report WHERE id = $1', [reportA]);
    const after = await admin.query('SELECT count(*)::int AS n FROM expense WHERE report_id = $1', [
      reportA,
    ]);
    expect(after.rows[0].n).toBe(0);
  });

  it('SET NULL clears the reference and NOT organization_id', async () => {
    // THE trap in this migration, and the reason it names its column. The
    // unqualified `ON DELETE SET NULL` on a composite key nulls EVERY referencing
    // column — `organization_id` included, which is NOT NULL — so the delete
    // fails with a not-null violation instead of clearing the reference. `0019`
    // writes `SET NULL (expense_id)`, Postgres 15+ syntax.
    //
    // The cascade above already deleted A's expense, and `receipt.expense_id` is
    // the SET NULL side of it, so the row this asserts on is the one that just
    // survived that delete.
    const row = await admin.query(
      'SELECT expense_id, organization_id FROM receipt WHERE id = $1',
      [receiptA],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].expense_id).toBeNull();
    expect(row.rows[0].organization_id).toBe(orgA);
    // And it is still ITS tenant's row, visible to that tenant and no other.
    const seen = await withOrg(orgA, (tx) => tx.query('SELECT id FROM receipt'));
    expect(seen.rows.map((r) => r.id)).toEqual([receiptA]);
    const other = await withOrg(orgB, (tx) =>
      tx.query('SELECT id FROM receipt WHERE id = $1', [receiptA]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it('RESTRICT still restricts (audit_entry -> app_user)', async () => {
    // `0013` chose RESTRICT for the actor on an audit row on purpose: an audit
    // trail whose actor could be deleted out from under it is not an audit trail.
    // Worth pinning here because a mechanical rewrite of 42 constraints is
    // exactly where a RESTRICT could have become a NO ACTION without anybody
    // noticing — they behave identically until somebody wraps a delete in a
    // transaction with a deferred check.
    await withOrg(orgB, (tx) =>
      tx.query(
        `INSERT INTO audit_entry
           (organization_id, actor_id, actor_name, actor_role, action,
            entity_type, entity_id, details, prev_hash, entry_hash)
         VALUES ($1, $2, 'User B', 'ADMIN', 'REPORT_SUBMITTED', 'expense_report', $3,
                 '{}'::jsonb, NULL, $4)`,
        [orgB, userB, reportB, 'b'.repeat(64)],
      ),
    );
    await expect(admin.query('DELETE FROM app_user WHERE id = $1', [userB])).rejects.toThrow(
      /violates foreign key/i,
    );
  });
});
