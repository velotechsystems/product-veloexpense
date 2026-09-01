-- ════════════════════════════════════════════════════════════════════════════
-- 0023 — PER-TENANT BRANDING (VX4-3, GAP-AUDIT BR-2/BR-3/BR-4)
--
-- ExpenseOS has the storage and the admin form for exactly this and NOTHING
-- reads them (BR-2): `PlatformConfig.organization` is a Json column, the admin
-- UI writes `logoUrl` / `primaryColor` / `loginTagline` into it, the router
-- validates all three, and all 47 occurrences of those names in the repo are in
-- those two files and their tests. So the *form* is the port and the *rendering*
-- is net-new — the opposite of how it looks from their admin screen.
--
-- ── WHY THESE ARE COLUMNS ON `organization` ─────────────────────────────────
--
-- Three homes were possible and two are wrong.
--
--   `organization.settings jsonb` has said "branding, enabled modules,
--   locale/currency" in its comment since 0001, so the blob LOOKS like the
--   intended home. VX4-1 already refused it for modules (MT-8 / AC-21) and the
--   reasoning is unchanged: a value inside jsonb is out of reach of every
--   constraint, index and RLS predicate that would otherwise protect it. Every
--   guarantee below — the hex shape, raster-only, the size cap, bytes-and-mime
--   together — would become an `if` in one code path instead.
--
--   A new `organization_branding` table with RLS is the shape VX4-1 used for
--   entitlements, and here it is actively wrong: branding has to be readable
--   with NO tenant context (see below), and under FORCE RLS an unset context
--   sees zero rows on a tenant table. It would work only for the reader that
--   already knows the tenant, which is the reader that needs it least.
--
--   `organization` itself carries no `organization_id` and so is not RLS-scoped
--   — it is the one table already read by slug before anybody is signed in.
--   That is exactly the property branding needs, so branding lives here.
--
-- ── AND WHY NOT `logo_url`, WHICH IS WHAT EXPENSEOS TOOK ────────────────────
--
-- Their form validates `logoUrl: z.string().url()` — an arbitrary external URL
-- typed by an admin and rendered as `<img src>`. That hands every viewer's IP
-- and Referer to a third party on every page load, can be swapped for different
-- bytes after anybody approved it, breaks under a strict CSP, and serves SVG if
-- the far end feels like it.
--
-- THEIR OWN CODEBASE HAS THE RIGHT ANSWER NEXT DOOR. `api/public-icons/[code]`
-- streams admin-uploaded image BYTES out of Postgres — chosen because the login
-- screen is pre-auth and "serving from Postgres avoids needing a public S3
-- bucket" — with `nosniff`, `Content-Disposition: attachment` and a sandbox CSP.
-- Its own comment records the scar: "uploads are now raster-only, but rows may
-- predate that". We start clean, so raster-only is a CHECK rather than a note,
-- and the URL column is a deliberate NON-port.
--
-- Bytes over S3 for this one asset: it is ≤512 KiB, it is read on every page
-- render, and it must be servable without a presign. Receipts stay on S3 where
-- they belong.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE organization
    -- Normalised to `#rrggbb`, lowercase, by lib/branding/color.ts before it
    -- ever reaches this column. The CHECK is deliberately strict rather than
    -- forgiving: a permissive column plus a normalising writer means the SECOND
    -- writer decides the format, and there is always a second writer.
    --
    -- NULL means "the VeloTech default palette" — an absent brand colour and a
    -- brand colour that happens to equal our sky are not the same fact, and
    -- only one of them should change when the product's default does. This is
    -- 0021's absence-means-off reasoning applied to a value instead of a gate.
    ADD COLUMN brand_color text,

    -- The tenant's wordmark. `logo_bytes` and `logo_mime` are ONE fact in two
    -- columns and the constraint below says so — the audit contract taught this
    -- the expensive way ("entityType and entityId are both required, or
    -- neither"), and a row with bytes and no mime is a route that has to guess
    -- a Content-Type, which is precisely what `nosniff` exists to prevent.
    ADD COLUMN logo_bytes bytea,
    ADD COLUMN logo_mime text,
    -- Stamped by the writer, and it is not decoration: it is the cache key. The
    -- logo URL cannot carry a hash of bytes it has not fetched, so the route
    -- serves `?v=<epoch millis>` and can then cache hard instead of for the 300
    -- seconds ExpenseOS's icon route settles for ("an icon change reuses the
    -- same URL, so cap staleness").
    ADD COLUMN logo_updated_at timestamptz,

    -- Shown under the sign-in headline once there is a tenant to show it for.
    -- Stored now because it is the same admin form and the same audit row;
    -- rendered pre-auth in Phase 5, with host-based tenancy (BR-1/BR-8).
    ADD COLUMN login_tagline text;

-- ── The constraints, and why each is here rather than in the form ───────────

ALTER TABLE organization
    -- `#rrggbb`, lowercase only. Six digits, no 3-digit shorthand, no alpha:
    -- one spelling per colour means `brand_color` can be compared, grouped and
    -- diffed in an audit row without normalising at every read.
    ADD CONSTRAINT organization_brand_color_shape
        CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$'),

    -- One fact, two columns.
    ADD CONSTRAINT organization_logo_both_or_neither
        CHECK ((logo_bytes IS NULL) = (logo_mime IS NULL)),

    -- RASTER ONLY. An SVG is a document that can carry script and reference
    -- remote content, and this asset is rendered into our own origin's pages by
    -- an admin whose account is exactly the one an attacker wants. The route's
    -- sandbox CSP is defence in depth; the database refusing the row is the
    -- defence. Their route comment shows what the alternative looks like in
    -- practice: rows that predate the rule and a header apologising for them.
    ADD CONSTRAINT organization_logo_mime_raster
        CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),

    -- 512 KiB. A wordmark that needs more is a wordmark nobody optimised, and
    -- the cap belongs here because the column is reachable by a future importer,
    -- a support script and a restored backup — none of which will re-run the
    -- form's validation. Postgres bytea would otherwise take a gigabyte.
    ADD CONSTRAINT organization_logo_size
        CHECK (logo_bytes IS NULL OR octet_length(logo_bytes) <= 524288),

    -- Non-empty if present, because '' is a third state nobody wants to handle:
    -- the form submits it for a cleared field and every reader then needs
    -- `?? null` — which is how PE-8's fallback got written.
    ADD CONSTRAINT organization_login_tagline_nonempty
        CHECK (login_tagline IS NULL OR length(btrim(login_tagline)) > 0),
    ADD CONSTRAINT organization_login_tagline_length
        CHECK (login_tagline IS NULL OR length(login_tagline) <= 200),

    -- The timestamp exists if and only if there are bytes to stamp.
    ADD CONSTRAINT organization_logo_updated_with_bytes
        CHECK ((logo_bytes IS NULL) = (logo_updated_at IS NULL));

COMMENT ON COLUMN organization.brand_color IS
    'Tenant brand colour as normalised #rrggbb, or NULL for the VeloTech default. '
    'The rendered ramp and the readable foreground are DERIVED from this one value '
    '(lib/branding/color.ts) — no second column may hold a shade of it (BR-3).';
COMMENT ON COLUMN organization.logo_bytes IS
    'Raster wordmark bytes, served by /api/branding/logo. Not a URL: an admin-typed '
    'external URL leaks every viewer to a third party and can change under us (BR-4).';
COMMENT ON COLUMN organization.logo_updated_at IS
    'Cache key for the logo route — the URL carries it as ?v= so the response can be '
    'cached immutably instead of briefly.';
