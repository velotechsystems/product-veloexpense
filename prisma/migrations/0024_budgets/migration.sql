-- ════════════════════════════════════════════════════════════════════════════
-- 0024 — BUDGETS (VX4-5 part 1, GAP-AUDIT BG-1/2/3/5)
--
-- ── BG-2: the blocker is already gone, and this is where it shows ──────────
--
-- ExpenseOS's `Budget.glAccountId` is a NON-NULLABLE foreign key into
-- `NetSuiteAccount` — a twice-daily SOAP cache — and their vendor-neutral
-- `Account` table was DELETED. Its own comment gives the reason: "GL account, not
-- ExpenseCategory: EFIN populates NetSuite's Budget record at account level, so
-- anything else would not reconcile." So budgets there are UNCREATABLE without
-- NetSuite, and it is the only non-nullable NetSuiteAccount FK in their schema.
--
-- VX3-1 built a first-class tenant-owned chart of accounts, so `budget` points at
-- `gl_account` and a vendor becomes an alias. The reconciliation argument is right
-- and is why the scope is an ACCOUNT rather than a category: a category is how an
-- employee describes a purchase, an account is what finance reports on, and a
-- budget nobody can tie to the ledger is a spreadsheet.
--
-- ── BG-1: every key leads with organization_id, and the real index is here ──
--
-- Their declared uniqueness `[fiscalYearId, glAccountId, businessUnitId,
-- departmentId]` is enforced by a hand-written `NULLS NOT DISTINCT` index their
-- ORM cannot express, so `db push` silently loses it. Ours is written out for the
-- same reason and kept for a stronger one: without `NULLS NOT DISTINCT`, two
-- budgets for the same account with a NULL business unit are DISTINCT to Postgres,
-- so "the company-wide travel budget" could be created twice and every total after
-- that would be wrong in a way nobody could see.
--
-- ── BG-5: periods are ROWS WITH DATES, not a month number ───────────────────
--
-- Theirs hard-codes `MONTHS_IN_BUDGET_YEAR = 12` and explicitly rules out 4-4-5.
-- The audit's advice was to expect the 4-4-5 request from the first retail-shaped
-- tenant and PRICE it rather than discover it — so a period here carries
-- `starts_on` / `ends_on` instead of an ordinal month. Twelve calendar months is
-- then a seeding decision, 4-4-5 is a different seeding decision, and neither is a
-- migration. Twelve rows per budget per year costs nothing; a schema change to a
-- table with live data costs a weekend.
--
-- ── BG-3: the rollup, and the defect it must not inherit ────────────────────
--
-- Their `computeActuals` scans a whole fiscal year of expenses and card
-- transactions on EVERY approval decision, apportions live, stores nothing, and
-- loads every FX rate ever fetched, unbounded, per call. It runs inside
-- `loadSubject`, so it fires on every `startInstance`, every `decide` and every
-- expiry sweep. That does not survive shared infrastructure.
--
-- So the totals are STORED on the period, recomputed deliberately, and the
-- columns below encode AN-7's lesson — which is the defect their analytics has and
-- their budget code has in mirror image: *a missing FX rate is summed as if the
-- amount were already in base currency, unflagged*. A budget that quietly
-- under-reports is worse than one that says it cannot answer, so an amount that
-- cannot be converted is counted in `unconvertible_minor` and NEVER folded into
-- `actual_minor`. `BUDGET_OVERAGE` then reports "cannot evaluate" instead of
-- "under budget", and the screen can say which currency is missing a rate.
-- ════════════════════════════════════════════════════════════════════════════

