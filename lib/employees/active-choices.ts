/**
 * The reference rows a picker may offer: the active ones, plus the one already chosen.
 *
 * Since the Wave 1 ports, business units and legal entities are deactivated rather than
 * deleted (ExpenseOS's soft delete). A deactivated row must not be offered for new work,
 * but a record that already points at one has to keep showing it: otherwise the select
 * falls back to "none" and the next save silently unassigns it. Pure, so client forms can
 * use it too.
 */
export function activeChoices<T extends { id: string; active: boolean }>(
  rows: readonly T[],
  current?: string | null,
): T[] {
  return rows.filter((r) => r.active || r.id === current);
}
