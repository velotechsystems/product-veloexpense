-- VeloExpense 0011 — notification core (VX2-7, ExpenseOS Module 11).
--
-- FOUR new tenant tables — `activity`, `notification`, `notification_preference`,
-- `notification_template` — so each takes the full treatment: organization_id +
-- org-id index + ENABLE/FORCE ROW LEVEL SECURITY + the tenant_isolation policy
-- (NULLIF form), and all four are added to test/rls-isolation.test.ts. CI's
-- RLS-coverage guard fails the build otherwise.
--
-- ── Where this shape comes from ──────────────────────────────────────────────
--
-- Ported from ExpenseOS SOURCE, read 2026-08-29:
-- `packages/notifications/src/{activity,templates,templateKeys}.ts`,
-- `apps/worker/src/{notification-dispatch,channels}.ts`, and the `Activity` /
-- `Notification` / `NotificationTemplate` / `NotificationTemplateVersion` /
-- `ReplyThread` models from `packages/db/prisma/schema.prisma`. Findings are
-- docs/porting/GAP-AUDIT.md NT-1 through NT-16, and the three decisions that
-- shaped this file are in that file's "Decisions taken (2026-08-29)" table.
-- Read those before changing anything here.
--
-- THE ONE THING TO UNDERSTAND FIRST (NT-1): ExpenseOS's notification model has
-- no tenant at all — not "gets it wrong in three places" like the audit chain,
-- but has no such column anywhere in 4,329 lines of schema, and says so:
--
--     /// Single-tenant: one installation per Module (unique). A future tenant
--     /// model adds `tenantId` here only.
--
-- That is fine for one enterprise on one database. What makes it dangerous to
-- port is `Activity.subjectId`: a bare uuid with NO foreign key, because the
-- column is polymorphic and cannot reference four different subject tables. So
-- on `activity` there is no FK to act as a second line of defence — a subject id
-- is a value a caller supplies, and RLS is the ONLY thing standing between a
-- leaked report id and another tenant's event stream. Every other tenant table
-- in this schema has a real FK as well. This one does not.
--
-- ── The three deliberate divergences ────────────────────────────────────────
--
--   1. TEMPLATE IDENTITY IS A KEY, NOT COORDINATES (NT-4). The Phase-2 board
--      says "exact -> any-subject -> shipped catalog string". That middle rung is
--      not a feature; it is an artefact of keying a template on
--      (channel, eventType, subjectType, locale), and ExpenseOS has already
--      deleted it — "That was not an identity, it was a set of coordinates".
--      One row per (template_key, channel), and the
--      (event_type, subject_type) -> key map lives in lib/notifications/catalog.ts.
--   2. A PREFERENCE CAN SUPPRESS AN IN-APP NOTIFICATION (NT-2). ExpenseOS's
--      in-app channel is unconditional and preferences gate only email/Slack —
--      while its schema comment promises an `inApp` key that no code reads.
--      VX2-7's acceptance criterion requires the suppression, so the preference
--      is consulted at FAN-OUT here, not at dispatch.
--   3. NO VERSION TABLE (NT-7). Body and subject live directly on the
--      (template_key, channel) row. The pure render-from-content split IS
--      ported, so a version table is additive later.
--
-- ── And two things NOT here on purpose ──────────────────────────────────────
--
--   * NO `emailed_at` on `notification` (NT-15). It exists in ExpenseOS solely
--     to serve the periodic email digest, and digest scheduling is on the
--     board's own deferred list. A nullable timestamp nothing ever sets is
--     indistinguishable from a bug.
--   * NO seeded template rows. A fresh tenant has ZERO. VX1-7 already settled
--     this shape: the starter policy set lives only in `DEFAULT_POLICIES` and
--     the seed deliberately writes none, "so there is no second copy to drift".
--     Shipped copy lives in code; a row exists only where a tenant overrode it.
--     It is also what makes VX2-7's acceptance criterion ("an empty template
--     table still renders shipped copy") the NORMAL path rather than an edge.

