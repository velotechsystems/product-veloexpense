-- VeloExpense 0077_travel — Wave 6, Travel 1 of 3 (w6-00, d88).
--
-- ExpenseOS's travel module (1e682dd6), as its schema stands after every travel migration:
-- 20260807110000_travel_module, 20260826100000_travel_category,
-- 20260826170000_drop_travel_quote, 20260826200000_travel_policy_violations and
-- 20260901040000_travel_line_notes_and_override. The quote table those created and then
-- dropped is not created here at all.
--
-- What is ExpenseOS's, unchanged in meaning:
--   · travel_request — a pre-trip request with a budget an approver can judge, decided by
--     the approval engine as subject type TRAVEL_REQUEST (already allowed by 0058);
--   · travel_category — travel's OWN short taxonomy, with the `line_kind` that decides which
--     editor block a budget line opens, mapped optionally to an expense category;
--   · travel_budget_line — one row per line of the estimate, its kind's fields in `payload`;
--   · travel_place — a Google place resolved to the metro and airports SerpApi prices;
--   · expense_report.travel_request_id — the report a trip became;
--   · policy_violation's travel subject — a violation is about a report OR a travel request,
--     never both (`policy_violation_one_subject`).
--
-- VeloExpense adaptations (the plumbing, not the meaning):
--   · every table is per tenant: `organization_id` from the transaction's tenant, FORCE RLS,
--     and composite tenant keys (TN-1) for every reference between tenant rows;
--   · ExpenseOS's Postgres enums are text under CHECKs, as VeloExpense's Wave 2+ tables keep
--     them; the currency is its ISO code (`currency_code`), as everywhere in VeloExpense;
--   · `travel_place` is per tenant. ExpenseOS's is one org-wide cache; here one tenant's
--     admin pinning an airport must not re-route another tenant's travellers, and a cache
--     keyed across tenants would tell one tenant where another's people travel;
--   · the number (`TRV-000001`) is per tenant, from `organization.travel_request_seq`, set by
--     a trigger — ExpenseOS's column default reads one global sequence, and a trigger keeps
--     the ported `create` calls unchanged (they never send a number);
--   · travel categories and the default travel approval flow are seeded for every tenant
--     that exists today, below, and for each new tenant at provisioning
--     (lib/travel/starterCategories.ts, lib/approvals/defaultWorkflow.ts).
--
-- Nothing reads these tables until Travel 2 of 3 (the router); the `travel` module stays
-- unavailable in this build until Travel 3 of 3.

-- ── The per-tenant number ────────────────────────────────────────────────────
ALTER TABLE organization ADD COLUMN travel_request_seq bigint NOT NULL DEFAULT 0;

