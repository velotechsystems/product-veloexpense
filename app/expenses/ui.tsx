/**
 * VX1-6 — the handful of presentational bits the workbench pages share.
 *
 * Server components, no client JS. Classes are the vendored lib-ui-kit tokens
 * (app/velotech-tokens.css) rather than raw colours, so the whole surface
 * follows the shared theme — including dark mode — without a second palette.
 * lib-ui-kit ships no table/select/badge yet, so those are hand-rolled here
 * against the same tokens (see the handoff note).
 */
import type { ReportStatus } from '@/lib/expenses/service';
import { enumLabel, REPORT_STATUS_COPY, SEVERITY_COPY } from '@/lib/i18n/catalog/enums';

export const fieldClass = 'flex flex-col gap-1.5';
export const labelClass = 'text-sm font-medium text-foreground';
export const selectClass =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
export const textareaClass =
  'min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
export const cardClass = 'rounded-xl border border-border bg-background';

const STATUS_TONE: Record<ReportStatus, string> = {
  DRAFT: 'border-border text-muted-foreground',
  SUBMITTED: 'border-primary/40 text-primary',
  APPROVED: 'border-primary/40 text-primary',
  RETURNED: 'border-destructive/40 text-destructive',
  REJECTED: 'border-destructive/40 text-destructive',
  REIMBURSED: 'border-border text-foreground',
};

/**
 * VX4-7 part 2a: the badge takes a LOCALE now, and renders copy rather than the
 * enum value.
 *
 * `{status}` put `REIMBURSED` on the screen — the schema's word, in the schema's
 * shouting case, on a page an employee reads. The tone map above stays as it is
 * and is deliberately NOT catalogued: a colour is not copy, it does not vary by
 * locale, and moving it would put a Tailwind class list in a translation file.
 */
export function StatusBadge({ status, locale }: { status: ReportStatus; locale: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        STATUS_TONE[status] ?? 'border-border text-muted-foreground'
      }`}
    >
      {enumLabel(REPORT_STATUS_COPY, status, locale)}
    </span>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  BLOCK: 'border-destructive/40 bg-destructive/10 text-destructive',
  WARNING: 'border-border bg-muted/60 text-foreground',
  INFO: 'border-border text-muted-foreground',
};

export function SeverityBadge({ severity, locale }: { severity: string; locale: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.INFO
      }`}
    >
      {enumLabel(SEVERITY_COPY, severity, locale)}
    </span>
  );
}

/** Validation failures come back as ?error=… so a plain form post can show them. */
export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="error-banner"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

/**
 * `formatDate` LIVED HERE and is gone — VX4-7 part 1b.
 *
 * It was `toISOString().slice(0, 10)` and it did three different jobs at twenty
 * call sites, badly at two of them. Its replacements are in `lib/i18n/format.ts`
 * and there are three, because there are three kinds of value:
 * `formatCalendarDate` for a `date` column, `formatInstant` for a `timestamptz`,
 * and `toDateInputValue` for an `<input type="date">`.
 *
 * It is DELETED rather than deprecated, and not re-exported from here, so that
 * the compiler had to name every caller — which is how all twenty were moved
 * deliberately instead of by search-and-replace.
 */
