-- VeloExpense 0005 — receipt upload state (VX1-5).
--
-- No new tables: `receipt` landed in 0003 with organization_id + ENABLE/FORCE RLS
-- + tenant_isolation, so the CI RLS-coverage guard is unaffected. This migration
-- only teaches the existing table about the two-step presigned-upload flow:
--
--   1. createUploadIntent — row written as PENDING with its storage key, before
--      any bytes exist. size_bytes is unknown at this point.
--   2. confirmUpload      — the server HEADs the object, records the REAL size
--      and flips the row to STORED.
--
-- A row that never reaches STORED is an abandoned upload: harmless, invisible to
-- the receipt lists, and safe to sweep later.

ALTER TABLE receipt
    ADD COLUMN status text NOT NULL DEFAULT 'PENDING';

ALTER TABLE receipt
    ADD CONSTRAINT receipt_status_check CHECK (status IN ('PENDING', 'STORED'));

-- Unknown until the upload is confirmed; the service never trusts a
-- client-reported size, it reads it back from storage.
ALTER TABLE receipt
    ALTER COLUMN size_bytes DROP NOT NULL;

-- The receipt-first "inbox": everything I have uploaded that is not yet attached
-- to an expense. Partial index — attached receipts are found via expense_id.
CREATE INDEX receipt_inbox_idx
    ON receipt (organization_id, uploaded_by_id)
    WHERE expense_id IS NULL;

CREATE INDEX receipt_status_idx ON receipt (organization_id, status);
