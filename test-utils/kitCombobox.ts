import { screen } from '@testing-library/react';

/**
 * VeloExpense: find the kit `Combobox` fields a ported ExpenseOS test found by placeholder.
 *
 * ExpenseOS's combobox is a Base UI `<input placeholder>`, so its tests reach a field with
 * `getByPlaceholderText` and read the pick back as the input's display value. The kit's
 * (`components/ui/combobox.tsx`, the suite standard since Oct 2026) is a `role="combobox"`
 * BUTTON that shows the placeholder until something is picked and the picked label after,
 * with the search box inside its popup. The kit keeps the placeholder on the trigger as
 * `data-placeholder` whatever it shows, so a field is found here by that, and the test reads
 * a pick back as the button's text.
 */
export function getAllComboboxesByPlaceholder(placeholder: string): HTMLElement[] {
  const found = screen
    .queryAllByRole('combobox')
    .filter((el) => el.getAttribute('data-placeholder') === placeholder);
  if (found.length === 0) {
    throw new Error(`No kit combobox shows the placeholder "${placeholder}".`);
  }
  return found;
}

/** The one kit `Combobox` field showing `placeholder` (see above). */
export function getComboboxByPlaceholder(placeholder: string): HTMLElement {
  const all = getAllComboboxesByPlaceholder(placeholder);
  if (all.length > 1) {
    throw new Error(`${all.length} kit comboboxes show the placeholder "${placeholder}".`);
  }
  return all[0];
}

/** Like `getComboboxByPlaceholder`, but null when there is none. */
export function queryComboboxByPlaceholder(placeholder: string): HTMLElement | null {
  try {
    return getComboboxByPlaceholder(placeholder);
  } catch {
    return null;
  }
}
