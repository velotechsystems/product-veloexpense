-- VeloExpense 0014_chart_of_accounts — VX3-1.
--
-- Two GLOBAL template tables and one TENANT account table, plus the two columns
-- that connect a coded expense to an account.
--
-- ── Why this is here at all ──────────────────────────────────────────────────
--
-- The Port & Build Plan put "selectable starter chart-of-accounts templates
-- (global templates -> per-tenant instances)" in PHASE 1 and it was never built;
-- `0001_init`'s own comment already names "chart-of-accounts starter templates"
-- as a global reference table, so this migration finishes a promise made in the
-- first one. It is the first ticket of Phase 3 because three things wait on it:
-- the adapter's "pull chart of accounts", the GL-mapping control, and Phase 4's
-- budgets.
--
-- ── This one could not be ported, and that is a finding, not an excuse ───────
--
-- GAP-AUDIT AC-9: ExpenseOS DELETED its vendor-neutral account table
-- (`20260617233000_drop_expenseos_account`). After that migration, accounts
-- exist there only as `NetSuiteAccount` — a cache filled by a twice-daily SOAP
-- pull — with no template, no accounts seed and no manual-entry screen. Their own
-- seed comment describes the resting state: a category's GL account is null
-- "when NetSuite has never synced, which is the normal state of a fresh
-- environment". That is fine for one company that certainly has NetSuite. It is
-- not fine for a tenant who signs up on Tuesday and connects a ledger on Friday.
--
-- So the SHAPE comes from VeloLedger instead — `product-veloledger`'s
-- `public.account` (`0001_init`, `0028_account_postable`) — which is the right
-- source twice over: it is the house sibling product, and it is the reference
-- adapter this phase has to post to. Numbers below are taken from its
-- `docs/Starter-Chart-of-Accounts.csv` verbatim, which is what makes VX3-4's
-- mapping near-identity rather than a translation table.
--
-- What is deliberately NOT copied from VeloLedger's account: `normal_balance`,
-- `gaap_presentation`, `ifrs_presentation`, `is_control_account`, `sub_ledger`,
-- and `currency`. The first five are ledger presentation concerns VeloExpense
-- never renders — it codes expenses, it does not produce financial statements.
-- The sixth is a trap: an amount's currency lives on `expense_report` and
-- `expense`, and a second currency authority on the account is how you get two
-- answers to one question (see PE-1, which is exactly that failure in the policy
-- engine).

