/**
 * VX1-6 — the handful of presentational bits the workbench pages share.
 *
 * Server components, no client JS. Since the 2026 kit these are thin wrappers
 * over the vendored kit parts (`Badge`, `Table*`, the flat `SURFACE`) — they
 * used to be hand-rolled because lib-ui-kit shipped no table, select or badge.
 * Selects and textareas are now the kit's `NativeSelect` / `Textarea` at each
 * call site, so their class strings are gone from here.
 */
import { CircleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { SURFACE } from '@/components/screen';
import type { ReportStatus } from '@/lib/expenses/service';
import { enumLabel, REPORT_STATUS_COPY, SEVERITY_COPY } from '@/lib/i18n/catalog/enums';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { readerPrefs } from '@/lib/i18n/request';

export const fieldClass = 'flex flex-col gap-1.5';
export const labelClass = 'text-sm font-medium text-foreground';
/** The guide's flat card surface (1px border, radius-lg, `--card`). */
export const cardClass = SURFACE;

type Tone = 'default' | 'success' | 'warning' | 'destructive' | 'muted' | 'secondary';

/**
 * Status → the kit badge's semantic variant. Waiting on somebody is the brand
 * tint; done is success; sent back is a warning (the submitter has work to do);
 * refused is destructive — a word is always on it, as the guide requires.
 */
const STATUS_TONE: Record<ReportStatus, Tone> = {
  DRAFT: 'muted',
  SUBMITTED: 'default',
  APPROVED: 'success',
  RETURNED: 'warning',
  REJECTED: 'destructive',
  REIMBURSED: 'secondary',
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
    <Badge variant={STATUS_TONE[status] ?? 'muted'}>{enumLabel(REPORT_STATUS_COPY, status, locale)}</Badge>
  );
}

const SEVERITY_TONE: Record<string, Tone> = {
  BLOCK: 'destructive',
  WARNING: 'warning',
  INFO: 'muted',
};

export function SeverityBadge({ severity, locale }: { severity: string; locale: string }) {
  return (
    <Badge className="shrink-0" variant={SEVERITY_TONE[severity] ?? 'muted'}>
      {enumLabel(SEVERITY_COPY, severity, locale)}
    </Badge>
  );
}

/** Validation failures come back as ?error=… so a plain form post can show them. */
/**
 * The one place a `?error=` value becomes words.
 *
 * VX4-7 part 2c. It resolves the reader ITSELF rather than taking a `locale`
 * prop, unlike `StatusBadge` and the rest of this module. Twenty pages render
 * this component and every one of them would otherwise have to thread a locale
 * down to it — and MT-3 is that a requirement at the edge is one the next caller
 * forgets. `readerPrefs()` is wrapped in React's `cache()`, so asking here costs
 * nothing on a page that already asked.
 *
 * An async server component: fine here, because nothing in this file is a client
 * component and every caller is a page.
 *
 * A value that is not a known code passes through unchanged — see
 * `renderUserMessage`. That is the transitional branch for the admin modules
 * part 2c-2 has not reached yet, and it is the reason this cannot yet refuse an
 * arbitrary string arriving in a link.
 */
export async function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  const { locale } = await readerPrefs();
  const text = renderUserMessage(message, locale);
  if (!text) return null;
  return (
    <p
      role="alert"
      data-testid="error-banner"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
      <span>{text}</span>
    </p>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-8 text-center whitespace-normal text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
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