-- ── activity ────────────────────────────────────────────────────────────────
--
-- One append-only row per NOTIFIABLE event on a subject, carrying the structured
-- parameters its sentence renders from — never pre-translated text, which is
-- ExpenseOS's rule and the reason a tenant can reword copy after the fact
-- without rewriting history.
--
-- There are now THREE event streams in this schema and the boundary is worth
-- stating (GAP-AUDIT NT-16):
--
--   expense_report_event  one status TRANSITION of one report — the user-facing
--                         timeline. Not tamper-evident.
--   audit_entry           any control-relevant change to any entity, hash-chained.
--                         Answers "prove nobody edited the record".
--   activity              one notifiable event, with render params. Answers
--                         "who needs telling, and what does the sentence say".
--
-- `activity` earns its place on evidence rather than taste: TASK_ASSIGNED is not
-- a status transition of a report, so `expense_report_event` is the wrong grain
-- for one of the five events this ticket has to deliver, and hanging the fan-out
-- off it would work for the happy path and need unpicking at the first reminder.
CREATE TABLE activity (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- Polymorphic subject. 'EXPENSE_REPORT' is the only value today; travel and
    -- card subjects are what the column is for, and they are OFF for MVP.
    subject_type    text NOT NULL,
    -- NO FOREIGN KEY, and it cannot have one — see the header. This is the
    -- column that makes RLS load-bearing rather than belt-and-braces.
    subject_id      uuid NOT NULL,
    -- The event taxonomy lives in CODE, not in a CHECK constraint or an enum.
    -- ExpenseOS is explicit that this is deliberate — its sibling
    -- `ApprovalInstance.subjectType` DOES use an enum and `Activity` does not —
    -- and it is the same rule VX1-7 applied to `expense_policy.kind`: adding an
    -- event type must never need a migration. `lib/notifications/catalog.ts` is
    -- the registry, and it is validated there.
    event_type      text NOT NULL,
    -- Who triggered it. NULL = the system (a future reminder sweep). RESTRICT
    -- rather than SET NULL: "the system did this" and "a person we can no longer
    -- name did this" are different claims, and employees are soft-deleted here
    -- (deleted_at) in normal operation, so a hard delete should be refused
    -- loudly rather than silently rewrite history. Same choice as
    -- audit_entry.actor_id.
    actor_id        uuid REFERENCES app_user(id) ON DELETE RESTRICT,
    -- Structured render parameters. Scalars become `{placeholder}` values; see
    -- lib/notifications/catalog.ts for why non-scalars are dropped rather than
    -- stringified, and why the reserved names are applied last.
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- clock_timestamp(), NOT now(). now() is transaction-START time, and a
    -- decision writes its transition, its audit entry and its activity in ONE
    -- transaction — under now() a later reminder written in the same transaction
    -- would share a timestamp with the decision that caused it. Same reasoning
    -- as audit_entry.occurred_at.
    occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT activity_subject_type_present CHECK (btrim(subject_type) <> ''),
    CONSTRAINT activity_event_type_present   CHECK (btrim(event_type) <> ''),
    -- A payload that is not an object cannot be read for placeholders; `'[]'` or
    -- `'"x"'` are both legal jsonb and both useless here.
    CONSTRAINT activity_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX activity_org_id_idx ON activity (organization_id);
-- "The stream for this subject, newest first" — the report timeline read, and
-- ExpenseOS's own index with the tenant column prefixed onto it.
CREATE INDEX activity_subject_idx
    ON activity (organization_id, subject_type, subject_id, occurred_at DESC);

ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activity
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── notification ────────────────────────────────────────────────────────────
--
-- Per-recipient delivery of one activity: the in-app inbox row plus its read
-- state. In-app is the always-on core channel — email and Slack arrive in VX2-8
-- and are delivered from these same rows.
CREATE TABLE notification (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    activity_id     uuid NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
    -- CASCADE, unlike actor_id above: an inbox row has no evidentiary value once
    -- its owner is gone, and it is addressed TO somebody rather than being a
    -- record OF what they did.
    recipient_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- ExpenseOS's comment says "One row per (activity, recipient)" and nothing
    -- enforces it: their de-dupe is `[...new Set(recipientIds)]` in application
    -- code, so two concurrent fan-outs of one activity would put two identical
    -- rows in one bell. The application de-dupe is ported too — this makes it
    -- structural as well.
    CONSTRAINT notification_one_per_recipient UNIQUE (activity_id, recipient_id)
);
CREATE INDEX notification_org_id_idx ON notification (organization_id);
-- The inbox read: everything addressed to me, newest first.
CREATE INDEX notification_inbox_idx
    ON notification (organization_id, recipient_id, created_at DESC);
-- The unread badge, which is asked for on every page render and answered by a
-- COUNT. Partial, because a read notification can never satisfy it and the
-- unread set is the small one.
CREATE INDEX notification_unread_idx
    ON notification (organization_id, recipient_id)
    WHERE read_at IS NULL;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── notification_preference ─────────────────────────────────────────────────
--
-- One row per (user, event_type, channel) the user has OVERRIDDEN. Absent = the
-- code default.
--
-- That "absent = default" property is the load-bearing one and it is ported
-- deliberately (NT-3). ExpenseOS keeps the map as a jsonb blob on the user and
-- reads it as `prefs[type]?.email ?? def.email`, so adding an event type needs
-- no backfill and no migration, and a tenant's stored preferences are never
-- rewritten when the taxonomy grows. A table that held every type x channel
-- explicitly would need a data migration per new event.
--
-- Rows rather than a jsonb column on `app_user`, which is where ExpenseOS puts
-- it: same reasoning as AP-14's flag. A blob cannot be constrained, cannot be
-- grepped, and cannot answer "who has turned approval notifications off" across
-- users. The cost is a table; the property that mattered survives either way.
CREATE TABLE notification_preference (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    event_type      text NOT NULL,
    channel         text NOT NULL,
    enabled         boolean NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- NOTE THE ASYMMETRY, it is deliberate: `channel` is constrained and
    -- `event_type` is not. The channel set is CLOSED — adding one means building
    -- a delivery integration, which is a feature with a migration in it anyway —
    -- whereas the event taxonomy has to grow without one. Exactly the split
    -- VX1-7 made between `expense_policy.severity` (constrained) and
    -- `expense_policy.kind` (not).
    CONSTRAINT notification_preference_channel_check
        CHECK (channel IN ('IN_APP', 'EMAIL', 'SLACK')),
    CONSTRAINT notification_preference_event_type_present CHECK (btrim(event_type) <> ''),
    CONSTRAINT notification_preference_unique UNIQUE (user_id, event_type, channel)
);
CREATE INDEX notification_preference_org_id_idx ON notification_preference (organization_id);
-- The fan-out's question, asked once per recipient per event: "has this person
-- overridden this event on this channel". Covered by the UNIQUE above for the
-- point read; this one serves "load all of one user's overrides" for the screen.
CREATE INDEX notification_preference_user_idx
    ON notification_preference (organization_id, user_id);

ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preference
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ── notification_template ───────────────────────────────────────────────────
--
-- A tenant's OVERRIDE of one shipped message. One row per
-- (organization, template_key, channel).
--
-- Per-tenant is a divergence with a consequence worth naming: in ExpenseOS the
-- key is a global identity and the unique is `(key, channel)`, because there is
-- one tenant. Here two tenants legitimately hold different copy under the same
-- key, so the unique carries organization_id and the key stays a shared
-- vocabulary rather than a row identity.
CREATE TABLE notification_template (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id),
    -- `<owner>.<name>`, both snake_case. The regex below is the SHAPE half of
    -- ExpenseOS's `isTemplateKey()`; the OWNER half — membership of a closed
    -- list of modules — stays in lib/notifications/catalog.ts on purpose,
    -- because adding a module must not need a migration. So the database
    -- refuses a malformed key and the application refuses an unowned one.
    template_key    text NOT NULL,
    channel         text NOT NULL,
    -- Locale-keyed: { "en": "..." }. VeloExpense is EN-only today and French is
    -- on the board's deferred list, so every row will carry exactly one key and
    -- this looks like ceremony. It is bought deliberately: a text column would
    -- need a DATA migration on rows tenants have already edited, and the whole
    -- of NT-4's postmortem is about what happens when locale is handled
    -- structurally rather than as content.
    --
    -- `subject` is EMAIL-only and NULL elsewhere; the bell and a Slack message
    -- have no subject line.
    subject         jsonb,
    body            jsonb NOT NULL,
    updated_by_id   uuid REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_template_key_shape
        CHECK (template_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
    CONSTRAINT notification_template_channel_check
        CHECK (channel IN ('IN_APP', 'EMAIL', 'SLACK')),
    CONSTRAINT notification_template_body_object
        CHECK (jsonb_typeof(body) = 'object'),
    CONSTRAINT notification_template_subject_object
        CHECK (subject IS NULL OR jsonb_typeof(subject) = 'object'),
    CONSTRAINT notification_template_subject_email_only
        CHECK (subject IS NULL OR channel = 'EMAIL'),
    CONSTRAINT notification_template_unique
        UNIQUE (organization_id, template_key, channel)
);
CREATE INDEX notification_template_org_id_idx ON notification_template (organization_id);

ALTER TABLE notification_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_template FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_template
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
