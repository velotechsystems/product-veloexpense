-- ════════════════════════════════════════════════════════════════════════════
-- VX4-8 part 4 — a platform task needs to know WHICH TENANTS have a module on.
--
-- ── WHY THIS MIGRATION EXISTS, AND WHY IT WAS NOT OBVIOUS ───────────────────
--
-- The compliance scan and the control evaluation are RETROSPECTIVE: they are
-- meant to run on a cadence, over every tenant entitled to them. Every other
-- scheduled job in this product moves WORK — `/api/internal/ledger/drain` reads
-- `integration_post`, `/api/internal/notifications/drain` reads
-- `notification_delivery` — and both find their tenants by reading the due rows
-- themselves, through a narrow `platform_read` policy on the work table.
--
-- Compliance has no work table. There is no "due scan" row: the scan IS the
-- work, and the only thing that says whether a tenant should get one is
-- `module_entitlement`. All four existing `platform_read` policies are on work
-- tables, so **there was no sanctioned way for a platform task to enumerate
-- tenants at all** — which made a scheduled compliance scan unbuildable rather
-- than merely unwritten. Worth stating plainly because the absence looked like an
-- oversight and is not: nothing before this needed it.
--
-- ── WHY NOT THE ALTERNATIVES ────────────────────────────────────────────────
--
-- A policy on `organization` would answer the question by handing a platform task
-- the tenant LIST, which is more than it needs and the wrong shape: the question
-- is "who is entitled to this", not "who exists".
--
-- Making the scan admin-only, with no schedule, was the other option and is not
-- silly — a controller runs a compliance report before a close, not hourly. It
-- was rejected because it changes what the feature IS. GAP-AUDIT MT-5's finding
-- against upstream is that their scan runs as an UNCONDITIONAL GLOBAL CRON; the
-- fix is a cron that respects entitlements, not the removal of the cron.
--
-- ── WHAT IT DISCLOSES, STATED HONESTLY ─────────────────────────────────────
--
-- To a caller that has already set `app.platform_task`: that organization X has
-- module Y enabled. `withPlatformRead` is reachable only from server code holding
-- the worker secret, which already sees every tenant's posting queue and every
-- tenant's undelivered mail. This is narrower than either.
--
-- SELECT ONLY, and `enabled = true` only. A disabled entitlement is invisible
-- here, so a platform task cannot even count the tenants who turned something
-- off, and cannot write anything at all.
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY platform_read ON module_entitlement
    FOR SELECT
    USING (
        NULLIF(current_setting('app.platform_task', true), '') = 'on'
        AND enabled = true
    );

COMMENT ON TABLE module_entitlement IS
    'Per-tenant module switches (0021). Tenant-isolated for the app; additionally '
    'readable across tenants by a platform task via the narrow platform_read '
    'policy added in 0033 — SELECT only, enabled rows only — so a scheduled job '
    'can find the tenants entitled to it. See that migration for why no policy '
    'existed here before.';
