/**
 * Employee lifecycle status — the value set, and the one badge colour each
 * value gets.
 *
 * A cross-cutting leaf rather than a section file: the same four statuses are
 * rendered by /profile's employment record (the surface that inherited them when
 * /my-info was deleted), by the People directory's status cell, and by the user
 * detail drawer, and each of those had grown its own private copy of the same
 * type + map. Three copies of a colour table is three chances for one screen to
 * call a departed employee grey while another calls it red — a reader comparing
 * two pages has no way to tell which one is lying.
 *
 * It lives in `@/lib` for the same reason `format.ts` does: pure data, no
 * React, no i18n, no router, importable from a server component and a client
 * component alike. The LABELS are not here — those are `people.status.*` in the
 * i18n catalogs, and stay there.
 *
 * Ported from ExpenseOS `apps/web/src/lib/employeeStatus.ts` (1e682dd6) unchanged, People 3.
 * VeloExpense's own employee screen keeps its own list (lib/employees/service.ts), which
 * leaves TERMINATED out on purpose; this one is ExpenseOS's, for the ported screens.
 */

import type { BadgeProps } from '@expenseos/design-system';

/**
 * Every employee status, in the order a picker should offer them: the working
 * state first, then the three ways of not working, least final to most.
 * Mirrors the `EmployeeStatus` enum in the Prisma schema.
 */
export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'DEACTIVATED', 'TERMINATED'] as const;

/** Derived from the tuple so the list and the type cannot disagree. */
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * Status → `<Badge>` variant.
 *
 * ON_LEAVE is amber rather than grey because it is a temporary state somebody
 * may need to act on; DEACTIVATED is grey because it is merely an absence;
 * TERMINATED is red because it is the one that ends things. Colour is never the
 * only signal — every call site renders the translated label beside the badge.
 */
export const EMPLOYEE_STATUS_VARIANT: Record<EmployeeStatus, BadgeProps['variant']> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  DEACTIVATED: 'secondary',
  TERMINATED: 'destructive',
};
