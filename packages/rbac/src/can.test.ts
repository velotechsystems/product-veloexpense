// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { can, require as requirePermission } from './can';
import { permissions as P } from './permissions';
import { ForbiddenError } from './types';

/**
 * The authorization primitive. It was at 0% — every consumer calls it, and nothing
 * asserted what it does.
 *
 * The pair exists because the two answers are different: `can` is for UI that branches
 * on absence (hide a menu item), `require` is for a procedure entry point where absence
 * is a policy error. Collapsing them is how a cosmetic check ends up guarding a
 * mutation, or a mutation throws where a button should merely be disabled.
 */

const user = (...perms: string[]) =>
  ({ id: 'u1', roleId: 'r1', roleLabel: 'Employee', permissions: perms }) as never;

describe('can', () => {
  it('is true only for a permission the role actually holds', () => {
    const u = user(P.expense.report.readOwn, P.expense.report.submitOwn);
    expect(can(u, P.expense.report.readOwn)).toBe(true);
    expect(can(u, P.expense.report.readAll)).toBe(false);
  });

  it('is false for an empty permission set', () => {
    // The state `resolveRbacUser` returns for a deactivated role — the session goes
    // read-only rather than retaining what it had at sign-in.
    expect(can(user(), P.expense.report.readOwn)).toBe(false);
  });

  it('does not treat a prefix as a match', () => {
    /**
     * `expense.report.read.all` starts with `expense.report.read` — a `startsWith`
     * implementation would grant read-all to anybody with read-own, which is the
     * difference between seeing your own expenses and seeing the company's.
     */
    const u = user(P.expense.report.readOwn);
    expect(can(u, P.expense.report.readAll)).toBe(false);
  });

  it('does not treat a hierarchy as implied', () => {
    // No inheritance: holding `admin.role.update` does not confer `admin.role.delete`.
    const u = user(P.admin.role.update);
    expect(can(u, P.admin.role.delete)).toBe(false);
  });
});

describe('require', () => {
  it('passes silently when the permission is held', () => {
    expect(() => requirePermission(user(P.vcc.cardIssue), P.vcc.cardIssue)).not.toThrow();
  });

  it('throws ForbiddenError naming the permission', () => {
    // tRPC middleware turns this into FORBIDDEN; naming the permission is what makes
    // the log line actionable rather than "access denied".
    try {
      requirePermission(user(), P.vcc.cardIssue);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect(String(e)).toContain(P.vcc.cardIssue);
    }
  });

  it('agrees with can for every case', () => {
    // The two must never disagree: `require` is defined in terms of `can`, and a future
    // refactor that gives them separate logic is the bug this catches.
    const u = user(P.budget.read);
    for (const perm of [P.budget.read, P.budget.update, P.admin.role.list]) {
      const allowed = can(u, perm);
      const threw = (() => {
        try {
          requirePermission(u, perm);
          return false;
        } catch {
          return true;
        }
      })();
      expect(threw).toBe(!allowed);
    }
  });
});
