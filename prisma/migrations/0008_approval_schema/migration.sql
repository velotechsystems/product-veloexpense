-- VeloExpense 0008 — approval schema + tiers (VX2-1, ExpenseOS Module 8).
--
-- FOUR new tenant tables — approval_policy, approval_request, approval_task,
-- delegation — so each takes the full treatment: organization_id + org-id index
-- + ENABLE/FORCE ROW LEVEL SECURITY + the tenant_isolation policy (NULLIF
-- form), and all four are added to test/rls-isolation.test.ts. CI's
-- RLS-coverage guard fails the build otherwise.
--
-- WHAT THIS DELIBERATELY IS NOT. ExpenseOS runs a versioned approval GRAPH
-- (ApprovalWorkflow -> ApprovalWorkflowVersion carrying a matchCondition JSON
-- predicate -> ApprovalInstance -> ApprovalTask), subject-agnostic across
-- expense reports, travel and virtual cards, with parallel and quorum nodes.
-- The Port & Build Plan's risk register is explicit that handing that to an SMB
-- on day one is onboarding friction, so VeloExpense's default path is
-- SIMPLIFIED TIERED approval: an ordered ladder of thresholds, each naming who
-- signs off. The graph stays out. lib/approvals/routing.ts holds the single
-- interface an advanced tier would implement, so it can slot in later without
-- reshaping these tables or the transition code.
--
-- AND WHAT IT IS NOT YET. This migration is the schema. VX2-2 resolves a rung
-- into an actual assignee, VX2-3 performs the transitions — and by then VX2-6's
-- audit log exists, so the engine writes into the trail from its first commit
-- rather than having one bolted on afterwards. `delegation` is created here,
-- with the rest of the schema, but nothing reads it until VX2-2 resolves
-- against it and VX2-5 gives it a CRUD surface.
--
-- Out of scope for the whole of Phase 2, recorded so the omissions read as
-- decisions rather than oversights: per-line-item rejection, which ExpenseOS
-- decided against and never built though its Module 8 use cases still describe
-- it; and approval subjects other than the expense report.

