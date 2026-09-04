-- ════════════════════════════════════════════════════════════════════════════
-- VX4-8 part 2 — Module 12 slice 2: fraud flags.
--
-- Four retrospective detectors write findings here; a person resolves, dismisses
-- or escalates each one. NOTHING in this module changes a report's state, blocks
-- a payment or tells an employee anything. Upstream's first design constraint is
-- the one worth keeping verbatim: "automated fraud accusations are how you get a
-- wrongful-accusation problem instead of a fraud problem."
--
-- ── THREE DEPARTURES FROM `packages/fraud` AT 5a11a647 ──────────────────────
--
-- 1. NO STORED ENGLISH SENTENCE. Their `FraudFlag.reason` is commented
--    "pre-localized summary for the list" and holds a rendered sentence —
--    `Possible duplicate of expense <uuid> — same merchant (Beck Taxi)…`. That is
--    IL-11 and `policy_violation.message` exactly, which migration `0029` spent a
--    PR replacing with `message_code` + `data`. Shipping it again in a new table
--    three weeks later would be the same defect with a fresh column name. So:
--    `message_code` names a renderer in `lib/i18n/catalog/fraud-messages.ts`, and
--    `data` carries the numbers it renders from. The reader's locale decides the
--    words, at read time.
--
--    It also removes the uuid: their sentence names `expense <uuid>` to a human.
--    UD-3's crawl asserts no page shows a record id, and this is where one would
--    have come from.
--
-- 2. `finding_key` IS TENANT-SCOPED. Their `dedupeKey` is globally unique
--    (`@unique` on the column), so two organizations' findings share a namespace.
--    Every key they build embeds uuids, so nothing collides in practice — which
--    is the kind of safety that holds until somebody keys a finding on a month
--    and a rule code, as their SOD rule nearly does. `UNIQUE (organization_id,
--    finding_key)` costs nothing and cannot be got wrong later. Same column name
--    and same purpose as `policy_violation.finding_key` (0006's note).
--
-- 3. EVERY TENANT-TO-TENANT FK IS COMPOSITE. Not a choice — CI's tenant-FK guard
--    fails the build otherwise, because referential checks run as the constraint
--    owner with RLS BYPASSED, so a plain `REFERENCES expense_report(id)` accepts
--    another tenant's row (TN-1, migration 0019).
--
-- ── WHY THE ROW IS NEVER DELETED ────────────────────────────────────────────
--
-- A rule that stops firing does not remove its flag; `last_seen_at` going stale
-- is the signal that the cause went away. Deleting would erase the fact that a
-- concern was ever raised, which is the wrong instinct in a compliance module —
-- and `audit_entry` already refuses DELETE for the same reason one level up.
-- ════════════════════════════════════════════════════════════════════════════

-- LOW/MEDIUM/HIGH, and deliberately NOT `policy_severity` (INFO/WARNING/BLOCK).
-- They answer different questions: a policy severity says whether a report may be
-- submitted, and a fraud severity says how much a reviewer should care. Reusing
-- the type would let `BLOCK` appear on a flag that blocks nothing.
CREATE TYPE fraud_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- ACTIVE is the only status a scan may write or refresh. The other three are a
-- person's verdict, and `lib/fraud/scan.ts` cannot move a row out of them — see
-- the ON CONFLICT ... WHERE there, which makes that a database rule rather than a
-- read-then-write the next scan could race.
CREATE TYPE fraud_flag_status AS ENUM ('ACTIVE', 'RESOLVED', 'DISMISSED', 'ESCALATED');

CREATE TABLE fraud_flag (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),

    -- The rule that fired, or MANUAL for a flag a person raised. TEXT, not an
    -- enum, and for the same reason `expense_policy.kind` and
    -- `policy_violation.rule_code` are text: the registry lives in code and grows
    -- with the product, so adding a detector must not need a migration.
    rule_code        text NOT NULL,
    severity         fraud_severity    NOT NULL DEFAULT 'MEDIUM',
    status           fraud_flag_status NOT NULL DEFAULT 'ACTIVE',

    -- What to say, and what to say it about. See departure 1 above. No CHECK on
    -- message_code, exactly as 0029 declined one: the catalogue is the registry,
    -- `scripts/check-i18n.mjs` compares it against the code that emits these in
    -- both directions, and a CHECK here would be a third copy of the same list
    -- that only a migration could correct.
    message_code     text  NOT NULL,
    data             jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- The rule's arithmetic, for a reviewer who wants to see the working rather
    -- than trust a badge. Distinct from `data`: `data` is what the SENTENCE needs,
    -- `evidence` is everything the rule saw. Overlapping, and worth keeping apart
    -- — a sentence that needed every number would be unreadable, and evidence
    -- trimmed to what the sentence needs would stop being evidence.
    evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- What was flagged. All three nullable and at least one required: a
    -- report-scope rule sets report_id, an entry-scope rule sets both, and the
    -- segregation-of-duties rule is about a PAIR OF PEOPLE that no single report
    -- owns.
    report_id        uuid,
    expense_id       uuid,
    subject_user_id  uuid,

    -- Stable identity of this finding across nightly runs. See departure 2.
    finding_key      text NOT NULL,

    first_seen_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- The person's verdict. Set together or not at all.
    reviewed_by_id   uuid,
    reviewed_at      timestamptz,
    review_note      text,

    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- `clock_timestamp()`, not `now()`, on all four: `now()` is the TRANSACTION
    -- start time, so every flag a single scan writes would tie on it and come
    -- back in arbitrary order. The house rule since the audit tables.

    CONSTRAINT fraud_flag_org_id_uniq UNIQUE (organization_id, id),
    CONSTRAINT fraud_flag_finding_key_uniq UNIQUE (organization_id, finding_key),

    -- A flag about nothing is not a flag.
    CONSTRAINT fraud_flag_subject_chk CHECK (
        report_id IS NOT NULL OR expense_id IS NOT NULL OR subject_user_id IS NOT NULL
    ),
    -- A verdict has a person and a time, or the row has neither. ESCALATED counts
    -- as reviewed: somebody decided it needed escalating.
    CONSTRAINT fraud_flag_review_chk CHECK (
        (status = 'ACTIVE') = (reviewed_at IS NULL)
        AND (reviewed_at IS NULL) = (reviewed_by_id IS NULL)
    ),
    CONSTRAINT fraud_flag_message_code_nonempty CHECK (length(btrim(message_code)) > 0),
    CONSTRAINT fraud_flag_finding_key_nonempty  CHECK (length(btrim(finding_key)) > 0),

    -- Composite, every one. See departure 3.
    FOREIGN KEY (organization_id, report_id)
        REFERENCES expense_report (organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, expense_id)
        REFERENCES expense (organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, subject_user_id)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL
);

