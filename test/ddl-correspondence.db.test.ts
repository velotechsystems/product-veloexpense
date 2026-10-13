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
 *  · `lib/policy/rules.ts:findingIdentity` said it "must match migration 0006's
 *    unique index exactly". It was real and was guarded here until both went at the
 *    policy cutover (w4-02d): ExpenseOS's engine keys a finding on (rule, line) and
 *    serializes per report rather than relying on a unique index (0066).
 *  · **The one nobody listed:** `LOGO_MIME_TYPES` in `lib/branding/service.ts`
 *    says it "mirrors `organization_logo_mime_raster`" — a code-to-DDL copy —
 *    AND `app/admin/branding/page.tsx` had the same three strings typed out again
 *    in a `accept="..."` attribute. Three copies of one list. The page now
 *    derives its list; the DDL correspondence is guarded below.
 *
 * ── WHY A CORRESPONDENCE IS TESTED BY BEHAVIOUR, NOT BY READING THE DDL ─────
 *
 * A test that reads `pg_get_constraintdef` and compares it to a list written in
 * the test is a fourth copy — it restates the thing it polices, which is IL-7's
 * shape and the exact failure mode `check:i18n` was built to avoid. So the database
 * is asked what it accepts and refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { LOGO_MIME_TYPES } from '@/lib/branding/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('ddl-co','DDL Co') RETURNING id",
  );
  orgId = o.rows[0].id;
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
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
