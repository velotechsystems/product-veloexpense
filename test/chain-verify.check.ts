/**
 * VX2-10 — verify every tenant's audit chain, over the database as it stands.
 *
 * NOT part of `npm test`, and the filename says so: `.check.ts`, excluded by
 * `vitest.config.ts`, run by `vitest.chain.config.ts` and by
 * `npm run verify:chain`. Two reasons it cannot be an ordinary suite:
 *
 *   · `test/rls-isolation.test.ts` inserts audit rows with DELIBERATELY fake
 *     hashes — `'a'.repeat(64)`, with a comment saying it tests RLS and not the
 *     chain — so a real verification running after it would fail on correct code.
 *   · it is only worth anything AFTER the seed and the e2e, because the point is
 *     to check rows the APPLICATION wrote through its real paths. `npm test` runs
 *     before both.
 *
 * ── What this catches that the other suites cannot ──────────────────────────
 *
 * `test/audit.db.test.ts` proves the verifier works. It writes rows, walks them,
 * tampers with one, and sees the tamper. All true, and all within one file's own
 * data.
 *
 * This proves something different and weaker-sounding but more useful: that the
 * chain the PRODUCT writes, through submit and decide and delegate and reimburse
 * and an emailed approval, is a chain that verifies. The failure it exists to
 * catch is a caller handing `append()` a payload the canonicalizer treats
 * differently from what the hash covered — a BigInt, a key order, a Date rendered
 * two ways — which no unit test written alongside that caller would notice,
 * because it would hash and verify consistently within itself.
 *
 * The board asked for "chain verification runs on every build". Before this it
 * did not; what ran was verification of test fixtures.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { verifyChain } from '@/lib/audit/verify';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('chain-verify.check.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
}
const admin = new Pool({ connectionString: ADMIN_URL });

afterAll(async () => {
  await admin.end();
});

describe('every tenant chain verifies', () => {
  it('walks each organization separately and finds no break', async () => {
    // PER TENANT, and that is not a detail: the chain is per-tenant (GAP-AUDIT
    // AU-1 — one advisory lock per tenant, a tenant predicate on the head read,
    // `organization_id` inside the hash). A single global walk would interleave
    // two tenants' chains and fail on a perfectly correct database, which is
    // exactly the mistake AU-1 says a verbatim port makes.
    const orgs = await admin.query(
      `SELECT o.id, o.slug, count(a.id)::int AS entries
         FROM organization o
         LEFT JOIN audit_entry a ON a.organization_id = o.id
        GROUP BY o.id, o.slug
        ORDER BY o.slug`,
    );
    expect(orgs.rows.length, 'the seed should have created at least one tenant').toBeGreaterThan(0);

    // A run where nothing wrote an audit row would pass this file vacuously, so
    // say out loud that at least one tenant has a chain to check. If the e2e ever
    // stops producing audit rows, this is the assertion that notices.
    const withEntries = orgs.rows.filter((o) => o.entries > 0);
    expect(
      withEntries.length,
      'no tenant has any audit entries — the seed and e2e should have written some, ' +
        'so either they did not run or nothing is being audited',
    ).toBeGreaterThan(0);

    for (const org of orgs.rows) {
      const result = await withOrg(org.id as string, (tx) => verifyChain(tx));
      expect(
        result,
        `tenant '${org.slug}' (${org.entries} entries) failed chain verification`,
      ).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.scanned, `tenant '${org.slug}' scanned count`).toBe(org.entries);
      }
      console.info(`[chain] ${org.slug}: ${org.entries} entries verified`);
    }
  });

  it('the chain covers the transitions the e2e walked', async () => {
    // A verifier that scanned zero rows would pass the test above. This asserts
    // the chain actually contains the product's most consequential actions — so a
    // regression that stopped auditing a decision would fail here rather than
    // producing a smaller, still-valid chain.
    const actions = await admin.query(
      `SELECT DISTINCT action FROM audit_entry ORDER BY action`,
    );
    const present = new Set(actions.rows.map((r) => r.action as string));
    // Not the full taxonomy: only what a seeded database plus the e2e must have
    // produced. Adding to this list is a decision, not housekeeping.
    for (const expected of ['APPROVAL_RUN_OPENED', 'REPORT_APPROVED', 'REPORT_REIMBURSED']) {
      expect(present.has(expected), `${expected} should be in the audit chain`).toBe(true);
    }
  });

  it('no tenant has two genesis rows, and no chain forks', async () => {
    // `0010` makes both structural with unique indexes, so this is belt and
    // braces — and it is cheap belt and braces, because a fork is the one failure
    // that would make `verifyChain` unable to give a useful answer at all rather
    // than reporting a mismatch.
    const genesis = await admin.query(
      `SELECT organization_id, count(*)::int AS n
         FROM audit_entry WHERE prev_hash IS NULL
        GROUP BY organization_id HAVING count(*) > 1`,
    );
    expect(genesis.rows, 'a tenant with more than one genesis row').toEqual([]);

    const forks = await admin.query(
      `SELECT organization_id, prev_hash, count(*)::int AS n
         FROM audit_entry WHERE prev_hash IS NOT NULL
        GROUP BY organization_id, prev_hash HAVING count(*) > 1`,
    );
    expect(forks.rows, 'two rows claiming the same predecessor').toEqual([]);
  });
});
