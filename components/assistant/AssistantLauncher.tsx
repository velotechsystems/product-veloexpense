'use client';

/**
 * NOT PORTED YET — a placeholder so ExpenseOS's TopBar (ported verbatim) has the import it
 * expects. TopBar renders it only when the `assistant` module is active, and no VeloExpense
 * module maps to that slug yet (`server/platform/modules.ts`), so it never renders. ExpenseOS's
 * own launcher comes over with the assistant in Wave 6 and replaces this file.
 */
export function AssistantLauncher() {
  return null;
}
