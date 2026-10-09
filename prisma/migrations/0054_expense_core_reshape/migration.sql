-- Wave 2, slice 1 (w2-00): the expense core reshaped IN PLACE to ExpenseOS's fields
-- (decision d22), so its `expenses` router and report screens run unchanged against
-- these tables (prisma/schema.prisma maps the names).
--
--   · `expense` gains ExpenseOS's Expense columns: owner, amount, payment method,
--     purpose/explanation, the FX snapshot and the tax figures;
--   · `expense_line_item` gains the line kind, its payload and the mileage snapshot;
--   · `receipt` gains the document kind;
--   · `expense_report` gains AP's FX override;
--   · NEW `expense_allocation` and `expense_attendee`, per tenant;
--   · NEW `tax_jurisdiction`, GLOBAL and platform-seeded (decision d24).
--
-- Every column VeloExpense's own readers use (analytics, budgets, fraud, ledger,
-- export, approvals) stays; they move to ExpenseOS's columns with their own waves.
--
-- THIS MIGRATION REWRITES EXISTING ROWS (the backfill at the end), so it deploys on
-- its own (d16). It runs per tenant (f08): on RDS the migrating role owns the tables
-- but FORCE ROW LEVEL SECURITY applies to it too, so an UPDATE with no tenant set
-- matches nothing and reports success.

-- ── tax_jurisdiction (global) ───────────────────────────────────────────────
-- ExpenseOS's `TaxJurisdiction`, field for field, seeded from its
-- packages/db/prisma/seed-data/tax-jurisdictions.json at 550b2945 (64 rows, version
-- 2026.1, sha256 2da02cf5…cd70) with ExpenseOS's own ids, so a jurisdiction is the
-- same row in both products. Rates are percentages (QST 9.975).
--
-- VeloExpense: global like `currency` (0001), but NOT writable by the app. ExpenseOS
-- only ever writes it from its seed; here a tenant's request that could write it would
-- change every other tenant's tax. So row security is ENABLED (not forced: the
-- migrating role owns the table and seeds it) with a read-only policy — `veloapp` can
-- SELECT every row and has no policy under which to INSERT, UPDATE or DELETE one.
-- A rate change ships as a migration.
CREATE TABLE tax_jurisdiction (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code   text NOT NULL,
    code           text NOT NULL,
    label          jsonb NOT NULL,
    gst_rate       numeric(6,3) NOT NULL DEFAULT 0,
    hst_rate       numeric(6,3) NOT NULL DEFAULT 0,
    pst_rate       numeric(6,3) NOT NULL DEFAULT 0,
    qst_rate       numeric(6,3) NOT NULL DEFAULT 0,
    sales_tax_rate numeric(6,3) NOT NULL DEFAULT 0,
    tax_type       text NOT NULL,
    version        text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tax_jurisdiction_country_iso CHECK (country_code ~ '^[A-Z]{2}$'),
    CONSTRAINT tax_jurisdiction_rates_percent CHECK (
        gst_rate BETWEEN 0 AND 100 AND hst_rate BETWEEN 0 AND 100 AND
        pst_rate BETWEEN 0 AND 100 AND qst_rate BETWEEN 0 AND 100 AND
        sales_tax_rate BETWEEN 0 AND 100),
    CONSTRAINT tax_jurisdiction_country_code_key UNIQUE (country_code, code)
);
CREATE INDEX tax_jurisdiction_country_idx ON tax_jurisdiction (country_code);
ALTER TABLE tax_jurisdiction ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_only ON tax_jurisdiction FOR SELECT USING (true);

INSERT INTO tax_jurisdiction
    (id, country_code, code, label, gst_rate, hst_rate, pst_rate, qst_rate, sales_tax_rate, tax_type, version)