-- ── The department a report BELONGS to, stamped rather than joined ──────────
--
-- John's call, 1 Sep. `department_id` lives on `app_user`, so the obvious rollup
-- joins `expense_report.submitter_id → app_user.department_id`. That makes a
-- department budget's history REWRITE ITSELF when somebody transfers: last
-- quarter's totals change after the fact, nothing records why, and recomputing the
-- same period twice can give two answers. A number finance signs cannot do that.
--
-- So the report carries its own copy, stamped at SUBMIT from the submitter — which
-- is exactly what VX3-1 already does with the GL account (AC-10's stamp-on-write),
-- for exactly this reason. NULL is legitimate and means two different things worth
-- distinguishing in a query: a report submitted by somebody with no department, or
-- a report that predates this column.
ALTER TABLE expense_report ADD COLUMN department_id uuid;

-- Composite, per TN-1: a single-column REFERENCES would accept another tenant's
-- department because referential integrity runs with RLS bypassed.
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_department_id_fkey
    FOREIGN KEY (organization_id, department_id)
    REFERENCES department (organization_id, id) ON DELETE SET NULL (department_id);

-- BACKFILL from each submitter's CURRENT department, and say plainly what that is
-- worth: it is the best available guess for reports submitted before the column
-- existed, and it is wrong for anybody who has transferred since. It is recorded
-- here rather than left implicit because the alternative — leaving them NULL —
-- makes every historical budget read as "no department" and that is a worse lie
-- than an approximate one. From this migration forward the value is stamped at
-- submit and is exact.
UPDATE expense_report r
   SET department_id = u.department_id
  FROM app_user u
 WHERE u.id = r.submitter_id
   AND u.organization_id = r.organization_id
   AND u.department_id IS NOT NULL
   AND r.status <> 'DRAFT';

-- The rollup's filter: tenant, then department, then date.
CREATE INDEX expense_report_department_idx
    ON expense_report (organization_id, department_id, status);

COMMENT ON COLUMN expense_report.department_id IS
    'The submitter''s department AT SUBMIT TIME, stamped rather than joined, so a '
    'reorg cannot rewrite a closed period''s budget totals. Rows before 0024 carry '
    'a backfill from the submitter''s current department (approximate by nature).';

-- ── budget ──────────────────────────────────────────────────────────────────

CREATE TABLE budget (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    name             text NOT NULL,
    -- The scope. `gl_account_id` is NOT NULL because a budget that is not tied to
    -- an account cannot be reconciled — BG-2's reasoning kept, its coupling
    -- dropped. `business_unit_id` and `department_id` are the optional narrowing,
    -- and NULL means "the whole organization" rather than "unknown", which is what
    -- makes the NULLS NOT DISTINCT index below necessary rather than tidy.
    gl_account_id    uuid NOT NULL,
    business_unit_id uuid,
    department_id    uuid,
    -- The budget's own currency. Amounts are converted INTO it, and an amount that
    -- cannot be converted is reported rather than absorbed (see the header).
    currency_code    text NOT NULL REFERENCES currency(code),
    -- The fiscal year label, e.g. 2026. Not a foreign key to a `fiscal_year`
    -- table: we have no fiscal-calendar surface yet, the periods below carry the
    -- actual dates, and inventing a table to hold one integer is how a schema
    -- grows a join nobody needed. When a fiscal-calendar surface arrives it owns
    -- the dates, and this stays the label.
    fiscal_year      int NOT NULL,
    notes            text,
    created_by_id    uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT budget_name_nonempty CHECK (length(btrim(name)) > 0),
    CONSTRAINT budget_fiscal_year_sane CHECK (fiscal_year BETWEEN 1900 AND 2999)
);

-- TN-1: referential integrity runs as the constraint owner with RLS BYPASSED, so
-- a single-column REFERENCES accepts another tenant's id. Every FK here is
-- composite through organization_id.
ALTER TABLE budget
    ADD CONSTRAINT budget_gl_account_id_fkey
    FOREIGN KEY (organization_id, gl_account_id)
    REFERENCES gl_account (organization_id, id),
    ADD CONSTRAINT budget_business_unit_id_fkey
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_unit (organization_id, id) ON DELETE SET NULL (business_unit_id),
    ADD CONSTRAINT budget_department_id_fkey
    FOREIGN KEY (organization_id, department_id)
    REFERENCES department (organization_id, id) ON DELETE SET NULL (department_id),
    ADD CONSTRAINT budget_created_by_id_fkey
    FOREIGN KEY (organization_id, created_by_id)
    REFERENCES app_user (organization_id, id) ON DELETE SET NULL (created_by_id);

-- ONE budget per scope per year, and NULLS NOT DISTINCT is what makes that true.
-- Postgres treats NULLs as distinct in a unique index by default, so without this
-- the company-wide budget for an account (business unit NULL, department NULL)
-- could be created any number of times and every total afterwards would be wrong
-- with nothing on screen to show it. Written as an index rather than a table
-- constraint because the ORM cannot express the clause and would drop it.
-- Declared NOW rather than retrofitted. `0019_composite_tenant_fks` exists because
-- nineteen tables were created without this and every FK into them was
-- single-column and therefore cross-tenant-permissive (TN-1). `budget_period`
-- below needs it immediately; anything else pointing at a budget later needs it
-- too, and the cheapest moment is this one.
ALTER TABLE budget ADD CONSTRAINT budget_org_id_uniq UNIQUE (organization_id, id);

CREATE UNIQUE INDEX budget_scope_unique
    ON budget (organization_id, fiscal_year, gl_account_id, business_unit_id, department_id)
    NULLS NOT DISTINCT;

CREATE INDEX budget_lookup ON budget (organization_id, fiscal_year) INCLUDE (gl_account_id);

ALTER TABLE budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget
    USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── budget_period ───────────────────────────────────────────────────────────

CREATE TABLE budget_period (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organization(id),
    budget_id           uuid NOT NULL,
    -- Dates, not an ordinal month — see BG-5 in the header. Inclusive of both
    -- ends, which is why the CHECK is `>=` and not `>`: a single-day period is
    -- absurd but not incoherent, and forbidding it buys nothing.
    starts_on           date NOT NULL,
    ends_on             date NOT NULL,
    amount_minor        bigint NOT NULL,
    -- THE ROLLUP. Stored, not computed per read (BG-3).
    --
    -- `actual_minor`     — APPROVED and beyond. What has been committed to.
    -- `pending_minor`    — SUBMITTED but not yet decided. Shown separately because
    --                      "you are within budget unless everything in flight is
    --                      approved" is the sentence a manager needs, and one
    --                      number cannot say it.
    -- `unconvertible_minor` — spend in a currency with no usable rate to this
    --                      budget's currency. NEVER folded into the two above:
    --                      that is AN-7's exact defect (a missing rate summed as
    --                      if the amount were already in base currency), and it
    --                      turns "I cannot answer" into "you are fine".
    actual_minor        bigint NOT NULL DEFAULT 0,
    pending_minor       bigint NOT NULL DEFAULT 0,
    unconvertible_minor bigint NOT NULL DEFAULT 0,
    -- When the rollup was last recomputed. NULL means never, which is NOT the same
    -- as zero spend — the screen must be able to say "not yet calculated" rather
    -- than showing a confident 0.
    rolled_up_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT budget_period_dates CHECK (ends_on >= starts_on),
    CONSTRAINT budget_period_amount_nonneg CHECK (amount_minor >= 0),
    CONSTRAINT budget_period_rollup_nonneg
        CHECK (actual_minor >= 0 AND pending_minor >= 0 AND unconvertible_minor >= 0),
    -- A total can only be non-zero if a rollup has run. NOT the reverse: a rollup
    -- that legitimately found nothing stamps the time and leaves the totals at
    -- zero, which is exactly the state `rolled_up_at` exists to distinguish from
    -- "never calculated". The first draft of this constraint was written as an
    -- if-and-only-if and was satisfied by almost anything.
    CONSTRAINT budget_period_totals_need_a_rollup
        CHECK (rolled_up_at IS NOT NULL
               OR (actual_minor = 0 AND pending_minor = 0 AND unconvertible_minor = 0))
);

