-- VeloExpense 0078_assistant — Wave 6, Assistant 1 of 3 (w6-03, d88).
--
-- ExpenseOS's assistant persistence (1e682dd6), as its schema stands after
-- 20260818210000_assistant_persistence and 20260819210000_assistant_feedback_user_fk
-- (20260902130000_merge_duplicate_user_rows only re-points rows during a one-off merge, and
-- creates nothing):
--   · assistant_conversation — one chat thread, owned by the person who started it; a
--     model-generated title after the first exchange;
--   · assistant_message — one turn, its content block array stored exactly as sent to or
--     received from the Messages API (thinking blocks must be replayed unchanged);
--   · assistant_feedback — a rating on one assistant turn, or a flag the assistant raised about
--     itself, and the review state that keeps an unreviewed answer from becoming canon.
--
-- VeloExpense adaptations (the plumbing, not the meaning), as 0077 does them:
--   · every table is per tenant: `organization_id` from the transaction's tenant, FORCE RLS,
--     and composite tenant keys (TN-1) for every reference between tenant rows, the person
--     included. A conversation is somebody's words about their company's money; one tenant
--     reading another's would be the worst leak this product could have;
--   · ExpenseOS's text columns with documented value sets (`role`, `flag`, `status`) get
--     CHECKs here, as VeloExpense's Wave 2+ tables keep them, and `rating` its 1–5 range;
--   · `reviewed_by` names a person, so it is a composite key too (ExpenseOS: a bare uuid).
--
-- Nothing reads these tables until Assistant 2 of 3 (the server).

-- ── assistant_conversation ───────────────────────────────────────────────────
CREATE TABLE assistant_conversation (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    user_id         uuid NOT NULL,
    -- Model-generated after the first exchange; null until then.
    title           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    UNIQUE (organization_id, id),
    -- CASCADE, as ExpenseOS's: a person's conversations go with them.
    CONSTRAINT assistant_conversation_user_id_fkey
        FOREIGN KEY (organization_id, user_id)
        REFERENCES app_user (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX assistant_conversation_user_updated_idx
    ON assistant_conversation (user_id, updated_at);

-- ── assistant_message ────────────────────────────────────────────────────────
CREATE TABLE assistant_message (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    conversation_id uuid NOT NULL,
    -- 'user' | 'assistant', mirroring the Messages API role.
    role            text NOT NULL,
    -- The content block array exactly as sent to / received from the API.
    content         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT assistant_message_role CHECK (role IN ('user', 'assistant')),
    CONSTRAINT assistant_message_conversation_id_fkey
        FOREIGN KEY (organization_id, conversation_id)
        REFERENCES assistant_conversation (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX assistant_message_conversation_created_idx
    ON assistant_message (conversation_id, created_at);

-- ── assistant_feedback ───────────────────────────────────────────────────────
CREATE TABLE assistant_feedback (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    conversation_id uuid NOT NULL,
    -- The assistant turn being rated.
    message_id      uuid NOT NULL,
    -- Denormalised from the conversation so the review queue can filter by person; still a
    -- real foreign key (ExpenseOS's 20260819210000).
    user_id         uuid NOT NULL,
    -- 1–5. Nullable so a turn can be flagged without being scored.
    rating          integer,
    comment         text,
    -- Set by the ASSISTANT, not the user: OFF_TOPIC | NO_ANSWER_FOUND | UNSUPPORTED_CLAIM | null
    -- (`TurnFlag` in @expenseos/assistant's review.ts; the schema comment names two of the three).
    flag            text,
    -- PENDING | REVIEWED | PROMOTED | DISMISSED. Promotion into the knowledge base is a human
    -- act with a diff, never an automatic one.
    status          text NOT NULL DEFAULT 'PENDING',
    created_at      timestamptz NOT NULL DEFAULT now(),
    reviewed_at     timestamptz,
    reviewed_by     uuid,
    UNIQUE (organization_id, id),
    CONSTRAINT assistant_feedback_rating CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    CONSTRAINT assistant_feedback_flag CHECK (flag IS NULL OR flag IN ('OFF_TOPIC', 'NO_ANSWER_FOUND', 'UNSUPPORTED_CLAIM')),
    CONSTRAINT assistant_feedback_status
        CHECK (status IN ('PENDING', 'REVIEWED', 'PROMOTED', 'DISMISSED')),
    CONSTRAINT assistant_feedback_conversation_id_fkey
        FOREIGN KEY (organization_id, conversation_id)
        REFERENCES assistant_conversation (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT assistant_feedback_message_id_fkey
        FOREIGN KEY (organization_id, message_id)
        REFERENCES assistant_message (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT assistant_feedback_user_id_fkey
        FOREIGN KEY (organization_id, user_id)
        REFERENCES app_user (organization_id, id) ON DELETE CASCADE,
    -- VeloExpense: ExpenseOS's `reviewedBy` is a bare uuid; a reviewer is a person of the tenant.
    CONSTRAINT assistant_feedback_reviewed_by_fkey
        FOREIGN KEY (organization_id, reviewed_by)
        REFERENCES app_user (organization_id, id) ON DELETE SET NULL (reviewed_by)
);
CREATE INDEX assistant_feedback_status_created_idx ON assistant_feedback (organization_id, status, created_at);
CREATE INDEX assistant_feedback_rating_idx ON assistant_feedback (rating);
CREATE INDEX assistant_feedback_user_created_idx ON assistant_feedback (user_id, created_at);
CREATE INDEX assistant_feedback_conversation_idx ON assistant_feedback (conversation_id);
CREATE INDEX assistant_feedback_message_idx ON assistant_feedback (message_id);

-- ── RLS on the three ─────────────────────────────────────────────────────────
ALTER TABLE assistant_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_conversation
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE assistant_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_message FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_message
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE assistant_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_feedback FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_feedback
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
