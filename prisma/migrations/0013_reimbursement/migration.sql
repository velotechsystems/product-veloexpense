-- VeloExpense 0013 — reimbursement (VX2-9, ExpenseOS Module 8's AP action).
--
-- NO NEW TABLE, so no new RLS surface and CI's coverage guard is untouched:
-- `expense_report_status` already carries 'REIMBURSED' (0003) and
-- `expense_report_event.action` already permits 'REIMBURSE' (0007). What was
-- missing was any record of the payment itself.
--
-- Ported from ExpenseOS SOURCE, read 2026-08-29:
-- `apps/web/src/server/routers/expenseApprovals.ts`, procedure `markReimbursed`.
-- Findings are docs/porting/GAP-AUDIT.md RB-1 through RB-8; the two decisions
-- are in that file's "Decisions taken (2026-08-29, VX2-9)" table.
--
-- ── Why there are three columns here at all ─────────────────────────────────
--
-- ExpenseOS records NOTHING for a reimbursement beyond flipping the status, and
-- passes `details: {}` to its own audit call — while the same file passes real
-- details from `decide` and `setFxOverride`. So the emptiness is considered, not
-- forgotten: in their design REIMBURSED is a bookkeeping-free flag asserting
-- that AP paid out-of-band (RB-6 — the ledger hand-off happens at APPROVAL,
-- because "an approved report is a liability").
--
-- Diverging for three reasons, in order of weight:
--
--   1. `approved_at` already exists on this table. A payment with no timestamp
--      next to an approval with one reads as a bug, and "when was this paid"
--      should not require walking a hash chain.
--   2. The reference is the only thing that connects the flag to the money.
--      Without it the status asserts a payment happened and offers nothing to
--      check it against.
--   3. Three columns on an existing table is the cheapest possible version of
--      that, and it leaves the coverage guard and the isolation test alone.

ALTER TABLE expense_report
    -- Deliberately NOT defaulted and NOT set by a trigger: it is stamped by the
    -- transition, in the same statement that moves the status, so the two can
    -- never disagree. Same arrangement as `approved_at`.
    ADD COLUMN reimbursed_at   timestamptz,
    -- RESTRICT, not SET NULL. "Somebody paid this and we no longer know who" is
    -- a worse record than refusing the delete — and employees are soft-deleted
    -- (deleted_at) in normal operation, so this only fires on a hard delete that
    -- should be loud. Same choice as audit_entry.actor_id and activity.actor_id.
    ADD COLUMN reimbursed_by_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
    -- The AP run, cheque number, EFT batch or whatever the tenant reconciles
    -- against. OPTIONAL, because a finance clerk marking a report paid may not
    -- have the reference to hand at that moment and refusing the transition over
    -- it would push people to type anything.
    ADD COLUMN reimbursement_reference text;

-- All three move together or not at all.
--
-- The pair form (`(a IS NULL) = (b IS NULL)`) rather than three separate NOT
-- NULLs, because the columns are meaningless before payment and mandatory after:
-- a report with `reimbursed_at` and no actor is a payment nobody made, and an
-- actor with no timestamp is a payment that never happened. The REFERENCE is
-- excluded from the constraint on purpose — it is optional even after payment.
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_reimbursement_complete
        CHECK ((reimbursed_at IS NULL) = (reimbursed_by_id IS NULL));

-- And the status has to agree with the columns.
--
-- Not merely tidiness: without this, a bug that stamped the columns and failed
-- to move the status would leave a report that has been paid and still looks
-- payable, which is the exact double-payment outcome RB-2 describes. The
-- implication is one-directional on purpose — REIMBURSED requires the stamp, and
-- a stamp on a non-REIMBURSED report is refused — so the only way to hold the
-- columns is to be in the terminal state.
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_reimbursed_stamped
        CHECK ((status = 'REIMBURSED') = (reimbursed_at IS NOT NULL));

-- "Everything approved and waiting to be paid", which is the AP screen's only
-- query. Partial, because in a healthy tenant almost every report is in some
-- other status and the payable set is the small one.
CREATE INDEX expense_report_payable_idx
    ON expense_report (organization_id, approved_at)
    WHERE status = 'APPROVED';

-- ── The break-glass flag now governs payment as well as approval ────────────
--
-- RB-3: ExpenseOS has NO self-payment check. `markReimbursed` is gated on a
-- static permission and nothing else, so an AP user can mark their own report
-- paid — in a codebase whose own `canDecide` ordering exists because
-- self-APPROVAL is a SOX-grade control (AP-13). The asymmetry is hard to defend:
-- approval is an opinion that money should move, payment asserts that it did.
--
-- So VeloExpense refuses it, and reuses THIS flag rather than adding a second
-- one, because the forcing case is identical — a tenant where the admin who
-- submits is the only person who can act. One flag with a name that
-- under-describes it beats two flags where the second is never set.
--
-- The COMMENT is the only thing this migration changes about the column. Renaming
-- it would be more honest and would also break every query and every line of
-- documentation that names it, for a clarity gain a comment delivers.
COMMENT ON COLUMN organization.allow_sole_approver_self_approval IS
    'AP-14 / RB-3 break-glass. When true, a user may decide an approval task on '
    'their OWN report -- but only one the resolver already proved nobody else '
    'could take (resolved_via = ADMIN_FALLBACK) -- and may mark their own '
    'approved report reimbursed. Both are audited under their own actions. '
    'Exists because a sole-admin tenant is otherwise unable to submit an expense '
    'at all. The name says "approval" and the flag also governs payment: see '
    'docs/porting/GAP-AUDIT.md RB-3 for why that was preferred to a second flag.';
