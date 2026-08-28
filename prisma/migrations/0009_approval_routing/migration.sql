-- VeloExpense 0009 — routing prerequisites (VX2-2, ExpenseOS Module 8).
--
-- NO new tables, so no new RLS surface: every column here hangs off a table that
-- 0008 or 0001 already put under ENABLE/FORCE ROW LEVEL SECURITY, and
-- test/rls-isolation.test.ts already covers both. CI's RLS-coverage guard has
-- nothing new to find.
--
-- ── Where this shape comes from ──────────────────────────────────────────────
--
-- Both changes are decisions recorded in docs/porting/GAP-AUDIT.md, taken after
-- reading ExpenseOS source rather than designing from the module docs. Read
-- AP-5, AP-7, AP-13 and AP-14 there before changing anything in this file; each
-- constraint below is load-bearing for a defect ExpenseOS actually shipped.

-- ── 1. The sole-approver break-glass (GAP-AUDIT AP-14) ──────────────────────
--
-- ExpenseOS's self-approval guard (their F15/F20, blocker B3) refuses a
-- requester their own subject ahead of EVERY other grant, including the admin
-- override. They accepted the consequence: a subject whose only possible
-- approver is also its requester "can no longer be decided by that person at
-- all. It parks until somebody else decides it." For one large enterprise that
-- is fine — somebody else always exists.
--
-- VeloExpense sells to SMBs, where it is not fine. In a tenant whose sole ADMIN
-- is also the submitter, that guard plus the ADMIN_FALLBACK resolution of AP-5
-- compose into a report that is structurally undecidable by anyone, forever.
-- Two individually correct rules producing a dead end, visible only in tenants
-- small enough that nobody else can approve.
--
-- So VeloExpense takes the break-glass ExpenseOS declined, narrowly:
--   * OFF by default, so no existing tenant's controls are relaxed by upgrading;
--   * the resolver may only honour it after proving no OTHER eligible approver
--     exists — it is not a general "admins may self-approve" switch;
--   * every use is written to the VX2-6 audit chain under its own action, so
--     "who approved their own expenses" is one query, not a forensic exercise.
--
-- A real column, NOT a key in organization.settings jsonb (which exists and
-- would have needed no migration). A setting that turns a control off must be
-- constrainable, greppable, and findable by somebody auditing exactly that —
-- the same argument GAP-AUDIT AP-11 makes for VeloExpense's column model over
-- ExpenseOS's JSON graph.
ALTER TABLE organization
    ADD COLUMN allow_sole_approver_self_approval boolean NOT NULL DEFAULT false;

-- ── 2. Role-claimable tasks (GAP-AUDIT AP-7, reopened) ──────────────────────
--
-- 0008 asserted "every task has an owner, internal or external" via
-- approval_task_assignee_present. That invariant is why routing is
-- all-or-nothing and fails closed, and it was worth keeping — until it turned
-- out to forbid the shape the STARTER LADDER needs. DEFAULT_LADDER's third rung
-- ("Finance sign-off", every report >= $5,000) is approverKind 'ROLE' /
-- approverRole 'ADMIN', so a ROLE approver is not an optional feature a tenant
-- might configure: it is what every tenant gets out of the box.
--
-- Under the old CHECK the router would have had to name ONE person for that
-- rung, and ExpenseOS documents precisely why that is wrong: "resolving a role
-- to a person here would mean picking one, and there is no non-arbitrary pick;
-- assigning 'the only holder' would make the same authored workflow behave
-- differently the day somebody else is given the role, a flip that is invisible
-- in the editor and that nobody would predict." The author wrote a ROLE so that
-- routing would NOT name a person.
--
-- Hence a third ownership shape: unassigned, claimable by active holders of one
-- named role. Deliberately NOT resolved to a person at routing time.
ALTER TABLE approval_task
    ADD COLUMN claim_role text;

-- No CHECK on the value, for the same reason approval_policy_approver
-- .approver_role has none (0008): per-tenant custom roles are coming and the
-- vocabulary stops being the fixed EMPLOYEE|MANAGER|ADMIN triple. Validated in
-- code against the role registry.
COMMENT ON COLUMN approval_task.claim_role IS
    'Unassigned-but-claimable: active holders of this role may decide. Set only when resolved_via = ''ROLE''.';

-- NOTE for anyone reading 0008: its comment on approval_task.assignee_id says
-- "Exactly one of assignee_id / assignee_email is always present — see the
-- CHECK — so there is still never a task nobody owns." That is superseded here.
-- 0008 is not edited, because an applied migration is a historical record; the
-- current invariant is approval_task_owner_exclusive below, and "never a task
-- nobody owns" still holds — there is simply a third way to own one.
ALTER TABLE approval_task
    DROP CONSTRAINT approval_task_assignee_present;

-- Exactly ONE ownership shape per task, never two and never none:
--   assignee_id    — an internal named approver;
--   assignee_email — an external approver (VX2-8 makes these actionable);
--   claim_role     — a role pool.
-- num_nonnulls = 1 subsumes the old "at least one" check, so there is one
-- constraint here rather than two. A claimed task is NOT rewritten to
-- assignee_id: the claim pool stays the owner and the decision is recorded in
-- decided_by_id, which keeps this invariant true for a task's whole life and
-- keeps "who could have decided this" answerable after the fact.
ALTER TABLE approval_task
    ADD CONSTRAINT approval_task_owner_exclusive
        CHECK (num_nonnulls(assignee_id, assignee_email, claim_role) = 1);

-- resolved_via already admits 'ROLE' (0008 pre-admitted the whole set). Tie the
-- two together so a ROLE resolution cannot silently produce a named assignee,
-- which is the exact drift this column exists to prevent.
ALTER TABLE approval_task
    ADD CONSTRAINT approval_task_role_claim_consistent
        CHECK ((resolved_via = 'ROLE') = (claim_role IS NOT NULL));

-- The approver inbox for a role pool. Partial on PENDING because a decided task
-- never appears in a queue, and org-scoped first because RLS has already
-- narrowed to one tenant by the time this index is consulted.
CREATE INDEX approval_task_claim_role_pending_idx
    ON approval_task (organization_id, claim_role)
    WHERE status = 'PENDING' AND claim_role IS NOT NULL;
