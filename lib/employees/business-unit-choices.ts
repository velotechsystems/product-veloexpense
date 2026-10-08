/**
 * The business units a picker may offer: the active ones, plus the one already chosen.
 *
 * Since the Wave 1 port a unit is deactivated rather than deleted (ExpenseOS's soft
 * delete). A deactivated unit must not be offered for new work, but a record that already
 * points at one has to keep showing it: otherwise the select falls back to "none" and the
 * next save silently unassigns it. Pure, so client forms can use it too.
 */
export function businessUnitChoices<T extends { id: string; active: boolean }>(
  units: readonly T[],
  current?: string | null,
): T[] {
  return units.filter((u) => u.active || u.id === current);
}