CREATE INDEX fraud_flag_org_id_idx ON fraud_flag (organization_id);
-- The review queue's own query: this tenant's open flags, worst first, newest
-- first within a severity. Severity is an enum so its ordering is the declaration
-- order, which is why LOW comes first in the type and DESC is what a queue wants.
CREATE INDEX fraud_flag_queue_idx
    ON fraud_flag (organization_id, status, severity DESC, last_seen_at DESC);
CREATE INDEX fraud_flag_report_idx ON fraud_flag (organization_id, report_id)
    WHERE report_id IS NOT NULL;

ALTER TABLE fraud_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_flag FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fraud_flag
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON COLUMN fraud_flag.message_code IS
    'Names a renderer in lib/i18n/catalog/fraud-messages.ts. The sentence is built '
    'at READ time in the reader''s locale, from `data`. Migration 0029 removed the '
    'stored-English column from policy_violation for this reason; this table was '
    'built without one.';
COMMENT ON COLUMN fraud_flag.status IS
    'ACTIVE is the only status a scan writes. RESOLVED/DISMISSED/ESCALATED are a '
    'person''s verdict and a later scan must not overwrite them — enforced by the '
    'ON CONFLICT ... WHERE in lib/fraud/scan.ts, not by a read-then-write.';

-- ── per-tenant rule configuration ───────────────────────────────────────────
--
-- Upstream reads its thresholds from a `systemFlag` row keyed `fraudRuleConfig` —
-- a GLOBAL singleton, which is MT-2 and precisely what VX4-8 was scheduled after
-- VX4-1/VX4-2 to fix. One tenant's noisy week must not retune everybody's scan.
--
-- A jsonb blob, and AC-21 deserves an answer rather than a shrug: the rule there
-- is that a settings blob puts values out of reach of constraints, indexes and
-- RLS predicates. These values are THRESHOLDS — pure numbers with no referential
-- meaning, never joined on, never filtered by. Nothing is lost by keeping them
-- together, and `resolveFraudConfig` validates every field and falls back to the
-- default for anything missing or nonsensical, so a hand-edited blob degrades to
-- the shipped defaults instead of throwing inside a nightly job. The line stays
-- where 0027 drew it: anything with a domain gets a column and a CHECK.
ALTER TABLE organization
    ADD COLUMN fraud_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN organization.fraud_config IS
    'Partial FraudConfig overrides for this tenant; {} means the shipped defaults. '
    'Validated field by field in lib/fraud/rules.ts#resolveFraudConfig — an '
    'unparseable value falls back rather than failing the scan.';
