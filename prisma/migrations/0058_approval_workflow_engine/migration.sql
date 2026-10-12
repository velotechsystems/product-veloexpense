-- VeloExpense 0058_approval_workflow_engine — Wave 4 (w4-00a, d50).
--
-- ExpenseOS's approval-workflow tables (its `approval_engine`, `approval_effective_graph`
-- and `approval_ttl_escalation` migrations, 550b2945): a workflow, its versions (a graph of
-- nodes and the condition that selects it), and the runs of a published version over one
-- subject, each holding its tasks. ExpenseOS's interpreter (`packages/approvals/engine.ts`)
-- arrives in w4-00b; nothing reads or writes these tables until then, and VeloExpense's
-- approval ladder (0008/0009) keeps running every approval until the cutover (w4-00c).
--
-- Adapted (VeloExpense):
--   · per tenant, under RLS like every tenant table, with composite foreign keys (TN-1).
--     A workflow's `key` is unique within its tenant, not across the database.
--   · ExpenseOS's enums are text under a CHECK, as the Wave 2 tables keep them. Subjects
--     are EXPENSE_REPORT and, for later, TRAVEL_REQUEST; the two virtual-card subjects are
--     out of scope (7 Oct 2026).
--   · the task table is `approval_instance_task`: `approval_task` is the ladder's until it is
--     retired after the cutover (w4-00d).
--   · `current_version_id` is a plain pointer with no foreign key, as ExpenseOS has it (a
--     key would make workflow and version reference each other).
--   · who created, published or decided is a bare id, as in ExpenseOS; an assignee or
--     decider carries the tenant key to app_user and is set null when the person goes.
--
-- New tables, no rows: safe to deploy in a batch (d16).

CREATE TABLE approval_workflow (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    uuid NOT NULL REFERENCES organization(id)
                       DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    key                text NOT NULL,
    name               text NOT NULL,
    description        text,
    subject_type       text NOT NULL,
    callable           boolean NOT NULL DEFAULT false,
    is_default         boolean NOT NULL DEFAULT false,
    priority           integer NOT NULL DEFAULT 0,
    active             boolean NOT NULL DEFAULT true,
    current_version_id uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid,
    updated_by         uuid,
    UNIQUE (organization_id, id),
    CONSTRAINT approval_workflow_key UNIQUE (organization_id, key),
    CONSTRAINT approval_workflow_subject_type
      CHECK (subject_type IN ('EXPENSE_REPORT', 'TRAVEL_REQUEST'))
);
CREATE INDEX approval_workflow_subject_active_idx
    ON approval_workflow (organization_id, subject_type, active);

CREATE TABLE approval_workflow_version (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization(id)
                    DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    workflow_id     uuid NOT NULL,
    version         integer NOT NULL,
    match_condition jsonb NOT NULL,
    graph           jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'DRAFT',
    published_at    timestamptz,
    published_by    uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT approval_workflow_version_number UNIQUE (organization_id, workflow_id, version),
    CONSTRAINT approval_workflow_version_status
      CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    CONSTRAINT approval_workflow_version_workflow_fkey
      FOREIGN KEY (organization_id, workflow_id)
      REFERENCES approval_workflow (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX approval_workflow_version_status_idx
    ON approval_workflow_version (organization_id, workflow_id, status);

CREATE TABLE approval_instance (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organization(id)
                        DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    workflow_version_id uuid NOT NULL,
    subject_type        text NOT NULL,
    subject_id          uuid NOT NULL,
    status              text NOT NULL DEFAULT 'RUNNING',
    cursor              jsonb NOT NULL,
    effective_graph     jsonb,
    parent_instance_id  uuid,
    call_depth          integer NOT NULL DEFAULT 0,
    started_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    UNIQUE (organization_id, id),
    CONSTRAINT approval_instance_subject_type
      CHECK (subject_type IN ('EXPENSE_REPORT', 'TRAVEL_REQUEST')),
    CONSTRAINT approval_instance_status
      CHECK (status IN ('RUNNING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT approval_instance_version_fkey
      FOREIGN KEY (organization_id, workflow_version_id)
      REFERENCES approval_workflow_version (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT approval_instance_parent_fkey
      FOREIGN KEY (organization_id, parent_instance_id)
      REFERENCES approval_instance (organization_id, id) ON DELETE SET NULL (parent_instance_id)
);
CREATE INDEX approval_instance_subject_idx
    ON approval_instance (organization_id, subject_type, subject_id);
CREATE INDEX approval_instance_status_idx ON approval_instance (organization_id, status);

CREATE TABLE approval_instance_task (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL REFERENCES organization(id)
                         DEFAULT NULLIF(current_setting('app.current_org', true), '')::uuid,
    instance_id          uuid NOT NULL,
    node_id              text NOT NULL,
    assignee_user_id     uuid,
    label                text,
    status               text NOT NULL DEFAULT 'PENDING',
    decided_by_id        uuid,
    decided_at           timestamptz,
    note                 text,
    expires_at           timestamptz,
    escalation_level     integer NOT NULL DEFAULT 0,
    deadline_reminder_at timestamptz,
    parallel_group       text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT approval_instance_task_status
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'EXPIRED')),
    CONSTRAINT approval_instance_task_instance_fkey
      FOREIGN KEY (organization_id, instance_id)
      REFERENCES approval_instance (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT approval_instance_task_assignee_fkey
      FOREIGN KEY (organization_id, assignee_user_id)
      REFERENCES app_user (organization_id, id) ON DELETE SET NULL (assignee_user_id),
    CONSTRAINT approval_instance_task_decided_by_fkey
      FOREIGN KEY (organization_id, decided_by_id)
      REFERENCES app_user (organization_id, id) ON DELETE SET NULL (decided_by_id)
);
CREATE INDEX approval_instance_task_assignee_idx
    ON approval_instance_task (organization_id, assignee_user_id, status);
CREATE INDEX approval_instance_task_instance_idx ON approval_instance_task (organization_id, instance_id);
CREATE INDEX approval_instance_task_expiry_idx ON approval_instance_task (organization_id, status, expires_at);

ALTER TABLE approval_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_workflow FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_workflow
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE approval_workflow_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_workflow_version FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_workflow_version
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE approval_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_instance FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_instance
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE approval_instance_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_instance_task FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_instance_task
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
