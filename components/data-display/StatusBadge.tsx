import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StatusBadgeProps, WorkflowStatus } from './StatusBadge.types';

export type { StatusBadgeProps, WorkflowStatus } from './StatusBadge.types';

/**
 * Per-status colour. Each workflow state gets a soft, status-specific surface treatment.
 *
 * VeloExpense kit: the kit Badge's tones (d31), not ExpenseOS's own classes. They are the
 * tones the kit tuned to WCAG AA on the 2026 grey surfaces (KITAA-1), and the ones VeloExpense
 * coloured these states with before the port. ExpenseOS's Reimbursed is its brand orange,
 * which the kit has no token for; here it is the kit's `secondary`.
 */
const STATUS_TONE: Record<
  WorkflowStatus,
  'muted' | 'default' | 'success' | 'warning' | 'destructive' | 'secondary'
> = {
  Draft: 'muted',
  Submitted: 'default',
  Approved: 'success',
  Rejected: 'destructive',
  Returned: 'warning',
  Reimbursed: 'secondary',
};

/**
 * StatusBadge — colored pill for an expense-report workflow state.
 *
 * `label` is the words on the pill, already translated by the caller. REQUIRED on purpose:
 * this package takes no next-intl dependency, so the text used to default to `status`, which
 * is a title-case English literal by construction — what printed "Approved" and "Reimbursed"
 * among French tiles (ExpenseOS's GA readiness report F43). A required prop makes the
 * compiler name every site that has to thread a label.
 *
 * `appearance: 'outline'` swaps the soft surface for a bordered, transparent pill — higher
 * contrast against the page, used to make a Draft stand out.
 */
export function StatusBadge({ status, label, appearance, className }: StatusBadgeProps) {
  return (
    <Badge
      variant={STATUS_TONE[status] ?? 'muted'}
      className={cn(appearance === 'outline' && 'border border-current bg-transparent', className)}
    >
      {label}
    </Badge>
  );
}
