-- VeloExpense 0019_composite_tenant_fks — VX3-10, closing GAP-AUDIT TN-1.
--
-- Redefines every single-column tenant-to-tenant foreign key as a COMPOSITE key
-- through `organization_id`. Mechanical, wide, and generated from the live schema
-- rather than written by hand — see the note at the bottom on how.
--
-- ── The defect ───────────────────────────────────────────────────────────────
--
-- Postgres performs referential-integrity checks as the constraint's owner WITH
-- ROW-LEVEL SECURITY BYPASSED. So `REFERENCES app_user(id)` does not scope
-- anything to a tenant:
--
--     -- as veloapp, app.current_org = tenant 1
--     INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
--     VALUES ('<tenant-1>', '<tenant-2 app_user id>', 'X', 'CAD');
--     -- ACCEPTED
--
-- Verified against this schema, on a shipped table. There is NO DISCLOSURE — a
-- read back through the reference returns nothing, because RLS still filters the
-- target row, and both inner and outer joins were checked. What it leaves is an
-- integrity hole and a missing backstop, and the shape it produces is nastier than
-- it sounds:
--
--     gl_account_id set: true, resolvable: false
--
-- A row that looks mapped and joins to nothing. Note what that does to the control
-- AC-14 describes, which counts categories where the account is NULL: this row is
-- NOT null, so a cross-tenant reference reads as CORRECTLY MAPPED to the very
-- check meant to find unmapped ones.
--
-- It also contradicts a stated house rule. HANDOFF §1 said tenancy is RLS, and
-- NT-1 leans on exactly that — `activity.subject_id` is a polymorphic uuid with no
-- foreign key at all, and that entry says "RLS is the only guard". RLS guards
-- READS. It does not guard FK TARGETS. §1 now carries the qualifier.
--
-- ── Why composite rather than a trigger ─────────────────────────────────────
--
-- A composite key makes a cross-tenant reference STRUCTURALLY impossible, with no
-- trigger to drop and no cooperation from RLS: it holds against a permissive
-- policy and against a superuser connection, which is more than RLS itself can
-- say. `0014` set the precedent for new FKs; this is the sweep.
--
-- Two details that are easy to get wrong, both learned by running them:
--
--   · ON DELETE SET NULL MUST NAME ITS COLUMN — `SET NULL (delivery_id)`. The
--     unqualified form nulls EVERY referencing column, `organization_id` included,
--     which is NOT NULL, so the delete FAILS instead of clearing the reference.
--     Postgres 15+ syntax; this project is on 16.
--   · MATCH SIMPLE is what we want, and it is the default: with a NULL in any
--     referencing column the constraint is skipped, so a nullable FK stays nullable.
--
-- ── What this migration does NOT change ─────────────────────────────────────
--
-- Every ON DELETE action is preserved exactly as it was. This is a tightening of
-- WHICH rows may be referenced, not a change to what happens when one is deleted —
-- so a cascade still cascades and a restrict still restricts. The generator read
-- each action out of `pg_constraint.confdeltype` and wrote it back.
--
-- `activity.subject_id` is deliberately untouched: it is polymorphic with no
-- foreign key, so there is nothing to make composite. NT-1 is still the only guard
-- there, and it is a read guard — which is now written down rather than assumed.

-- ADD the composite keys the foreign keys below need.
ALTER TABLE activity ADD CONSTRAINT activity_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE approval_policy ADD CONSTRAINT approval_policy_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE approval_request ADD CONSTRAINT approval_request_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE approval_task ADD CONSTRAINT approval_task_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE business_unit ADD CONSTRAINT business_unit_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE department ADD CONSTRAINT department_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE expense ADD CONSTRAINT expense_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE expense_category ADD CONSTRAINT expense_category_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE expense_line_item ADD CONSTRAINT expense_line_item_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE expense_policy ADD CONSTRAINT expense_policy_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE legal_entity ADD CONSTRAINT legal_entity_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE notification ADD CONSTRAINT notification_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_org_id_uniq UNIQUE (organization_id, id);

