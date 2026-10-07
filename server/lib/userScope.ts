/**
 * Directory scopes — match the `scope` chip group on /users.
 *
 *   all      — every employee in the org (admin only).
 *   direct   — caller's direct reports (managerId = caller.id).
 *   indirect — caller's chain at depth >= 2 (reports of reports, …).
 *   chain    — caller's direct + indirect reports (everyone below them).
 *   self     — only the caller.
 *
 * Ported from ExpenseOS `server/lib/userScope.ts` (550b2945). VeloExpense: the TYPE only, which
 * the table chrome needs. `resolveScopedIds` (the manager-tree walk) reads ExpenseOS's `User`
 * model; it comes over with the People port, mapped onto `app_user`, with its DB tests.
 */
export type DirectoryScope = 'all' | 'direct' | 'indirect' | 'chain' | 'self';