-- ── GLOBAL: starter templates (no organization_id, no RLS) ────────────────────
-- Reference data, the same category as `currency`. The RLS-coverage guard in CI
-- keys off the presence of an `organization_id` column, so these two are
-- correctly outside it — do not add one to make the guard happy.
CREATE TABLE coa_template (
    key          text PRIMARY KEY,          -- stable, referenced by seeds and tests
    name         text NOT NULL,
    description  text NOT NULL,
    jurisdiction text,                      -- informational: 'CA', 'US', NULL = neutral
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coa_template_account (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key  text NOT NULL REFERENCES coa_template(key) ON DELETE CASCADE,
    number        text NOT NULL,
    name          text NOT NULL,
    type          text NOT NULL,
    sub_type      text,
    -- parent_number, not parent_id: this is the CSV's own shape, and it keeps a
    -- template row independent of insertion order. Instantiation resolves it in
    -- a second pass.
    parent_number text,
    is_postable   boolean NOT NULL DEFAULT true,
    sort_order    int NOT NULL DEFAULT 0,
    notes         text,
    UNIQUE (template_key, number),
    CONSTRAINT coa_template_account_type_chk
        CHECK (type IN ('asset','liability','equity','revenue','expense'))
    -- No rollup/leaf CHECK here: "is this a rollup" is "does any other row name
    -- me as its parent", which a CHECK cannot see. The template data sets
    -- is_postable explicitly per row, and the instantiation in lib/accounts
    -- verifies the two agree — see `assertRollupsNotPostable` there, which is the
    -- assertion this constraint wanted to be.
);
CREATE INDEX coa_template_account_template_idx ON coa_template_account (template_key, sort_order);

-- ── TENANT: the accounts a tenant actually codes to ──────────────────────────
CREATE TABLE gl_account (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    -- RESTRICT, not CASCADE: deleting a rollup must not silently orphan or
    -- delete its children. Accounts deactivate; they do not disappear.
    -- The FK itself is declared at the bottom of the table as a COMPOSITE — see
    -- the note on gl_account_org_id_uniq.
    parent_id        uuid,
    number           text NOT NULL,
    name             text NOT NULL,
    type             text NOT NULL,
    sub_type         text,
    -- ── is_postable, and the bug it exists to prevent ────────────────────────
    -- Ported from VeloLedger `0028_account_postable`, whose comment records the
    -- incident: "the starter CoA uses rollup accounts (e.g. 40000 Revenue) as
    -- category headers … Nothing prevented postings to them, which produced the
    -- 'invoice posted but IS shows no revenue' bug where a line hit 40000 and
    -- vanished from the presentation." A measured defect in a sibling product
    -- with this exact schema costs one column to avoid, and the trigger below is
    -- the VeloExpense equivalent of their journal_line guard.
    is_postable      boolean NOT NULL DEFAULT true,
    active           boolean NOT NULL DEFAULT true,
    -- ── source, and why one table rather than a pulled cache ─────────────────
    -- A tenant instantiates a template on day one, files expenses against it for
    -- a month, and then connects a real ledger. If the pull landed in a separate
    -- cache, every category mapping made in that month would need re-pointing at
    -- the moment of connection. So: ONE table, and the pull ADOPTS a matching row
    -- by (organization_id, number) rather than duplicating it — a TEMPLATE row
    -- gains an external_id and becomes PULLED. Categories keep pointing at the
    -- same row throughout. VX3-5 owns the reconcile; unmatched accounts on either
    -- side are surfaced to a human there and never resolved silently.
    source           text NOT NULL DEFAULT 'MANUAL',
    source_template  text REFERENCES coa_template(key),
    -- The id in the connected ledger. NULL until VX3-5 pulls.
    external_id      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, number),
    -- ── The key that makes cross-tenant references IMPOSSIBLE ────────────────
    -- Postgres runs referential-integrity checks as the constraint owner with
    -- RLS BYPASSED. A plain `REFERENCES gl_account(id)` therefore accepts an id
    -- belonging to ANOTHER TENANT: the write succeeds, and the row reads back as
    -- `gl_account_id set: true, resolvable: false` — a category that looks mapped
    -- and joins to nothing. Verified against this schema, on both a new and a
    -- pre-existing FK.
    --
    -- A composite FK through organization_id closes it structurally, without a
    -- trigger and without depending on RLS at all. This UNIQUE is what the
    -- composite references need; the FKs are below and on expense_category /
    -- expense_line_item.
    --
    -- The other 43 tenant-to-tenant FKs in this schema still have the weak form.
    -- That is its own ticket (see GAP-AUDIT TN-1) rather than folded in here.
    CONSTRAINT gl_account_org_id_uniq UNIQUE (organization_id, id),
    CONSTRAINT gl_account_parent_fkey
        FOREIGN KEY (organization_id, parent_id)
        REFERENCES gl_account (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT gl_account_type_chk
        CHECK (type IN ('asset','liability','equity','revenue','expense')),
    CONSTRAINT gl_account_source_chk
        CHECK (source IN ('TEMPLATE','IMPORT','MANUAL','PULLED')),
    -- TEMPLATE is the only source that names a template, and it must name one.
    CONSTRAINT gl_account_source_template_chk
        CHECK ((source = 'TEMPLATE') = (source_template IS NOT NULL)),
    -- PULLED is the only source that carries an external id. The converse is NOT
    -- asserted: VX3-5 adopts a TEMPLATE row by stamping its external_id, and that
    -- row becomes PULLED in the same statement.
    CONSTRAINT gl_account_external_id_chk
        CHECK (external_id IS NULL OR source = 'PULLED')
);
CREATE INDEX gl_account_org_id_idx  ON gl_account (organization_id);
CREATE INDEX gl_account_parent_idx  ON gl_account (parent_id);
-- Postable accounts are what every picker lists, and the only ones a category
-- may map to.
CREATE INDEX gl_account_postable_idx ON gl_account (organization_id, number)
    WHERE active AND is_postable;
-- One external account maps to at most one local row. Correct while a tenant has
-- one connected ledger, which is all VX3-3 will allow at first; when a second
-- installation becomes possible this widens to include the installation id.
CREATE UNIQUE INDEX gl_account_external_id_key ON gl_account (organization_id, external_id)
    WHERE external_id IS NOT NULL;

ALTER TABLE gl_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_account FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gl_account
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Connect categories and lines to accounts ─────────────────────────────────
--
-- `expense_category.gl_account` was a bare `text` since 0002 — "maps to the
-- tenant's chart of accounts", against a chart that did not exist. ExpenseOS made
-- exactly this move (free text -> FK) and recorded why: joinability with the rest
-- of the coding, and catching a bad account before push time rather than at it.
-- The old column is DROPPED rather than kept alongside: its only reader is one
-- SELECT in lib/expenses/service.ts, and the demo seed's values (630500, 640100,
-- …) are invented numbers matching no chart anywhere — keeping them would leave a
-- column that looks authoritative and resolves to nothing.
ALTER TABLE expense_category DROP COLUMN gl_account;
ALTER TABLE expense_category ADD COLUMN gl_account_id uuid;
-- Composite, for the reason on gl_account_org_id_uniq above.
--
-- `ON DELETE SET NULL (gl_account_id)` names the column deliberately: a composite
-- SET NULL nulls EVERY referencing column by default, and organization_id is NOT
-- NULL — so the unqualified form would make the delete fail instead of clearing
-- the mapping. The column list is Postgres 15+; this project is on 16.
ALTER TABLE expense_category
    ADD CONSTRAINT expense_category_gl_account_fkey
    FOREIGN KEY (organization_id, gl_account_id)
    REFERENCES gl_account (organization_id, id) ON DELETE SET NULL (gl_account_id);

