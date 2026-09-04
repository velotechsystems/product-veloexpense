-- ════════════════════════════════════════════════════════════════════════════
-- VX4-8 part 3 — Module 12 slice 3: control evaluation.
--
-- A control evaluation answers "are the controls operating?", which is a
-- different question from the fraud rules' "does this transaction look wrong?".
-- Upstream states the distinction in three places and all three shape this
-- schema:
--
-- 1. **A RUN IS A SNAPSHOT, NOT A QUEUE.** Findings are written once, belong to
--    the run that produced them, and are never revised or reconciled. There is
--    no review workflow — you do not dismiss a control deficiency, you fix it
--    and the next run stops reporting it. That is the whole reason this is a
--    second pair of tables rather than more rows in `fraud_flag`, which has a
--    status, a reviewer and a dedupe key precisely because a fraud flag IS a
--    queue item.
--
-- 2. **FINDINGS CARRY LOOSE SUBJECT REFS PLUS A LABEL CAPTURED AT RUN TIME.**
--    The output is handed to an auditor as "the evaluation we ran in Q3"; it must
--    not change meaning because a report was renamed or a category deleted
--    afterwards. So `subject_id` has NO FOREIGN KEY — the only place in this
--    schema where that is the right answer, and it is worth saying why out loud
--    given that TN-1 and migration 0019 exist to make every other reference
--    composite and enforced. A run that loses rows when its subject is deleted
--    is not a snapshot.
--
-- 3. **SEVERITY IS ABOUT THE CONTROL, NOT THE MONEY.** CRITICAL means the control
--    failed in a way that would be a finding in an audit (an approval with no
--    receipt on file); WARNING means it is drifting (a report sitting
--    unactioned); INFO means configuration is incomplete but nothing is
--    mis-stated yet.
--
-- ── THE RUN ROW IS WRITTEN FIRST, AND THAT IS THE POINT ─────────────────────
--
-- `RUNNING` → `COMPLETED` or `FAILED`, with the row created before any check
-- runs. Ported with upstream's reasoning verbatim, because it is this project's
-- own standing lesson in someone else's words: "writing the row only on success
-- would make a run that died halfway simply not exist, and 'no findings' and
-- 'never ran' would look identical — the exact failure mode this module exists
-- to catch elsewhere."
--
-- ── NO STORED ENGLISH SENTENCE, FOR THE THIRD TIME ──────────────────────────
--
-- `ControlFinding.detail` upstream is a rendered sentence ("Category \"travel\"
-- was used on 14 line item(s) but has no GL account mapped."). Same treatment as
-- `policy_violation.message` (removed by 0029) and `FraudFlag.reason` (never
-- built, 0031): `message_code` + `data`, rendered per reader by
-- `lib/i18n/catalog/control-messages.ts`.
--
-- There is one extra reason here. A control evaluation is the artefact most
-- likely to be READ BY SOMEBODY OTHER THAN ITS AUTHOR — an external auditor, a
-- francophone controller — and it is the one whose sentences quote a category
-- code and a count rather than a person's own words. Freezing them in the
-- language of whichever cron wrote them is the worst case of the three.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TYPE control_run_status AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- Deliberately NOT `fraud_severity` (LOW/MEDIUM/HIGH) and NOT `policy_severity`
-- (INFO/WARNING/BLOCK), though it shares two names with the latter. Three
-- vocabularies for three questions: whether a report may be submitted, how much
-- a reviewer should care about a transaction, and whether a control is operating.
-- A shared type would let `BLOCK` appear on a control finding that blocks
-- nothing, which is how 0031 argued the same case.
CREATE TYPE control_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE control_evaluation_run (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),

    status           control_run_status NOT NULL DEFAULT 'RUNNING',
    started_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at     timestamptz,

    -- The window the checks covered — inclusive start, EXCLUSIVE end.
    period_start     timestamptz NOT NULL,
    period_end       timestamptz NOT NULL,

    -- Who asked. NULL for a scheduled run. A loose ref with the name snapshotted
    -- beside it, for the same reason the findings are loose: the run outlives the
    -- people and the records it describes. `requested_by_name` is therefore NOT
    -- a denormalisation to be tidied away later.
    requested_by_id   uuid,
    requested_by_name text,

    -- Per-control counts plus the thresholds used, so a run is readable on its
    -- own without loading (or re-deriving) its findings — and so a control that
    -- THREW is visible as a name in `failedControls` rather than as an absent
    -- count that reads like "ran, found nothing".
    summary          jsonb,
    -- Populated when `status` is FAILED, so a failed run is not
    -- indistinguishable from a clean one.
    error            text,

    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT control_run_org_id_uniq UNIQUE (organization_id, id),
    CONSTRAINT control_run_period_chk CHECK (period_end > period_start),
    -- RUNNING has no completion; the two terminal states must have one. Same
    -- shape as `integration_post_posted_chk` and `approval_request_closed_consistent`.
    CONSTRAINT control_run_completion_chk CHECK ((status = 'RUNNING') = (completed_at IS NULL)),
    -- An error belongs to a failure and nowhere else. A COMPLETED run carrying an
    -- error message is the state that makes a screen say two things at once.
    CONSTRAINT control_run_error_chk CHECK (status = 'FAILED' OR error IS NULL)
);