VALUES
    ('ebd1b14c-8501-4ea9-82f3-805bc0c34767', 'CA', 'AB', '{"en": "Alberta", "fr-CA": "Alberta"}'::jsonb, 5, 0, 0, 0, 0, 'GST', '2026.1'),
    ('4cf23e0b-8043-4cb4-805b-1925228dd7ef', 'CA', 'BC', '{"en": "British Columbia", "fr-CA": "Colombie-Britannique"}'::jsonb, 5, 0, 7, 0, 0, 'GST+PST', '2026.1'),
    ('c7c8a4a9-c851-49b5-b941-902d6fa46a49', 'CA', 'SK', '{"en": "Saskatchewan", "fr-CA": "Saskatchewan"}'::jsonb, 5, 0, 6, 0, 0, 'GST+PST', '2026.1'),
    ('52de0c69-4293-49d5-893d-db20140f7f94', 'CA', 'MB', '{"en": "Manitoba", "fr-CA": "Manitoba"}'::jsonb, 5, 0, 7, 0, 0, 'GST+RST', '2026.1'),
    ('0c3cb932-40b8-4889-8684-b819d603e4cc', 'CA', 'ON', '{"en": "Ontario", "fr-CA": "Ontario"}'::jsonb, 0, 13, 0, 0, 0, 'HST', '2026.1'),
    ('82591dbc-b0d9-4139-85a9-b86f38c2dcde', 'CA', 'QC', '{"en": "Quebec", "fr-CA": "Québec"}'::jsonb, 5, 0, 0, 9.975, 0, 'GST+QST', '2026.1'),
    ('f949b2fc-4dec-4d29-ada4-acafeb6929f3', 'CA', 'NB', '{"en": "New Brunswick", "fr-CA": "Nouveau-Brunswick"}'::jsonb, 0, 15, 0, 0, 0, 'HST', '2026.1'),
    ('f331f807-aea0-42fe-8c7d-6688848b59b0', 'CA', 'NS', '{"en": "Nova Scotia", "fr-CA": "Nouvelle-Écosse"}'::jsonb, 0, 15, 0, 0, 0, 'HST', '2026.1'),
    ('edf723d2-bef7-4cbe-acc2-5ccd827f91af', 'CA', 'PE', '{"en": "Prince Edward Island", "fr-CA": "Île-du-Prince-Édouard"}'::jsonb, 0, 15, 0, 0, 0, 'HST', '2026.1'),
    ('17725598-81e0-42cf-924d-6e1e2abff827', 'CA', 'NL', '{"en": "Newfoundland & Labrador", "fr-CA": "Terre-Neuve-et-Labrador"}'::jsonb, 0, 15, 0, 0, 0, 'HST', '2026.1'),
    ('1c58e909-b749-44d9-b138-cd5da549683d', 'CA', 'NT', '{"en": "Northwest Territories", "fr-CA": "Territoires du Nord-Ouest"}'::jsonb, 5, 0, 0, 0, 0, 'GST', '2026.1'),
    ('1b80eec2-3499-4ab8-bf58-ec06b11b10c1', 'CA', 'YT', '{"en": "Yukon", "fr-CA": "Yukon"}'::jsonb, 5, 0, 0, 0, 0, 'GST', '2026.1'),
    ('0cf232e2-db51-4579-a5bb-708dc6e1d749', 'CA', 'NU', '{"en": "Nunavut", "fr-CA": "Nunavut"}'::jsonb, 5, 0, 0, 0, 0, 'GST', '2026.1'),
    ('20950687-b29a-4636-a2d9-49ed7f1ac2ce', 'US', 'AL', '{"en": "Alabama", "fr-CA": "Alabama"}'::jsonb, 0, 0, 0, 0, 4, 'SALES_TAX', '2026.1'),
    ('516e3b1d-b93e-4e3c-b75d-20ef82b364d1', 'US', 'AK', '{"en": "Alaska", "fr-CA": "Alaska"}'::jsonb, 0, 0, 0, 0, 0, 'NONE', '2026.1'),
    ('556eed31-9790-4cec-889d-fa95242818d4', 'US', 'AZ', '{"en": "Arizona", "fr-CA": "Arizona"}'::jsonb, 0, 0, 0, 0, 5.6, 'SALES_TAX', '2026.1'),
    ('6c615963-f2aa-463c-8435-9253a90dc8f6', 'US', 'AR', '{"en": "Arkansas", "fr-CA": "Arkansas"}'::jsonb, 0, 0, 0, 0, 6.5, 'SALES_TAX', '2026.1'),
    ('d5cb646c-cea3-44c6-87f6-30fedf9ad313', 'US', 'CA', '{"en": "California", "fr-CA": "California"}'::jsonb, 0, 0, 0, 0, 7.25, 'SALES_TAX', '2026.1'),
    ('89700288-523b-4d2f-a935-2b7fa298f158', 'US', 'CO', '{"en": "Colorado", "fr-CA": "Colorado"}'::jsonb, 0, 0, 0, 0, 2.9, 'SALES_TAX', '2026.1'),
    ('d0454175-0453-4a59-b8ed-66cf507d0cc1', 'US', 'CT', '{"en": "Connecticut", "fr-CA": "Connecticut"}'::jsonb, 0, 0, 0, 0, 6.35, 'SALES_TAX', '2026.1'),
    ('04a73ea6-957d-472c-98df-85d037db5713', 'US', 'DE', '{"en": "Delaware", "fr-CA": "Delaware"}'::jsonb, 0, 0, 0, 0, 0, 'NONE', '2026.1'),
    ('5d1c9574-2816-4ca5-b57f-a723cbdf035f', 'US', 'FL', '{"en": "Florida", "fr-CA": "Florida"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('d314b206-1fd5-4cba-b5b3-00c73d6183ae', 'US', 'GA', '{"en": "Georgia", "fr-CA": "Georgia"}'::jsonb, 0, 0, 0, 0, 4, 'SALES_TAX', '2026.1'),
    ('b086d103-f414-47ca-8b55-f578bf596362', 'US', 'HI', '{"en": "Hawaii", "fr-CA": "Hawaii"}'::jsonb, 0, 0, 0, 0, 4, 'SALES_TAX', '2026.1'),
    ('b2c8a999-743e-4884-9ad5-d94ca855f44a', 'US', 'ID', '{"en": "Idaho", "fr-CA": "Idaho"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('1cdea4ac-2609-4063-a1b6-ef95e58659f3', 'US', 'IL', '{"en": "Illinois", "fr-CA": "Illinois"}'::jsonb, 0, 0, 0, 0, 6.25, 'SALES_TAX', '2026.1'),
    ('c081d324-f754-4aa4-af50-7ead31f82866', 'US', 'IN', '{"en": "Indiana", "fr-CA": "Indiana"}'::jsonb, 0, 0, 0, 0, 7, 'SALES_TAX', '2026.1'),
    ('90953b20-3843-45ac-9850-6fc1192d400a', 'US', 'IA', '{"en": "Iowa", "fr-CA": "Iowa"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('002fad87-27ae-4039-82c0-d7417535180e', 'US', 'KS', '{"en": "Kansas", "fr-CA": "Kansas"}'::jsonb, 0, 0, 0, 0, 6.5, 'SALES_TAX', '2026.1'),
    ('3da7fe40-9b83-4270-ab59-7b30b1902932', 'US', 'KY', '{"en": "Kentucky", "fr-CA": "Kentucky"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('98b67a33-3849-45d4-a2d4-f0134df0e3a8', 'US', 'LA', '{"en": "Louisiana", "fr-CA": "Louisiana"}'::jsonb, 0, 0, 0, 0, 4.45, 'SALES_TAX', '2026.1'),
    ('463529cb-3e2b-4c90-b3b3-7f0015338367', 'US', 'ME', '{"en": "Maine", "fr-CA": "Maine"}'::jsonb, 0, 0, 0, 0, 5.5, 'SALES_TAX', '2026.1'),
    ('7d392747-21ed-45cc-a1c3-4ecddfe2360a', 'US', 'MD', '{"en": "Maryland", "fr-CA": "Maryland"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('f4787264-7a06-407c-9b59-10c126ead4fd', 'US', 'MA', '{"en": "Massachusetts", "fr-CA": "Massachusetts"}'::jsonb, 0, 0, 0, 0, 6.25, 'SALES_TAX', '2026.1'),
    ('f0058b76-13e4-4d11-83d8-ee6ab895a5c4', 'US', 'MI', '{"en": "Michigan", "fr-CA": "Michigan"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('47fa9823-d8ac-4349-8a62-9fa31f1ecaed', 'US', 'MN', '{"en": "Minnesota", "fr-CA": "Minnesota"}'::jsonb, 0, 0, 0, 0, 6.875, 'SALES_TAX', '2026.1'),
    ('c9dc6536-89e9-43ac-b6e5-6a7236b256a0', 'US', 'MS', '{"en": "Mississippi", "fr-CA": "Mississippi"}'::jsonb, 0, 0, 0, 0, 7, 'SALES_TAX', '2026.1'),
    ('088c8d9a-e8c9-46b0-a387-0f434bc9bfd9', 'US', 'MO', '{"en": "Missouri", "fr-CA": "Missouri"}'::jsonb, 0, 0, 0, 0, 4.225, 'SALES_TAX', '2026.1'),
    ('14b7833e-4e5f-4b63-b22c-d4b5ba4664e2', 'US', 'MT', '{"en": "Montana", "fr-CA": "Montana"}'::jsonb, 0, 0, 0, 0, 0, 'NONE', '2026.1'),
    ('0cbfaf1b-c312-464a-ac04-df3dee867fad', 'US', 'NE', '{"en": "Nebraska", "fr-CA": "Nebraska"}'::jsonb, 0, 0, 0, 0, 5.5, 'SALES_TAX', '2026.1'),
    ('999cb026-1893-4609-a039-b5be87f9efe0', 'US', 'NV', '{"en": "Nevada", "fr-CA": "Nevada"}'::jsonb, 0, 0, 0, 0, 6.85, 'SALES_TAX', '2026.1'),
    ('79062814-79b8-44fd-b47a-6d431ca8bcec', 'US', 'NH', '{"en": "New Hampshire", "fr-CA": "New Hampshire"}'::jsonb, 0, 0, 0, 0, 0, 'NONE', '2026.1'),
    ('1dfc418f-7bb2-4d39-bf9e-eba5f8a59597', 'US', 'NJ', '{"en": "New Jersey", "fr-CA": "New Jersey"}'::jsonb, 0, 0, 0, 0, 6.625, 'SALES_TAX', '2026.1'),
    ('2a6285ea-45ba-45b0-9320-adb72991f502', 'US', 'NM', '{"en": "New Mexico", "fr-CA": "New Mexico"}'::jsonb, 0, 0, 0, 0, 5.125, 'SALES_TAX', '2026.1'),
    ('877baebb-37ac-45e7-ab30-dcef1b8baf9f', 'US', 'NY', '{"en": "New York", "fr-CA": "New York"}'::jsonb, 0, 0, 0, 0, 4, 'SALES_TAX', '2026.1'),
    ('479e887f-0828-4f3b-a35c-2858d8150e58', 'US', 'NC', '{"en": "North Carolina", "fr-CA": "North Carolina"}'::jsonb, 0, 0, 0, 0, 4.75, 'SALES_TAX', '2026.1'),
    ('be0ffc21-f82b-41b9-9625-54f29196668d', 'US', 'ND', '{"en": "North Dakota", "fr-CA": "North Dakota"}'::jsonb, 0, 0, 0, 0, 5, 'SALES_TAX', '2026.1'),
    ('a98a087f-09ce-4c8b-a6c4-81ef673fc029', 'US', 'OH', '{"en": "Ohio", "fr-CA": "Ohio"}'::jsonb, 0, 0, 0, 0, 5.75, 'SALES_TAX', '2026.1'),
    ('2a745dce-d6b2-41ab-ac1c-a096ca9e4a4e', 'US', 'OK', '{"en": "Oklahoma", "fr-CA": "Oklahoma"}'::jsonb, 0, 0, 0, 0, 4.5, 'SALES_TAX', '2026.1'),
    ('9a85f917-1b14-4a45-8d10-81a592fe7647', 'US', 'OR', '{"en": "Oregon", "fr-CA": "Oregon"}'::jsonb, 0, 0, 0, 0, 0, 'NONE', '2026.1'),
    ('28120e37-71b8-4df7-89de-231f0deccb36', 'US', 'PA', '{"en": "Pennsylvania", "fr-CA": "Pennsylvania"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('c21df465-5ba5-45c3-8c12-674a665b9322', 'US', 'RI', '{"en": "Rhode Island", "fr-CA": "Rhode Island"}'::jsonb, 0, 0, 0, 0, 7, 'SALES_TAX', '2026.1'),
    ('046f6174-b1f3-40d8-9fc7-7fa2f01a6d29', 'US', 'SC', '{"en": "South Carolina", "fr-CA": "South Carolina"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('4a89c213-b930-4b56-8cb9-182ac89f831f', 'US', 'SD', '{"en": "South Dakota", "fr-CA": "South Dakota"}'::jsonb, 0, 0, 0, 0, 4.2, 'SALES_TAX', '2026.1'),
    ('16a3ba59-20f8-4d2e-adbf-8e50fb076b40', 'US', 'TN', '{"en": "Tennessee", "fr-CA": "Tennessee"}'::jsonb, 0, 0, 0, 0, 7, 'SALES_TAX', '2026.1'),
    ('1c03c2a0-ac58-4eaf-90e7-0962182a269c', 'US', 'TX', '{"en": "Texas", "fr-CA": "Texas"}'::jsonb, 0, 0, 0, 0, 6.25, 'SALES_TAX', '2026.1'),
    ('0f4a0aca-1609-495d-aed1-54ad1806302f', 'US', 'UT', '{"en": "Utah", "fr-CA": "Utah"}'::jsonb, 0, 0, 0, 0, 6.1, 'SALES_TAX', '2026.1'),
    ('275634e4-80bf-4e47-80ac-aea1cd10bb25', 'US', 'VT', '{"en": "Vermont", "fr-CA": "Vermont"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('2fc968ac-f53d-4acd-9b91-cd135a446cb8', 'US', 'VA', '{"en": "Virginia", "fr-CA": "Virginia"}'::jsonb, 0, 0, 0, 0, 5.3, 'SALES_TAX', '2026.1'),
    ('adfd75c6-c10f-4151-82eb-831f5d9240ed', 'US', 'WA', '{"en": "Washington", "fr-CA": "Washington"}'::jsonb, 0, 0, 0, 0, 6.5, 'SALES_TAX', '2026.1'),
    ('4b87ce39-4826-494e-a895-7ef4810c7dc7', 'US', 'DC', '{"en": "District of Columbia", "fr-CA": "District of Columbia"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('6383c502-bbdc-44e5-9bd0-7531a6a59f49', 'US', 'WV', '{"en": "West Virginia", "fr-CA": "West Virginia"}'::jsonb, 0, 0, 0, 0, 6, 'SALES_TAX', '2026.1'),
    ('a350480d-0fe6-4f65-b751-69dc4d2b11de', 'US', 'WI', '{"en": "Wisconsin", "fr-CA": "Wisconsin"}'::jsonb, 0, 0, 0, 0, 5, 'SALES_TAX', '2026.1'),
    ('c18bad0f-d5bc-4eda-95d4-0cd9911969b4', 'US', 'WY', '{"en": "Wyoming", "fr-CA": "Wyoming"}'::jsonb, 0, 0, 0, 0, 4, 'SALES_TAX', '2026.1');

-- ── expense ─────────────────────────────────────────────────────────────────
-- ExpenseOS's Expense columns. VeloExpense differences:
--   · the date stays `txn_date` (a date; ExpenseOS's `date` is a timestamp) and the
--     currency stays `currency_code` (the ISO code; ExpenseOS's `currencyId` is a uuid
--     — the same mapping as 0048's `homeCurrencyId`);
--   · enums are text with a CHECK listing ExpenseOS's values (no Postgres enums);
--   · `home_currency` is a foreign key to `currency` (ExpenseOS: a bare code);
--   · `notes` (VeloExpense's) stays beside ExpenseOS's `purpose` and `explanation`.
ALTER TABLE expense
    ADD COLUMN owner_id                  uuid,
    ADD COLUMN place_text                text,
    -- The entry total, which must equal the sum of its line items. Backfilled below.
    ADD COLUMN amount_minor              bigint NOT NULL DEFAULT 0,
    ADD COLUMN payment_method            text NOT NULL DEFAULT 'OUT_OF_POCKET',
    ADD COLUMN purpose                   text,
    ADD COLUMN explanation               text,
    ADD COLUMN subtotal_minor            bigint,
    ADD COLUMN fx_rate                   numeric(18,8),
    ADD COLUMN fx_rate_source            text,
    ADD COLUMN home_currency             text REFERENCES currency(code),
    ADD COLUMN home_amount_minor         bigint,
    ADD COLUMN tax_gst_hst_minor         bigint,
    ADD COLUMN tax_qst_minor             bigint,
    ADD COLUMN tax_pst_minor             bigint,
    ADD COLUMN recoverable_gst_hst_minor bigint,
    ADD COLUMN recoverable_qst_minor     bigint,
    ADD COLUMN tax_source                text NOT NULL DEFAULT 'CALCULATED',
    ADD COLUMN tax_jurisdiction_id       uuid,
    ADD CONSTRAINT expense_payment_method CHECK (payment_method IN ('OUT_OF_POCKET', 'VIRTUAL_CARD', 'PHYSICAL_CARD')),
    ADD CONSTRAINT expense_fx_rate_source CHECK (fx_rate_source IN ('MANUAL', 'EXTRACTED', 'CALCULATED')),
    ADD CONSTRAINT expense_tax_source CHECK (tax_source IN ('MANUAL', 'EXTRACTED', 'CALCULATED')),
    ADD CONSTRAINT expense_fx_rate_positive CHECK (fx_rate IS NULL OR fx_rate > 0),
    -- ExpenseOS: onDelete Restrict on the owner, SetNull on the jurisdiction.
    ADD CONSTRAINT expense_owner_fkey
        FOREIGN KEY (organization_id, owner_id) REFERENCES app_user (organization_id, id),
    ADD CONSTRAINT expense_tax_jurisdiction_fkey
        FOREIGN KEY (tax_jurisdiction_id) REFERENCES tax_jurisdiction (id) ON DELETE SET NULL;
CREATE INDEX expense_owner_idx ON expense (owner_id);
CREATE INDEX expense_tax_jurisdiction_idx ON expense (tax_jurisdiction_id) WHERE tax_jurisdiction_id IS NOT NULL;

-- ExpenseOS writes `ownerId` (the report's submitter) on every create. VeloExpense's
-- own writer and its test fixtures predate the column, so a row inserted without one
-- takes the report's submitter. A row that names an owner keeps it.
CREATE FUNCTION expense_owner_from_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    SELECT r.submitter_id INTO NEW.owner_id
      FROM expense_report r
     WHERE r.organization_id = NEW.organization_id AND r.id = NEW.report_id;
    -- No such report in this tenant: exactly the condition expense_report_id_fkey
    -- refuses, so refuse it as that — otherwise the NOT NULL on owner_id, checked
    -- before foreign keys, would report it as a missing owner.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insert or update on table "expense" violates foreign key constraint "expense_report_id_fkey"'
        USING ERRCODE = 'foreign_key_violation',
              DETAIL = format('Key (organization_id, report_id)=(%s, %s) is not present in table "expense_report".',
                              NEW.organization_id, NEW.report_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_owner_default
    BEFORE INSERT ON expense
    FOR EACH ROW EXECUTE FUNCTION expense_owner_from_report();

-- ── expense_line_item ───────────────────────────────────────────────────────
-- ExpenseOS's ExpenseLineItem columns. VeloExpense differences: ExpenseOS's `notes`
-- is the existing `description`; VeloExpense's per-line `tax_minor` stays for its
-- ledger reader (ExpenseOS keeps tax on the expense); `kind` and `mileage_unit` are
-- text with a CHECK.
ALTER TABLE expense_line_item
    ADD COLUMN kind                      text NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN payload                   jsonb,
    ADD COLUMN mileage_distance          numeric(12,2),
    ADD COLUMN mileage_unit              text,
    ADD COLUMN mileage_ytd_before        numeric(12,2),
    ADD COLUMN mileage_breakdown         jsonb,
    ADD COLUMN mileage_route             jsonb,
    ADD COLUMN mileage_distance_override numeric(12,2),
    ADD CONSTRAINT expense_line_item_kind CHECK (kind IN ('STANDARD', 'STANDARD_WITH_TIP', 'MILEAGE')),
    ADD CONSTRAINT expense_line_item_mileage_unit CHECK (mileage_unit IN ('KM', 'MI'));

-- ── receipt ─────────────────────────────────────────────────────────────────
-- ExpenseOS's ReceiptKind. VeloExpense's upload `status` stays.
ALTER TABLE receipt
    ADD COLUMN kind text NOT NULL DEFAULT 'OTHER',
    ADD CONSTRAINT receipt_kind CHECK (kind IN ('RECEIPT', 'ITEMIZED_BILL', 'CARD_COPY', 'BANK_STATEMENT', 'OTHER'));

-- ── expense_report ──────────────────────────────────────────────────────────
-- AP's FX override (ExpenseOS's A4): one rate per report, converting
-- `fx_rate_override_currency` to the report currency.
ALTER TABLE expense_report
    ADD COLUMN fx_rate_override          numeric(18,8),
    ADD COLUMN fx_rate_override_currency text REFERENCES currency(code),
    ADD COLUMN fx_rate_override_at       timestamptz,
    ADD COLUMN fx_rate_override_by_id    uuid,
    ADD CONSTRAINT expense_report_fx_override_positive CHECK (fx_rate_override IS NULL OR fx_rate_override > 0),
    -- VeloExpense: a rate with no currency (or the reverse) converts nothing.
    ADD CONSTRAINT expense_report_fx_override_complete
        CHECK ((fx_rate_override IS NULL) = (fx_rate_override_currency IS NULL)),
    ADD CONSTRAINT expense_report_fx_override_by_fkey
        FOREIGN KEY (organization_id, fx_rate_override_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (fx_rate_override_by_id);

-- ── expense_allocation ──────────────────────────────────────────────────────
-- ExpenseOS's ExpenseAllocation: splits an expense across coding combinations in
-- basis points (an expense's rows sum to 10000; none = unallocated). VeloExpense
-- differences: per tenant; no NetSuite class or NetSuite business unit (VeloExpense
-- codes to its own business units and departments); a row's share is held to 1–10000
-- by the table, the sum by the router (it spans rows).
CREATE TABLE expense_allocation (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    expense_id       uuid NOT NULL,
    percent_bp       integer NOT NULL,
    business_unit_id uuid,
    department_id    uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT expense_allocation_percent_bp CHECK (percent_bp BETWEEN 1 AND 10000),
    UNIQUE (organization_id, id),
    CONSTRAINT expense_allocation_expense_fkey
      FOREIGN KEY (organization_id, expense_id)
      REFERENCES expense (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT expense_allocation_business_unit_fkey
      FOREIGN KEY (organization_id, business_unit_id)
      REFERENCES business_unit (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT expense_allocation_department_fkey
      FOREIGN KEY (organization_id, department_id)
      REFERENCES department (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX expense_allocation_expense_idx ON expense_allocation (expense_id);
CREATE INDEX expense_allocation_business_unit_idx ON expense_allocation (business_unit_id) WHERE business_unit_id IS NOT NULL;
CREATE INDEX expense_allocation_department_idx ON expense_allocation (department_id) WHERE department_id IS NOT NULL;
ALTER TABLE expense_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_allocation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_allocation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── expense_attendee ────────────────────────────────────────────────────────
-- ExpenseOS's ExpenseAttendee: who was at a meal or entertainment expense. Per tenant.
CREATE TABLE expense_attendee (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    expense_id      uuid NOT NULL,
    name            text NOT NULL,
    company         text,
    is_external     boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT expense_attendee_expense_fkey
      FOREIGN KEY (organization_id, expense_id)
      REFERENCES expense (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX expense_attendee_expense_idx ON expense_attendee (expense_id);
ALTER TABLE expense_attendee ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_attendee FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_attendee
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Backfill (per tenant, f08) ──────────────────────────────────────────────
--   1. owner_id     ← the report's submitter;
--   2. amount_minor ← the sum of the expense's line items (ExpenseOS's invariant);
--   3. a line in a mileage category is a MILEAGE line (ExpenseOS's resolveLineKind);
--   4. coding: VeloExpense codes a REPORT to a business unit and department, ExpenseOS
--      codes each EXPENSE through allocations. An expense on a report that names
--      either gets one allocation of 10000 bp carrying them, so the ported screens
--      show the coding the filer chose. The report columns stay for their readers.
-- Every statement also names the tenant: RLS confines it on RDS, but a superuser (a
-- local database) bypasses RLS and would otherwise write one tenant's rows as another's.
-- The tax and FX columns are left empty: VeloExpense's per-line `tax_minor` does not
-- say which tax it is, and a guess would be a filed figure nobody filed.
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);

    UPDATE expense e
       SET owner_id = r.submitter_id
      FROM expense_report r
     WHERE e.organization_id = org AND r.organization_id = org
       AND r.id = e.report_id AND e.owner_id IS NULL;

    UPDATE expense e
       SET amount_minor = s.total
      FROM (SELECT expense_id, SUM(amount_minor) AS total
              FROM expense_line_item WHERE organization_id = org
             GROUP BY expense_id) s
     WHERE e.organization_id = org AND s.expense_id = e.id;

    UPDATE expense_line_item li
       SET kind = 'MILEAGE'
      FROM expense_category c
     WHERE li.organization_id = org AND c.organization_id = org
       AND c.id = li.category_id AND c.is_mileage AND li.kind <> 'MILEAGE';

    INSERT INTO expense_allocation (organization_id, expense_id, percent_bp, business_unit_id, department_id)
    SELECT org, e.id, 10000, r.business_unit_id, r.department_id
      FROM expense e
      JOIN expense_report r ON r.id = e.report_id
     WHERE e.organization_id = org AND r.organization_id = org
       AND (r.business_unit_id IS NOT NULL OR r.department_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM expense_allocation a WHERE a.expense_id = e.id);
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;

-- Every expense now has its owner (the report's submitter is NOT NULL). If one had
-- been missed — a tenant the loop could not see — this fails the migration rather
-- than leaving a row ExpenseOS's code would read as ownerless.
ALTER TABLE expense ALTER COLUMN owner_id SET NOT NULL;
