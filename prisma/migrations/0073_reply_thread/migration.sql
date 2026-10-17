-- w5-01 — reply threads: ExpenseOS's `ReplyThread` (1e682dd6 schema.prisma), so a reply to a
-- notification email becomes a COMMENT on its subject.
--
-- One row per recipient × subject. An email carries a `reply+<token>@` Reply-To whose token is
-- an HMAC over this row's id (lib/notifications/replyThreads.ts); only its sha256 is stored.
-- The Slack columns are ExpenseOS's too, for the per-subject DM thread root; nothing writes
-- them until Slack (w5-02).
--
-- ExpenseOS's ids are loose (no FK) — "the inbound path re-validates the subject +
-- recipient". Kept loose: the subject is polymorphic, as `activity.subject_id` is (NT-1), and
-- the inbound path checks the recipient is still on the thread before posting anything.
--
-- VeloExpense: per tenant, with RLS, like every tenant table; the unique key and the token
-- lookup are ExpenseOS's.
CREATE TABLE reply_thread (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organization(id)
                     DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    subject_type     text NOT NULL,
    subject_id       uuid NOT NULL,
    recipient_id     uuid NOT NULL,
    -- sha256 of the raw email reply token (null until an email is sent)
    token_hash       text UNIQUE,
    slack_channel_id text,
    slack_thread_ts  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reply_thread_subject_type_present CHECK (btrim(subject_type) <> ''),
    UNIQUE (recipient_id, subject_type, subject_id)
);
CREATE INDEX reply_thread_org_id_idx ON reply_thread (organization_id);
CREATE INDEX reply_thread_slack_idx ON reply_thread (slack_channel_id, slack_thread_ts);

ALTER TABLE reply_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_thread FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reply_thread
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