-- REDEFINE every single-column tenant-to-tenant foreign key as composite.
ALTER TABLE action_token DROP CONSTRAINT action_token_delivery_id_fkey;
ALTER TABLE action_token ADD CONSTRAINT action_token_delivery_id_fkey
    FOREIGN KEY (organization_id, delivery_id)
    REFERENCES notification_delivery (organization_id, id) ON DELETE SET NULL (delivery_id);
ALTER TABLE action_token DROP CONSTRAINT action_token_recipient_id_fkey;
ALTER TABLE action_token ADD CONSTRAINT action_token_recipient_id_fkey
    FOREIGN KEY (organization_id, recipient_id)
    REFERENCES app_user (organization_id, id) ON DELETE CASCADE;
ALTER TABLE action_token DROP CONSTRAINT action_token_task_id_fkey;
ALTER TABLE action_token ADD CONSTRAINT action_token_task_id_fkey
    FOREIGN KEY (organization_id, task_id)
    REFERENCES approval_task (organization_id, id) ON DELETE CASCADE;
ALTER TABLE activity DROP CONSTRAINT activity_actor_id_fkey;
ALTER TABLE activity ADD CONSTRAINT activity_actor_id_fkey
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES app_user (organization_id, id) ON DELETE RESTRICT;
ALTER TABLE app_user DROP CONSTRAINT app_user_business_unit_id_fkey;
ALTER TABLE app_user ADD CONSTRAINT app_user_business_unit_id_fkey
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_unit (organization_id, id);
ALTER TABLE app_user DROP CONSTRAINT app_user_department_id_fkey;
ALTER TABLE app_user ADD CONSTRAINT app_user_department_id_fkey
    FOREIGN KEY (organization_id, department_id)
    REFERENCES department (organization_id, id);
ALTER TABLE app_user DROP CONSTRAINT app_user_legal_entity_id_fkey;
ALTER TABLE app_user ADD CONSTRAINT app_user_legal_entity_id_fkey
    FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entity (organization_id, id);
