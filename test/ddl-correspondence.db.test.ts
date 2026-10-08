/**
 * UD-9 — the comments that promise a correspondence, made to fail instead.
 *
 * ExpenseOS `ce8e64aa`'s cause was a list annotated *"(mirrors the router's
 * SUBJECT_TYPES)"* — *"which is what a hand-kept copy says right up until it stops
 * mirroring anything"*. Their remedy was one list plus a generated parity
 * assertion. The audit found two comments in our tree making the same promise.
 * Working through them turned up a third that neither had noticed, and closed one
 * of the two by reading the code rather than the comment:
 *
 *  · `lib/receipts/constants.ts` said its list was "kept in step with the UI's
 *    file-picker accept list". It is not a copy — `RECEIPT_ACCEPT` is derived
 *    from it and the drawer imports that. Nothing to guard; the comment was the
 *    only thing that had drifted, and it is now corrected.
 *  · `lib/policy/rules.ts:findingIdentity` says it "must match migration 0006's
 *    unique index exactly". That one is real, and is guarded below.
 *  · **The one nobody listed:** `LOGO_MIME_TYPES` in `lib/branding/service.ts`
 *    says it "mirrors `organization_logo_mime_raster`" — a code-to-DDL copy —
 *    AND `app/admin/branding/page.tsx` had the same three strings typed out again
 *    in a `accept="..."` attribute. Three copies of one list. The page now
 *    derives its list; the DDL correspondence is guarded below.
 *
 * ── WHY THE POLICY ONE IS TESTED BY BEHAVIOUR, NOT BY READING THE DDL ───────
 *
 * A test that reads `pg_get_constraintdef` and compares it to a list written in
 * the test is a fourth copy — it restates the thing it polices, which is IL-7's
 * shape and the exact failure mode `check:i18n` was built to avoid.
 *
 * So the identity is tested by what it MEANS: two findings that differ only in a
 * field OUTSIDE the identity must collide, and two that differ in any component
 * OF it must coexist. That fails if the index gains a column, loses one, or
 * changes which column it coalesces — without this file naming a single column.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { LOGO_MIME_TYPES } from '@/lib/branding/service';
import { findingIdentity } from '@/lib/policy/rules';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let reportId: string;
let lineItemId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('ddl-co','DDL Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name)
       VALUES ($1,'a@ddl.test','Ada') RETURNING id`,
      [orgId],
    );
    const rep = await tx.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, number)
       VALUES ($1,$2,'Subject','CAD','EXP-000001') RETURNING id`,
      [orgId, u.rows[0].id],
    );
    reportId = rep.rows[0].id;
    const cat = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label)
       VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    const exp = await tx.query(
      `INSERT INTO expense (organization_id, report_id, currency_code)
       VALUES ($1,$2,'CAD') RETURNING id`,
      [orgId, reportId],
    );
    const li = await tx.query(
      `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor)
       VALUES ($1,$2,$3,100) RETURNING id`,
      [orgId, exp.rows[0].id, cat.rows[0].id],
    );
    lineItemId = li.rows[0].id;
  });
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

/** One violation row, written the way the service writes them. */
async function insertViolation(over: {
  ruleCode?: string;
  lineItemId?: string | null;
  findingKey?: string;
  severity?: string;
}) {
  return withOrg(orgId, (tx) =>
    tx.query(
      // `message` is NOT NULL and predates the message_code split (0029) — it is
      // the diagnostic half, kept for the log. IL-11's shape in the schema.
      `INSERT INTO policy_violation
         (organization_id, report_id, rule_code, line_item_id, finding_key, severity,
          message, message_code)
       VALUES ($1,$2,$3,$4,$5,$6,'a receipt is required','POLICY_GENERIC')`,
      [
        orgId,
        reportId,
        over.ruleCode ?? 'RECEIPT_REQUIRED',
        over.lineItemId === undefined ? lineItemId : over.lineItemId,
        over.findingKey ?? 'k1',
        over.severity ?? 'WARNING',
      ],
    ),
  );
}

const violationCount = async () => {
  const r = await admin.query('SELECT count(*)::int AS n FROM policy_violation WHERE report_id = $1', [
    reportId,
  ]);
  return r.rows[0].n as number;
};

