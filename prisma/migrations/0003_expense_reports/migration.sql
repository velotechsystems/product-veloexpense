-- VeloExpense 0003 — expense reports, expenses, line items, receipts (VX1-3).
-- Mirrors the ExpenseOS shape (report → expense → line item; receipts attach to
-- the expense, enabling the receipt-first flow), trimmed to MVP. Every table is
-- tenant-scoped: organization_id + org index + ENABLE/FORCE RLS + tenant_isolation.
-- (Mileage, tax engine, NetSuite coding, fraud, approvals arrive in later phases.)

-- Per-tenant report numbering counter (organization is a global table, no RLS).
ALTER TABLE organization ADD COLUMN expense_report_seq bigint NOT NULL DEFAULT 0;

CREATE TYPE expense_report_status AS ENUM
  ('DRAFT','SUBMITTED','APPROVED','REJECTED','RETURNED','REIMBURSED');

-- ── Expense report ───────────────────────────────────────────────────────────
CREATE TABLE expense_report (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    number           text,                          -- 'EXP-000001', assigned per-tenant by the app
    title            text NOT NULL,
    purpose          text,
    status           expense_report_status NOT NULL DEFAULT 'DRAFT',
    total_minor      bigint NOT NULL DEFAULT 0,
    currency_code    text NOT NULL REFERENCES currency(code),
    submitter_id     uuid NOT NULL REFERENCES app_user(id),
    business_unit_id uuid REFERENCES business_unit(id),
    submitted_at     timestamptz,
    approved_at      timestamptz,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, number)
);
CREATE INDEX expense_report_org_id_idx ON expense_report (organization_id);
CREATE INDEX expense_report_submitter_idx ON expense_report (submitter_id);
ALTER TABLE expense_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_report FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_report
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Expense (one charge; groups line items + receipts under a report) ─────────
CREATE TABLE expense (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    report_id        uuid NOT NULL REFERENCES expense_report(id) ON DELETE CASCADE,
    merchant         text,
    txn_date         date,
    currency_code    text NOT NULL REFERENCES currency(code),
    notes            text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_org_id_idx ON expense (organization_id);
CREATE INDEX expense_report_id_idx ON expense (report_id);
ALTER TABLE expense ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Expense line item (a coded amount within an expense; splits = many) ───────
CREATE TABLE expense_line_item (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    expense_id       uuid NOT NULL REFERENCES expense(id) ON DELETE CASCADE,
    category_id      uuid NOT NULL REFERENCES expense_category(id),
    amount_minor     bigint NOT NULL,
    description      text,
    tax_minor        bigint NOT NULL DEFAULT 0,   -- simple total tax for now; engine later
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_line_item_org_id_idx ON expense_line_item (organization_id);
CREATE INDEX expense_line_item_expense_idx ON expense_line_item (expense_id);
ALTER TABLE expense_line_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_line_item FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_line_item
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Receipt (attaches to an expense; nullable to support receipt-first) ───────
CREATE TABLE receipt (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    expense_id       uuid REFERENCES expense(id) ON DELETE SET NULL,
    s3_key           text NOT NULL,
    filename         text NOT NULL,
    content_type     text NOT NULL,
    size_bytes       int NOT NULL,
    uploaded_by_id   uuid NOT NULL REFERENCES app_user(id),
    uploaded_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, s3_key)
);
CREATE INDEX receipt_org_id_idx ON receipt (organization_id);
CREATE INDEX receipt_expense_idx ON receipt (expense_id);
ALTER TABLE receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
