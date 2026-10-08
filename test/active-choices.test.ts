import { describe, expect, it } from 'vitest';
import { activeChoices } from '@/lib/employees/active-choices';

/**
 * Wave 1: business units and legal entities are deactivated, not deleted. VeloExpense's
 * own forms (the employee form, the expense workbench, budgets) offer only active ones — but a record
 * already pointing at a deactivated unit must keep it, or the select falls back to "none"
 * and the next save silently unassigns it.
 */
const units = [
  { id: 'hq', name: 'Head Office', active: true },
  { id: 'old', name: 'Retired', active: false },
  { id: 'west', name: 'West', active: true },
];

describe('activeChoices', () => {
  it('offers only active units for new work', () => {
    expect(activeChoices(units).map((u) => u.id)).toEqual(['hq', 'west']);
    expect(activeChoices(units, null).map((u) => u.id)).toEqual(['hq', 'west']);
  });

  it('keeps the unit a record already names, even when it has been deactivated', () => {
    expect(activeChoices(units, 'old').map((u) => u.id)).toEqual(['hq', 'old', 'west']);
  });
});