const clear = () => admin.query('DELETE FROM policy_violation WHERE report_id = $1', [reportId]);

describe("policy_violation's identity is the one findingIdentity() builds", () => {
  it('refuses a second row differing only OUTSIDE the identity', async () => {
    await clear();
    await insertViolation({ severity: 'WARNING' });
    // Severity is not part of the identity, so this is the same finding.
    await expect(insertViolation({ severity: 'BLOCK' })).rejects.toMatchObject({ code: '23505' });
    expect(await violationCount()).toBe(1);
  });

  it('admits rows differing in EACH component of the identity, and only those', async () => {
    await clear();
    await insertViolation({});
    // rule_code
    await insertViolation({ ruleCode: 'CATEGORY_ACTIVE' });
    // finding_key — the column that fixes ExpenseOS's "a rule that emits several
    // findings for one line silently loses all but the first" (VX1-7).
    await insertViolation({ findingKey: 'k2' });
    // line_item_id, including the NULL case the index coalesces to a zero uuid.
    await insertViolation({ lineItemId: null });
    expect(await violationCount()).toBe(4);
  });

  it('treats two report-level findings (NULL line item) as one', async () => {
    // The coalesce is the interesting half: in SQL, NULL never equals NULL, so
    // without it two report-level findings of the same rule would BOTH insert and
    // reconciliation would grow a duplicate on every save.
    await clear();
    await insertViolation({ lineItemId: null });
    await expect(insertViolation({ lineItemId: null })).rejects.toMatchObject({ code: '23505' });
    expect(await violationCount()).toBe(1);
  });

  it('builds a key from exactly the components the database keys on', () => {
    // The function's own shape, kept honest: three components, and the null line
    // item renders as the empty slot rather than the string "null".
    expect(findingIdentity('RECEIPT_REQUIRED', lineItemId, 'k1')).toBe(
      `RECEIPT_REQUIRED|${lineItemId}|k1`,
    );
    expect(findingIdentity('RECEIPT_REQUIRED', null, 'k1')).toBe('RECEIPT_REQUIRED||k1');
  });
});

describe('LOGO_MIME_TYPES mirrors the CHECK that actually refuses the row', () => {
  /**
   * The database is asked, rather than the constraint's text being restated here.
   * Every member of the code list has to be accepted and — the half that matters
   * — anything outside it has to be refused, so the guard fails whether the two
   * drift apart in either direction.
   */
  /**
   * A logo is ONE FACT IN THREE COLUMNS, and 0023 has a constraint for each
   * pairing: `organization_logo_both_or_neither` (bytes with mime) and
   * `organization_logo_updated_with_bytes` (a timestamp with the bytes). Both
   * fire before the raster check, so the first two versions of this helper failed
   * on the wrong constraint — and a refusal assertion that does not name WHICH
   * constraint refused would have passed both times while proving nothing about
   * the mime list. That is why the expectation below names it.
   */
  const setLogo = (mime: string | null) =>
    admin.query(
      `UPDATE organization
          SET logo_mime = $1,
              logo_bytes = CASE WHEN $1::text IS NULL THEN NULL ELSE '\\x00'::bytea END,
              logo_updated_at = CASE WHEN $1::text IS NULL THEN NULL ELSE clock_timestamp() END
        WHERE id = $2`,
      [mime, orgId],
    );

  it('accepts every mime the code allows', async () => {
    for (const mime of LOGO_MIME_TYPES) {
      await expect(setLogo(mime)).resolves.toBeTruthy();
    }
  });

  it('refuses a mime the code does not allow, image or not', async () => {
    for (const mime of ['image/svg+xml', 'image/gif', 'application/pdf', 'text/html']) {
      expect(LOGO_MIME_TYPES as readonly string[]).not.toContain(mime);
      // Named constraint, so a refusal from `both_or_neither` cannot be mistaken
      // for the raster rule doing its job.
      await expect(setLogo(mime)).rejects.toMatchObject({
        constraint: 'organization_logo_mime_raster',
      });
    }
  });

  it('still allows NULL — a tenant with no logo', async () => {
    await expect(setLogo(null)).resolves.toBeTruthy();
  });
});