-- SET NULL, not RESTRICT: a category outliving its account is a configuration
-- gap for an admin to fix, and a gap must not block a deletion that is otherwise
-- legitimate. The line below is the opposite case.
--
-- ── The SNAPSHOT (GAP-AUDIT AC-10, ported including the reason) ──────────────
-- The account is stamped onto the line WHEN THE LINE IS WRITTEN, not read through
-- the category at posting time, so a report posts to the account the line was
-- coded to when it was filed rather than to wherever its category points today.
-- Their rule, worth keeping verbatim: "The stamp is a SNAPSHOT, not a cache …
-- stamp on write, and never refresh."
--
-- Nullable, and a null blocks nothing — also theirs, also worth keeping: "a
-- category with no account is a configuration gap, and the employee filing the
-- expense is not who fixes it." Same instinct as VX1-8's submit gate: collect the
-- problem for whoever can act on it, do not fail the person who cannot.
ALTER TABLE expense_line_item ADD COLUMN gl_account_id uuid;
ALTER TABLE expense_line_item
    ADD CONSTRAINT expense_line_item_gl_account_fkey
    FOREIGN KEY (organization_id, gl_account_id)
    REFERENCES gl_account (organization_id, id) ON DELETE RESTRICT;

-- RESTRICT here: a snapshot that could silently become NULL is not a snapshot.
CREATE INDEX expense_line_item_gl_account_idx ON expense_line_item (gl_account_id)
    WHERE gl_account_id IS NOT NULL;

-- ── The postable guard ───────────────────────────────────────────────────────
-- VeloLedger enforces this with a trigger on `journal_line`. VeloExpense has no
-- journal, so the equivalent choke points are the two places an account is
-- chosen: a category's mapping, and a line's snapshot. A CHECK cannot see another
-- row, so it is a trigger — and it is worth the trigger rather than an app-level
-- gate because the whole point of AC-9's and 0028's history is that the guard has
-- to hold for paths nobody has written yet.
CREATE OR REPLACE FUNCTION gl_account_must_be_postable() RETURNS trigger AS $$
DECLARE
    acct_number text;
    acct_name   text;
    postable    boolean;
    is_active   boolean;