ALTER TABLE budget_period
    ADD CONSTRAINT budget_period_budget_id_fkey
    FOREIGN KEY (organization_id, budget_id)
    REFERENCES budget (organization_id, id) ON DELETE CASCADE;

-- One period per start date per budget. The end date is deliberately NOT in the
-- key: two periods starting the same day are a data error whatever their ends,
-- and including `ends_on` would let a 4-4-5 reseed silently double up.
ALTER TABLE budget_period ADD CONSTRAINT budget_period_org_id_uniq UNIQUE (organization_id, id);

CREATE UNIQUE INDEX budget_period_start_unique
    ON budget_period (organization_id, budget_id, starts_on);

-- The lookup the rule makes: which period covers this transaction date.
CREATE INDEX budget_period_covering
    ON budget_period (organization_id, budget_id, starts_on, ends_on);

ALTER TABLE budget_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_period FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_period
    USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON COLUMN budget_period.unconvertible_minor IS
    'Spend that could not be converted into the budget currency for want of a rate. '
    'Never folded into actual_minor — AN-7 is the defect where a missing rate is '
    'summed as if the amount were already in base currency, turning "cannot answer" '
    'into "under budget".';
COMMENT ON COLUMN budget_period.rolled_up_at IS
    'NULL means the rollup has never run, which is not the same as zero spend.';
