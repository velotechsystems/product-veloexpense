-- VeloExpense 0057_receipt_reading — Wave 3 (w3-02a).
--
-- What the worker writes when it reads a receipt, beyond the reading itself (0056):
--
--   expense_determination  ExpenseOS's ExpenseDetermination: what a pass concluded for
--                          the whole expense, and what a person changed afterwards. The
--                          worker records each conclusion; the web records corrections
--                          against the current one (`recordOverrides`), so a later pass
--                          replays them instead of overwriting a person's work.
--   receipt_external_id    ExpenseOS's ReceiptExternalId / ExpenseExternalId: the
--   expense_external_id    transaction number a merchant printed, at the document and the
--                          expense grain, under the 'merchant-receipt' source.
--   ai_usage               VeloLedger's ai_usage (its 0050), one row per model call:
--                          the metering record d43 settles. NOT from ExpenseOS, which
--                          meters nothing.
--
-- Adapted (VeloExpense), as 0056: per tenant under RLS with composite foreign keys (TN-1),
-- organization_id defaulting to the tenant scope, ExpenseOS's uuid(7) ids as
-- gen_random_uuid().
--
-- New tables, no rows rewritten: safe to deploy in a batch (d16).

-- ── expense_determination ───────────────────────────────────────────────────
CREATE TABLE expense_determination (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    expense_id       uuid NOT NULL,
    -- The document set this pass actually saw.
    receipt_ids      uuid[] NOT NULL,
    -- What the pass concluded for the whole expense, verbatim.
    proposed         jsonb NOT NULL,
    -- Field-level human edits made after this pass.
    overrides        jsonb NOT NULL DEFAULT '{}'::jsonb,
    model            text,
    model_version    text,
    confidence       numeric(4, 3),
    -- Set when a newer pass replaces this one. Null = current.
    superseded_by_id uuid UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT expense_determination_confidence
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT expense_determination_overrides_object
      CHECK (jsonb_typeof(overrides) = 'object'),
    CONSTRAINT expense_determination_expense_fkey
      FOREIGN KEY (organization_id, expense_id)
      REFERENCES expense (organization_id, id) ON DELETE CASCADE,
    -- ExpenseOS's supersededById is a bare id; here it names a row of the same tenant.
    CONSTRAINT expense_determination_superseded_by_fkey
      FOREIGN KEY (organization_id, superseded_by_id)
      REFERENCES expense_determination (organization_id, id) ON DELETE SET NULL (superseded_by_id)
);
CREATE INDEX expense_determination_expense_created_idx
    ON expense_determination (expense_id, created_at);
CREATE INDEX expense_determination_org_id_idx ON expense_determination (organization_id);
ALTER TABLE expense_determination ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_determination FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_determination
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── receipt_external_id / expense_external_id ───────────────────────────────
CREATE TABLE receipt_external_id (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id       uuid NOT NULL,
    source_value    text NOT NULL,
    receipt_id      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_by      uuid,
    CONSTRAINT receipt_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 128),
    CONSTRAINT receipt_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT receipt_external_id_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES receipt (organization_id, id) ON DELETE CASCADE,
    -- ExpenseOS's @@unique([sourceId, sourceValue, receiptId]).
    UNIQUE (source_id, source_value, receipt_id)
);
CREATE INDEX receipt_external_id_receipt_idx ON receipt_external_id (receipt_id);
CREATE INDEX receipt_external_id_source_value_idx ON receipt_external_id (source_id, source_value);
CREATE INDEX receipt_external_id_org_id_idx ON receipt_external_id (organization_id);
ALTER TABLE receipt_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE TABLE expense_external_id (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id       uuid NOT NULL,
    source_value    text NOT NULL,
    expense_id      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_by      uuid,
    CONSTRAINT expense_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 128),
    CONSTRAINT expense_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT expense_external_id_expense_fkey
      FOREIGN KEY (organization_id, expense_id)
      REFERENCES expense (organization_id, id) ON DELETE CASCADE,
    -- ExpenseOS's @@unique([sourceId, sourceValue, expenseId]).
    UNIQUE (source_id, source_value, expense_id)
);
CREATE INDEX expense_external_id_expense_idx ON expense_external_id (expense_id);
CREATE INDEX expense_external_id_source_value_idx ON expense_external_id (source_id, source_value);
CREATE INDEX expense_external_id_org_id_idx ON expense_external_id (organization_id);
ALTER TABLE expense_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── ai_usage (VeloLedger 0050, d43) ─────────────────────────────────────────
-- One row per real model call. Token counts are authoritative; cost is derived from a
-- rate table (lib/ai/usage.ts) in micro-USD so small per-call costs do not round to zero.
-- VeloExpense adds `metered`: receipt reading is INCLUDED in every plan (the VeloExpense
-- pricing doc, Sept 2026) and is recorded for cost and fair use but never reported to the
-- platform; only metered rows are, which is what `reported_at` watermarks.
CREATE TABLE ai_usage (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Which AI feature drove the call: 'receipt_extraction' | …
    feature         text NOT NULL,
    model           text NOT NULL,
    input_tokens    integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens   integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost_micro_usd  bigint  NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
    metered         boolean NOT NULL,
    -- The document the call read, when it read one.
    receipt_id      uuid,
    actor_user_id   uuid,
    -- Our own correlation id for the call.
    request_id      text NOT NULL,
    reported_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    -- An included call is never reported.
    CONSTRAINT ai_usage_included_unreported CHECK (metered OR reported_at IS NULL),
    -- ON DELETE SET NULL: the usage happened whether or not the receipt survives.
    CONSTRAINT ai_usage_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES receipt (organization_id, id) ON DELETE SET NULL (receipt_id),
    CONSTRAINT ai_usage_actor_fkey
      FOREIGN KEY (organization_id, actor_user_id)
      REFERENCES app_user (organization_id, id) ON DELETE SET NULL (actor_user_id)
);
CREATE INDEX ai_usage_by_org_created ON ai_usage (organization_id, created_at DESC);
-- Drives the usage reporter: a cheap scan of metered rows not yet reported.
CREATE INDEX ai_usage_unreported ON ai_usage (organization_id) WHERE metered AND reported_at IS NULL;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_usage
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