BEGIN
    IF NEW.gl_account_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT number, name, is_postable, active
      INTO acct_number, acct_name, postable, is_active
      FROM gl_account WHERE id = NEW.gl_account_id;
    IF postable IS NULL THEN
        -- Unreachable on these two columns as things stand, and kept anyway.
        -- The composite FKs already make a cross-tenant id structurally
        -- impossible, so this fires only if someone later replaces one of them
        -- with a plain `REFERENCES gl_account(id)` — which is exactly the change
        -- that would silently reopen the hole, and this is the line that would
        -- notice. Not a substitute for the composite FK: a trigger this function
        -- is attached to can be dropped, and the constraint cannot be dropped by
        -- accident.
        RAISE EXCEPTION 'gl_account % is not visible in this tenant', NEW.gl_account_id
            USING ERRCODE = '23503';
    END IF;
    IF NOT postable THEN
        RAISE EXCEPTION
            'account %/% is a rollup and cannot be coded to directly; choose a leaf account',
            acct_number, acct_name
            USING ERRCODE = '23514';
    END IF;
    -- Inactive is refused on a NEW mapping only. An existing line keeps its
    -- snapshot when an account is later deactivated — that is what a snapshot is
    -- for, and VX3-4 reports it as a posting problem rather than rewriting history.
    IF NOT is_active AND (TG_OP = 'INSERT' OR OLD.gl_account_id IS DISTINCT FROM NEW.gl_account_id) THEN
        RAISE EXCEPTION 'account %/% is inactive and cannot be newly coded to',
            acct_number, acct_name
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expense_category_gl_account_postable
    BEFORE INSERT OR UPDATE OF gl_account_id ON expense_category
    FOR EACH ROW EXECUTE FUNCTION gl_account_must_be_postable();

CREATE TRIGGER expense_line_item_gl_account_postable
    BEFORE INSERT OR UPDATE OF gl_account_id ON expense_line_item
    FOR EACH ROW EXECUTE FUNCTION gl_account_must_be_postable();

COMMENT ON COLUMN gl_account.is_postable IS
    'True for leaf accounts. False for rollup/heading accounts, which nothing may '
    'code to — enforced by gl_account_must_be_postable() on expense_category and '
    'expense_line_item. Ported from VeloLedger 0028_account_postable.';
COMMENT ON COLUMN expense_line_item.gl_account_id IS
    'SNAPSHOT of the category''s account at the time the line was written. Stamped '
    'on write, never refreshed (GAP-AUDIT AC-10).';

-- ── The first starter template ───────────────────────────────────────────────
--
-- Global reference data, seeded here for the same reason `currency` is seeded in
-- `0001`: a template a tenant can select has to exist before any tenant does.
--
-- PROVENANCE, because it matters for VX3-4: every number and name below is taken
-- verbatim from `product-veloledger/docs/Starter-Chart-of-Accounts.csv`. That is
-- what makes posting to VeloLedger a match on `number` rather than a translation
-- table — and it is the reason to resist "tidying" these numbers later.
--
-- It is the EXPENSE-CLAIM SUBSET, not that chart. VeloLedger's has 279 accounts
-- across five types; an employee expense claim cannot reach a balance-sheet
-- account, a salary line, stock compensation, depreciation or income tax, so
-- including them would be 250 rows of picker noise and an invitation to code a
-- lunch to Deferred Income Tax. Twenty-eight rows: eight rollups and twenty
-- leaves.
--
-- Two notes for whoever extends this:
--   · 68100/68200 split travel from meals because MEALS ARE 50% DEDUCTIBLE IN
--     CANADA and travel is not. That is a real tax distinction in the NA-first
--     market this product ships to, it is VeloLedger's own split, and collapsing
--     the two is a tax error rather than a simplification.
--   · Mileage has no account of its own here, deliberately: it is travel, and it
--     posts to 68100. If a tenant wants it separated it adds a leaf, which is
--     what `source = 'MANUAL'` is for.
INSERT INTO coa_template (key, name, description, jurisdiction) VALUES (
    'na-expense-claims',
    'North American expense claims',
    'The expense-claim subset of the Velotech starter chart of accounts, aligned '
    'number-for-number with VeloLedger so a connected ledger reconciles on the '
    'account number. Twenty-eight accounts: operating-expense rollups and the '
    'leaves an employee claim can reach. CAD/USD, with the Canadian 50% '
    'meals-and-entertainment split preserved.',
    'CA'
);

