-- VX4-1 part 2 — the module gate, in the DATABASE.
--
-- ── Why a second enforcement point ──────────────────────────────────────────
--
-- Part 1 put `requireModule()` in the service layer and a generated guard
-- (`test/module-gates.test.ts`) around it, which is sound and is still the layer
-- that produces the MESSAGE. What it is not is unbypassable: it holds because a
-- guard enumerates the call sites, and GAP-AUDIT MT-3 is a whole finding about
-- what happens when a gate depends on somebody remembering.
--
-- This is the other half. The predicate is supplied by the POLICY, so no query can
-- omit it — not a new service function, not a raw `tx.query` in a screen, not a
-- job written next year by somebody who has never read the registry. The same
-- relationship RLS already has with tenancy: `test/rls-isolation.test.ts` proves
-- the property, and no code path has to be trusted to add `WHERE organization_id`.
--
-- ── It is SILENT, which is why it ships with screens that explain ───────────
--
-- A policy-level refusal returns zero rows; it does not raise. On its own that
-- makes a disabled module look exactly like an empty chart of accounts — the AC-22
-- mistake. That is why this migration lands in the same PR as the Modules screen
-- and the banners: the service gate says WHY, and this makes sure the data is gone
-- even when somebody finds a path around the sentence.
--
-- ── WHICH TABLES, and one deliberate exception that matters ────────────────
--
-- Gated:
--   · gl_account              the chart of accounts
--   · integration_installation the connections
--   · integration_oauth_state  the in-flight authorisations
--
-- NOT gated, on purpose:
--
--   · integration_post — THE POSTING QUEUE. `enqueuePost()` runs UNCONDITIONALLY
--     inside the approving transaction (`lib/approvals/engine.ts`), and its own
--     comment says why: "a tenant connecting a ledger next week should still find
--     last week's approvals waiting to go". If this table's policy required an
--     entitlement, the WITH CHECK would refuse that insert and **APPROVING A
--     REPORT WOULD FAIL** for every tenant without the accounting module — a core
--     flow broken by an optional module's gate. The queue is deliberately readable
--     and writable regardless; whether anything may POST is decided by
--     `resolveCapability`, which is gated, and a disabled module already lands
--     there as SKIPPED with no attempt burnt.
--
--   · coa_template / coa_template_account — GLOBAL reference data with no
--     organization_id, so there is no tenant policy to extend.
--
-- ── Why gating `gl_account` is safe for the core expense flow ───────────────
--
-- `accountForCategory()` joins `gl_account` and is called by `addLineItem` for
-- EVERY line item filed by EVERY tenant. With the module off the join now returns
-- nothing and the snapshot is NULL — which is exactly what VX3-1 already
-- specified: "Null is fine and blocks nothing — an unmapped category is a
-- configuration gap, and the person filing the expense is not who fixes it."
-- `expense_line_item.gl_account_id` is nullable, and no policy rule reads it. A
-- tenant without accounting files expenses with no GL coding, which is the truth.
--
-- Note what does NOT break: existing `expense_line_item.gl_account_id` values
-- survive a module being switched off, because referential integrity is checked
-- with RLS BYPASSED (TN-1). The rows become invisible, not orphaned, and they
-- reappear if the module is re-enabled.
--
-- ── Performance ────────────────────────────────────────────────────────────
--
-- The EXISTS depends only on `current_setting`, not on the row being tested, so
-- the planner evaluates it once per query as an InitPlan rather than per row, and
-- `module_entitlement_lookup` (0021) makes it an index-only probe.

-- A function, so the predicate is written ONCE. Four policies sharing a copied
-- subquery is four places to get it subtly wrong.
--
-- SECURITY INVOKER (the default) deliberately: the caller's own RLS applies to
-- `module_entitlement` inside it, so this cannot become a way to read another
-- tenant's entitlements. STABLE, so it is hoisted out of the row loop.
CREATE OR REPLACE FUNCTION app_module_enabled(p_module text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM module_entitlement
         WHERE organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
           AND module_code = p_module
           AND enabled
    );
$$;

-- PUBLIC already has EXECUTE on a new function by default; said explicitly so a
-- deployment that revokes the default does not silently break every policy that
-- depends on it — a policy whose function is not executable refuses everything.
GRANT EXECUTE ON FUNCTION app_module_enabled(text) TO PUBLIC;

COMMENT ON FUNCTION app_module_enabled(text) IS
    'VX4-1 part 2: is the named module enabled for the CURRENT tenant. Used inside '
    'RLS policies so a disabled module''s rows are invisible no matter which code '
    'path asks. The service layer''s requireModule() produces the human message; '
    'this makes the data unreachable.';

-- ── gl_account ─────────────────────────────────────────────────────────────
DROP POLICY tenant_isolation ON gl_account;
CREATE POLICY tenant_isolation ON gl_account
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'));

-- ── integration_installation ───────────────────────────────────────────────
DROP POLICY tenant_isolation ON integration_installation;
CREATE POLICY tenant_isolation ON integration_installation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'));

-- ── integration_oauth_state ────────────────────────────────────────────────
--
-- The tenant policy only. `platform_read` (0020) is left exactly as it is: the
-- OAuth callback arrives with no session and finds its tenant THROUGH that hatch,
-- so making the hatch entitlement-aware would mean a callback could not even
-- discover which tenant to tell about the problem. The authorisation still cannot
-- complete — `completeAuthorisation` reads the installation with the tenant set,
-- and that read is now gated.
DROP POLICY tenant_isolation ON integration_oauth_state;
CREATE POLICY tenant_isolation ON integration_oauth_state
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'))
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND app_module_enabled('accounting'));

COMMENT ON TABLE integration_post IS
    'The ledger posting queue. DELIBERATELY NOT gated on the accounting module: '
    'enqueuePost() runs unconditionally in the approving transaction, so an '
    'entitlement in this policy would make approval itself fail for a tenant '
    'without the module. See migration 0022''s header.';
