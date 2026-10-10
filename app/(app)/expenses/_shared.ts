/**
 * Shared helpers for the expenses UI (real-data wiring).
 *
 * The API sends the Prisma `ExpenseReportStatus` enum (SCREAMING_CASE); the
 * design-system `StatusBadge` expects the title-case `WorkflowStatus`. Category
 * labels arrive as locale-keyed Json maps. These map between the two.
 */
import type { WorkflowStatus } from '@expenseos/design-system';

/**
 * Prisma ExpenseReportStatus → the StatusBadge COLOUR key.
 *
 * Deliberately NOT exported. Every render site goes through `statusBadgeProps` below, so a
 * seventh one physically cannot do `<StatusBadge status={STATUS_BADGE[x]} …>` and reintroduce
 * an English pill — which is what put "Approved" and "Reimbursed" among French tiles (GA
 * readiness report F43).
 */
const STATUS_BADGE: Record<string, WorkflowStatus> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned',
  REIMBURSED: 'Reimbursed',
};

/**
 * Badge props for a Prisma report status: COLOUR from the map, TEXT from the catalog.
 *
 * Uses the same `expenses.status.*` keys the status filter dropdown and the CSV export already
 * use, rather than a parallel set — so the pill, the filter and the export cannot end up
 * saying three different things about one report. That disagreement is what the audit saw: on
 * a fr-CA screen the filter said "Approuvé" and the pill beside it said "Approved".
 *
 * The label is derived from the MAPPED badge, not from the raw enum, so a status the server
 * ships before the UI knows it falls back to a TRANSLATED label rather than to a
 * MISSING_MESSAGE on a key nobody wrote.
 */
export function statusBadgeProps(
  status: string,
  t: (key: string) => string,
  fallback: WorkflowStatus = 'Draft',
): { status: WorkflowStatus; label: string } {
  const badge = STATUS_BADGE[status] ?? fallback;
  return { status: badge, label: t(`status.${badge.toLowerCase()}`) };
}

/** Report statuses in display order (for the status filter). */
export const REPORT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'REIMBURSED',
] as const;

/** A locale-keyed Json label ({ en, "fr-CA" }) → the best string for `locale`. */
export function localeLabel(label: unknown, locale: string): string {
  if (label && typeof label === 'object' && !Array.isArray(label)) {
    const m = label as Record<string, unknown>;
    const v = m[locale] ?? m.en ?? Object.values(m)[0];
    if (typeof v === 'string') return v;
  }
  return typeof label === 'string' ? label : '';
}

/** Policy severity → the FilterPillBar/severity styling bucket + i18n key. */
export const SEVERITY_KEY: Record<string, 'error' | 'warning' | 'info'> = {
  BLOCK: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * Should the report page prompt for receipts?
 *
 * An MCP client that could not upload the files hands the person a `?upload=1` link, and this
 * decides whether the banner behind it appears.
 *
 * **The editable gate is the part worth stating.** A submitted report has no upload control —
 * `editable` is false, so the button is not rendered — and a banner saying "add your receipts"
 * above a page that cannot accept them is worse than no banner: it reads as broken rather than
 * as "recall it first". The link is not wrong in that case, it has simply arrived late (the
 * report was submitted between the tool call and the click).
 */
export function shouldPromptUpload(input: { linkArrived: boolean; editable: boolean }): boolean {
  return input.linkArrived && input.editable;
}

/**
 * Which expense the workbench should have open.
 *
 * Three claims on the selection, in falling priority:
 *
 *   1. whatever the person selected themselves, as long as it still exists — this
 *      effect re-runs on every refetch, so without it any poll would yank the
 *      selection back;
 *   2. `?expense=<id>`, the deep link from the cross-report list. On a twelve-line
 *      claim the first row is almost never the charge somebody is asking about;
 *   3. the first expense, the plain default.
 *
 * A `requested` id that isn't on this report is IGNORED rather than treated as
 * "select nothing" — that's a stale or hand-edited link, and blanking the centre
 * pane reads as a broken page.
 */
export function nextSelectedExpenseId(input: {
  current: string | null;
  expenseIds: readonly string[];
  requested?: string | null;
}): string | null {
  const { current, expenseIds, requested } = input;
  if (expenseIds.length === 0) return null;
  if (current && expenseIds.includes(current)) return current;
  if (requested && expenseIds.includes(requested)) return requested;
  return expenseIds[0];
}