ALTER TABLE app_user DROP CONSTRAINT app_user_manager_id_fkey;
ALTER TABLE app_user ADD CONSTRAINT app_user_manager_id_fkey
    FOREIGN KEY (organization_id, manager_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE approval_policy_approver DROP CONSTRAINT approval_policy_approver_approver_user_id_fkey;
ALTER TABLE approval_policy_approver ADD CONSTRAINT approval_policy_approver_approver_user_id_fkey
    FOREIGN KEY (organization_id, approver_user_id)
    REFERENCES app_user (organization_id, id) ON DELETE RESTRICT;
ALTER TABLE approval_policy_approver DROP CONSTRAINT approval_policy_approver_policy_id_fkey;
ALTER TABLE approval_policy_approver ADD CONSTRAINT approval_policy_approver_policy_id_fkey
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policy (organization_id, id) ON DELETE CASCADE;
ALTER TABLE approval_request DROP CONSTRAINT approval_request_opened_by_id_fkey;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_opened_by_id_fkey
    FOREIGN KEY (organization_id, opened_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE approval_request DROP CONSTRAINT approval_request_report_id_fkey;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_report_id_fkey
    FOREIGN KEY (organization_id, report_id)
    REFERENCES expense_report (organization_id, id) ON DELETE CASCADE;
ALTER TABLE approval_task DROP CONSTRAINT approval_task_assignee_id_fkey;
ALTER TABLE approval_task ADD CONSTRAINT approval_task_assignee_id_fkey
    FOREIGN KEY (organization_id, assignee_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE approval_task DROP CONSTRAINT approval_task_decided_by_id_fkey;
ALTER TABLE approval_task ADD CONSTRAINT approval_task_decided_by_id_fkey
    FOREIGN KEY (organization_id, decided_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE approval_task DROP CONSTRAINT approval_task_delegated_from_id_fkey;
ALTER TABLE approval_task ADD CONSTRAINT approval_task_delegated_from_id_fkey
    FOREIGN KEY (organization_id, delegated_from_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE approval_task DROP CONSTRAINT approval_task_request_id_fkey;
ALTER TABLE approval_task ADD CONSTRAINT approval_task_request_id_fkey
    FOREIGN KEY (organization_id, request_id)
    REFERENCES approval_request (organization_id, id) ON DELETE CASCADE;
ALTER TABLE audit_entry DROP CONSTRAINT audit_entry_actor_id_fkey;
ALTER TABLE audit_entry ADD CONSTRAINT audit_entry_actor_id_fkey
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES app_user (organization_id, id) ON DELETE RESTRICT;
ALTER TABLE delegation DROP CONSTRAINT delegation_created_by_id_fkey;
ALTER TABLE delegation ADD CONSTRAINT delegation_created_by_id_fkey
    FOREIGN KEY (organization_id, created_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE delegation DROP CONSTRAINT delegation_from_user_id_fkey;
ALTER TABLE delegation ADD CONSTRAINT delegation_from_user_id_fkey
    FOREIGN KEY (organization_id, from_user_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE delegation DROP CONSTRAINT delegation_revoked_by_id_fkey;
ALTER TABLE delegation ADD CONSTRAINT delegation_revoked_by_id_fkey
    FOREIGN KEY (organization_id, revoked_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE delegation DROP CONSTRAINT delegation_to_user_id_fkey;
ALTER TABLE delegation ADD CONSTRAINT delegation_to_user_id_fkey
    FOREIGN KEY (organization_id, to_user_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE department DROP CONSTRAINT department_parent_department_id_fkey;
ALTER TABLE department ADD CONSTRAINT department_parent_department_id_fkey
    FOREIGN KEY (organization_id, parent_department_id)
    REFERENCES department (organization_id, id);
ALTER TABLE expense DROP CONSTRAINT expense_report_id_fkey;
ALTER TABLE expense ADD CONSTRAINT expense_report_id_fkey
    FOREIGN KEY (organization_id, report_id)
    REFERENCES expense_report (organization_id, id) ON DELETE CASCADE;
ALTER TABLE expense_line_item DROP CONSTRAINT expense_line_item_category_id_fkey;
ALTER TABLE expense_line_item ADD CONSTRAINT expense_line_item_category_id_fkey
    FOREIGN KEY (organization_id, category_id)
    REFERENCES expense_category (organization_id, id);
ALTER TABLE expense_line_item DROP CONSTRAINT expense_line_item_expense_id_fkey;
ALTER TABLE expense_line_item ADD CONSTRAINT expense_line_item_expense_id_fkey
    FOREIGN KEY (organization_id, expense_id)
    REFERENCES expense (organization_id, id) ON DELETE CASCADE;
ALTER TABLE expense_policy DROP CONSTRAINT expense_policy_category_id_fkey;
ALTER TABLE expense_policy ADD CONSTRAINT expense_policy_category_id_fkey
    FOREIGN KEY (organization_id, category_id)
    REFERENCES expense_category (organization_id, id) ON DELETE CASCADE;
ALTER TABLE expense_report DROP CONSTRAINT expense_report_business_unit_id_fkey;
ALTER TABLE expense_report ADD CONSTRAINT expense_report_business_unit_id_fkey
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_unit (organization_id, id);
ALTER TABLE expense_report DROP CONSTRAINT expense_report_reimbursed_by_id_fkey;
ALTER TABLE expense_report ADD CONSTRAINT expense_report_reimbursed_by_id_fkey
    FOREIGN KEY (organization_id, reimbursed_by_id)
    REFERENCES app_user (organization_id, id) ON DELETE RESTRICT;
ALTER TABLE expense_report DROP CONSTRAINT expense_report_submitter_id_fkey;
ALTER TABLE expense_report ADD CONSTRAINT expense_report_submitter_id_fkey
    FOREIGN KEY (organization_id, submitter_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE expense_report_event DROP CONSTRAINT expense_report_event_actor_id_fkey;
ALTER TABLE expense_report_event ADD CONSTRAINT expense_report_event_actor_id_fkey
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE expense_report_event DROP CONSTRAINT expense_report_event_report_id_fkey;
ALTER TABLE expense_report_event ADD CONSTRAINT expense_report_event_report_id_fkey
    FOREIGN KEY (organization_id, report_id)
    REFERENCES expense_report (organization_id, id) ON DELETE CASCADE;
ALTER TABLE notification DROP CONSTRAINT notification_activity_id_fkey;
ALTER TABLE notification ADD CONSTRAINT notification_activity_id_fkey
    FOREIGN KEY (organization_id, activity_id)
    REFERENCES activity (organization_id, id) ON DELETE CASCADE;
ALTER TABLE notification DROP CONSTRAINT notification_recipient_id_fkey;
ALTER TABLE notification ADD CONSTRAINT notification_recipient_id_fkey
    FOREIGN KEY (organization_id, recipient_id)
    REFERENCES app_user (organization_id, id) ON DELETE CASCADE;
ALTER TABLE notification_delivery DROP CONSTRAINT notification_delivery_notification_id_fkey;
ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_notification_id_fkey
    FOREIGN KEY (organization_id, notification_id)
    REFERENCES notification (organization_id, id) ON DELETE CASCADE;
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_user_id_fkey;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_user_id_fkey
    FOREIGN KEY (organization_id, user_id)
    REFERENCES app_user (organization_id, id) ON DELETE CASCADE;
ALTER TABLE notification_template DROP CONSTRAINT notification_template_updated_by_id_fkey;
ALTER TABLE notification_template ADD CONSTRAINT notification_template_updated_by_id_fkey
    FOREIGN KEY (organization_id, updated_by_id)
    REFERENCES app_user (organization_id, id) ON DELETE SET NULL (updated_by_id);
ALTER TABLE policy_violation DROP CONSTRAINT policy_violation_line_item_id_fkey;
ALTER TABLE policy_violation ADD CONSTRAINT policy_violation_line_item_id_fkey
    FOREIGN KEY (organization_id, line_item_id)
    REFERENCES expense_line_item (organization_id, id) ON DELETE CASCADE;
ALTER TABLE policy_violation DROP CONSTRAINT policy_violation_policy_id_fkey;
ALTER TABLE policy_violation ADD CONSTRAINT policy_violation_policy_id_fkey
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES expense_policy (organization_id, id) ON DELETE CASCADE;
ALTER TABLE policy_violation DROP CONSTRAINT policy_violation_report_id_fkey;
ALTER TABLE policy_violation ADD CONSTRAINT policy_violation_report_id_fkey
    FOREIGN KEY (organization_id, report_id)
    REFERENCES expense_report (organization_id, id) ON DELETE CASCADE;
ALTER TABLE policy_violation DROP CONSTRAINT policy_violation_resolved_by_id_fkey;
ALTER TABLE policy_violation ADD CONSTRAINT policy_violation_resolved_by_id_fkey
    FOREIGN KEY (organization_id, resolved_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE receipt DROP CONSTRAINT receipt_expense_id_fkey;
ALTER TABLE receipt ADD CONSTRAINT receipt_expense_id_fkey
    FOREIGN KEY (organization_id, expense_id)
    REFERENCES expense (organization_id, id) ON DELETE SET NULL (expense_id);
ALTER TABLE receipt DROP CONSTRAINT receipt_uploaded_by_id_fkey;
ALTER TABLE receipt ADD CONSTRAINT receipt_uploaded_by_id_fkey
    FOREIGN KEY (organization_id, uploaded_by_id)
    REFERENCES app_user (organization_id, id);

-- ── How this file was produced, so it can be reproduced ─────────────────────
--
-- Generated from the live schema, not typed. The enumeration:
--
--   WITH tenant AS (
--     SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE n.nspname = 'public' AND c.relkind = 'r'
--       AND EXISTS (SELECT 1 FROM pg_attribute a
--                   WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
--                     AND NOT a.attisdropped))
--   SELECT k.conname, src.relname, a.attname, tgt.relname, k.confdeltype,
--          cardinality(k.conkey)
--   FROM pg_constraint k
--   JOIN tenant src ON src.oid = k.conrelid
--   JOIN tenant tgt ON tgt.oid = k.confrelid
--   JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
--   WHERE k.contype = 'f' ORDER BY src.relname, a.attname;
--
-- 49 tenant-to-tenant foreign keys, of which 7 were already composite (`0014`,
-- `0016`, `0017`) and 42 were not. Doing it by hand would have meant 42 chances to
-- transcribe a delete action wrongly, and the CI guard added with this migration is
-- what keeps the count at zero afterwards.
