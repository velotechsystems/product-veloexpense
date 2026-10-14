-- VeloExpense 0069_role_cutover — Wave 4 (w4-10b, d73, d74).
--
-- The end of the staged cutover 0068 began. A person's role is `app_user.role_id` and
-- nothing else: VeloExpense's own admin checks now ask for a permission
-- (`admin.appSettings.update`, d74) rather than the text role, and the employee and invite
-- screens pick a role row. So the text role, which only the 0068 trigger still read, goes.
--
--   · `invite.role` → `invite.role_id`, the role the invitation grants, with a composite
--     foreign key to the tenant's role. Pending invites keep what they promised: ADMIN →
--     System Administrator; MANAGER and EMPLOYEE → Employee (0068's mapping).
--   · `app_user.role_id` and `invite.role_id` default to the tenant's Employee role
--     (ExpenseOS's "Default role", SYSTEM_ROLE_IDS.employee), which every tenant holds (0068).
--   · `app_user.role`, its CHECK and index, the 0068 trigger and the mapping function go.
--     Nothing reads them after this release; the migration runs before the new code serves.
--   · `audit_entry.actor_role` is unchanged as a column. New entries record the actor's
--     role LABEL (d74, as ExpenseOS does); entries already written keep the text role they
--     were hashed with, so the chain verifies as before.

ALTER TABLE invite ADD COLUMN role_id uuid;

DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('app.current_org', org::text, true);
    UPDATE invite SET role_id = role_id_for_legacy_role(role) WHERE organization_id = org;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;

ALTER TABLE invite
    ALTER COLUMN role_id SET DEFAULT '019e3000-0000-7000-8000-000000000004'::uuid,
    ALTER COLUMN role_id SET NOT NULL,
    ADD CONSTRAINT invite_role_fkey
      FOREIGN KEY (organization_id, role_id) REFERENCES role (organization_id, id);
ALTER TABLE invite DROP CONSTRAINT invite_role_check;
ALTER TABLE invite DROP COLUMN role;

DROP TRIGGER app_user_role_id_from_legacy ON app_user;
DROP FUNCTION app_user_role_id_from_legacy();
DROP FUNCTION role_id_for_legacy_role(text);

ALTER TABLE app_user ALTER COLUMN role_id SET DEFAULT '019e3000-0000-7000-8000-000000000004'::uuid;
DROP INDEX IF EXISTS app_user_org_role_idx;
ALTER TABLE app_user DROP CONSTRAINT app_user_role_check;
ALTER TABLE app_user DROP COLUMN role;