INSERT INTO coa_template_account
    (template_key, number, name, type, sub_type, parent_number, is_postable, sort_order, notes)
VALUES
    ('na-expense-claims','60000','Operating Expenses','expense','opex',NULL,   false,  10,'Rollup'),
    ('na-expense-claims','61000','Research and Development','expense','opex','60000', false,  20,'Rollup'),
    ('na-expense-claims','61300','Development Tools and Software','expense','opex','61000', true,  30,'Per-seat developer tooling'),
    ('na-expense-claims','61500','R&D Travel and Conferences','expense','opex','61000', true,  40,NULL),
    ('na-expense-claims','62000','Sales and Marketing','expense','opex','60000', false,  50,'Rollup'),
    ('na-expense-claims','62500','Events and Sponsorships','expense','opex','62000', true,  60,NULL),
    ('na-expense-claims','62600','Marketing Tools and Software','expense','opex','62000', true,  70,NULL),
    ('na-expense-claims','63000','General and Administrative','expense','opex','60000', false,  80,'Rollup'),
    ('na-expense-claims','63700','Consulting Fees (G&A)','expense','opex','63000', true,  90,'An employee-paid professional fee; most land in AP instead'),
    ('na-expense-claims','63800','Bank Fees (non-COGS)','expense','opex','63000', true, 100,'Card FX and wire fees on a claim'),
    ('na-expense-claims','64000','Employee-related (non-salary)','expense','opex','60000', false, 110,'Rollup'),
    ('na-expense-claims','64700','Training and Education','expense','opex','64000', true, 120,NULL),
    ('na-expense-claims','64900','Employee Engagement and Morale','expense','opex','64000', true, 130,'Team meals that are not client entertainment'),
    ('na-expense-claims','66000','Technology (Internal Use)','expense','opex','60000', false, 140,'Rollup'),
    ('na-expense-claims','66100','Software Subscriptions (internal)','expense','opex','66000', true, 150,NULL),
    ('na-expense-claims','66200','Hardware and Equipment (below cap)','expense','opex','66000', true, 160,'Above the capitalization threshold this is an asset, not a claim'),
    ('na-expense-claims','66400','Telecom and Phone','expense','opex','66000', true, 170,'Cellphone reimbursements'),
    ('na-expense-claims','66500','Internet','expense','opex','66000', true, 180,'Home-office internet where the policy allows it'),
    ('na-expense-claims','67000','Office and Administrative','expense','opex','60000', false, 190,'Rollup'),
    ('na-expense-claims','67100','Office Supplies','expense','opex','67000', true, 200,NULL),
    ('na-expense-claims','67200','Postage and Courier','expense','opex','67000', true, 210,NULL),
    ('na-expense-claims','67300','Business Licenses and Permits','expense','opex','67000', true, 220,NULL),
    ('na-expense-claims','67400','Dues and Subscriptions','expense','opex','67000', true, 230,'Professional memberships'),
    ('na-expense-claims','67500','Printing','expense','opex','67000', true, 240,NULL),
    ('na-expense-claims','68000','Travel Meals and Entertainment','expense','opex','60000', false, 250,'Rollup'),
    ('na-expense-claims','68100','Travel (100% deductible)','expense','opex','68000', true, 260,'Airfare, lodging, ground transport, mileage'),
    ('na-expense-claims','68200','Meals and Entertainment (50% deductible)','expense','opex','68000', true, 270,'CANADA: 50% deductible. Do not merge with 68100'),
    ('na-expense-claims','68300','Conferences and Trade Shows','expense','opex','68000', true, 280,NULL);
