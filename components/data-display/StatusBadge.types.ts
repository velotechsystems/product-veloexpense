/**
 * VeloExpense kit: ExpenseOS's `WorkflowStatus`, the six report states, declared here. In
 * ExpenseOS it is the key set of `tokens/workflowColors.ts`, a Radix Themes colour map that
 * nothing in the kit uses — the colours are the kit Badge's tones (see `StatusBadge.tsx`).
 */
export type WorkflowStatus =
  'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Returned' | 'Reimbursed';

export type ExpenseStatus = WorkflowStatus;

export interface StatusBadgeProps {
  /** Colour key. Not rendered. */
  status: WorkflowStatus;
  /** Pill text, translated by the caller — this package has no next-intl dependency. */
  label: string;
  /** `outline` swaps the soft surface for a bordered, transparent pill. */
  appearance?: 'solid' | 'outline' | null;
  className?: string;
}
