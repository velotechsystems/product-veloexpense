/**
 * VX4-3 — per-tenant branding against a real Postgres. Own org slugs
 * ('brand-co', 'brand-co-2').
 *
 * TWO LAYERS ARE ASSERTED SEPARATELY, and the split is the point.
 *
 * The SERVICE refuses with a sentence an admin can act on. The COLUMN refuses
 * with a constraint, and it has to, because an importer, a support script, a seed
 * and a restored backup all reach the column without reaching the service. Both
 * halves are tested here: the service tests would all still pass if every CHECK
 * in `0023` were dropped, so the constraint tests drive raw SQL through the admin
 * pool and assert on constraint NAMES.
 *
 * The colour arithmetic itself lives in `branding-color.test.ts` with no database
 * anywhere near it.
 */
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg, withoutOrg } from '@/lib/tenant/context';
import {
  clearLogo,
  getBranding,
  LOGO_MAX_BYTES,
  setBrandColor,
  setLoginTagline,
  setLogo,
} from '@/lib/branding/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
let actorId: string;

const ACTOR = () => ({ id: actorId, name: 'Brand Admin', role: 'ADMIN' });
/** A four-byte PNG signature. Enough to be non-empty bytes; not a real image. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('brand-co','Brand Co'), ('brand-co-2','Brand Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'brand-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'brand-co-2').id;
  const u = await withOrg(orgId, (tx) =>
    tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1, 'admin@brand.test', 'Brand Admin', 'ADMIN') RETURNING id`,
      [orgId],
    ),
  );
  actorId = u.rows[0].id;
});

beforeEach(async () => {
  await admin.query(
    `UPDATE organization
        SET brand_color = NULL, logo_bytes = NULL, logo_mime = NULL,
            logo_updated_at = NULL, login_tagline = NULL`,
  );
});

afterAll(async () => {
  await admin.end();
});

describe('branding defaults (VX4-3)', () => {
  it('a tenant that has chosen nothing reads as nothing, not as the default palette', async () => {
    // ABSENCE MEANS UNTOUCHED. If this ever returned '#0284c7' the renderer could
    // no longer tell "this tenant wants our sky" from "this tenant has not
    // chosen", and only one of those should move when the product's default does.
    const b = await withOrg(orgId, getBranding);
    expect(b.brandColor).toBeNull();
    expect(b.logo).toBeNull();
    expect(b.loginTagline).toBeNull();
    expect(b.name).toBe('Brand Co');
  });
});

describe('brand colour (VX4-3)', () => {
  it('normalises what an admin pastes, and stores one spelling', async () => {
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '  #0F766E '));
    expect((await withOrg(orgId, getBranding)).brandColor).toBe('#0f766e');
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), 'abc'));
    expect((await withOrg(orgId, getBranding)).brandColor).toBe('#aabbcc');
  });

  it('reports which foreground it chose, because the admin screen shows it', async () => {
    const dark = await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#0c2340'));
    expect(dark.foreground).toBe('#ffffff');
    const light = await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#4ade80'));
    expect(light.foreground).toBe('#0f172a');
    expect(light.ratio).toBeGreaterThan(4.5);
  });

  it('REFUSES a colour that can carry no readable label, and says both numbers', async () => {
    // Mid-luminance is the unusable band — pale colours read against ink and deep
    // ones against white. #7f7f7f is 4.00 and 4.46.
    await expect(
      withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#7f7f7f')),
    ).rejects.toMatchObject({ code: 'UNREADABLE_COLOR' });
    await expect(
      withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#7f7f7f')),
    ).rejects.toThrow(/4\.00:1 against white and 4\.46:1 against dark ink/);
    // And nothing was written.
    expect((await withOrg(orgId, getBranding)).brandColor).toBeNull();
  });

  it('refuses a value that is not a colour at all', async () => {
    for (const bad of ['teal', '#0f766eff', '#12345']) {
      await expect(
        withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), bad)),
      ).rejects.toMatchObject({ code: 'INVALID_COLOR' });
    }
  });

  it('clears back to the default palette', async () => {
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#0f766e'));
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), null));
    expect((await withOrg(orgId, getBranding)).brandColor).toBeNull();
  });

  it('audits the change with the previous value, so a rebrand is reconstructable', async () => {
    // Scoped to rows written by THIS test. `beforeEach` resets the branding
    // columns and deliberately does not touch `audit_entry` — the chain carries a
    // watermark on `organization` (`organization_audit_watermark_*`), so
    // truncating the entries without resetting the watermark leaves a state the
    // chain reader is right to reject. The first draft of this test asserted on
    // every branding row in the table and passed only while it ran first, which
    // is the same defect the approval-flow mail lookup had.
    const before = await withOrg(orgId, (tx) =>
      tx.query('SELECT coalesce(max(sequence), 0) AS hw FROM audit_entry'),
    );
    const highWater = before.rows[0].hw as string;
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#0f766e'));
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#7c3aed'));
    const rows = await withOrg(orgId, (tx) =>
      tx.query(
        `SELECT action, entity_type, entity_id, details FROM audit_entry
          WHERE sequence > $1 ORDER BY sequence`,
        [highWater],
      ),
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['branding.color.set', 'branding.color.set']);
    // entityType and entityId are both required or neither — the contract was
    // right about this once already.
    expect(rows.rows[0].entity_type).toBe('organization');
    expect(rows.rows[0].entity_id).toBe(orgId);
    expect(rows.rows[0].details.previousColor).toBeNull();
    expect(rows.rows[1].details).toMatchObject({
      previousColor: '#0f766e',
      color: '#7c3aed',
      foreground: '#ffffff',
    });
  });
});

describe('logo (VX4-3)', () => {
  it('stores bytes, mime and a cache stamp together', async () => {
    await withOrg(orgId, (tx) => setLogo(tx, ACTOR(), PNG, 'image/png'));
    const b = await withOrg(orgId, getBranding);
    expect(b.logo?.mime).toBe('image/png');
    expect(b.logo?.updatedAt).toBeInstanceOf(Date);
  });

  it('does NOT load the bytes on the every-page read', async () => {
    // A 512 KiB buffer per page render, through the pool, to be discarded is a
    // cost that never shows up in a test and never leaves. `getBranding` selects
    // metadata only; the route that serves the image reads the bytes.
    await withOrg(orgId, (tx) => setLogo(tx, ACTOR(), PNG, 'image/png'));
    const b = await withOrg(orgId, getBranding);
    expect(Object.keys(b.logo!)).toEqual(['mime', 'updatedAt']);
    expect(JSON.stringify(b)).not.toContain('logo_bytes');
  });

  it('refuses SVG with the reason, not just a format list', async () => {
    await expect(
      withOrg(orgId, (tx) => setLogo(tx, ACTOR(), Buffer.from('<svg/>'), 'image/svg+xml')),
    ).rejects.toThrow(/can carry script into our own pages/);
  });

  it('refuses empty bytes and anything over the cap', async () => {
    await expect(
      withOrg(orgId, (tx) => setLogo(tx, ACTOR(), Buffer.alloc(0), 'image/png')),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(
      withOrg(orgId, (tx) => setLogo(tx, ACTOR(), Buffer.alloc(LOGO_MAX_BYTES + 1), 'image/png')),
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    // Exactly at the cap is allowed — an off-by-one here is a support ticket
    // nobody can reproduce.
    await withOrg(orgId, (tx) => setLogo(tx, ACTOR(), Buffer.alloc(LOGO_MAX_BYTES, 1), 'image/png'));
    expect((await withOrg(orgId, getBranding)).logo?.mime).toBe('image/png');
  });

  it('clears all three columns at once', async () => {
    await withOrg(orgId, (tx) => setLogo(tx, ACTOR(), PNG, 'image/png'));
    await withOrg(orgId, (tx) => clearLogo(tx, ACTOR()));
    expect((await withOrg(orgId, getBranding)).logo).toBeNull();
    const raw = await admin.query(
      'SELECT logo_bytes, logo_mime, logo_updated_at FROM organization WHERE id = $1',
      [orgId],
    );
    expect(raw.rows[0]).toEqual({ logo_bytes: null, logo_mime: null, logo_updated_at: null });
  });
});

describe('login tagline (VX4-3)', () => {
  it('trims, and treats a cleared field as absent rather than empty', async () => {
    expect(await withOrg(orgId, (tx) => setLoginTagline(tx, ACTOR(), '  Expenses, sorted.  '))).toBe(
      'Expenses, sorted.',
    );
    // '' is a third state nobody wants to handle — every reader would then need
    // `?? null`, which is how PE-8's fallback got written.
    expect(await withOrg(orgId, (tx) => setLoginTagline(tx, ACTOR(), '   '))).toBeNull();
    expect((await withOrg(orgId, getBranding)).loginTagline).toBeNull();
  });

  it('refuses one over the limit', async () => {
    await expect(
      withOrg(orgId, (tx) => setLoginTagline(tx, ACTOR(), 'x'.repeat(201))),
    ).rejects.toMatchObject({ code: 'INVALID_TAGLINE' });
  });
});

describe('tenancy (VX4-3)', () => {
  it('one tenant\'s branding is not another\'s', async () => {
    await withOrg(orgId, (tx) => setBrandColor(tx, ACTOR(), '#0f766e'));
    expect((await withOrg(otherOrgId, getBranding)).brandColor).toBeNull();
    expect((await withOrg(otherOrgId, getBranding)).name).toBe('Brand Co 2');
  });

  it('a write with no tenant context REFUSES rather than touching every row', async () => {
    // `organization` carries no organization_id and is NOT RLS-scoped, so the
    // WHERE is the only thing standing between this and an UPDATE across every
    // tenant. PE-8's lesson, and the `NULLIF` is what makes the refusal the same
    // on a fresh connection and a recycled one.
    await expect(
      withoutOrg(async (tx) => {
        await tx.query("SELECT set_config('app.current_org', '', true)");
        return setBrandColor(tx, ACTOR(), '#0f766e');
      }),
    ).rejects.toMatchObject({ code: 'NO_TENANT' });
    await expect(withoutOrg((tx) => getBranding(tx))).rejects.toMatchObject({ code: 'NO_TENANT' });
    // Nothing was written to EITHER tenant.
    const all = await admin.query('SELECT brand_color FROM organization');
    expect(all.rows.every((r) => r.brand_color === null)).toBe(true);
  });
});

describe('the columns refuse independently of the service (0023)', () => {
  // Every case here bypasses lib/branding entirely. If the service were deleted
  // tomorrow these guarantees would still hold, which is the reason they are
  // constraints and not `if`s.
  const raw = (sql: string, params: unknown[] = []) =>
    admin.query(`UPDATE organization SET ${sql} WHERE id = $${params.length + 1}`, [
      ...params,
      orgId,
    ]);

  it('refuses a hex that is not normalised', async () => {
    await expect(raw("brand_color = '#ABCDEF'")).rejects.toThrow(/organization_brand_color_shape/);
    await expect(raw("brand_color = '#abc'")).rejects.toThrow(/organization_brand_color_shape/);
    await expect(raw("brand_color = '0284c7'")).rejects.toThrow(/organization_brand_color_shape/);
  });

  it('refuses bytes without a mime, and a mime without bytes', async () => {
    await expect(raw("logo_mime = 'image/png'")).rejects.toThrow(
      /organization_logo_both_or_neither/,
    );
    await expect(raw("logo_bytes = '\\x89504e47'::bytea")).rejects.toThrow(
      /organization_logo_both_or_neither/,
    );
  });

  it('refuses SVG at the column, not only at the service', async () => {
    await expect(
      raw("logo_bytes = '\\x3c737667'::bytea, logo_mime = 'image/svg+xml', logo_updated_at = now()"),
    ).rejects.toThrow(/organization_logo_mime_raster/);
  });

  it('refuses an oversized logo at the column', async () => {
    await expect(
      raw(
        `logo_bytes = repeat('a', ${LOGO_MAX_BYTES + 1})::bytea, logo_mime = 'image/png', logo_updated_at = now()`,
      ),
    ).rejects.toThrow(/organization_logo_size/);
  });

  it('refuses bytes with no cache stamp', async () => {
    await expect(
      raw("logo_bytes = '\\x89504e47'::bytea, logo_mime = 'image/png'"),
    ).rejects.toThrow(/organization_logo_updated_with_bytes/);
  });

  it('refuses a blank or overlong tagline', async () => {
    await expect(raw("login_tagline = '   '")).rejects.toThrow(
      /organization_login_tagline_nonempty/,
    );
    await expect(raw(`login_tagline = repeat('x', 201)`)).rejects.toThrow(
      /organization_login_tagline_length/,
    );
  });
});
