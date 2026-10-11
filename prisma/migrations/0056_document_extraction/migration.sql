-- VeloExpense 0056_document_extraction — Wave 3 (w3-01).
--
-- ExpenseOS's DocumentExtraction: one reading of one uploaded receipt — the malware scan's
-- verdict, the model's extraction (its data, confidence, model and version, the raw
-- response), the error when there is none, and a reviewer's sign-off on a low-confidence
-- one. The worker writes it (w3-02); the workbench reads it (`expenses.report`,
-- `receiptGroupingSuggestions`, the statement procedures) and `markExtractionReviewed`
-- stamps the review.
--
-- Adapted (VeloExpense):
--   · receipts only. ExpenseOS's row also hangs off a virtual-card attachment, which
--     VeloExpense does not have; `receipt_id` is therefore required, not one of two.
--   · per tenant, under RLS like every tenant table, with the composite foreign key
--     (TN-1). `receipt` gains the UNIQUE (organization_id, id) that key needs.
--   · ExpenseOS's DocScanStatus / DocExtractStatus enums are text under a CHECK, as the
--     Wave 2 tables keep ExpenseOS's enums.
--   · `reviewed_by` is ExpenseOS's bare id, `reviewed_by_id` here, with the tenant key to
--     app_user.
--
-- New table, no rows rewritten: safe to deploy in a batch (d16).

ALTER TABLE receipt ADD CONSTRAINT receipt_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE document_extraction (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    receipt_id      uuid NOT NULL,
    scan_status     text NOT NULL DEFAULT 'PENDING',
    status          text NOT NULL DEFAULT 'PENDING',
    model           text,
    model_version   text,
    confidence      numeric(4, 3),
    data            jsonb,
    raw_response    jsonb,
    error           text,
    reviewed_at     timestamptz,
    reviewed_by_id  uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    -- One reading per receipt, as ExpenseOS's @unique.
    CONSTRAINT document_extraction_receipt_key UNIQUE (receipt_id),
    -- The same, on the tenant key, for Prisma's one-to-one relation over it.
    CONSTRAINT document_extraction_org_receipt_key UNIQUE (organization_id, receipt_id),
    CONSTRAINT document_extraction_scan_status
      CHECK (scan_status IN ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'FAILED')),
    CONSTRAINT document_extraction_status
      CHECK (status IN ('PENDING', 'EXTRACTING', 'EXTRACTED', 'FAILED')),
    CONSTRAINT document_extraction_confidence
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    -- A sign-off names who gave it, and only a sign-off does.
    CONSTRAINT document_extraction_review_complete
      CHECK ((reviewed_at IS NULL) = (reviewed_by_id IS NULL)),
    CONSTRAINT document_extraction_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES receipt (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT document_extraction_reviewed_by_fkey
      FOREIGN KEY (organization_id, reviewed_by_id)
      REFERENCES app_user (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX document_extraction_org_id_idx ON document_extraction (organization_id);
ALTER TABLE document_extraction ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_extraction
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