CREATE INDEX control_run_org_id_idx ON control_evaluation_run (organization_id);
CREATE INDEX control_run_recent_idx
    ON control_evaluation_run (organization_id, started_at DESC);

ALTER TABLE control_evaluation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_evaluation_run FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON control_evaluation_run
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE TABLE control_finding (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id),
    run_id           uuid NOT NULL,

    -- Stable control identifier from the registry in `lib/fraud/controls.ts`
    -- (`STALE_DRAFT`, `GL_MAPPING_GAP`, …). Text, not an enum, for the third time
    -- and the same reason: the control set grows with the product and adding one
    -- must not need a migration.
    control_code     text NOT NULL,
    severity         control_severity NOT NULL DEFAULT 'WARNING',

    -- What failed, as a LOOSE reference — see note 2 in the header. No FK, on
    -- purpose. `subject_label` is the human handle at run time (a report number,
    -- a category code), so the finding still reads correctly if the subject is
    -- later renamed or removed.
    subject_type     text NOT NULL,
    subject_id       uuid,
    subject_label    text,

    -- The sentence, as a code and its numbers. See note 4 in the header.
    message_code     text  NOT NULL,
    data             jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Everything the check saw, for a reader who wants the working rather than
    -- the summary. Same split as `fraud_flag`.
    evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT control_finding_org_id_uniq UNIQUE (organization_id, id),
    CONSTRAINT control_finding_message_code_nonempty CHECK (length(btrim(message_code)) > 0),
    CONSTRAINT control_finding_subject_type_nonempty CHECK (length(btrim(subject_type)) > 0),

    -- The ONE reference here that IS composite and enforced: a finding belongs to
    -- a run, in the same tenant, and cascades with it. TN-1 applies to this one
    -- because the run is our own row rather than a subject that may legitimately
    -- disappear.
    FOREIGN KEY (organization_id, run_id)
        REFERENCES control_evaluation_run (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX control_finding_org_id_idx ON control_finding (organization_id);
-- The screen's query: this run's findings, worst first. `severity DESC` because
-- the enum's declaration order runs INFO → CRITICAL.
CREATE INDEX control_finding_run_idx
    ON control_finding (organization_id, run_id, severity DESC, control_code);

ALTER TABLE control_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_finding FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON control_finding
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON COLUMN control_finding.subject_id IS
    'Deliberately NOT a foreign key. A run is a snapshot handed to an auditor; it '
    'must not lose rows or change meaning because the report or category it '
    'describes was later renamed or deleted. subject_label is the handle as it '
    'was at run time. Every OTHER tenant reference in this schema is composite '
    'and enforced (TN-1, migration 0019) — this is the exception and the reason.';

COMMENT ON COLUMN control_evaluation_run.summary IS
    'Per-control counts, the thresholds used, and failedControls — the controls '
    'that THREW. A control absent from perControl because it failed would read as '
    '"ran, found nothing", which is the failure mode this module exists to catch.';

-- ── per-tenant control configuration ────────────────────────────────────────
--
-- Same argument as `organization.fraud_config` (0031): upstream keys these on a
-- global `systemFlag` (MT-2), so one tenant's idea of a stale draft is
-- everybody's. Pure thresholds, no referential meaning, validated field by field
-- in `resolveControlConfig` so a hand-edited blob degrades to the shipped
-- defaults instead of throwing inside a scheduled run.
ALTER TABLE organization
    ADD COLUMN control_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN organization.control_config IS
    'Partial ControlConfig overrides for this tenant; {} means the shipped '
    'defaults. Validated in lib/fraud/controls.ts#resolveControlConfig.';
