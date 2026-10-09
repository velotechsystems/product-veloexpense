-- Wave 1: ExpenseOS's job levels and fiscal years, ported (w1-04, w1-05). Both
-- are NEW tables — VeloExpense had neither — shaped as ExpenseOS's `JobLevel`
-- and `FiscalYear` so its `appSettings` router and screens run unchanged
-- (prisma/schema.prisma maps the names). Each gets External IDs on the
-- tenant's own sources (0047), as the other admin lookups do.
--
-- Nothing here rewrites an existing row: the only change to an existing table
-- is a new nullable column on `app_user`.

-- ── Job levels: the approval-tier ladder ─────────────────────────────────────
-- VeloExpense: the track is text with a CHECK listing ExpenseOS's
-- `JobLevelTrack` enum values (house rule: no Postgres enums, as for
-- `app_user.employee_status`); the code is unique per tenant, not globally.
CREATE TABLE job_level (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    code            text NOT NULL,
    track           text NOT NULL,
    label           jsonb NOT NULL,
    sort_order      integer NOT NULL,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_level_code_format CHECK (code ~ '^[A-Za-z0-9_-]{1,40}$'),
    CONSTRAINT job_level_track CHECK (track IN ('INDIVIDUAL_CONTRIBUTOR', 'MANAGER', 'EXECUTIVE', 'BOARD')),
    CONSTRAINT job_level_label_en CHECK (
      COALESCE(
        jsonb_typeof(label) = 'object'
        AND jsonb_typeof(label -> 'en') = 'string'
        AND length(btrim(label ->> 'en')) > 0,
        false
      )
    ),
    UNIQUE (organization_id, code),
    UNIQUE (organization_id, id)
);
CREATE INDEX job_level_ladder_idx ON job_level (organization_id, active, sort_order);
ALTER TABLE job_level ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_level FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_level
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ExpenseOS's `User.jobLevelId`. Nothing assigns it yet (the people screens
-- arrive with their own port); it is here so the router's "who is on this
-- level" check before a delete reads a real column. ON DELETE SET NULL is
-- ExpenseOS's, narrowed to the one column so the tenant stays set.
ALTER TABLE app_user ADD COLUMN job_level_id uuid;
ALTER TABLE app_user ADD CONSTRAINT app_user_job_level_id_fkey
    FOREIGN KEY (organization_id, job_level_id)
    REFERENCES job_level (organization_id, id) ON DELETE SET NULL (job_level_id);
CREATE INDEX app_user_job_level_id_idx ON app_user (job_level_id);

CREATE TABLE job_level_external_id (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id        uuid NOT NULL,
    source_value     text NOT NULL,
    job_level_id     uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_level_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    CONSTRAINT job_level_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT job_level_external_id_job_level_fkey
      FOREIGN KEY (organization_id, job_level_id)
      REFERENCES job_level (organization_id, id) ON DELETE CASCADE,
    UNIQUE (source_id, source_value)
);
CREATE INDEX job_level_external_id_job_level_idx ON job_level_external_id (job_level_id);
ALTER TABLE job_level_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_level_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_level_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── Fiscal years: reporting periods ─────────────────────────────────────────
-- VeloExpense: the dates are `date` (ExpenseOS stores midnight timestamps of
-- the same days), the end must follow the start (ExpenseOS's router rule, held
-- here too), and AT MOST ONE year per tenant is current — ExpenseOS keeps that
-- by flipping the others in the same transaction; the partial unique index
-- makes it a guarantee under concurrent writes as well.
--
-- (Budgets keep their own integer `fiscal_year` label, 0024; tying them to
-- these rows is the budgets port's business.)
CREATE TABLE fiscal_year (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    label           jsonb NOT NULL,
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    is_current      boolean NOT NULL DEFAULT false,
    closed          boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fiscal_year_dates CHECK (end_date > start_date),
    CONSTRAINT fiscal_year_label_en CHECK (
      COALESCE(
        jsonb_typeof(label) = 'object'
        AND jsonb_typeof(label -> 'en') = 'string'
        AND length(btrim(label ->> 'en')) > 0,
        false
      )
    ),
    UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX fiscal_year_one_current
    ON fiscal_year (organization_id) WHERE is_current;
CREATE INDEX fiscal_year_dates_idx ON fiscal_year (organization_id, start_date, end_date);
ALTER TABLE fiscal_year ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_year
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE TABLE fiscal_year_external_id (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    source_id        uuid NOT NULL,
    source_value     text NOT NULL,
    fiscal_year_id   uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fiscal_year_external_id_value_len
      CHECK (length(btrim(source_value)) BETWEEN 1 AND 200),
    CONSTRAINT fiscal_year_external_id_source_fkey
      FOREIGN KEY (organization_id, source_id)
      REFERENCES external_id_source (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT fiscal_year_external_id_fiscal_year_fkey
      FOREIGN KEY (organization_id, fiscal_year_id)
      REFERENCES fiscal_year (organization_id, id) ON DELETE CASCADE,
    UNIQUE (source_id, source_value)
);
CREATE INDEX fiscal_year_external_id_fiscal_year_idx ON fiscal_year_external_id (fiscal_year_id);
ALTER TABLE fiscal_year_external_id ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_external_id FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_year_external_id
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