-- ── Approval policy (one rung of the tenant's ladder) ────────────────────────
--
-- A report needing approval collects EVERY enabled rung whose threshold it
-- meets, in `sequence` order, and each rung becomes one sequential approval
-- step. A tenant writes "always the manager; past $1,000 a second level too;
-- past $5,000 finance as well" as three rows, and a $6,000 report then needs all
-- three sign-offs while a $200 one needs the first alone.
--
-- Cumulative-by-threshold rather than a (min, max) band per rung: bands need an
-- exclusion constraint to stop two overlapping, still leave gaps a report can
-- fall through, and cannot express "and also" without repeating the lower
-- approver inside every higher band.
CREATE TABLE approval_policy (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          uuid NOT NULL REFERENCES organization(id),
    name                     text NOT NULL,
    -- Position in the ladder: the ORDER of approvals, kept separate from the
    -- threshold so an admin can insert "finance" ahead of "second-level manager"
    -- without renumbering money.
    sequence                 int NOT NULL,
    -- This rung applies when the report total is >= this. Minor units of the
    -- report's currency, same as expense_report.total_minor. 0 = always.
    threshold_minor          bigint NOT NULL DEFAULT 0,
    -- Who signs off:
    --   MANAGER — walk the submitter's manager chain to `manager_level`
    --   ROLE    — anyone holding `approver_role` (in practice ADMIN: finance)
    --   USER    — one named person, `approver_user_id`
    approver_kind            text NOT NULL DEFAULT 'MANAGER',
    -- 1 = the submitter's direct manager, 2 = their manager's manager. Only
    -- meaningful for approver_kind = 'MANAGER'.
    manager_level            int,
    approver_role            text,
    -- SET NULL, not CASCADE: deleting the named approver must not silently
    -- delete the rung and quietly shorten every future approval ladder. VX2-2
    -- treats a rung with a null approver_user_id as unresolvable and escalates,
    -- which fails closed.
    approver_user_id         uuid REFERENCES app_user(id) ON DELETE SET NULL,
    -- The approver must record that they reviewed the receipts before a decision
    -- is accepted. ExpenseOS never captured this, which forced Module 12's
    -- APPROVED_WITHOUT_RECEIPT control to approximate it as "approved with no
    -- receipt on file" — a weaker statement than the one the control wanted.
    -- Per-rung, because a $40 lunch and a $9k conference do not warrant the same
    -- ceremony, and defaulting ON because the expensive direction to be wrong in
    -- is the one where the evidence was never recorded at all.
    require_receipt_view_ack boolean NOT NULL DEFAULT true,
    enabled                  boolean NOT NULL DEFAULT true,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT approval_policy_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT approval_policy_threshold_nonneg CHECK (threshold_minor >= 0),
    -- 10 rungs may be CONFIGURED; at most 5 may APPLY to one report
    -- (approval_request.total_steps). Both are past what an SMB tolerates, and
    -- both are a different quantity from how far the resolver may walk the
    -- manager chain hunting for a present approver (MAX_CHAIN_DEPTH in
    -- lib/employees/service.ts).
    CONSTRAINT approval_policy_sequence_range CHECK (sequence BETWEEN 1 AND 10),
    CONSTRAINT approval_policy_kind_check
        CHECK (approver_kind IN ('MANAGER', 'ROLE', 'USER')),
    CONSTRAINT approval_policy_manager_level_range
        CHECK (manager_level IS NULL OR manager_level BETWEEN 1 AND 5),
    CONSTRAINT approval_policy_role_check
        CHECK (approver_role IS NULL OR approver_role IN ('EMPLOYEE', 'MANAGER', 'ADMIN')),
    -- Exactly the companion column the kind needs, and no other. A rung naming
    -- both a role and a user, or neither, is unresolvable — and an unresolvable
    -- rung is the failure the ticket says must fail closed, so it is better
    -- refused at write time than discovered at approval time.
    CONSTRAINT approval_policy_approver_complete
        CHECK (CASE approver_kind
                 WHEN 'MANAGER' THEN manager_level IS NOT NULL
                                 AND approver_role IS NULL AND approver_user_id IS NULL
                 WHEN 'ROLE'    THEN approver_role IS NOT NULL
                                 AND manager_level IS NULL AND approver_user_id IS NULL
                 WHEN 'USER'    THEN approver_user_id IS NOT NULL
                                 AND manager_level IS NULL AND approver_role IS NULL
               END)
);
CREATE INDEX approval_policy_org_id_idx ON approval_policy (organization_id);
-- One rung per position: the ladder needs a single stable order, and two rungs
-- sharing a sequence would make "the second approval" ambiguous.
CREATE UNIQUE INDEX approval_policy_sequence_idx
    ON approval_policy (organization_id, sequence);
ALTER TABLE approval_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policy FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_policy
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Approval request (one run against one report) ────────────────────────────
CREATE TYPE approval_request_status AS ENUM
  ('RUNNING', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

CREATE TABLE approval_request (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       uuid NOT NULL REFERENCES organization(id),
    report_id             uuid NOT NULL REFERENCES expense_report(id) ON DELETE CASCADE,
    -- The rungs that applied, AS THEY WERE at routing time, in order. This is
    -- the authoritative record once the run is open — the approval_policy rows
    -- are only a convenience join, and they will have moved on. Same reasoning
    -- as expense_report_event.context in 0007: an admin retuning the ladder next
    -- quarter must not be able to rewrite why THIS report needed three
    -- approvals, or whether a receipt acknowledgement was demanded of its
    -- approvers.
    policy_snapshot       jsonb NOT NULL,
    status                approval_request_status NOT NULL DEFAULT 'RUNNING',
    current_step          int NOT NULL DEFAULT 1,
    total_steps           int NOT NULL,
    -- What was routed on. A report's total can move after a RETURN, so a
    -- resubmit opens a NEW run rather than re-banding this one — otherwise an
    -- employee returned at three sign-offs could trim a line and resubmit into
    -- one.
    subject_total_minor   bigint NOT NULL,
    subject_currency_code text NOT NULL REFERENCES currency(code),
    opened_by_id          uuid NOT NULL REFERENCES app_user(id),
    -- clock_timestamp(), not now(): now() is the TRANSACTION start time, so a
    -- run opened in the same transaction as its first task would tie with it and
    -- history would come back in arbitrary order (0007's lesson, which a test
    -- caught rather than a review).
    opened_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at             timestamptz,
    CONSTRAINT approval_request_total_steps_range CHECK (total_steps BETWEEN 1 AND 5),
    CONSTRAINT approval_request_step_within_total
        CHECK (current_step BETWEEN 1 AND total_steps),
    CONSTRAINT approval_request_closed_consistent
        CHECK ((status =  'RUNNING' AND closed_at IS NULL)
            OR (status <> 'RUNNING' AND closed_at IS NOT NULL))
);
CREATE INDEX approval_request_org_id_idx ON approval_request (organization_id);
CREATE INDEX approval_request_report_idx ON approval_request (report_id, opened_at DESC);
-- At most ONE open run per report, enforced by the database rather than by the
-- engine remembering to check. This is the concurrency guard: two simultaneous
-- submits of one report cannot both open a run, so the second fails loudly
-- instead of quietly creating a second approval chain nobody is watching.
CREATE UNIQUE INDEX approval_request_one_running_idx
    ON approval_request (report_id) WHERE status = 'RUNNING';
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_request
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Approval task (one assignment, one step) ─────────────────────────────────
CREATE TYPE approval_task_status AS ENUM
  ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SKIPPED', 'CANCELLED');

CREATE TABLE approval_task (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id              uuid NOT NULL REFERENCES organization(id),
    request_id                   uuid NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
    step                         int NOT NULL,
    -- NOT NULL on purpose. ExpenseOS permits an unassigned task and escalates it
    -- from the requester's chain when it lapses; here the resolver has to land on
    -- a person at assignment time, so there is never a task nobody owns sitting
    -- in a queue nobody reads. A rung the resolver cannot fill escalates or
    -- fails the routing — it never produces an ownerless task.
    assignee_id                  uuid NOT NULL REFERENCES app_user(id),
    -- How the assignee was chosen. Text + CHECK rather than an enum so the set
    -- reads in the schema. DELEGATION (VX2-5) and REASSIGNED (VX2-4) are
    -- admitted NOW so neither ticket needs a migration — the same trick 0007
    -- played by pre-admitting the Phase-2 transition actions.
    resolved_via                 text NOT NULL DEFAULT 'MANAGER_CHAIN',
    -- Whose queue the work was taken from, when resolved_via = 'DELEGATION'.
    delegated_from_id            uuid REFERENCES app_user(id),
    -- How many extra links up the chain the resolver had to walk past absent
    -- approvers (ON_LEAVE / DEACTIVATED) to land on this person. 0 = the
    -- intended approver was available. Non-zero is the number an admin wants
    -- when a report took a strange route, and what a future TTL escalation
    -- would increment.
    escalation_level             int NOT NULL DEFAULT 0,
    status                       approval_task_status NOT NULL DEFAULT 'PENDING',
    decided_by_id                uuid REFERENCES app_user(id),
    decided_at                   timestamptz,
    note                         text,
    -- The receipt-view acknowledgement (see approval_policy.require_receipt_view_ack).
    receipt_view_acknowledged_at timestamptz,
    -- How many STORED receipts hung off this report at the moment of the
    -- decision. Module 12's APPROVED_WITHOUT_RECEIPT control wants "approved
    -- without the approver looking at a receipt" and could only measure
    -- "approved with no receipt on file"; recording the count at decision time
    -- is what makes the honest control possible, and it costs one integer now
    -- versus a backfill later that nobody can actually perform.
    receipts_present_at_decision int,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT approval_task_step_positive CHECK (step >= 1),
    CONSTRAINT approval_task_escalation_nonneg CHECK (escalation_level >= 0),
    CONSTRAINT approval_task_resolved_via_check
        CHECK (resolved_via IN ('MANAGER_CHAIN', 'ROLE', 'USER', 'DELEGATION',
                                'ADMIN_FALLBACK', 'REASSIGNED')),
    CONSTRAINT approval_task_delegation_source
        CHECK (resolved_via <> 'DELEGATION' OR delegated_from_id IS NOT NULL),
    -- A pending task carries no decision. A real decision (APPROVED / REJECTED /
    -- RETURNED) carries both halves — same shape as 0006's
    -- policy_violation_resolution_complete. SKIPPED and CANCELLED are the two
    -- outcomes the SYSTEM reaches without a person (a step the resolver could
    -- not fill; the tasks voided when a submitter recalls), so they need the
    -- timestamp but may have no actor.
    CONSTRAINT approval_task_decision_complete
        CHECK (CASE status
                 WHEN 'PENDING'   THEN decided_by_id IS NULL AND decided_at IS NULL
                 WHEN 'SKIPPED'   THEN decided_at IS NOT NULL
                 WHEN 'CANCELLED' THEN decided_at IS NOT NULL
                 ELSE decided_by_id IS NOT NULL AND decided_at IS NOT NULL
               END),
    -- The acknowledgement is submitted WITH the decision, never ahead of it.
    CONSTRAINT approval_task_ack_requires_decision
        CHECK (receipt_view_acknowledged_at IS NULL OR status <> 'PENDING')
);
CREATE INDEX approval_task_org_id_idx ON approval_task (organization_id);
-- The approver inbox (VX2-4): "the decisions waiting on me".
CREATE INDEX approval_task_assignee_idx ON approval_task (assignee_id, status);
-- One task per step of a run. The simplified ladder is strictly sequential and
-- single-approver, so a second task at the same step is a bug, not a feature.
-- A parallel or quorum rung is the one thing that would have to relax this — to
-- a partial unique on PENDING — and that is the only place an advanced graph
-- tier would need to touch these tables.
CREATE UNIQUE INDEX approval_task_step_idx ON approval_task (request_id, step);
ALTER TABLE approval_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_task FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_task
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Delegation (an approver's stand-in) ──────────────────────────────────────
--
-- Created here with the rest of the schema so VX2-1 lands all four tables and
-- the isolation harness covers them in one go. Nothing reads it yet: VX2-2
-- resolves against it (a live delegation wins ahead of the manager chain) and
-- VX2-5 adds the CRUD surface.
--
-- ExpenseOS's prototype stored `scope` and no handler ever read it — its own
-- Module 8 doc lists that as a gap to close. The column exists here from the
-- start so the resolver has something to enforce rather than something to
-- retrofit.
CREATE TABLE delegation (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- Whose approvals are handed over, and to whom. No ON DELETE clause: an
    -- app_user with a delegation cannot be hard-deleted, and employees are
    -- soft-deleted (deleted_at) in normal operation anyway.
    from_user_id    uuid NOT NULL REFERENCES app_user(id),
    to_user_id      uuid NOT NULL REFERENCES app_user(id),
    -- Inclusive calendar dates in the tenant's working timezone. Dates rather
    -- than timestamps because this is "I am away these days", not an instant,
    -- and a half-open timestamp range invites off-by-one-day bugs at exactly
    -- the moment somebody is away and cannot fix it.
    starts_on       date NOT NULL,
    -- NULL = open-ended, for a standing stand-in rather than a vacation.
    ends_on         date,
    -- What the stand-in covers. ALL and REPORTS are the same thing while the
    -- expense report is the only approval subject; the distinction exists so
    -- that adding travel or card approvals later does not silently widen every
    -- delegation written before them.
    scope           text NOT NULL DEFAULT 'ALL',
    -- A self-service delegation is created by from_user; an admin may create one
    -- on someone's behalf, and that difference is worth being able to see.
    created_by_id   uuid NOT NULL REFERENCES app_user(id),
    revoked_at      timestamptz,
    revoked_by_id   uuid REFERENCES app_user(id),
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT delegation_not_self CHECK (from_user_id <> to_user_id),
    CONSTRAINT delegation_range_ordered CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT delegation_scope_check CHECK (scope IN ('ALL', 'REPORTS')),
    CONSTRAINT delegation_revocation_complete
        CHECK ((revoked_at IS NULL     AND revoked_by_id IS NULL)
            OR (revoked_at IS NOT NULL AND revoked_by_id IS NOT NULL))
);
CREATE INDEX delegation_org_id_idx ON delegation (organization_id);
-- The resolver's lookup: "is anything standing in for this approver today".
CREATE INDEX delegation_from_active_idx ON delegation (from_user_id, starts_on, ends_on);
CREATE INDEX delegation_to_idx ON delegation (to_user_id);
--
-- NOT constrained here, on purpose: two live delegations from the same person
-- with overlapping date ranges. Expressing that needs EXCLUDE USING gist over
-- (from_user_id WITH =, daterange WITH &&), which needs the btree_gist
-- extension — a new deployment dependency for CI, the Docker image and every
-- laptop, to prevent a conflict the resolver can settle deterministically. So
-- VX2-2 picks the most recently created live delegation, and there is a test for
-- exactly that tie. If the ambiguity ever turns up in support tickets rather
-- than in tests, the extension is the fix.
ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delegation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
