/**
 * UD-11 — the actor the db suites pass to an audited write.
 *
 * Every edit in `lib/expenses/service.ts` takes an `AuditActor`, by design: the
 * compiler is what guarantees no edit path forgets to audit (see that file's
 * header for the alternative that was rejected). The consequence is that ~68
 * existing call sites across thirteen suites needed one, and none of them is
 * about auditing — they are testing totals, policy, routing, budgets.
 *
 * So they share this one, and it is deliberately the EXTERNAL-APPROVER shape —
 * `id: null` with an email — for two reasons:
 *
 *  1. It needs no seeded `app_user` row, so a suite that only wanted to add a
 *     line item does not gain a fixture.
 *  2. It exercises the id/email exclusivity that `audit_entry_actor_exclusive`
 *     enforces, from the side the internal path does not.
 *
 * WHAT IT IS NOT FOR: asserting audit CONTENT. `test/expense-audit.db.test.ts`
 * uses real seeded employees with real ids, because "who edited this" is the
 * question under test there and an anonymous stand-in would answer it vacuously.
 */
import type { AuditActor } from '@/lib/audit/service';

export const TEST_ACTOR: AuditActor = {
  id: null,
  email: 'suite@test.invalid',
  name: 'Test Suite',
  role: 'SYSTEM',
};
