-- w4-10f — "Deactivated" on the employee form now deactivates.
--
-- Everything that decides whether somebody is a member reads `deleted_at`: sign-in
-- (lib/auth/resolve-sso-user.ts), `requireActor`, the admin gate, the tRPC context and the
-- seat meter. The employee form wrote only `employee_status`, so a person set to
-- "Deactivated" there kept signing in and acting, and kept a paid seat, while every
-- directory screen said they were gone. lib/employees/service.ts now stamps `deleted_at`
-- when the form deactivates somebody; this mends the rows written before it, honouring what
-- the admin chose: stamped as of their last update, when the status was set.
--
-- No constraint ties the two columns together. They are separate facts in ExpenseOS's model
-- (its approval-engine tests refuse "a deactivated employee" and "a soft-deleted user" as two
-- cases), so the rule lives where VeloExpense writes the status, not in the table.
UPDATE app_user
   SET deleted_at = updated_at
 WHERE employee_status = 'DEACTIVATED' AND deleted_at IS NULL;