-- ── travel_category ──────────────────────────────────────────────────────────
CREATE TABLE travel_category (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organization(id)
                        DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Stable machine key, the role `expense_category.code` plays. Null for a category an
    -- admin created by hand.
    code                text,
    -- Locale-keyed display name, { en, fr-CA }.
    label               jsonb NOT NULL,
    icon                text,
    color               text,
    active              boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    -- Which editor block a line in this category opens (ExpenseOS's TravelLineKind).
    line_kind           text NOT NULL DEFAULT 'STANDARD',
    -- The expense category a generated report files this under, and that budget-vs-actual
    -- compares against. Optional: an unmapped travel category can be estimated, not compared.
    expense_category_id uuid,
    -- Null falls back to the MAPPED expense category's account.
    gl_account_id       uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT travel_category_code_key UNIQUE (organization_id, code),
    CONSTRAINT travel_category_line_kind
        CHECK (line_kind IN ('STANDARD', 'AIRFARE', 'LODGING', 'DEPARTMENT_MEAL', 'CAR_RENTAL', 'GROUND')),
    CONSTRAINT travel_category_label_en CHECK (length(btrim(coalesce(label->>'en', ''))) > 0),
    CONSTRAINT travel_category_expense_category_id_fkey
        FOREIGN KEY (organization_id, expense_category_id)
        REFERENCES expense_category (organization_id, id) ON DELETE SET NULL (expense_category_id),
    CONSTRAINT travel_category_gl_account_id_fkey
        FOREIGN KEY (organization_id, gl_account_id)
        REFERENCES gl_account (organization_id, id) ON DELETE SET NULL (gl_account_id)
);
CREATE INDEX travel_category_expense_category_id_idx ON travel_category (expense_category_id);
CREATE INDEX travel_category_gl_account_id_idx ON travel_category (gl_account_id);

-- ── travel_place ─────────────────────────────────────────────────────────────
CREATE TABLE travel_place (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- Google's durable handle — the exact key.
    place_id        text NOT NULL,
    label           text NOT NULL,
    -- The locality, so a new ADDRESS in a known city reuses that city's airports.
    city            text,
    country         text,
    -- SerpApi city kgmid, passed as departure_id / arrival_id.
    serp_place_id   text,
    -- The metro's airports as SerpApi listed them, e.g. {YYZ,YTZ}.
    airports        text[] NOT NULL DEFAULT ARRAY[]::text[],
    -- A null serp_place_id with a recent resolved_at is a cached "the provider had nothing".
    resolved_at     timestamptz NOT NULL DEFAULT now(),
    -- Set when an admin corrects a mapping by hand, so a refresh cannot clobber it.
    pinned_by_id    uuid,
    pinned_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT travel_place_place_id_key UNIQUE (organization_id, place_id),
    CONSTRAINT travel_place_pinned_by_id_fkey
        FOREIGN KEY (organization_id, pinned_by_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (pinned_by_id)
);
CREATE INDEX travel_place_city_country_idx ON travel_place (organization_id, city, country);
CREATE INDEX travel_place_resolved_at_idx ON travel_place (resolved_at);

-- ── travel_request ───────────────────────────────────────────────────────────
CREATE TABLE travel_request (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL REFERENCES organization(id)
                         DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    -- 'TRV-000001', per tenant: set by travel_request_assign_number below.
    number               text NOT NULL,

    submitter_id         uuid NOT NULL,
    purpose              text NOT NULL,
    notes                text,

    -- Where. The traveller picks ONE thing, a Google place; the rest is resolved from it
    -- through travel_place and snapshotted here.
    destination_place_id text,
    destination_label    text NOT NULL,
    destination_city     text,
    destination_country  text,
    destination_serp_id  text,
    destination_airports text[] NOT NULL DEFAULT ARRAY[]::text[],
    destination_airport  text,

    origin_place_id      text,
    origin_label         text,
    origin_city          text,
    origin_country       text,
    origin_serp_id       text,
    origin_airports      text[] NOT NULL DEFAULT ARRAY[]::text[],
    origin_airport       text,

    -- When.
    trip_type            text NOT NULL DEFAULT 'ROUND_TRIP',
    depart_date          timestamptz NOT NULL,
    return_date          timestamptz,
    include_car          boolean NOT NULL DEFAULT false,

    -- Lifecycle.
    status               text NOT NULL DEFAULT 'DRAFT',
    approval_instance_id uuid,
    submitted_at         timestamptz,
    approved_at          timestamptz,

    currency_code        text NOT NULL REFERENCES currency(code) ON DELETE RESTRICT,
    -- The total AS APPROVED. A later fare move must not restate what was authorised.
    approved_total_minor bigint,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT travel_request_number_key UNIQUE (organization_id, number),
    CONSTRAINT travel_request_status
        CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED')),
    CONSTRAINT travel_request_trip_type CHECK (trip_type IN ('ROUND_TRIP', 'ONE_WAY', 'MULTI_CITY')),
    CONSTRAINT travel_request_submitter_id_fkey
        FOREIGN KEY (organization_id, submitter_id)
        REFERENCES app_user (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT travel_request_approval_instance_id_fkey
        FOREIGN KEY (organization_id, approval_instance_id)
        REFERENCES approval_instance (organization_id, id) ON DELETE SET NULL (approval_instance_id)
);
CREATE INDEX travel_request_submitter_status_idx ON travel_request (submitter_id, status);
CREATE INDEX travel_request_status_idx ON travel_request (organization_id, status);
CREATE INDEX travel_request_depart_date_idx ON travel_request (depart_date);
CREATE INDEX travel_request_approval_instance_id_idx ON travel_request (approval_instance_id);

-- The number, per tenant. The organization row is locked by the UPDATE, so two requests
-- created at once in one tenant take consecutive numbers, never the same one — the rule
-- `createReport` keeps for EXP- numbers.
CREATE FUNCTION travel_request_assign_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next bigint;
BEGIN
  IF NEW.number IS NULL OR NEW.number = '' THEN
    UPDATE organization SET travel_request_seq = travel_request_seq + 1
     WHERE id = NEW.organization_id
    RETURNING travel_request_seq INTO next;
    IF next IS NULL THEN
      RAISE EXCEPTION 'travel_request: no organization % to number from', NEW.organization_id;
    END IF;
    NEW.number := 'TRV-' || lpad(next::text, 6, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER travel_request_assign_number
    BEFORE INSERT ON travel_request
    FOR EACH ROW EXECUTE FUNCTION travel_request_assign_number();

-- ── travel_budget_line ───────────────────────────────────────────────────────
CREATE TABLE travel_budget_line (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL REFERENCES organization(id)
                         DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    travel_request_id    uuid NOT NULL,
    -- Travel's own category, not the expense one.
    category_id          uuid NOT NULL,
    -- What this line IS, resolved from the category on write and never re-derived on read.
    kind                 text NOT NULL DEFAULT 'STANDARD',
    -- The kind's own fields, validated by its zod schema in @expenseos/travel-lines.
    payload              jsonb,
    -- Snapshotted from the category when the line is written.
    gl_account_id        uuid,
    amount_minor         bigint NOT NULL,
    basis                text NOT NULL,
    confidence           text,
    -- The traveller's own words (ExpenseOS renamed `detail` to this).
    notes                text,
    -- What the policy derived, when a human replaced it with their own figure.
    derived_amount_minor bigint,
    -- Itinerary order.
    sort_order           integer NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT travel_budget_line_kind
        CHECK (kind IN ('STANDARD', 'AIRFARE', 'LODGING', 'DEPARTMENT_MEAL', 'CAR_RENTAL', 'GROUND')),
    CONSTRAINT travel_budget_line_basis CHECK (basis IN ('QUOTE', 'POLICY_CAP', 'PER_DIEM', 'MANUAL')),
    CONSTRAINT travel_budget_line_confidence
        CHECK (confidence IS NULL OR confidence IN ('BELOW_TYPICAL', 'TYPICAL', 'ABOVE_TYPICAL', 'UNKNOWN')),
    CONSTRAINT travel_budget_line_travel_request_id_fkey
        FOREIGN KEY (organization_id, travel_request_id)
        REFERENCES travel_request (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT travel_budget_line_category_id_fkey
        FOREIGN KEY (organization_id, category_id)
        REFERENCES travel_category (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT travel_budget_line_gl_account_id_fkey
        FOREIGN KEY (organization_id, gl_account_id)
        REFERENCES gl_account (organization_id, id) ON DELETE SET NULL (gl_account_id)
);
CREATE INDEX travel_budget_line_travel_request_id_idx ON travel_budget_line (travel_request_id);
CREATE INDEX travel_budget_line_gl_account_id_idx ON travel_budget_line (gl_account_id);
CREATE INDEX travel_budget_line_category_id_idx ON travel_budget_line (category_id);

-- ── RLS on the four ──────────────────────────────────────────────────────────
ALTER TABLE travel_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_category FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON travel_category
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE travel_place ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_place FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON travel_place
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE travel_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_request FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON travel_request
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE travel_budget_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_budget_line FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON travel_budget_line
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── The report a trip became ─────────────────────────────────────────────────
-- SET NULL: deleting a draft travel request must not take a filed report with it.
ALTER TABLE expense_report ADD COLUMN travel_request_id uuid;
ALTER TABLE expense_report
    ADD CONSTRAINT expense_report_travel_request_id_fkey
    FOREIGN KEY (organization_id, travel_request_id)
    REFERENCES travel_request (organization_id, id) ON DELETE SET NULL (travel_request_id);
CREATE INDEX expense_report_travel_request_id_idx ON expense_report (travel_request_id);

-- ── Policy violations against a travel estimate ──────────────────────────────
ALTER TABLE policy_rule DROP CONSTRAINT policy_rule_scope;
ALTER TABLE policy_rule ADD CONSTRAINT policy_rule_scope
    CHECK (scope IN ('LINE', 'REPORT', 'AGGREGATE', 'TRAVEL_REQUEST'));

ALTER TABLE policy_violation ALTER COLUMN report_id DROP NOT NULL;
ALTER TABLE policy_violation ADD COLUMN travel_request_id uuid;
ALTER TABLE policy_violation ADD COLUMN travel_line_id uuid;
ALTER TABLE policy_violation
    ADD CONSTRAINT policy_violation_travel_request_id_fkey
    FOREIGN KEY (organization_id, travel_request_id)
    REFERENCES travel_request (organization_id, id) ON DELETE CASCADE;
ALTER TABLE policy_violation
    ADD CONSTRAINT policy_violation_travel_line_id_fkey
    FOREIGN KEY (organization_id, travel_line_id)
    REFERENCES travel_budget_line (organization_id, id) ON DELETE CASCADE;
CREATE INDEX policy_violation_travel_request_id_idx ON policy_violation (travel_request_id);
CREATE INDEX policy_violation_travel_line_id_idx ON policy_violation (travel_line_id);
-- A violation is about a report (and maybe one of its expenses or lines) OR about a travel
-- request (and maybe one of its lines). Never both, never neither.
ALTER TABLE policy_violation ADD CONSTRAINT policy_violation_one_subject CHECK (
    (report_id IS NOT NULL AND travel_request_id IS NULL AND travel_line_id IS NULL)
    OR
    (travel_request_id IS NOT NULL AND report_id IS NULL AND expense_id IS NULL AND line_item_id IS NULL)
);

-- ── Every tenant that exists today: its travel categories and travel approval flow ──
-- One SQL function, `seed_travel_defaults()`, called here for every tenant, by
-- `createOrganization` for each new tenant (lib/onboarding/provision.ts) and by the demo seed
-- (scripts/seed.mjs) — one copy of the list and the graph, not three kept in step by hand.
-- It writes for the CURRENT tenant (`app.current_org`), under RLS like any other write, and
-- is idempotent: an existing category code or workflow key is left exactly as it is.
--
-- Categories: ExpenseOS's fifteen (seed-data/travel-categories.json), each mapped to the
-- tenant's expense category by ExpenseOS's code when the tenant has it, else by VeloExpense's
-- starter code for the same thing (lib/onboarding/starter.ts), else unmapped — ExpenseOS's
-- own rule: "a code the expense side does not have resolves to null rather than throwing".
--
-- Travel approval flow: VeloExpense's default expense flow (d54/d56/d59), for travel
-- requests: the traveller's manager approves; with no manager, the Admin role; no deadline.
-- ExpenseOS's `travel-default` has a 5-business-day deadline that escalates; VeloExpense's
-- default flows have none (d56). Without a flow, ExpenseOS's submit leaves a request
-- SUBMITTED with nobody to approve it (its seed's own note on `travel-default`), and
-- VeloExpense refuses a submit nothing governs (d58) — either way travel would not work.
CREATE FUNCTION seed_travel_defaults() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tenant uuid := NULLIF(current_setting('app.current_org', true), '')::uuid;
  wf uuid;
  ver uuid;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'seed_travel_defaults: no tenant in scope (app.current_org)';
  END IF;

  INSERT INTO travel_category
      (organization_id, code, label, icon, color, active, sort_order, line_kind, expense_category_id)
  SELECT tenant, s.code, s.label, s.icon, s.color, true, s.sort_order, s.line_kind,
         COALESCE(
           (SELECT ec.id FROM expense_category ec
             WHERE ec.organization_id = tenant AND ec.code = s.eos_code),
           (SELECT ec.id FROM expense_category ec
             WHERE ec.organization_id = tenant AND ec.code = s.starter_code))
    FROM (VALUES
      ('travelAirfare',        '{"en":"Airfare","fr-CA":"Billet d''avion"}'::jsonb,                          '✈️', '#2563eb', 10,  'AIRFARE',         'travelAirfare',        'travel_air'),
      ('travelHotel',          '{"en":"Hotel / Lodging","fr-CA":"Hôtel / Hébergement"}'::jsonb,               '🏨', '#7c3aed', 20,  'LODGING',         'travelHotel',          'travel_lodging'),
      ('travelMeals',          '{"en":"Meals (per-diem)","fr-CA":"Repas (per diem)"}'::jsonb,                 '🥘', '#ea580c', 30,  'STANDARD',        'travelMeals',          'meals'),
      ('travelCarRental',      '{"en":"Car Rental","fr-CA":"Location de voiture"}'::jsonb,                    '🚗', '#0891b2', 40,  'CAR_RENTAL',      'travelCarRental',      'ground'),
      ('travelTaxi',           '{"en":"Taxi / Rideshare","fr-CA":"Taxi / Covoiturage"}'::jsonb,               '🚕', '#ca8a04', 50,  'GROUND',          'travelTaxi',           'ground'),
      ('travelOtherTransit',   '{"en":"Train / Transit","fr-CA":"Train / Transport en commun"}'::jsonb,       '🚊', '#059669', 60,  'GROUND',          'travelOtherTransit',   'ground'),
      ('travelParking',        '{"en":"Parking / Tolls","fr-CA":"Stationnement / Péages"}'::jsonb,            '🅿️', '#475569', 70,  'STANDARD',        'travelParking',        'ground'),
      ('travelGas',            '{"en":"Fuel","fr-CA":"Essence"}'::jsonb,                                    '⛽', '#dc2626', 80,  'STANDARD',        'travelGas',            'ground'),
      ('travelMileage',        '{"en":"Mileage","fr-CA":"Kilométrage"}'::jsonb,                               '📍', '#16a34a', 90,  'STANDARD',        'travelMileage',        NULL),
      ('travelOtherAir',       '{"en":"Baggage & Other Air Costs","fr-CA":"Bagages et autres frais aériens"}'::jsonb, '🛫', '#1d4ed8', 100, 'STANDARD', 'travelOtherAir',  'travel_air'),
      ('conferenceTradeShows', '{"en":"Conference & Registration","fr-CA":"Congrès et inscription"}'::jsonb,  '🎤', '#9333ea', 110, 'STANDARD',        'conferenceTradeShows', NULL),
      ('employeeMeetings',     '{"en":"Department Meal","fr-CA":"Repas de département"}'::jsonb,                  '🗣️', '#c026d3', 120, 'DEPARTMENT_MEAL', 'employeeMeetings',     'meals'),
      ('employeeMeals',        '{"en":"Team Meal","fr-CA":"Repas d''équipe"}'::jsonb,                         '🍱', '#db2777', 130, 'DEPARTMENT_MEAL', 'employeeMeals',        'meals'),
      ('clientMeals',          '{"en":"Client Meal","fr-CA":"Repas client"}'::jsonb,                          '🍽️', '#e11d48', 140, 'DEPARTMENT_MEAL', 'clientMeals',          'meals'),
      ('clientEntertainment',  '{"en":"Client Entertainment","fr-CA":"Divertissement client"}'::jsonb,        '🎁', '#f59e0b', 150, 'STANDARD',        'clientEntertainment',  'meals')
    ) AS s(code, label, icon, color, sort_order, line_kind, eos_code, starter_code)
  ON CONFLICT (organization_id, code) DO NOTHING;

  IF EXISTS (SELECT 1 FROM approval_workflow WHERE organization_id = tenant AND key = 'travel-request-default') THEN
    RETURN;
  END IF;
  INSERT INTO approval_workflow
      (organization_id, key, name, description, subject_type, is_default, priority, active)
  VALUES (tenant, 'travel-request-default', 'Default — Manager approval',
          'The traveller''s direct manager approves. With no manager on file, the fallback approver does.',
          'TRAVEL_REQUEST', true, 0, true)
  RETURNING id INTO wf;
  INSERT INTO approval_workflow_version
      (organization_id, workflow_id, version, match_condition, graph, status, published_at)
  VALUES (tenant, wf, 1, '{"always": true}'::jsonb,
          jsonb_build_object(
            'nodes', jsonb_build_array(
              jsonb_build_object('id', 'start', 'type', 'start',
                                 'position', jsonb_build_object('x', 240, 'y', 40)),
              jsonb_build_object('id', 'manager', 'type', 'approval',
                                 'approver', jsonb_build_object('kind', 'manager',
                                   'fallback', jsonb_build_object('kind', 'role',
                                     'roleId', '019e3000-0000-7000-8000-000000000001')),
                                 'position', jsonb_build_object('x', 240, 'y', 170)),
              jsonb_build_object('id', 'approved', 'type', 'approved',
                                 'position', jsonb_build_object('x', 240, 'y', 320))),
            'edges', jsonb_build_array(
              jsonb_build_object('id', 'e1', 'source', 'start', 'target', 'manager'),
              jsonb_build_object('id', 'e2', 'source', 'manager', 'target', 'approved'))),
          'PUBLISHED', now())
  RETURNING id INTO ver;
  UPDATE approval_workflow SET current_version_id = ver WHERE id = wf;
END $$;

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    PERFORM seed_travel_defaults();
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END $$;
