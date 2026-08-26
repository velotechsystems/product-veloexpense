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

export function StatusBadge({ status }: { status: ReportStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        STATUS_TONE[status] ?? 'border-border text-muted-foreground'
      }`}
    >
      {status}
    </span>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  BLOCK: 'border-destructive/40 bg-destructive/10 text-destructive',
  WARNING: 'border-border bg-muted/60 text-foreground',
  INFO: 'border-border text-muted-foreground',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.INFO
      }`}
    >
      {severity}
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

export function formatDate(value: Date | string | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}
