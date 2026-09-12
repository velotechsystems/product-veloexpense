-- VX5-21 — the plan's entitlement projection reaches the mirror.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- Since VX5-19 the platform has returned `features` and `limits` on every
-- entitlement call and `mirrorEntitlement` has thrown both away. Nothing in this
-- product has ever read either — a grep across lib/ and app/ returns zero
-- consumers — so the only gate that fires is `read_only`, which is binary. Three
-- priced tiers, one product from the inside.
--
-- These two columns are what a tier is allowed to mean.
--
-- ── WHY jsonb AND NOT COLUMNS, WHEN 0021 ARGUED THE OPPOSITE ───────────────
--
-- Migration 0021 put module entitlements in a TABLE rather than in
-- `organization.settings`, and AC-21 is quoted there: *"a value inside a jsonb
-- column is out of reach of every constraint, index, foreign key and RLS
-- predicate that would otherwise protect it."* That argument is correct and it
-- does not apply here, for one reason: **these columns are a MIRROR of somebody
-- else's data, not a decision this database makes.**
--
-- `module_entitlement.enabled` is a fact this product owns — an admin toggles it,
-- an audit row records who, and a constraint should protect it. `subscription.
-- features` is a copy of a blob the platform sent, and the platform's schema is
-- the one that gets to constrain its shape. A CHECK here enumerating the valid
-- keys would be the same duplication that 0039's own header refuses for
-- `plan_code`: *"a CHECK listing the platform's plans would be the same
-- duplication one layer down."* When the platform adds a key, this column should
-- store it, not reject it.
--
-- The safety that jsonb gives up is bought back in `lib/billing/plan-entitlement.
-- ts`, which parses rather than trusts: an unknown key is ignored, and a
-- malformed value is treated as ABSENT rather than coerced.
--
-- ── NULLABLE, AND THE THREE STATES THAT DEPENDS ON ─────────────────────────
--
-- Both columns are nullable, and NULL is load-bearing. It means "the platform did
-- not send one", which is different from `'{}'::jsonb` meaning "the platform sent
-- an empty object". The reader turns the first into UNGATED and the second into a
-- plan that grants no modules — opposite outcomes from what a lazy default would
-- have collapsed into one.
--
-- This is the same reasoning 0039 gives for `read_only` being nullable: *"a row
-- mirrored before this column existed has no answer, and guessing one is exactly
-- what this ticket is about not doing."* Every row that exists on the day this
-- migration runs is such a row.
--
-- ── AND WHY NO BACKFILL ────────────────────────────────────────────────────
--
-- There is deliberately no UPDATE here. A backfill would have to invent a
-- features blob for every existing subscription, and the only honest value is the
-- one the platform has not yet been asked for. The next entitlement refresh
-- writes the real thing; until then NULL is true.

ALTER TABLE subscription ADD COLUMN features jsonb;
ALTER TABLE subscription ADD COLUMN limits   jsonb;

COMMENT ON COLUMN subscription.features IS
    'The platform plan''s `features` blob, verbatim. NULL = never sent (ungated); '
    '''{}'' = sent and empty. Read through lib/billing/plan-entitlement.ts, which '
    'ignores unknown keys and treats malformed values as absent. Holds booleans '
    'plus `modules`, the array of module codes this tier includes.';

COMMENT ON COLUMN subscription.limits IS
    'The platform plan''s `limits` blob, verbatim. NULL = never sent. Holds NUMBERS '
    'only — maxUsers, minUsers, expensesPerYear, receiptAiPerSeat, aiCreditsPerSeat. '
    'A key present with value null means unlimited; a key absent means the platform '
    'did not state one. See lib/billing/plan-entitlement.ts for the full contract.';
