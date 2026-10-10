'use client';

/**
 * Shared workbench parts — the reusable three-pane pieces used by BOTH the
 * expense-report workbench (`/expenses/[reportId]`) and the unfiled-expenses
 * inbox (`/expenses/items`): the expense list row, the center editor (+ tax
 * panel, attendees, line items), and the right-hand receipt pane, plus the
 * helpers/types they share. The two pages differ only in their outer chrome
 * (header, selection, report-level actions); everything inside the panes is
 * identical, so it lives here.
 */
import {
  Badge,
  Button,
  Combobox,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  Input,
  Textarea,
} from '@expenseos/design-system';
import { tipMinorOf } from '@expenseos/expense-lines';
import {
  IconAlertTriangle,
  IconCamera,
  IconDownload,
  IconFileText,
  IconMaximize,
  IconPaperclip,
  IconPlus,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  AttachmentDocument,
  useViewerZoom,
  ZoomControls,
} from '@/components/attachments/AttachmentViewer';
import { ReceiptFileInput } from '@/components/attachments/ReceiptFileInput';
import { groupViolations, violationValues } from '@/components/policy/violations';
import { categoryPillStyle } from '@/lib/categoryColor';
import {
  type CurrencyLike,
  formatMinor,
  majorToMinor,
  minorToMajorInput,
  sanitizeMoneyText,
} from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { useIsBelowLg } from '@/lib/useIsBelowLg';
import type { AppRouter } from '@/server/routers/_app';
import { SectionNotice } from '../../SectionNotice';
import { localeLabel, SEVERITY_KEY } from '../_shared';
import { fieldsToClear, strategyFor } from './lineKinds';
import { convertDistance, isValidDistance, MileageFields, useSettled } from './MileageFields';
import { EMPTY_ROUTE, type RouteValue } from './RouteEditor';
import {
  isReceiptDrag,
  type ReceiptDragPayload,
  readReceiptDrag,
  setReceiptDrag,
} from './receiptDrag';

export type ReportDetail = inferRouterOutputs<AppRouter>['expenses']['report'];
export type ExpenseDetail = ReportDetail['expenses'][number];
type LineItemDetail = ExpenseDetail['lineItems'][number];
type ReceiptDetail = ExpenseDetail['receipts'][number];
type ExtractionDetail = ReceiptDetail['extraction'];
/** Policy violations scoped to a single expense (the inbox passes none). */
export type ViolationList = ReportDetail['violations'];

/** major-unit input string → minor-unit string (null when blank/invalid),
 *  scaled by the currency's ISO-4217 exponent (JPY 0 / KWD 3 round-trip). */
export function inputToMinor(s: string, code: string, locale: string): string | null {
  const minor = majorToMinor(s.trim(), code, locale);
  return minor === null ? null : String(minor);
}
const minorToInput = (m: string | null, code: string): string =>
  minorToMajorInput(m == null ? null : Number(m), code);

/** Amount with its currency code suffix, e.g. "$53.10 CAD" / "53,10 $ CAD".
 *  `locale` is the reader's — this is the workbench's single money render
 *  point, so passing the wrong one here mislabels every expense line, tax
 *  figure and total on the page at once. */
function money(minor: number, currency: CurrencyLike, locale: string): string {
  return `${formatMinor(minor, currency, locale)} ${currency.code}`;
}

/**
 * The home-currency figure to show beside a foreign expense, or null when the
 * expense is already in the home currency and there is nothing to convert.
 *
 * `missing` distinguishes "no rate exists" from "converts to zero" — the first
 * has to be visible, because that expense is excluded from the report total.
 */
function convertedLabel(
  e: {
    amountMinor: string;
    currency: CurrencyLike;
    homeCurrency: string | null;
    homeAmountMinor: string | null;
    fxRate: string | null;
  },
  locale: string,
): { label: string; code: string; missing: boolean } | null {
  if (!e.homeCurrency || e.homeCurrency === e.currency.code) return null;
  if (e.homeAmountMinor === null || e.fxRate === null) {
    return { label: '', code: e.currency.code, missing: true };
  }
  return {
    label: money(Number(e.homeAmountMinor), { code: e.homeCurrency }, locale),
    code: e.homeCurrency,
    missing: false,
  };
}

/**
 * A decimal amount input with the currency symbol as a left prefix.
 *
 * IT FILTERS ITS OWN INPUT. Every change passes through `sanitizeMoneyText` before the
 * caller's `onChange` sees it, so letters and pasted prose never reach the caller's state.
 * The audit typed `abc<b>x</b>` into a `$` field and it was accepted; the only consequence
 * was a save that never happened, so the bogus text sat there looking exactly like a saved
 * amount (GA readiness report F06).
 *
 * A FILTER, not a validator: half-typed amounts — "", "-", "12," — have to pass, because
 * people type one character at a time. `invalid` is the separate signal for "this cannot be
 * converted", and gives the field an `aria-invalid` and a destructive border rather than
 * silently refusing the keystroke.
 *
 * `wrapperClassName` sizes the field (e.g. "w-24"); `className` styles the input itself.
 */
function MoneyInput({
  symbol,
  wrapperClassName,
  className,
  invalid,
  locale,
  onChange,
  ...props
}: {
  symbol: string;
  wrapperClassName?: string;
  /** Marks the field as carrying a value that cannot be converted. */
  invalid?: boolean;
  /** The reader's locale — their decimal character is not ours to assume. */
  locale: string;
} & ComponentProps<typeof Input>) {
  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground text-xs">
        {symbol}
      </span>
      <Input
        inputMode="decimal"
        aria-invalid={invalid || undefined}
        {...props}
        onChange={(e) => {
          const cleaned = sanitizeMoneyText(e.target.value, locale);
          if (cleaned === e.target.value) {
            onChange?.(e);
            return;
          }
          // Rewrite the event's value so the caller stores what the field will show. Mutating
          // the target is what keeps the cursor from jumping, which a controlled re-render
          // from a differing value would cause.
          e.target.value = cleaned;
          onChange?.(e);
        }}
        // The separator is explicit: Biome's class sorter strips a trailing space inside the
        // string, and without one here the two class lists concatenate into one bogus name.
        className={[
          'w-full pr-2 pl-6 text-right',
          invalid ? 'border-destructive focus-visible:ring-destructive' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    </div>
  );
}

/** True while any receipt is in a genuinely-transient state a refetch would
 *  advance. Does NOT treat "extraction not configured" (PENDING + error) as
 *  pending, so we don't poll forever when no Claude API key is set. Accepts the
 *  expense list from either the report query or the unfiled-pool query. */
/**
 * How long a freshly uploaded receipt is given to produce an extraction row before the
 * view stops waiting for one.
 *
 * A receipt row is written by the request; its extraction row is written by the worker.
 * In the window between the two there is no extraction at all — and `scanCleared` reads a
 * missing row as "not cleared" and shows "Scanning…", correctly, because un-scanned bytes
 * must not be rendered. But `hasPendingExtractionIn` used to read the same missing row as
 * "nothing pending" and switch polling OFF, so the pane sat on that placeholder until the
 * reader reloaded the page. The audit measured 56 seconds and gave up (GA readiness report
 * F09); with extraction not configured at all it never clears.
 *
 * Bounded rather than open-ended: polling for a row the worker is never going to write
 * would be a 4-second heartbeat forever.
 */
const PIPELINE_REPORT_GRACE_MS = 3 * 60 * 1000;

/** Is this receipt still within the window where a missing extraction row is normal? */
function awaitingPipeline(r: { uploadedAt: string | Date; extraction: ExtractionDetail }): boolean {
  if (r.extraction) return false;
  const uploaded = new Date(r.uploadedAt).getTime();
  if (Number.isNaN(uploaded)) return false;
  return Date.now() - uploaded < PIPELINE_REPORT_GRACE_MS;
}

export function hasPendingExtractionIn(expenses: readonly ExpenseDetail[] | undefined): boolean {
  if (!expenses) return false;
  return expenses.some((e) =>
    e.receipts.some((r) => {
      const ext = r.extraction;
      // No extraction row YET. The worker has not reported; keep polling so the pane
      // clears on its own rather than waiting for a reload.
      if (!ext) return awaitingPipeline(r);
      if (['PENDING', 'SCANNING'].includes(ext.scanStatus)) return true; // AV scan running
      if (ext.status === 'EXTRACTING') return true; // extraction running
      if (ext.status === 'PENDING' && !ext.error) return true; // queued, not yet attempted
      return false;
    }),
  );
}

/** Collapse the separate scan (AV) + extraction (AI) lifecycles into one chip
 *  state the UI can render honestly. */
type ReceiptState =
  | 'scanning'
  | 'infected'
  | 'scanFailed'
  | 'extracting'
  | 'extracted'
  | 'extractFailed'
  | 'notConfigured'
  | 'ready';
/** Exported for `extractionOff.test.ts`, which pins the no-API-key contract: a
 *  receipt still uploads, previews and can be typed over when extraction is off. */
export function receiptState(ext: ExtractionDetail): ReceiptState | null {
  if (!ext) return null;
  if (ext.scanStatus === 'INFECTED') return 'infected';
  if (['PENDING', 'SCANNING'].includes(ext.scanStatus)) return 'scanning';
  if (ext.scanStatus === 'FAILED') return 'scanFailed';
  // Scan is CLEAN from here — the file is safe to preview regardless of AI extraction.
  if (ext.status === 'EXTRACTED') return 'extracted';
  if (ext.status === 'EXTRACTING') return 'extracting';
  if (ext.status === 'FAILED') return 'extractFailed';
  if (ext.status === 'PENDING' && ext.error) return 'notConfigured'; // e.g. no API key
  return 'ready'; // clean scan, extraction not (yet) applicable
}
/** The file is safe to render once the AV scan is CLEAN. A missing extraction
 *  row means the scan hasn't run yet — treat as not-cleared (show "scanning")
 *  rather than exposing un-scanned bytes. */
function scanCleared(ext: ExtractionDetail): boolean {
  return ext != null && ext.scanStatus === 'CLEAN';
}

/** Lock state for the selected expense while its receipt is processing:
 *  - uploading OR AV-scan not yet clear → both the editor AND viewer are locked;
 *  - scan clear but extraction still running/queued → editor stays locked (an
 *    extraction is about to overwrite the fields) while the viewer unlocks;
 *  - otherwise → unlocked. */
export function receiptLockState(
  expense: ExpenseDetail | null,
  uploading: boolean,
): { editorLocked: boolean; viewerLocked: boolean } {
  const ext = expense?.receipts[0]?.extraction;
  const scanning = uploading || (ext != null && ['PENDING', 'SCANNING'].includes(ext.scanStatus));
  const extracting =
    ext != null &&
    ext.scanStatus === 'CLEAN' &&
    (ext.status === 'EXTRACTING' || (ext.status === 'PENDING' && !ext.error));
  return { viewerLocked: scanning, editorLocked: scanning || extracting };
}

function sumTax(e: ExpenseDetail): number {
  // Tax lives on the expense now (a receipt = one tax total).
  return Number(e.taxGstHstMinor ?? 0) + Number(e.taxQstMinor ?? 0) + Number(e.taxPstMinor ?? 0);
}

/** Local label wrapper. Control nested as `children` (implicit association). */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

// ── Left-pane expense row ─────────────────────────────────────────────────────
export function ExpenseListRow({
  expense,
  locale,
  active,
  violationCount,
  onSelect,
  selectable,
  selected,
  onToggleSelected,
  onReceiptDrop,
  onOpenReceipts,
}: {
  expense: ExpenseDetail;
  locale: string;
  active: boolean;
  /** Number of (deduped) unresolved policy violations on this expense. */
  violationCount: number;
  onSelect: () => void;
  /** When set, a leading checkbox renders (the inbox's multi-select). */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: () => void;
  /** Accepts a receipt dragged from the receipts pane. Omitted = not a drop
   *  target (a read-only report). */
  onReceiptDrop?: (payload: ReceiptDragPayload) => void;
  /**
   * Open this expense's receipts in the bottom sheet — below `lg` only, where
   * the receipt pane is a sheet rather than the third stacked pane. Selects the
   * expense on the way, so one tap does both.
   */
  onOpenReceipts?: () => void;
}) {
  const t = useTranslations('expenses');
  /**
   * Below `lg` the paperclip is not a badge, it is the way IN to the receipt.
   * A RELOCATION — the count moves out of the row button and becomes a control
   * beside it — so it is selected in JS, and for a second reason that is not
   * about the rule: the badge lives INSIDE the row's own `<button>`, and a
   * button inside a button is invalid HTML that browsers resolve by dropping
   * one of them. Rendering both faces and letting CSS pick is not available
   * here even if the rule allowed it.
   */
  const isBelowLg = useIsBelowLg();
  // Highlighting is driven by dragover, so it can only ever be true while one of OUR
  // receipts is over the row — a dragged file from the desktop leaves it alone.
  const [dragOver, setDragOver] = useState(false);
  // Distinct categories across the expense's line items → colored pills.
  const categories = Array.from(
    new Map(
      expense.lineItems.map((li) => [
        li.categoryId,
        {
          id: li.categoryId,
          label: localeLabel(li.category.label, locale),
          color: li.category.color,
          icon: li.category.icon,
        },
      ]),
    ).values(),
  );
  const tax = sumTax(expense);
  const converted = convertedLabel(expense, locale);
  // Format in UTC: the expense date is a calendar date stored at UTC midnight,
  // and the editor's date input reads it as UTC (toISOString) — formatting the
  // label in local time would shift it a day for behind-UTC timezones.
  // VeloExpense: an expense may have no date yet — a dash, as /expenses/all shows it.
  const dateLabel = expense.date
    ? new Date(expense.date).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
    : '—';

  const droppable = onReceiptDrop != null;
  return (
    <li
      className={`flex items-stretch border-border border-b ${
        active ? 'border-l-2 border-l-warning bg-warning/10' : ''
      } ${dragOver ? 'bg-primary/10 outline-2 outline-primary outline-offset-[-2px]' : ''}`}
      onDragOver={
        droppable
          ? (e) => {
              if (!isReceiptDrag(e.dataTransfer)) return;
              // preventDefault is what marks this a valid drop point; without it the
              // browser refuses the drop and shows a "no" cursor.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOver(true);
            }
          : undefined
      }
      onDragLeave={droppable ? () => setDragOver(false) : undefined}
      onDrop={
        droppable
          ? (e) => {
              setDragOver(false);
              const payload = readReceiptDrag(e.dataTransfer);
              if (!payload) return;
              e.preventDefault();
              // Dropping a receipt back where it started is a no-op, not an error.
              if (payload.fromExpenseId === expense.id) return;
              onReceiptDrop?.(payload);
            }
          : undefined
      }
    >
      {selectable && (
        <label className="flex cursor-pointer items-center pl-3">
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={onToggleSelected}
            aria-label={t('inbox.select')}
          />
        </label>
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left hover:bg-muted/50"
      >
        {/* Line 1 — date · label (left) | violation · total (right) */}
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{dateLabel}</span>
          {/**
           * Wraps onto a second line rather than truncating.
           *
           * This was `truncate`, which reads as tidy and is the wrong trade in a pane this
           * narrow: vendor names arrive from card feeds and receipt extraction as things
           * like "SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA" and the ellipsis fell
           * exactly where the identifying part is. `break-words` so a single unbroken
           * token — a URL, a long reference — breaks instead of pushing the amount out of
           * the row, which is how the layout used to give way.
           */}
          <span className="min-w-0 flex-1 break-words font-medium text-foreground text-sm">
            {expense.merchant ?? t('line.noMerchant')}
          </span>
          {violationCount > 0 && (
            <span
              role="img"
              className="inline-flex shrink-0 items-center gap-0.5 self-center font-medium text-warning text-xs tabular-nums"
              aria-label={t('line.violation')}
            >
              <IconAlertTriangle size={14} />
              {violationCount}
            </span>
          )}
          <span className="shrink-0 text-right">
            <span className="block font-medium text-foreground text-sm tabular-nums">
              {money(Number(expense.amountMinor), expense.currency, locale)}
            </span>
            {/* Foreign expense: what the employee is actually paid, in the
                entity's home currency (rule 3). A missing rate is said out loud
                — an unconverted foreign amount silently missing from the report
                total is the failure this replaces. */}
            {converted && (
              <span
                className={`block text-[10px] tabular-nums ${
                  converted.missing ? 'text-warning' : 'text-muted-foreground'
                }`}
              >
                {converted.missing
                  ? t('workbench.fxNoRate', { currency: converted.code })
                  : `≈ ${converted.label}`}
              </span>
            )}
          </span>
        </div>
        {/* Line 2 — 👥 attendees · 📎 count · category pills (wrap, left) | tax (right) */}
        <div className="flex items-start gap-2">
          {(expense.attendees?.length ?? 0) > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 pt-0.5 text-muted-foreground text-xs tabular-nums">
              <IconUsers size={12} />
              {expense.attendees.length}
            </span>
          )}
          {expense.receipts.length > 0 && !isBelowLg && (
            <span className="inline-flex shrink-0 items-center gap-0.5 pt-0.5 text-muted-foreground text-xs tabular-nums">
              <IconPaperclip size={12} />
              {expense.receipts.length}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {categories.map((c) => (
              <Badge
                key={c.id}
                variant="outline"
                className="border text-[10px]"
                style={categoryPillStyle(c)}
              >
                {c.icon && <span className="mr-0.5">{c.icon}</span>}
                {c.label}
              </Badge>
            ))}
          </div>
          {tax > 0 && (
            <span className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">
              {t('workbench.taxLabel')} {money(tax, expense.currency, locale)}
            </span>
          )}
        </div>
      </button>
      {/**
       * The paperclip, below `lg`, as a control rather than a count.
       *
       * A sibling of the row button, not a child of it — see `isBelowLg` above.
       * Rendered whether or not there are receipts: with none, this is the only
       * route from an expense to the place a receipt gets attached now that the
       * receipt pane is a sheet, and a control that appears only once you have
       * already done the thing is not a route. The count is drawn when there is
       * one; the accessible name says the whole sentence in either case, which
       * is what a screen reader and iOS voice control both read.
       */}
      {isBelowLg && (
        <button
          type="button"
          onClick={onOpenReceipts}
          aria-label={t('workbench.viewReceipts', { count: expense.receipts.length })}
          className="flex pointer-coarse:min-w-11 shrink-0 items-center justify-center gap-0.5 self-stretch px-3 text-muted-foreground text-xs tabular-nums hover:bg-muted/50"
        >
          <IconPaperclip size={16} aria-hidden="true" />
          {expense.receipts.length > 0 && expense.receipts.length}
        </button>
      )}
    </li>
  );
}

/**
 * The four header fields as prose — date · vendor · currency · location.
 *
 * Lifted out of `ExpenseEditor`'s `!editable` arm unchanged so that the SAME markup can be
 * rendered in two conditions: alone on a submitted report (as before), and beside the
 * editable grid as its below-`lg` face on a draft one.
 *
 * NOT ONE `<Field>`, NOT ONE `<input>`, NOT ONE `aria-label`, and that is a contract rather
 * than a style. On a draft report this renders at the same time as the labelled Date,
 * Vendor, Currency and Location inputs — merely CSS-hidden — and Playwright's label engine
 * has no visibility filter, so a second labelled "Vendor" here would make
 * `e2e/support/workbench.ts:81`'s unscoped, strict `getByLabel('Vendor')` ambiguous in
 * every spec that adds an expense, at 1280 in `chromium`. `getByRole` skips ARIA-hidden
 * nodes and would not have cared; `getByLabel` does. Plain spans, so neither does.
 */
function ExpenseFieldsReadOnly({
  expense,
  locale,
  className,
}: {
  expense: ExpenseDetail;
  locale: string;
  className?: string;
}) {
  const t = useTranslations('expenses');
  return (
    /* Narrow-first: two columns at a phone's width, three from `sm` up — the idiom
       `TotalsReadOnly` already uses. A third of a 360px pane is 120px, narrower than
       the labelled values these cells carry. `col-span-2` still means "the rest of the
       row" in either shape. */
    <div className={`grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3 ${className ?? ''}`}>
      <div>
        <span className="text-muted-foreground text-xs">{t('line.date')}: </span>
        {/* VeloExpense: an expense may have no date yet — a dash. */}
        {expense.date ? new Date(expense.date).toLocaleDateString(locale, { timeZone: 'UTC' }) : '—'}
      </div>
      <div className="col-span-2">
        <span className="text-muted-foreground text-xs">{t('workbench.vendor')}: </span>
        {expense.merchant ?? t('line.noMerchant')}
      </div>
      <div>
        <span className="text-muted-foreground text-xs">{t('line.currency')}: </span>
        {expense.currency.code}
      </div>
      {expense.placeText && (
        <div className="col-span-2">
          <span className="text-muted-foreground text-xs">{t('line.location')}: </span>
          {expense.placeText}
        </div>
      )}
    </div>
  );
}

// ── Center-pane expense editor ────────────────────────────────────────────────
export function ExpenseEditor({
  expense,
  violations,
  currencySymbol,
  editable,
  categoryItems,
  locale,
  onChange,
  entityRecovers,
  locked = false,
}: {
  expense: ExpenseDetail;
  violations: ViolationList;
  currencySymbol: string;
  editable: boolean;
  categoryItems: {
    value: string;
    label: string;
    icon?: string;
    isMileage?: boolean;
    acceptsTip?: boolean;
  }[];
  locale: string;
  onChange: () => void;
  /** `LegalEntity.itcRecoverable`. False (a US entity, any non-registrant) means
   *  recoverable ITC is $0.00 by definition, so the figure is hidden rather than
   *  shown as a zero somebody has to interpret (rule 6). */
  entityRecovers: boolean;
  /** Lock the editor (disabled + overlay) while a receipt is still scanning /
   *  extracting so the fields don't fight the incoming extraction. */
  locked?: boolean;
}) {
  const t = useTranslations('expenses');
  // A warning on this expense makes "Explain this charge" required — a
  // non-empty explanation justifies it server-side (see policy/validate).
  const hasWarning = violations.some((v) => v.severity === 'WARNING');
  // Attendees are only captured when a line item's category requires them
  // (meals/entertainment). Dimensions/allocation are always available.
  const requiresAttendees = expense.lineItems.some((li) => li.category.requiresAttendees);
  /**
   * Overall AI-extraction confidence for this expense's receipt (0–1), and ONLY where the
   * extraction actually succeeded.
   *
   * A failed extraction still writes a row, and its confidence is 0 — so the header
   * badged the failure as "AI: 0%", which reads as an extraction that ran and was certain
   * of nothing rather than one that did not produce anything (GA readiness report F10).
   * `receiptState` already distinguishes the two; the badge just has to ask it.
   */
  const extraction = expense.receipts[0]?.extraction;
  const aiConfidence =
    receiptState(extraction) === 'extracted' ? (extraction?.confidence ?? null) : null;
  const [explanation, setExplanation] = useState(expense.explanation ?? '');
  const explanationMissing = hasWarning && !explanation.trim();
  const updateExpense = trpc.expenses.updateExpense.useMutation({ onSuccess: onChange });
  const deleteExpense = trpc.expenses.deleteExpense.useMutation({ onSuccess: onChange });
  const currencies = trpc.expenses.currencies.useQuery(undefined, { enabled: editable });
  const currencyItems = (currencies.data ?? []).map((c) => ({ value: c.id, label: c.code }));
  /**
   * Per-draft error, so a failed save keeps the row AND says why.
   *
   * The draft used to be discarded synchronously right after `mutate()` — before the
   * write was known — so a rejected create took the typed values with it and showed
   * nothing. A mileage line on a traveller with no country did exactly that: the
   * server returned a precise, actionable PRECONDITION_FAILED and the user saw a row
   * silently vanish.
   */
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  const lineCreate = trpc.expenses.lineItemCreate.useMutation({ onSuccess: onChange });
  // Draft line-item rows (keyed by a running id) — several can be open at once,
  // each committed independently. Adding never blocks on saving a prior draft.
  const [drafts, setDrafts] = useState<number[]>([]);
  const draftSeq = useRef(0);
  const addDraft = () => setDrafts((d) => [...d, draftSeq.current++]);
  const removeDraft = (id: number) => setDrafts((d) => d.filter((x) => x !== id));
  /**
   * What each open draft row currently holds, so the projected totals below can price
   * the whole set. Keyed by draft id and pruned when a row reports `null` (cancelled,
   * saved, or not yet complete enough to price).
   */
  const [draftValues, setDraftValues] = useState<Record<number, DraftLine>>({});
  const setDraftValue = (id: number, draft: DraftLine | null) =>
    setDraftValues(({ [id]: _drop, ...rest }) => (draft ? { ...rest, [id]: draft } : rest));
  // In row order, so the projection's line order matches the screen. (Tax does not
  // depend on order, but a differing order would make the two hard to compare.)
  const openDrafts = useMemo(
    () => drafts.map((d) => draftValues[d]).filter((v): v is DraftLine => v != null),
    [drafts, draftValues],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {locked && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70 backdrop-blur-[1px]">
          <span className="rounded-md border border-border bg-card px-3 py-2 text-muted-foreground text-sm shadow-sm">
            {t('workbench.processingReceipt')}
          </span>
        </div>
      )}
      {/* Expense header — this IS the details panel's title bar (same height /
          typography as the other panels): vendor · amount · AI confidence ·
          delete.

          The testid exists so a test can say "the HEADER names the vendor" and mean it.
          The vendor, the currency code and the amount have always also appeared in the
          read-only field grid below — on a submitted report — and since that grid is now
          rendered on a draft report too (CSS-hidden above `lg`), an unscoped
          `getByText('Corner Bistro')` in jsdom, which applies no CSS, matches both. */}
      <div
        data-testid="expense-header"
        className="flex h-12 shrink-0 items-center gap-3 border-border border-b px-3"
      >
        {/* Left (vendor) · center (AI confidence) · right (amount + delete) —
            the two flex-1 side zones center the AI badge in the bar. */}
        <span className="min-w-0 flex-1 truncate font-semibold text-base text-foreground">
          {expense.merchant?.trim() || t('line.noMerchant')}
        </span>
        {aiConfidence != null && (
          <span className="shrink-0 rounded-full bg-purple-500/15 px-2.5 py-0.5 font-medium text-purple-600 text-xs">
            {t('line.aiConfidence', { pct: Math.round(aiConfidence * 100) })}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <span className="shrink-0 font-semibold text-base text-foreground tabular-nums">
            <span className="mr-1 font-normal text-muted-foreground text-xs">
              {expense.currency.code}
            </span>
            {formatMinor(Number(expense.amountMinor), expense.currency, locale)}
          </span>
          {editable && (
            <button
              type="button"
              aria-label={t('actions.delete')}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => deleteExpense.mutate({ expenseId: expense.id })}
            >
              <IconTrash size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {/**
         * THE ONE `SectionNotice` ON THIS ROUTE, and the only place it is rendered.
         *
         * It used to be five — one at the cost-allocation card, one at the tax panel, one
         * at the line items, one at the attendees, and one in the expenses card over in
         * `ExpenseReportWorkbench`. Each was accurate and each was in the right place, and
         * together they were five copies of one sentence down a single 664px scroll. The
         * register cannot carry that: by the third the reader is skipping a box that is
         * trying to tell them something, and the field grid (which has no notice of its
         * own) was left looking like the one region that was merely broken.
         *
         * Said once, at the top of the editor, it covers the whole of what this pane
         * suppresses — the header fields as well as the four regions that used to carry
         * their own — and the reader meets it before the read-only values rather than
         * after them, which is the order in which it explains anything. That also closes
         * the field-grid gap `docs/design/pwa.md` recorded as an open product call: the
         * answer was not a sixth notice, it was one.
         *
         * Above the violation warnings, not below: this is the frame for the whole pane,
         * and a phone reader who scrolled past it to reach the warnings would have to come
         * back up to find out why the values under them cannot be changed.
         *
         * `editable` for exactly the reason each placement carried it: on a submitted
         * report the editing controls are absent at EVERY width, so a notice saying
         * "changing them is a desktop task" would blame the screen for a refusal the
         * report's status made. `lg:hidden`, so a desktop sees nothing here at all.
         */}
        {editable && <SectionNotice className="lg:hidden" />}
        {violations.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="mb-2 font-medium text-foreground text-xs uppercase tracking-wide">
              {t('drawer.expenseWarnings')}
            </div>
            <ul className="flex flex-col gap-1.5">
              {groupViolations(violations).map((g) => (
                <ViolationLine key={g.key} violation={g.violation} count={g.count} />
              ))}
            </ul>
          </div>
        )}
        {/*
         * ALWAYS BOTH, CSS-SELECTED — not mutually exclusive on `editable` any more.
         *
         * On a DRAFT report (`editable === true`) both faces exist in the DOM at every
         * width and only the viewport decides which one has a box. On a SUBMITTED report
         * (`editable === false`) the editable twin is not rendered at all, exactly as it
         * was before — so `editable` still means precisely what it meant: "the server will
         * accept a mutation on this report". Nothing about the predicate moved, and the
         * server re-derives it from `EDITABLE_REPORT_STATUSES` on every write regardless.
         *
         * The reason it is CSS and not a `useIsBelowLg` branch: a JS branch would UNMOUNT
         * the four inputs on a desktop resize across 1024px and take any half-typed value
         * with them, for a reader who did nothing but drag a window.
         *
         * `lg:contents`, NEVER `lg:block`. The parent is `flex flex-col gap-3 p-3`, so a
         * `block` wrapper would become the flex item and the grid inside it would resolve
         * its own sizing against the wrapper rather than against the column.
         */}
        <ExpenseFieldsReadOnly
          expense={expense}
          locale={locale}
          className={editable ? 'lg:hidden' : undefined}
        />
        {editable && (
          <div className="hidden lg:contents">
            {/* 1/3 · 2/3 grid: date (small, first) · vendor; currency · location.
                Narrow-first like its read-only twin. Inert below `lg` today — this face
                sits inside `hidden lg:contents` — and written that way anyway so that
                the day P12 uncloaks it the grid is already the right shape, and so the
                two faces cannot be read as having different intentions. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Field label={t('line.date')}>
                <Input
                  type="date"
                  // VeloExpense: an undated expense opens with the field empty.
                  defaultValue={expense.date ? new Date(expense.date).toISOString().slice(0, 10) : ''}
                  onBlur={(e) =>
                    e.currentTarget.value &&
                    updateExpense.mutate({ expenseId: expense.id, date: e.currentTarget.value })
                  }
                />
              </Field>
              <div className="col-span-2">
                <Field label={t('workbench.vendor')}>
                  <Input
                    defaultValue={expense.merchant ?? ''}
                    placeholder={t('addLine.merchantPlaceholder')}
                    onBlur={(e) =>
                      updateExpense.mutate({
                        expenseId: expense.id,
                        merchant: e.currentTarget.value || null,
                      })
                    }
                  />
                </Field>
              </div>
              <Field label={t('line.currency')}>
                <Combobox
                  items={currencyItems}
                  value={expense.currencyId}
                  onValueChange={(v) =>
                    v && updateExpense.mutate({ expenseId: expense.id, currencyId: v })
                  }
                  placeholder={t('line.currency')}
                />
              </Field>
              <div className="col-span-2">
                <Field label={t('line.location')}>
                  <Input
                    defaultValue={expense.placeText ?? ''}
                    onBlur={(e) =>
                      updateExpense.mutate({
                        expenseId: expense.id,
                        placeText: e.currentTarget.value || null,
                      })
                    }
                  />
                </Field>
              </div>
            </div>
          </div>
        )}

        {!editable && expense.explanation && (
          <div className="text-sm">
            <span className="text-muted-foreground text-xs">{t('drawer.explanation')}: </span>
            {expense.explanation}
          </div>
        )}

        {editable && (
          <Field label={hasWarning ? `${t('drawer.explanation')} *` : t('drawer.explanation')}>
            <Textarea
              value={explanation}
              placeholder={t('drawer.explanationPlaceholder')}
              aria-invalid={explanationMissing}
              className={explanationMissing ? 'border-warning' : undefined}
              onChange={(e) => setExplanation(e.target.value)}
              onBlur={(e) =>
                updateExpense.mutate({
                  expenseId: expense.id,
                  explanation: e.currentTarget.value || null,
                })
              }
            />
            {explanationMissing && (
              <p className="mt-1 text-warning text-xs">{t('drawer.explanationRequired')}</p>
            )}
          </Field>
        )}

        {/* Cost allocation across BU / Department / Class — before taxes */}
        <AllocationEditor
          expense={expense}
          editable={editable}
          locale={locale}
          onChange={onChange}
        />

        {/* Expense-level tax (a receipt = one tax total) — before line items */}
        <ExpenseTaxPanel
          expense={expense}
          currencySymbol={currencySymbol}
          editable={editable}
          entityRecovers={entityRecovers}
          onChange={onChange}
        />

        {/* Line items */}
        <div>
          <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
            {t('drawer.lineItems')}
          </div>
          {expense.lineItems.length === 0 && drafts.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('drawer.noLines')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {expense.lineItems.map((li) => (
                <LineItemRow
                  key={li.id}
                  line={li}
                  expenseId={expense.id}
                  currencySymbol={currencySymbol}
                  currencyCode={expense.currency.code}
                  editable={editable}
                  categoryItems={categoryItems}
                  locale={locale}
                  onChange={onChange}
                />
              ))}
            </div>
          )}
          {/* No notice here: this region's suppression is named once, at the top of the
              pane — see the single `SectionNotice` in `ExpenseEditor`. The cloak below is
              unchanged, so what this width renders is exactly what it rendered before. */}
          <div className="hidden lg:contents">
            {editable && drafts.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                {drafts.map((d) => (
                  <NewLineForm
                    key={d}
                    categoryItems={categoryItems}
                    expenseId={expense.id}
                    currencySymbol={currencySymbol}
                    currencyCode={expense.currency.code}
                    pending={lineCreate.isPending}
                    error={lineErrors[d]}
                    onDraftChange={(draft) => setDraftValue(d, draft)}
                    onCancel={() => {
                      setLineErrors(({ [d]: _drop, ...rest }) => rest);
                      removeDraft(d);
                    }}
                    onSave={(data) => {
                      setLineErrors(({ [d]: _drop, ...rest }) => rest);
                      // The draft is removed on SUCCESS only. Anything else keeps the row
                      // and its values, so the fix is one edit away rather than a retype.
                      lineCreate.mutate(
                        { expenseId: expense.id, ...data },
                        {
                          onSuccess: () => removeDraft(d),
                          onError: (err) =>
                            setLineErrors((prev) => ({ ...prev, [d]: err.message })),
                        },
                      );
                    }}
                  />
                ))}
              </div>
            )}
            {editable && (
              <Button size="sm" variant="outline" className="mt-2 w-full" onClick={addDraft}>
                <IconPlus size={12} className="mr-1" />
                {t('drawer.addLine')}
              </Button>
            )}
            {/* What saving those drafts will do to the tax and the converted total —
                below the rows it describes. Whether there is anything to show is the
                component's own call, so there is one rule rather than two. */}
            {editable && (
              <ProjectedTotals
                expense={expense}
                drafts={openDrafts}
                entityRecovers={entityRecovers}
              />
            )}
          </div>
        </div>

        {/* Attendees — after line items; only when a line's category requires it */}
        {editable && requiresAttendees && (
          <div>
            <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
              {t('drawer.attendees')}
            </div>
            {/* Named once at the top of the pane, like every other region here. This is
                still the one with nothing to show beneath it — `AttendeesEditor` has no
                read-only twin anywhere in this file, and building it is P13's, with the
                editing. */}
            <div className="hidden lg:contents">
              <AttendeesEditor
                initial={expense.attendees}
                onCommit={(attendees) => updateExpense.mutate({ expenseId: expense.id, attendees })}
                t={t}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Cost-allocation editor ────────────────────────────────────────────────────
/**
 * One allocation row being edited. `''` is unset. `businessUnitId` is the admin business
 * unit; `nsBusinessUnitId` the NetSuite one, which the picker edits when the server says the
 * source is `NETSUITE`. Both are sent on save as they stand — which of them the row is
 * saved with is the server's rule, not the client's.
 */
type AllocRow = {
  percent: string;
  businessUnitId: string;
  nsBusinessUnitId: string;
  departmentId: string;
  classId: string;
};

const BLANK_ALLOC_ROW: Omit<AllocRow, 'percent'> = {
  businessUnitId: '',
  nsBusinessUnitId: '',
  departmentId: '',
  classId: '',
};

function AllocationEditor({
  expense,
  editable,
  locale,
  onChange,
}: {
  expense: ExpenseDetail;
  editable: boolean;
  locale: string;
  onChange: () => void;
}) {
  const t = useTranslations('expenses');
  const opts = trpc.expenses.dimensionOptions.useQuery(undefined, { enabled: editable });
  const save = trpc.expenses.allocationSet.useMutation({ onSuccess: onChange });

  /**
   * The business unit source, learned from `dimensionOptions` and nowhere else. `NETSUITE`
   * lists the NetSuite business units with path labels and edits `nsBusinessUnitId`;
   * anything else (including "not loaded yet") is the admin list editing `businessUnitId`,
   * exactly as before.
   */
  // VeloExpense: never — VeloExpense has no NetSuite business unit source, so
  // `dimensionOptions` always answers EXPENSEOS (w2-03) and the admin picker below is the
  // only one. ExpenseOS: `opts.data?.businessUnitSource === 'NETSUITE'`. Its NETSUITE
  // branches are kept as they are; they never run. Named `ledgerBusinessUnits` where
  // ExpenseOS says `netsuiteBusinessUnits` (check-vendor-neutral).
  const ledgerBusinessUnits = false as boolean;
  /**
   * Nothing is saved, and nothing can be edited, until the options have loaded (or ever,
   * if the query fails). Before then the source is unknown, and a save would have to guess
   * it: guessing EXPENSEOS leaves `nsBusinessUnitId` off the payload, and the server
   * re-saves a line coded only by its NetSuite business unit uncoded. Waiting keeps the
   * EXPENSEOS payload exactly what it was, and drops nothing under NETSUITE.
   */
  const optionsLoaded = opts.data !== undefined;
  // VeloExpense: the admin business units only — ExpenseOS's NETSUITE arm
  // (`businessUnitOptions`, the NetSuite tree as path labels) has no source here.
  const buItems = (opts.data?.businessUnits ?? []).map((b) => ({
    value: b.id,
    label: localeLabel(b.label, locale),
  }));
  const deptItems = (opts.data?.departments ?? []).map((d) => ({
    value: d.id,
    label: localeLabel(d.label, locale),
  }));
  /**
   * THE CLASS LIST IS THE TENANT'S CLASSES AND NOTHING ELSE.
   *
   * It used to lead with a synthetic "No Class" that resolved to a null `classId`, and with
   * class among the required posting dimensions that option guaranteed the rejection it
   * invited — the payload went out with no `class` key for NetSuite to refuse with "Please
   * enter value(s) for: Class". `ClassCombobox` dropped its own copy of the same sentinel
   * for that reason; this editor was the last place still offering one.
   *
   * It was also redundant. A tenant that genuinely posts to a "no class" bucket has a REAL
   * NetSuite Class record for it — DEV's is named exactly "No Class" — and that record is
   * already in this list, so choosing it selects a class NetSuite accepts instead of
   * selecting nothing.
   */
  const classItems = (opts.data?.classes ?? []).map((c) => ({ value: c.id, label: c.name }));
  // VeloExpense: a class is asked for — and required — only where the tenant has classes.
  // VeloExpense has none (`dimensionOptions` sends an empty list, w2-03; `allocationSet`
  // takes no class), so the row is a business unit and a department, and the picker is not
  // drawn. ExpenseOS requires all three, because NetSuite does.
  const hasClasses = classItems.length > 0;
  /**
   * A row whose saved NetSuite business unit is not among the picker's options — the server
   * sends active units only, but keeps a row's own inactive id on purpose. The picker shows
   * it blank while the row still counts as coded, so it is flagged here: otherwise the
   * submitter learns it only when posting refuses the line.
   */
  const buValues = new Set(buItems.map((b) => b.value));
  const inactiveBusinessUnit = (r: AllocRow) =>
    ledgerBusinessUnits && Boolean(r.nsBusinessUnitId) && !buValues.has(r.nsBusinessUnitId);

  // Always start with at least one 100% row — BU/Department/Class are required, so there's
  // no "unallocated" state. A row saved with a null classId (from before the sentinel was
  // removed) reads back as UNPICKED and is flagged as required, which is honest: blank is
  // the state NetSuite rejects.
  //
  // `nsBusinessUnitId` is seeded from the server's `pickerNsBusinessUnitId` — the row's own
  // NetSuite business unit, or the one its admin business unit is aliased to — so a line
  // coded before the switch opens pre-selected, and its next save stores it.
  const [rows, setRows] = useState<AllocRow[]>(() =>
    expense.allocations.length > 0
      ? expense.allocations.map((a) => ({
          percent: String(a.percentBp / 100),
          businessUnitId: a.businessUnitId ?? '',
          nsBusinessUnitId: a.pickerNsBusinessUnitId ?? '',
          departmentId: a.departmentId ?? '',
          classId: a.classId ?? '',
        }))
      : [{ percent: '100', ...BLANK_ALLOC_ROW }],
  );

  const sumBp = rows.reduce((s, r) => s + Math.round((Number(r.percent) || 0) * 100), 0);
  const balanced = sumBp === 10000;
  // Mirrors the server's either-column rule so the editor saves exactly the rows the
  // server accepts: under NETSUITE either column counts, otherwise only the admin one.
  const hasBusinessUnit = (r: AllocRow) =>
    Boolean(r.businessUnitId || (ledgerBusinessUnits && r.nsBusinessUnitId));
  const complete = (r: AllocRow) =>
    Boolean(hasBusinessUnit(r) && r.departmentId && (!hasClasses || r.classId));
  // A row is "started" once any dimension is picked. A pristine, untouched row
  // shows no required-field flags (so a fresh expense isn't nagged before the
  // user has engaged with the allocation at all).
  const started = (r: AllocRow) => Boolean(hasBusinessUnit(r) || r.departmentId || r.classId);
  const showRequired = rows.some((r) => started(r) && !complete(r));
  const showInactive = rows.some(inactiveBusinessUnit);

  /**
   * The row with the business unit picker's new value. Under NETSUITE the admin id goes
   * too: a line still carrying one from before the switch is coded by it (the server keeps
   * such a row), so leaving it would make clearing this picker uncode nothing — and on a
   * pick the server derives the admin id from the NetSuite one anyway.
   */
  const withBusinessUnit = (r: AllocRow, v: string | null): AllocRow =>
    ledgerBusinessUnits
      ? { ...r, nsBusinessUnitId: v ?? '', businessUnitId: '' }
      : { ...r, businessUnitId: v ?? '' };

  const commit = (next: AllocRow[]) => {
    setRows(next);
    const nextSum = next.reduce((s, r) => s + Math.round((Number(r.percent) || 0) * 100), 0);
    // Persist only a complete, balanced set: every row has BU + Department +
    // Class picked and percentages total 100%.
    if (optionsLoaded && next.length > 0 && nextSum === 10000 && next.every(complete)) {
      save.mutate({
        expenseId: expense.id,
        allocations: next.map((r) => ({
          percentBp: Math.round((Number(r.percent) || 0) * 100),
          businessUnitId: r.businessUnitId || null,
          // Under EXPENSEOS the key is left out entirely, so the payload is exactly what it
          // was before the NetSuite column existed (the server writes null there anyway).
          ...(ledgerBusinessUnits ? { nsBusinessUnitId: r.nsBusinessUnitId || null } : {}),
          departmentId: r.departmentId || null,
          classId: r.classId || null,
        })),
      });
    }
  };
  const editRow = (i: number, patch: Partial<AllocRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // ── Read-only view ──
  if (!editable) {
    return (
      <div className="rounded-md border border-border p-3">
        <div className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
          {t('allocation.heading')}
        </div>
        <AllocationLinesReadOnly expense={expense} locale={locale} />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">
          {t('allocation.heading')}
        </span>
        {rows.length > 0 && (
          <span
            className={`text-xs tabular-nums ${balanced ? 'text-muted-foreground' : 'text-warning'}`}
          >
            {sumBp / 100}% / 100%
          </span>
        )}
      </div>
      {/*
       * The below-`lg` face of the rows, and the third always-both region of this pane.
       *
       * The head above it used to be the WHOLE of what a phone was shown: a heading, a
       * "% / 100 %" total and — when a row was half-coded — a warning. So the reader was
       * told there was a problem with the coding and never shown the coding, which is the
       * one shape of suppression the ruling rejects ("these values are current and can be
       * read here" rather than "not available"). The figures are real review content, so
       * they are shown, exactly as the tax panel's are.
       *
       * It is the SAME component the `!editable` arm renders, for the reason
       * `ExpenseFieldsReadOnly` and `TaxFiguresReadOnly` carry in their own headers: one
       * piece of markup serving two conditions cannot drift between them. On a submitted
       * report it is the only face there is, at every width; on a draft it is the phone's.
       *
       * It reads `expense.allocations` — the SAVED set — rather than the local `rows`.
       * Below `lg` the two cannot differ, because the only thing that edits `rows` is the
       * control set cloaked immediately below. Above `lg` this face has no box at all.
       */}
      <AllocationLinesReadOnly expense={expense} locale={locale} className="lg:hidden" />
      {/*
       * PLACEMENT 1 of 5 — cost-allocation editing.
       *
       * The percentage total in the head above stays visible below `lg`: it is the fact a
       * reader needs to understand a coding blocker, not a control. What is cloaked is the
       * row set and the "add a row" button.
       *
       * `lg:contents` rather than `lg:block` even though this card's own parent is a block:
       * the rule is the file's, so the next region that IS a flex child inherits a correct
       * example rather than a coincidentally-harmless one. It also keeps the rows' own
       * `mb`/`mt` spacing collapsing against the card's padding exactly as it does today.
       */}
      <div className="hidden lg:contents">
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, locally-edited rows
            <div key={i} className="flex items-center gap-1.5">
              <div className="relative w-20 shrink-0">
                <Input
                  inputMode="decimal"
                  value={r.percent}
                  aria-label={t('allocation.percent')}
                  onChange={(e) => editRow(i, { percent: e.target.value })}
                  onBlur={() => commit(rows)}
                  disabled={!optionsLoaded}
                  className="w-full pr-5 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground text-xs">
                  %
                </span>
              </div>
              <div
                className={`min-w-0 flex-1 rounded ${(started(r) && !hasBusinessUnit(r)) || inactiveBusinessUnit(r) ? 'ring-1 ring-warning/60' : ''}`}
              >
                <Combobox
                  items={buItems}
                  value={ledgerBusinessUnits ? r.nsBusinessUnitId : r.businessUnitId}
                  onValueChange={(v) =>
                    commit(rows.map((x, idx) => (idx === i ? withBusinessUnit(x, v) : x)))
                  }
                  placeholder={t('allocation.businessUnit')}
                  disabled={!optionsLoaded}
                />
              </div>
              <div
                className={`min-w-0 flex-1 rounded ${started(r) && !r.departmentId ? 'ring-1 ring-warning/60' : ''}`}
              >
                <Combobox
                  items={deptItems}
                  value={r.departmentId}
                  onValueChange={(v) =>
                    commit(rows.map((x, idx) => (idx === i ? { ...x, departmentId: v ?? '' } : x)))
                  }
                  placeholder={t('allocation.department')}
                  disabled={!optionsLoaded}
                />
              </div>
              {/* VeloExpense: only where the tenant has classes (see `hasClasses`). */}
              {hasClasses && (
                <div
                  className={`min-w-0 flex-1 rounded ${started(r) && !r.classId ? 'ring-1 ring-warning/60' : ''}`}
                >
                  <Combobox
                    items={classItems}
                    value={r.classId}
                    onValueChange={(v) =>
                      commit(rows.map((x, idx) => (idx === i ? { ...x, classId: v ?? '' } : x)))
                    }
                    placeholder={t('allocation.class')}
                    disabled={!optionsLoaded}
                  />
                </div>
              )}
              {/* The base 100% row is required and can't be removed. */}
              {rows.length > 1 && (
                <button
                  type="button"
                  aria-label={t('allocation.remove')}
                  className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                  disabled={!optionsLoaded}
                  onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {/* OUTSIDE the cloak, deliberately. "This expense has to be coded" is the sentence a
          submitter needs in order to understand why the report will not submit, and a
          reader who cannot fix it here still has to be able to learn it. The control is
          suppressed; its explanation is not. */}
      {showRequired && <p className="mt-1 text-warning text-xs">{t('allocation.required')}</p>}
      {showInactive && (
        <p className="mt-1 text-warning text-xs">{t('allocation.businessUnitInactive')}</p>
      )}
      <div className="hidden lg:contents">
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          disabled={!optionsLoaded}
          onClick={() => setRows((prev) => [...prev, { percent: '', ...BLANK_ALLOC_ROW }])}
        >
          <IconPlus size={12} className="mr-1" />
          {t('allocation.add')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The saved allocation as prose — one line per row: its share, what that share is in
 * money, and the dimensions it codes to.
 *
 * Lifted out of `AllocationEditor`'s `!editable` arm so that the same markup can be
 * rendered in two conditions: alone on a submitted report (as before), and beside the
 * editable row set as its below-`lg` face on a draft one.
 *
 * NO `<Field>`, NO `<input>`, NO `aria-label` — the same contract `ExpenseFieldsReadOnly`
 * and `TaxFiguresReadOnly` carry, and here it rules out `Percent` specifically: on a draft
 * report this renders at the same time as the `allocation.percent`-labelled input the
 * cloak merely hides, and Playwright's label engine has no visibility filter.
 *
 * The money column is what the read-only arm did not have. A percentage alone is not what
 * a reader is checking — "60 % of what" is the question, and every other figure on this
 * pane is already money. It is derived, never stored: the server allocates by basis point,
 * so this is the expense's own total split by the same arithmetic and rounded once.
 */
function AllocationLinesReadOnly({
  expense,
  locale,
  className,
}: {
  expense: ExpenseDetail;
  locale: string;
  className?: string;
}) {
  const t = useTranslations('expenses');
  /**
   * An UNCODED expense says so, rather than rendering nothing.
   *
   * `return null` hid the whole block the moment a report stopped being editable — so
   * the approver, who is the last person able to catch it, could not see that BU /
   * department / class were blank. It reads as "no allocation section on this expense"
   * rather than "this expense is not coded", and blank coding is exactly what NetSuite
   * rejects downstream (GA readiness report F17, alongside F18 / F21 / F22). Below `lg`
   * on a draft it says the same thing to the submitter, who can still fix it.
   */
  if (expense.allocations.length === 0) {
    return <p className={`text-sm text-warning ${className ?? ''}`}>{t('allocation.none')}</p>;
  }
  return (
    <ul className={`flex flex-col gap-1 text-sm ${className ?? ''}`}>
      {expense.allocations.map((a) => (
        /* `flex-wrap`: at 360 the dimension string is the long part, and it takes its own
           line under the two figures rather than squeezing them. */
        <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-12 shrink-0 text-foreground tabular-nums">{a.percentBp / 100}%</span>
          <span className="shrink-0 text-foreground tabular-nums">
            {money(
              Math.round((Number(expense.amountMinor) * a.percentBp) / 10000),
              expense.currency,
              locale,
            )}
          </span>
          <span className="min-w-0 text-muted-foreground text-xs">
            {[
              // The server names the NetSuite business unit when the switch makes it the
              // line's business unit (`nsBusinessUnitLabel`); otherwise the admin one, as ever.
              a.nsBusinessUnitLabel ??
                (a.businessUnit ? localeLabel(a.businessUnit.label, locale) : null),
              a.department ? localeLabel(a.department.label, locale) : null,
              a.class?.name ?? null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Expense-level tax panel ───────────────────────────────────────────────────
function ExpenseTaxPanel({
  expense,
  currencySymbol,
  editable,
  entityRecovers,
  onChange,
}: {
  expense: ExpenseDetail;
  currencySymbol: string;
  editable: boolean;
  entityRecovers: boolean;
  onChange: () => void;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const refusalText = useRefusalText();

  const code = expense.currency.code;
  const [gst, setGst] = useState(minorToInput(expense.taxGstHstMinor, code));
  const [qst, setQst] = useState(minorToInput(expense.taxQstMinor, code));
  const [pst, setPst] = useState(minorToInput(expense.taxPstMinor, code));
  /** Why the server refused the last edit, shown under the fields it refused. */
  const [refusal, setRefusal] = useState<string | null>(null);

  // Re-sync from the server when the polled report changes these figures (e.g.
  // extraction filled the tax from the receipt, or the split re-derived) — never
  // while the user is editing.
  const editing = useRef(false);
  useEffect(() => {
    if (editing.current) return;
    setGst(minorToInput(expense.taxGstHstMinor, code));
    setQst(minorToInput(expense.taxQstMinor, code));
    setPst(minorToInput(expense.taxPstMinor, code));
  }, [expense.taxGstHstMinor, expense.taxQstMinor, expense.taxPstMinor, code]);

  const update = trpc.expenses.expenseTaxUpdate.useMutation({
    onSuccess: () => {
      setRefusal(null);
      onChange();
    },
    /**
     * A refused figure is NOT one the field should keep showing as if it were saved. The
     * server bounds paid tax by the gross ($5,000 of GST on a $113.98 lunch); before this
     * handler existed the refusal was silent — the typed figure stayed in the box, the
     * stored one stayed what it was, and nothing on screen said they differed. Say why,
     * in the reader's language, and put back what the server still holds.
     */
    onError: (e) => {
      setRefusal(refusalText(e, e.message));
      editing.current = false;
      setGst(minorToInput(expense.taxGstHstMinor, code));
      setQst(minorToInput(expense.taxQstMinor, code));
      setPst(minorToInput(expense.taxPstMinor, code));
    },
  });

  const recoverable =
    Number(expense.recoverableGstHstMinor ?? 0) + Number(expense.recoverableQstMinor ?? 0);

  // No source dropdown: the receipt's extracted tax is the default; any edit here
  // is a manual override of the paid amounts. Recoverable ITC stays engine-derived.
  const commit = (over?: { gst?: string; qst?: string; pst?: string }) => {
    update.mutate({
      expenseId: expense.id,
      taxSource: 'MANUAL',
      taxGstHstMinor: inputToMinor(over?.gst ?? gst, code, locale),
      taxQstMinor: inputToMinor(over?.qst ?? qst, code, locale),
      taxPstMinor: inputToMinor(over?.pst ?? pst, code, locale),
    });
  };

  const onNumFocus = () => {
    editing.current = true;
  };
  const onNumBlur = () => {
    editing.current = false;
    commit();
  };

  /**
   * ONE definition of the card head, rendered in both conditions.
   *
   * It was written out twice — once in each arm — and the two copies were already
   * byte-identical. Now that both arms can be on screen in the same render they have to be
   * one thing, or the phone would carry a second "Taxes" heading and a second recoverable
   * figure in the accessibility tree.
   */
  const head = (
    <div className="mb-2 flex items-start justify-between gap-2">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {t('workbench.taxHeading')}
      </span>
      {entityRecovers && (
        <span className="text-right text-muted-foreground text-xs tabular-nums">
          {t('workbench.recoverable')}:{' '}
          <span className="text-foreground">{money(recoverable, expense.currency, locale)}</span>
        </span>
      )}
    </div>
  );

  if (!editable) {
    return (
      <div className="rounded-md border border-border p-3">
        {head}
        <TaxFiguresReadOnly expense={expense} locale={locale} />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      {head}
      {/*
       * PLACEMENT 2 of 5, and the second of the three always-both regions.
       *
       * GST/HST, QST and PST are real review content — an approver reads them on a phone —
       * so the figures are shown rather than merely named as missing. Below `lg` they are
       * prose; at `lg` and up the three `MoneyInput`s take over and the prose goes.
       *
       * The read-only face carries NO `<Field>` and no `aria-label`. Three labelled
       * "GST/HST" fields would be one too many for any strict `getByLabel`, and the label
       * engine counts a `display:none` node.
       */}
      <TaxFiguresReadOnly expense={expense} locale={locale} className="lg:hidden" />
      <div className="hidden lg:contents">
        {/* Narrow-first like its read-only twin, and inert below `lg` for the same
            reason — see the header-field grid in `ExpenseEditor`. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Field label={t('line.gst')}>
            <MoneyInput
              symbol={currencySymbol}
              locale={locale}
              invalid={gst.trim() !== '' && inputToMinor(gst, code, locale) == null}
              value={gst}
              onFocus={onNumFocus}
              onChange={(e) => setGst(e.target.value)}
              onBlur={onNumBlur}
            />
          </Field>
          <Field label={t('line.qst')}>
            <MoneyInput
              symbol={currencySymbol}
              locale={locale}
              invalid={qst.trim() !== '' && inputToMinor(qst, code, locale) == null}
              value={qst}
              onFocus={onNumFocus}
              onChange={(e) => setQst(e.target.value)}
              onBlur={onNumBlur}
            />
          </Field>
          <Field label={t('workbench.pst')}>
            <MoneyInput
              symbol={currencySymbol}
              locale={locale}
              invalid={pst.trim() !== '' && inputToMinor(pst, code, locale) == null}
              value={pst}
              onFocus={onNumFocus}
              onChange={(e) => setPst(e.target.value)}
              onBlur={onNumBlur}
            />
          </Field>
        </div>
      </div>
      {/* The server's refusal, under the fields it refused (#513). It sits OUTSIDE the
          `hidden lg:contents` cloak and not inside it: only the `MoneyInput`s are
          suppressed below `lg`, and a refusal already in state when the viewport crosses
          the breakpoint would otherwise vanish with no explanation. Nothing below `lg` can
          produce one — the inputs are the only thing that calls the mutation — so this is
          a guard on the resize case, not a second phone surface. */}
      {refusal && (
        <p role="alert" className="mt-2 text-destructive text-xs">
          {refusal}
        </p>
      )}
    </div>
  );
}

/**
 * The three tax figures as prose — GST/HST · QST · PST.
 *
 * Lifted out of `ExpenseTaxPanel`'s `!editable` arm unchanged, for the same reason as
 * `ExpenseFieldsReadOnly`: one piece of markup now has to serve two conditions. Plain
 * spans and no `<Field>`, because on a draft report this renders alongside the three
 * labelled `MoneyInput`s that a `lg:hidden`/`lg:contents` pair merely hides.
 */
function TaxFiguresReadOnly({
  expense,
  locale,
  className,
}: {
  expense: ExpenseDetail;
  locale: string;
  className?: string;
}) {
  const t = useTranslations('expenses');
  return (
    /* Narrow-first, as in `ExpenseFieldsReadOnly` above and `TotalsReadOnly` below. */
    <div
      className={`grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-3 ${className ?? ''}`}
    >
      <div>
        <span className="text-muted-foreground text-xs">{t('line.gst')}: </span>
        {money(Number(expense.taxGstHstMinor ?? 0), expense.currency, locale)}
      </div>
      <div>
        <span className="text-muted-foreground text-xs">{t('line.qst')}: </span>
        {money(Number(expense.taxQstMinor ?? 0), expense.currency, locale)}
      </div>
      <div>
        <span className="text-muted-foreground text-xs">{t('workbench.pst')}: </span>
        {money(Number(expense.taxPstMinor ?? 0), expense.currency, locale)}
      </div>
    </div>
  );
}

// ── Projected totals (the pre-save tax / FX preview) ──────────────────────────

/** A row that is real but cannot be priced in the browser. */
type DraftLine = { categoryId: string; amountMinor: string } | { mileage: true };

/**
 * What the tax, the recoverable ITC and the home-currency total WILL be once the
 * draft rows are saved.
 *
 * Everything above shows the SAVED figures, which is correct and also the problem: while
 * a person is typing a line, the tax panel answers for the lines they have already
 * committed, so the number they are looking at is the answer to a question they stopped
 * asking. The server has computed both since the beginning — this surfaces them before
 * save (legacy UC-01).
 *
 * Three rules, in order of how much damage getting them wrong does:
 *
 *  1. **The arithmetic is the server's.** `totalsPreview` runs the same
 *     `resolveExpenseTax` / `resolveExpenseFx` the save path runs, over the saved lines
 *     plus these drafts. Estimating in the browser would eventually disagree by a cent —
 *     and being a cent off is the kind of wrong that is believed and then reconciled
 *     against.
 *  2. **It must never be mistaken for a saved figure.** Dashed border, its own heading,
 *     muted throughout. If it rendered like the panel above, a stale projection would be
 *     read as fact.
 *  3. **A figure that lags its inputs is worse than no figure** — the old total sitting
 *     beside the new amount reads as the answer. So the projection is shown only while
 *     the query's input still matches what is on screen; in between there is a
 *     placeholder, not a number. (Same rule as the mileage price above it.)
 */
function ProjectedTotals({
  expense,
  drafts,
  entityRecovers,
}: {
  expense: ExpenseDetail;
  /** The open draft rows, in row order. */
  drafts: DraftLine[];
  entityRecovers: boolean;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const priceable = drafts.filter((d): d is { categoryId: string; amountMinor: string } => {
    return !('mileage' in d);
  });
  const unpriceable = drafts.length - priceable.length;

  // Held still until typing stops: "115.00" is six values and only the last is worth a
  // round-trip. Keyed on the serialised set so the identity of the array doesn't matter.
  const wanted = JSON.stringify(priceable);
  const settled = useSettled(wanted, 400);
  const preview = trpc.expenses.totalsPreview.useQuery(
    { expenseId: expense.id, addLines: JSON.parse(settled) as typeof priceable },
    { enabled: priceable.length > 0, staleTime: 15_000 },
  );
  /**
   * Rule 3: only a projection whose inputs are still on screen counts.
   *
   * Two conditions, and both are needed. `settled === wanted` covers the debounce window,
   * where the query is still keyed to the previous amount. `!isFetching` covers the render
   * in between — the settle commits, the query key changes, and for one pass `data` is
   * still the previous key's answer. Either alone leaves a window where the old total sits
   * beside the new amount and reads as the answer to it.
   */
  const current = settled === wanted && !preview.isFetching ? (preview.data ?? null) : null;

  // Nothing typed yet — the saved panels above are the truth, and a second set of
  // figures beside them would only invite a stale read later. Rendering nothing is this
  // component's decision, not the caller's, so an empty draft list is a valid input.
  if (priceable.length === 0 && unpriceable === 0) return null;

  const gross = current ? Number(current.grossMinor) : null;
  const tax = current
    ? Number(current.taxGstHstMinor ?? 0) +
      Number(current.taxQstMinor ?? 0) +
      Number(current.taxPstMinor ?? 0)
    : null;
  const recoverable = current
    ? Number(current.recoverableGstHstMinor ?? 0) + Number(current.recoverableQstMinor ?? 0)
    : null;
  const converted = current
    ? convertedLabel(
        {
          amountMinor: current.grossMinor,
          currency: expense.currency,
          homeCurrency: current.homeCurrency,
          homeAmountMinor: current.homeAmountMinor,
          fxRate: current.fxRate,
        },
        locale,
      )
    : null;
  /** The placeholder that stands in for a figure not yet known. Never a zero — a zero
   *  is a number, and this is the absence of one. */
  const dash = '—';
  const show = (minor: number | null) =>
    minor === null ? dash : money(minor, expense.currency, locale);

  return (
    <div
      // `aria-live` because the figures change without the focus moving: a person typing
      // an amount is not looking down here, and a screen reader would otherwise never
      // announce that the projected total moved.
      aria-live="polite"
      className="rounded-md border border-border border-dashed bg-muted/30 p-3"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">
          {t('workbench.projectedHeading')}
        </span>
        {preview.isFetching && (
          <span className="text-muted-foreground text-xs">{t('workbench.projectedPending')}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-3">
        <div>
          <span className="text-muted-foreground text-xs">{t('drawer.total')}: </span>
          <span className="text-foreground">{show(gross)}</span>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">{t('workbench.taxHeading')}: </span>
          <span className="text-foreground">{show(tax)}</span>
        </div>
        {entityRecovers && (
          <div>
            <span className="text-muted-foreground text-xs">{t('workbench.recoverable')}: </span>
            <span className="text-foreground">{show(recoverable)}</span>
          </div>
        )}
        {/* Only when a conversion applies at all. `missing` is a rate that does not
            exist, which has to be said out loud — the alternative is a blank that
            reads as "no conversion needed". */}
        {converted && (
          <div>
            <span className="text-muted-foreground text-xs">{t('drawer.homeTotal')}: </span>
            {converted.missing ? (
              <span className="text-warning">
                {t('workbench.fxNoRate', { currency: expense.currency.code })}
              </span>
            ) : (
              <span className="text-foreground">{converted.label}</span>
            )}
          </div>
        )}
      </div>
      {/* A mileage row is in the list but not in these figures. Saying so is the
          difference between a projection and a wrong total. */}
      {unpriceable > 0 && (
        <p className="mt-2 text-muted-foreground text-xs">
          {t('workbench.projectedExcludesMileage', { count: unpriceable })}
        </p>
      )}
      {preview.isError && (
        <p className="mt-2 text-warning text-xs">{t('workbench.projectedUnavailable')}</p>
      )}
    </div>
  );
}

// ── Right-pane receipts ───────────────────────────────────────────────────────

/**
 * The receipt pane's attach control — today's 12px text link, character for
 * character. Site 4 of P04's four, and the only single-file one.
 *
 * At a fine pointer this is the whole treatment and nothing below it is used:
 * one control, the same three-state wording it has always had, unchanged.
 *
 * `pointer-coarse:min-h-11` is the one addition, and it is not for the desktop:
 * the icon-only treatment below is chosen in JS, so on a phone's FIRST paint —
 * where `useCoarsePointer()` still answers `false` — this text link is the only
 * control on screen. Sizing it in CSS is what makes it a 44px target in that
 * frame instead of a 16px one, which is the same reason sites 2 and 3 keep
 * their resize unconditional (`RECEIPT_TOUCH` in
 * `ExpenseReportWorkbench.tsx`). Height only, because this label carries text:
 * a fixed square would squash it, and the row is `h-12` so 44px fits. The
 * variant is inert at a fine pointer, so the desktop link is untouched.
 */
const ATTACH_LINK =
  'flex cursor-pointer items-center gap-1 text-primary text-xs pointer-coarse:min-h-11 hover:underline';

/**
 * The same control on a phone, where it is one of a PAIR and icon-only.
 *
 * Icon-only rather than icon-plus-text because this row is `h-12` and already
 * carries a heading, the zoom controls, "Full screen" and a download button:
 * two more text links would not fit at a phone's width, and the shorter of the
 * two ("Take photo") is the one that would have been dropped. So the words move
 * into an `sr-only` span — see the call site — and the icons carry the meaning
 * visually. `text-xs` and `hover:underline` come off because there is no text
 * left to size or underline, and `gap-1` because Tailwind's `sr-only` is
 * absolutely positioned and therefore contributes nothing to a flex gap.
 *
 * A REAL 44px BOX, and `ReceiptFileInput`'s ring declined — the same call as
 * sites 2 and 3, reached by different arithmetic. The only laid-out child here
 * is an 18px icon: Tailwind's `sr-only` span is `position:absolute` at 1px
 * square and contributes nothing to the flex box. So an unsized label paints
 * 18x18, and the primitive's 6px ring would take that to 30x30 — 14px short of
 * 44, not at it. A fixed row height is not the reason it cannot grow: this bar
 * is `flex h-12 shrink-0 items-center`, so a 44px control fits inside 48 with
 * 2px of clearance top and bottom. Hence `pointer-coarse:min-h-11
 * pointer-coarse:min-w-11` plus `justify-center`, and `hitSlop={false}` at the
 * call site.
 *
 * A WIDER RING was the alternative and it is worse. Reaching 44 by ring alone
 * needs 13px per side, and then the pair needs a 26px gap for the two rings to
 * stop overlapping (the row runs `pointer-coarse:gap-3`, 12px) and the ring
 * would reach well into the download button beside it — an invisible target
 * that steals taps from a visible one.
 *
 * `min-w-11` rather than `w-11`/`size-11` because this row can get tight at a
 * phone's width: a fixed width still shrinks under flex, a minimum does not.
 */
const ATTACH_LINK_ICON =
  'flex cursor-pointer items-center justify-center text-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11';

/**
 * Both controls of the coarse-pointer pair, while an upload runs.
 *
 * `disabled` on the inputs stops being sufficient the moment there are two: a
 * person who taps the one they did NOT start the upload with gets silence with
 * nothing to explain it. `pointer-events-none` is what actually swallows that
 * tap and `opacity-50` is what explains it; `aria-disabled` on the label says
 * the same thing to a screen reader, and the accessible name relabels to the
 * drawer's existing "Uploading…". No spinner — this codebase has no
 * `animate-spin` and no `prefers-reduced-motion` handling anywhere, so motion
 * here would open an obligation P04 has no business paying.
 *
 * Coarse only. At a fine pointer the busy state stays exactly what it is today:
 * `disabled` on the one input and the link's own text swapped for "Uploading…",
 * with no dimming and no `aria-disabled`.
 */
const ATTACH_LINK_ICON_BUSY = `${ATTACH_LINK_ICON} pointer-events-none opacity-50`;

export function ReceiptPane({
  expense,
  editable,
  reviewThreshold,
  onChange,
  locked = false,
  moveTargets = [],
  onMoveReceipt,
  sheetOpen = false,
  onSheetOpenChange,
  onRefetchReport,
}: {
  expense: ExpenseDetail | null;
  editable: boolean;
  reviewThreshold: number;
  onChange: () => void;
  /** Lock the viewer (overlay) while the receipt is uploading / AV-scanning. */
  locked?: boolean;
  /**
   * The other expenses on this report, for the "Move to" menu.
   *
   * Drag-and-drop is the gesture people will reach for, but it is mouse-only: no
   * keyboard has a drag, and a touch device has no dragover. The menu is the same
   * operation reachable by tab and by thumb, not a lesser fallback.
   */
  moveTargets?: { id: string; label: string }[];
  onMoveReceipt?: (receiptId: string, toExpenseId: string) => void;
  /**
   * Below `lg` this pane is not a pane — it is a bottom sheet, and this is
   * whether it is open. The host owns the state because the TRIGGER is not in
   * here: it is the paperclip on the expense row, one pane over.
   *
   * Undefined at a fine pointer and at `lg` and up, where the sheet does not
   * exist and nothing reads these.
   */
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
  /**
   * Refetch `expenses.report`. Called when the sheet opens and again whenever
   * the installed app comes back to the foreground with it open — SEC-4. Not a
   * new query and not a new procedure: it is the page's existing one, asked
   * again. See `viewerUrl` for what it is protecting.
   */
  onRefetchReport?: () => void;
}) {
  const t = useTranslations('expenses');
  const refusalText = useRefusalText();
  const uploadUrl = trpc.expenses.receiptUploadUrl.useMutation();
  const receiptCreate = trpc.expenses.receiptCreate.useMutation();
  const receiptRemove = trpc.expenses.receiptRemove.useMutation();
  const lineRemove = trpc.expenses.lineItemRemove.useMutation();
  const startExtraction = trpc.expenses.startExtraction.useMutation();
  const markReviewed = trpc.expenses.markExtractionReviewed.useMutation({ onSuccess: onChange });

  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // A receipt delete or a replace-upload prompts to also remove the line items
  // that were extracted from that receipt (a receipt = one expense's records).
  const [confirm, setConfirm] = useState<
    { kind: 'delete'; receiptId: string; filename: string } | { kind: 'replace'; file: File } | null
  >(null);
  const [alsoRemoveLines, setAlsoRemoveLines] = useState(true);

  const receipts = expense?.receipts ?? [];
  // A move needs an editable report, a source expense, a handler, and somewhere to
  // land. Missing any of those and the row is a plain button.
  const canMove = editable && expense != null && onMoveReceipt != null && moveTargets.length > 0;
  const active = receipts.find((r) => r.id === activeId) ?? receipts[0] ?? null;
  // Resets to fit whenever the viewed file changes.
  const [zoom, setZoom] = useViewerZoom(active?.id);

  /**
   * Is the primary pointer a finger? Read to decide what to RENDER — the camera
   * control, and the icon-only treatment that only makes sense once the pair
   * exists. The rule this follows (attribute → JS, size → CSS) is stated in
   * full at the top of `@/lib/useCoarsePointer`.
   */
  const coarsePointer = useCoarsePointer();

  /**
   * Below Tailwind's `lg` the receipt is not the third of three stacked panes —
   * it is a bottom sheet opened from the expense row's paperclip. A RELOCATION,
   * so the tree is selected in JS with the ruled hook rather than duplicated
   * under CSS: the viewer, its zoom controls and the attach pair all carry
   * accessible names, and two copies of them is two of everything a screen
   * reader and a `getByLabel` can find.
   */
  const isBelowLg = useIsBelowLg();
  /** The sheet exists AND is open — the state the URL freeze is relaxed for. */
  const sheetMode = isBelowLg && sheetOpen;

  /**
   * An upload is running AND there are two controls to silence.
   *
   * Gated on the pointer rather than on `uploading` alone, which is the whole
   * point: the dimming and the relabel exist to answer "why did nothing happen
   * when I tapped the other one", and on a desktop there is no other one. So a
   * fine pointer's busy state is left byte-for-byte as it was.
   */
  const captureBusy = coarsePointer && uploading;

  /** One icon-only control's classes — the same for the camera and the picker. */
  const attachIconLink = captureBusy ? ATTACH_LINK_ICON_BUSY : ATTACH_LINK_ICON;

  const viewerLabels = {
    zoomIn: t('workbench.zoomIn'),
    zoomOut: t('workbench.zoomOut'),
    zoomReset: t('workbench.zoomReset'),
    fullScreen: t('workbench.fullScreen'),
    download: t('workbench.download'),
  };

  // Presigned receipt URLs are regenerated on every poll of the report query
  // (the 4s scan/extraction poll). Freeze the first URL seen per receipt id so
  // the <img>/<iframe> src stays stable across refetches — otherwise the preview
  // reloads (flickers) on every poll while "scanning". Same S3 object + content;
  // only the signature would differ.
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const stableUrl = (r: { id: string; url: string }): string => {
    const cache = urlCacheRef.current;
    if (!cache.has(r.id)) cache.set(r.id, r.url);
    return cache.get(r.id) as string;
  };

  /**
   * SEC-4 — the URL the viewer actually loads, and the freeze is OFF in the sheet.
   *
   * A presigned receipt URL is a bearer credential with a one-hour life. The freeze
   * above exists for a four-second problem: while an extraction is pending the report
   * query re-polls, every poll re-signs every receipt, and an unfrozen `src` would
   * reload the preview each time. That trade is right in a desktop pane, which is on
   * screen continuously and dies with the tab.
   *
   * It is the wrong trade in a sheet. An installed PWA is backgrounded aggressively and
   * the page can sit in memory for hours; reopening the sheet against a frozen URL that
   * expired while the phone was in a pocket renders S3's `AccessDenied` XML INSIDE the
   * viewer, which reads as the receipt having been lost. So in the sheet the viewer
   * reads the URL the server most recently signed, and the effect below asks for a
   * fresh one on open and on every return to the foreground.
   *
   * The flicker this gives back is bounded to the pending-extraction window — the only
   * time the poll runs at all — during which the viewer is already showing "Scanning…"
   * rather than the document.
   */
  const viewerUrl = (r: { id: string; url: string }): string => (sheetMode ? r.url : stableUrl(r));

  /**
   * SEC-4, the other half: ask the server for a fresh signature whenever the sheet
   * becomes readable.
   *
   * `refetchOnWindowFocus: false` and `staleTime: 30_000` were calibrated for a desktop
   * tab, where "focus" is a click into a window that never stopped rendering. A phone
   * backgrounds the installed app, and `visibilitychange` is the event that actually
   * fires when it comes back — `focus` alone misses the standalone-window case on iOS,
   * so both are listened for and the handler is idempotent.
   *
   * It refetches; it does not re-issue anything. Nothing here mutates.
   */
  useEffect(() => {
    if (!sheetMode || !onRefetchReport) return;
    onRefetchReport();
    const refresh = () => {
      if (document.visibilityState === 'visible') onRefetchReport();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [sheetMode, onRefetchReport]);

  const lowConfidence = (expense?.receipts ?? []).filter(
    (r) =>
      r.extraction?.status === 'EXTRACTED' &&
      r.extraction.confidence != null &&
      r.extraction.confidence < reviewThreshold &&
      !r.extraction.reviewedAt,
  );
  const needsReview = editable && lowConfidence.length > 0;

  // An expense takes SEVERAL documents (rule 2), so a second upload ADDS one.
  // It used to prompt to replace, which is why a restaurant bill and its
  // cardholder copy could never both be attached — and the tip on the copy was
  // therefore invisible. On upload the server re-reads the whole set and rebuilds
  // the expense from one determination, so the answer accounts for every file
  // rather than for the newest.
  function pickUpload(file: File) {
    if (!expense) return;
    void uploadReceipt(file);
  }

  async function removeExpenseLines() {
    for (const li of expense?.lineItems ?? []) await lineRemove.mutateAsync({ id: li.id });
  }

  async function uploadReceipt(file: File) {
    if (!expense) return;
    setUploadErr(null);
    setUploading(true);
    try {
      const contentType = file.type || 'application/octet-stream';
      const { url, headers, key } = await uploadUrl.mutateAsync({
        expenseId: expense.id,
        filename: file.name,
        contentType,
        // The link is bound to this exact length, so it must be the body PUT below.
        sizeBytes: file.size,
      });
      const put = await fetch(url, { method: 'PUT', headers, body: file });
      if (!put.ok) throw new Error(t('drawer.uploadFailed'));
      const { id } = await receiptCreate.mutateAsync({
        expenseId: expense.id,
        key,
        filename: file.name,
        contentType,
        sizeBytes: file.size,
        deferExtraction: true,
      });
      onChange();
      await startExtraction.mutateAsync({ receiptIds: [id] });
    } catch (err) {
      setUploadErr(refusalText(err, t('drawer.uploadFailed')));
    } finally {
      setUploading(false);
    }
  }

  async function confirmProceed() {
    const c = confirm;
    if (!c) return;
    setConfirm(null);
    try {
      if (alsoRemoveLines) await removeExpenseLines();
      if (c.kind === 'delete') {
        await receiptRemove.mutateAsync({ id: c.receiptId });
        onChange();
      } else {
        // Replace: drop the existing receipt(s), then upload the new file.
        for (const r of receipts) await receiptRemove.mutateAsync({ id: r.id });
        await uploadReceipt(c.file);
      }
    } catch (err) {
      setUploadErr(refusalText(err, t('drawer.uploadFailed')));
    }
  }

  const OUTER = isBelowLg
    ? // In the sheet the panel IS the card: the drawer draws the border, the
      // rounding and the surface, so repeating them here would paint a card
      // inside a card with a 1px seam down both edges.
      'flex min-h-0 flex-1 flex-col overflow-hidden'
    : 'flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card';

  /**
   * The sheet, below `lg` — the shipped `DrawerContent side="bottom"`, the same
   * component and the same shape as `FilterSheet` and `SortSheet`. Nothing new is
   * written here; a second bottom-sheet implementation is a second set of focus,
   * escape, scroll-lock and safe-area behaviours to keep in step.
   *
   * `dismissible`, like the other two and unlike the Drawer default: this sheet is
   * a READER over the list behind it, and it must yield to a tap outside and to
   * Esc. The default is the opposite because the case it was written for is a
   * half-filled form, where the same gesture loses work. Nothing is lost here —
   * attaching, deleting and moving a receipt each commit on their own press.
   *
   * `hideCloseButton`, like `FilterSheet`: the built-in X is a 24px target on a
   * touch surface. The ways out are the footer's Close, a tap outside, and Esc.
   *
   * The TRIGGER is not in this component. It is the paperclip on the expense row
   * (`ExpenseListRow`), which is where a reader looks to find out whether an
   * expense has a receipt at all, and the host owns the open state between them.
   */
  const asSheet = (body: ReactNode) =>
    isBelowLg ? (
      <Drawer open={sheetOpen} onOpenChange={onSheetOpenChange} dismissible>
        <DrawerContent side="bottom" hideCloseButton className="max-h-[calc(100dvh-4rem)]">
          <DrawerHeader className="pr-5">
            <DrawerTitle>{t('drawer.receipt')}</DrawerTitle>
          </DrawerHeader>
          {body}
          {/* A real 44px way out, in the one place a thumb reaches without
              crossing the sheet. `DrawerClose` is the primitive's own, so Esc,
              the overlay tap and this button all end in the same place. */}
          <div className="shrink-0 border-border border-t p-3">
            <Button
              variant="secondary"
              className="pointer-coarse:min-h-11 w-full"
              onClick={() => onSheetOpenChange?.(false)}
            >
              {t('drawer.close')}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    ) : (
      body
    );

  if (!expense) {
    return asSheet(
      <div className={OUTER}>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
          {t('workbench.selectPrompt')}
        </div>
      </div>,
    );
  }

  const isPdf = (active?.contentType ?? '').toLowerCase().includes('pdf');
  const isImage = (active?.contentType ?? '').toLowerCase().startsWith('image/');

  return asSheet(
    <div className={`relative ${OUTER}`}>
      {locked && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/70 backdrop-blur-[1px]">
          <span className="rounded-md border border-border bg-card px-3 py-2 text-muted-foreground text-sm shadow-sm">
            {t('workbench.processingReceipt')}
          </span>
        </div>
      )}
      {/* Title bar: title (left) · zoom (centered) · full-screen + download +
          attach (right). Attach stays available: an expense takes as many
          documents as it takes to prove the claim.

          It WRAPS below `lg`. At 360 the row carries a heading, three zoom
          controls and the attach pair, which does not fit on one line — and the
          bar is `h-12` inside an `overflow-hidden` card, so what does not fit is
          not clipped, it is painted over the receipt. `h-auto` with a `min-h-12`
          floor keeps the desktop row's height while letting the phone row become
          two. `lg:` puts the single-line shape back verbatim. */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-border border-b px-3 py-1 lg:h-12 lg:flex-nowrap lg:py-0">
        {/* In the sheet the heading is the `DrawerTitle`, so rendering it again
            here would put "Receipt" in the accessibility tree twice. */}
        {!isBelowLg && (
          <h3 className="shrink-0 font-semibold text-base text-foreground">
            {t('drawer.receipt')}
          </h3>
        )}
        <div className="flex flex-1 justify-center">
          {active && (isImage || isPdf) && (
            <ZoomControls zoom={zoom} onZoom={setZoom} labels={viewerLabels} />
          )}
        </div>
        {/* `pointer-coarse:gap-3`, and it is spacing rather than a collision
            fix. This site sizes its controls to 44px and declines
            `ReceiptFileInput`'s hit-slop, so there is no 6px ring here to
            overlap its twin or to reach into the download button — both of
            those conditions belong to site 1, which keeps the ring. 12px stays
            because two 44px targets 8px apart in a 48px bar are easy to
            mis-tap. Coarse-scoped because the pair only exists there — the
            desktop row's spacing is untouched. */}
        <div className="flex items-center gap-2 pointer-coarse:gap-3">
          {/**
           * SEC-2 and SEC-3 — and the reason both links are ABSENT below `lg`
           * rather than `max-lg:hidden`.
           *
           * A presigned receipt URL is a bearer credential to a financial document,
           * valid for up to an hour, with no second factor. On iOS a `target="_blank"`
           * navigation out of a standalone PWA window hands that URL to Safari: it
           * lands in the default browser's history and tab list and anything the share
           * sheet can reach, and it stays live for the rest of its hour. The in-window
           * sheet is the full-screen viewer on a phone, which is SEC-2.
           *
           * Hiding them in CSS would not have been the same thing. The `href` would
           * still be a real presigned URL sitting in the DOM of a page whose own
           * full-screen affordance is a sheet — reachable by long-press on a touch
           * surface that ignores `display:none` no more reliably than it does today,
           * by any "copy link" path, and by anything reading the document. SEC-3 says
           * the URL must never reach a share sheet, the clipboard, or any string the
           * user can copy, and the only way to hold that line is for the string not to
           * be there. The desktop tree is untouched: at `lg` and up both links render
           * exactly as they always have.
           */}
          {active && !isBelowLg ? (
            <>
              <a
                href={stableUrl(active)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
              >
                <IconMaximize size={13} />
                {t('workbench.fullScreen')}
              </a>
              <a
                href={stableUrl(active)}
                download={active.filename}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('workbench.download')}
              >
                <IconDownload size={15} />
              </a>
            </>
          ) : null}
          {editable && (
            <ReceiptFileInput
              disabled={uploading}
              /**
               * Single-file, here and nowhere else among the four sites. No
               * `multiple` today and none after: `pickUpload` takes ONE file
               * and this pane's whole upload path is written around that.
               *
               * `hitSlop={false}`, as at sites 2 and 3 — see
               * `ATTACH_LINK_ICON` above. Both controls here are sized to a
               * real 44px box, which fits inside this `h-12` bar with 2px of
               * clearance, so the primitive's invisible 6px ring would only
               * add reach outside a control that is already the right size —
               * and import its neighbour-clearance condition onto a row whose
               * next-door neighbour is a download button.
               */
              hitSlop={false}
              className={coarsePointer ? attachIconLink : ATTACH_LINK}
              aria-disabled={captureBusy || undefined}
              camera={{
                className: attachIconLink,
                'aria-disabled': captureBusy || undefined,
                children: (
                  <>
                    <IconCamera size={18} aria-hidden="true" />
                    {/*
                      The control's accessible name, and the only place it comes
                      from: one string, one translation, and voice control
                      ("tap Take photo") matches what a sighted user is told the
                      icon means. NOT `aria-label` — on a `<label>` element it
                      does nothing useful, and on the input it would shadow the
                      visible text at the two labelled sites.
                    */}
                    <span className="sr-only">
                      {captureBusy ? t('drawer.uploading') : t('capture.takePhoto')}
                    </span>
                  </>
                ),
              }}
              /**
               * `files[0]`, exactly as the inline handler did: the primitive
               * hands over the whole `FileList` and deciding which of those two
               * shapes a site wants is the site's business. Read synchronously
               * — the primitive resets the input's value straight after this
               * returns, and that empties this very object.
               */
              onFiles={(files) => {
                const file = files[0];
                if (file) pickUpload(file);
              }}
            >
              {coarsePointer ? (
                <>
                  <IconPaperclip size={18} aria-hidden="true" />
                  <span className="sr-only">
                    {captureBusy ? t('drawer.uploading') : t('capture.chooseFile')}
                  </span>
                </>
              ) : (
                /**
                 * A desktop keeps the three-state text link it has always had.
                 * On a phone the middle state — "Attach another" — is dropped,
                 * and the signal it carried is not lost: the receipt list
                 * renders directly beneath this bar whenever
                 * `receipts.length > 0`, so "something is already attached" is
                 * carried by the visible filenames rather than only by the verb.
                 */
                <>
                  <IconPaperclip size={12} />
                  {uploading
                    ? t('drawer.uploading')
                    : receipts.length > 0
                      ? t('drawer.attachAnother')
                      : t('drawer.attach')}
                </>
              )}
            </ReceiptFileInput>
          )}
        </div>
      </div>

      {/* File + extraction status (directly under the title). */}
      {receipts.length > 0 && (
        <ul className="flex shrink-0 flex-col gap-1 border-border border-b p-2">
          {receipts.map((r) => (
            /* `pointer-coarse:gap-3`: the last control in this row deletes a financial
               document, and it sits one gutter from its neighbour. 8px between a 44px
               destructive target and that neighbour is a mis-tap; 12px is the same
               clearance the title bar's control pair already asks for, and it is
               coarse-scoped so the desktop row's spacing is untouched.

               Below `lg` the neighbour is the document's own name button rather than the
               move picker, which is cloaked there — so the clearance is asked for on the
               same axis for one fewer reason, and is kept for the coarse pointer at `lg`
               and up, where the picker is still beside it. */
            <li key={r.id} className="flex items-center gap-2 pointer-coarse:gap-3 text-sm">
              <button
                type="button"
                onClick={() => setActiveId(r.id)}
                // Draggable only when the report can be edited AND there is somewhere
                // to drop it. A drag that can never land is a worse affordance than
                // no drag at all.
                draggable={canMove}
                onDragStart={
                  canMove && expense
                    ? (e) => {
                        setReceiptDrag(e.dataTransfer, {
                          receiptId: r.id,
                          fromExpenseId: expense.id,
                          filename: r.filename,
                        });
                      }
                    : undefined
                }
                /* `.einc-tap-slop`, vertical only: the row is already the full width
                   of the pane, and this is the only way to switch between receipts
                   inside the sheet. The slop is coarse-pointer-only, so a mouse sees
                   the 22px row it has always seen. */
                className={`einc-tap-slop flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted ${
                  active?.id === r.id ? 'bg-muted' : ''
                } ${canMove ? 'cursor-grab active:cursor-grabbing' : ''}`}
              >
                <IconFileText size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{r.filename}</span>
                {/* What this document turned out to be. OTHER is the default the
                    row is created with, so it says nothing worth the space. */}
                {r.kind && r.kind !== 'OTHER' && (
                  <Badge variant="outline" className="shrink-0 border text-[10px]">
                    {t(`documentKind.${r.kind}`)}
                  </Badge>
                )}
                <ExtractionBadge extraction={r.extraction} />
              </button>
              {/* A statement evidences several charges, so it gets its own action:
                  the move above puts a document on ONE expense, and that is the wrong
                  shape for a page that covers five. Shown only on statement rows —
                  offering it on a restaurant bill would invite attaching one meal's
                  receipt to five expenses. */}
              {/* VeloExpense: the statement action and its dialog (`StatementApplyDialog`,
                  `statementTargets`, `statementApply`) match a statement's EXTRACTED lines
                  to expenses, and arrive with extraction (Wave 3). Nothing marks a receipt
                  a BANK_STATEMENT until then. */}
              {canMove && (
                /*
                 * PLACEMENT — moving a document to another expense, suppressed below `lg`.
                 *
                 * It is editing, and of a kind that is hard to read and easy to fire by
                 * accident: an unlabelled 7rem picker sitting between the document's name
                 * and a trash can, whose options are other expenses on the report, and
                 * whose effect is invisible from here — the document leaves this pane, the
                 * selection follows it, and if it was the last document on this expense
                 * the expense is deleted server-side. On a phone it opened as a platform
                 * picker beside the receipt the reader had just tapped to LOOK at, which
                 * is how it was read as part of the viewer rather than as an action.
                 *
                 * `hidden lg:contents` and not an unmount: the same rule as every other
                 * suppressed control on this route. The `<li>` is a flex row, so a
                 * `lg:block` wrapper would become its flex item and take the select's own
                 * `shrink-0` and `max-w` out of the row's arithmetic; hidden, it is not a
                 * flex item at all, which is exactly the absent case — the name button
                 * keeps its `flex-1` and the delete control keeps the end of the row.
                 *
                 * The drag on the row above is untouched: a touch device has no dragover,
                 * so below `lg` it was never reachable to begin with.
                 */
                <div className="hidden lg:contents">
                  <select
                    aria-label={t('workbench.moveReceiptTo')}
                    title={t('workbench.moveReceiptTo')}
                    // A select, not a menu: the whole operation is "pick one of these
                    // expenses", which is what a select already is — and it is keyboard
                    // and screen-reader native without any of the roving-tabindex work
                    // a custom menu would need. Value resets so the same target can be
                    // chosen twice in a row.
                    value=""
                    /* A real `min-h-11`, not `.einc-tap-slop`. The slop utilities work by
                       `::after`, and a `<select>` is a replaced element whose generated
                       content browsers are free not to render — a hit region that may or
                       may not exist is worse than none. Growing the trigger box is the
                       same 44px and it is guaranteed. Only the trigger needs it: a coarse
                       pointer at `lg` and up still gets this control, and there iOS hands
                       the option list to the platform picker. */
                    className="pointer-coarse:min-h-11 max-w-[7rem] shrink-0 rounded border border-input bg-transparent px-1 py-0.5 text-muted-foreground text-xs"
                    onChange={(e) => {
                      const to = e.target.value;
                      e.currentTarget.value = '';
                      if (to) onMoveReceipt?.(r.id, to);
                    }}
                  >
                    <option value="">{t('workbench.moveReceiptTo')}</option>
                    {moveTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {editable && (
                <button
                  type="button"
                  aria-label={t('actions.delete')}
                  /* A REAL box rather than `.einc-tap-slop-both`, and the reason is
                     that this control is destructive. `-both` reaches 44px with an
                     INVISIBLE `::after` that paints above whatever it overlaps and
                     wins the tap: 13px of glyph needs 15.5px a side, which is more
                     than the 12px gutter beside it, so the picker's own box would
                     start deleting documents. A `min-h-11 min-w-11` box occupies the
                     space it claims, so the gutter stays a gutter. Coarse-only, so
                     the desktop glyph is untouched. */
                  className="inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    // Only offer to clear the itemization when this is the LAST
                    // document. With others still attached the server re-determines
                    // the expense from what remains, so wiping the lines by hand
                    // would just discard work it is about to redo correctly.
                    setAlsoRemoveLines(
                      receipts.length === 1 && (expense.lineItems.length ?? 0) > 0,
                    );
                    setConfirm({ kind: 'delete', receiptId: r.id, filename: r.filename });
                  }}
                >
                  <IconTrash size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {uploadErr && <p className="px-3 py-1 text-destructive text-xs">{uploadErr}</p>}

      {confirm && (
        <div className="flex flex-col gap-2 border-warning/40 border-b bg-warning/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            <span className="text-foreground text-xs">
              {confirm.kind === 'delete'
                ? t('drawer.removeReceiptConfirm', { filename: confirm.filename })
                : t('drawer.replaceReceiptConfirm')}
            </span>
          </div>
          {expense.lineItems.length > 0 && (
            <label className="ml-6 flex cursor-pointer items-center gap-2 text-foreground text-xs">
              <input
                type="checkbox"
                checked={alsoRemoveLines}
                onChange={(e) => setAlsoRemoveLines(e.target.checked)}
              />
              {t('drawer.removeRecordsAlso', { count: expense.lineItems.length })}
            </label>
          )}
          <div className="ml-6 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={confirmProceed}>
              {confirm.kind === 'delete' ? t('actions.delete') : t('drawer.replaceReceipt')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              {t('addLine.cancel')}
            </Button>
          </div>
        </div>
      )}

      {needsReview && (
        <div className="flex items-center justify-between gap-2 border-warning/40 border-b bg-warning/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            <span className="text-foreground text-xs">{t('extraction.reviewPrompt')}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={markReviewed.isPending}
            onClick={() => {
              for (const r of lowConfidence) markReviewed.mutate({ receiptId: r.id });
            }}
          >
            {t('extraction.markReviewed')}
          </Button>
        </div>
      )}

      {receipts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
          {t('drawer.noReceipts')}
        </div>
      ) : (
        // Viewer — edge-to-edge (no padding). Blocked until the AV scan clears.
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
          {active && !scanCleared(active.extraction) ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm">
              <span
                className={
                  active.extraction?.scanStatus === 'INFECTED'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }
              >
                {active.extraction?.scanStatus === 'INFECTED'
                  ? t('extraction.infected')
                  : active.extraction?.scanStatus === 'FAILED'
                    ? t('extraction.failed')
                    : // A receipt with no extraction row at all, past the grace window, is
                      // not being scanned — nothing is coming. Saying so beats a
                      // placeholder that never resolves.
                      !active.extraction && !awaitingPipeline(active)
                      ? t('extraction.notReported')
                      : t('extraction.scanning')}
              </span>
            </div>
          ) : active && (isImage || isPdf) ? (
            // Fit-to-pane at 100%, our controls the only controls — the same
            // component the card workbench renders, so the two can't diverge.
            <AttachmentDocument
              file={{
                id: active.id,
                filename: active.filename,
                url: viewerUrl(active),
                mimeType: isPdf ? 'application/pdf' : 'image/*',
              }}
              zoom={zoom}
              className="h-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
              {t('extraction.ready')}
            </div>
          )}
        </div>
      )}
    </div>,
  );
}

function ExtractionBadge({ extraction }: { extraction: ExtractionDetail }) {
  const t = useTranslations('expenses');
  const st = receiptState(extraction);
  if (!st) return null;
  const variant: 'destructive' | 'success' | 'secondary' | 'outline' =
    st === 'infected'
      ? 'destructive'
      : st === 'extracted'
        ? 'success'
        : st === 'scanning' || st === 'extracting'
          ? 'secondary'
          : st === 'scanFailed' || st === 'extractFailed'
            ? 'secondary'
            : 'outline'; // ready / notConfigured — a neutral, non-alarming chip
  const label: string = {
    scanning: t('extraction.scanning'),
    infected: t('extraction.infected'),
    scanFailed: t('extraction.failed'),
    extracting: t('extraction.extracting'),
    extracted: t('extraction.done'),
    extractFailed: t('extraction.extractFailed'),
    notConfigured: t('extraction.notConfigured'),
    ready: t('extraction.ready'),
  }[st];
  return <Badge variant={variant}>{label}</Badge>;
}

// ── Policy violation line (display-only) ──────────────────────────────────────
// The friendly label is resolved from the message KEY the engine stored
// (`violation.message` currently holds the messageKey, e.g. "perTransactionLimit")
// via `policy.labels.*`, falling back to the raw value. Justification is the
// expense's "Explain this charge" field (see ExpenseEditor), not per-violation.
/**
 * Both helpers now live in `@/components/policy/violations` — travel requests raise
 * violations too, and the grouping and placeholder rules are the same problem on both
 * sides. Re-exported here so the existing importers (and their tests) keep their path.
 */
export { groupViolations, violationValues };

function ViolationLine({
  violation,
  count = 1,
}: {
  violation: ReportDetail['violations'][number];
  count?: number;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const sev = SEVERITY_KEY[violation.severity] ?? 'info';
  const labelKey = `policy.labels.${violation.message}`;
  const label = t.has(labelKey as never)
    ? t(labelKey as never, violationValues(violation, locale) as never)
    : violation.message;
  const iconCls =
    sev === 'error'
      ? 'text-destructive'
      : sev === 'warning'
        ? 'text-warning'
        : 'text-muted-foreground';

  return (
    <li className="flex items-start gap-2 text-sm">
      <IconAlertTriangle size={14} className={`mt-0.5 shrink-0 ${iconCls}`} />
      <span className="text-foreground text-xs">
        <span className="text-muted-foreground">{t(`policy.${sev}`)}: </span>
        {label}
        {/**
         * "on 3 lines", not a bare "×3".
         *
         * This is an OCCURRENCE count — how many line items raised the same rule — while the
         * top-bar count and the row badge show DEDUPED issue counts for the same violations.
         * Three numbers about one report, disagreeing, with nothing saying they measure
         * different things (GA readiness report F11; the duplication half of that finding was
         * separately shown not to be a defect). Labelling it is what stops it reading as a
         * competing total.
         */}
        {count > 1 && (
          <span className="ml-1 text-muted-foreground">{t('policy.onNLines', { count })}</span>
        )}
      </span>
    </li>
  );
}

// ── Attendees editor ──────────────────────────────────────────────────────────
type AttendeeRow = { name: string; company: string; isExternal: boolean };

function AttendeesEditor({
  initial,
  onCommit,
  t,
}: {
  initial: ExpenseDetail['attendees'];
  onCommit: (
    attendees: Array<{ name: string; company: string | null; isExternal: boolean }>,
  ) => void;
  t: ReturnType<typeof useTranslations<'expenses'>>;
}) {
  const [rows, setRows] = useState<AttendeeRow[]>(() =>
    (initial ?? []).map((a) => ({
      name: a.name,
      company: a.company ?? '',
      isExternal: a.isExternal,
    })),
  );
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(h);
  }, [query]);
  const dir = trpc.expenses.attendeeDirectory.useQuery(
    { query: debounced },
    { enabled: debounced.length >= 2 },
  );

  const commit = (next: AttendeeRow[]) => {
    setRows(next);
    onCommit(
      next
        .filter((r) => r.name.trim())
        .map((r) => ({
          name: r.name.trim(),
          // Company applies to external attendees only; internal (employee) rows
          // never carry one.
          company: r.isExternal ? r.company.trim() || null : null,
          isExternal: r.isExternal,
        })),
    );
  };
  const edit = (i: number, patch: Partial<AttendeeRow>) =>
    setRows((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional, locally-edited rows
        <div key={i} className="flex items-center gap-2 rounded-md border border-border p-2">
          {r.isExternal ? (
            <>
              <Input
                value={r.name}
                placeholder={t('attendee.name')}
                className="min-w-0 flex-1"
                onChange={(e) => edit(i, { name: e.currentTarget.value })}
                onBlur={() => commit(rows)}
              />
              <Input
                value={r.company}
                placeholder={t('attendee.company')}
                className="min-w-0 flex-1"
                onChange={(e) => edit(i, { company: e.currentTarget.value })}
                onBlur={() => commit(rows)}
              />
            </>
          ) : (
            // A picked employee is display-only — no name or company inputs.
            <span className="min-w-0 flex-1 truncate text-foreground text-sm">{r.name}</span>
          )}
          <Badge variant={r.isExternal ? 'outline' : 'secondary'} className="shrink-0 text-[10px]">
            {r.isExternal ? t('attendee.external') : t('attendee.internal')}
          </Badge>
          <button
            type="button"
            aria-label={t('attendee.remove')}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => commit(rows.filter((_, idx) => idx !== i))}
          >
            <IconTrash size={14} />
          </button>
        </div>
      ))}

      {/* Add: employee picker (internal) + free-text external. */}
      <div className="flex flex-col gap-1.5 rounded-md border border-border border-dashed p-2">
        <Input
          value={query}
          placeholder={t('attendee.searchPlaceholder')}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        {debounced.length >= 2 && (dir.data ?? []).length > 0 && (
          <ul className="max-h-40 overflow-y-auto rounded border border-border">
            {(dir.data ?? []).map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="flex w-full flex-col px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    commit([...rows, { name: u.name, company: '', isExternal: false }]);
                    setQuery('');
                  }}
                >
                  <span className="text-foreground text-sm">{u.name}</span>
                  <span className="text-muted-foreground text-xs">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="w-full"
          onClick={() => setRows((prev) => [...prev, { name: '', company: '', isExternal: true }])}
        >
          <IconPlus size={12} className="mr-1" />
          {t('attendee.addExternal')}
        </Button>
      </div>
    </div>
  );
}

// ── Line-item row (view + edit) ───────────────────────────────────────────────
function LineItemRow({
  line,
  expenseId,
  currencySymbol,
  currencyCode,
  editable,
  categoryItems,
  locale,
  onChange,
}: {
  line: LineItemDetail;
  /** The parent expense — the mileage price is derived from its owner and date. */
  expenseId: string;
  currencySymbol: string;
  currencyCode: string;
  editable: boolean;
  categoryItems: {
    value: string;
    label: string;
    icon?: string;
    isMileage?: boolean;
    acceptsTip?: boolean;
  }[];
  locale: string;
  onChange: () => void;
}) {
  const t = useTranslations('expenses');
  /**
   * Same failure as the new-line form, reached a different way: switch an existing line
   * to a mileage category and enter a distance, and the reprice can be refused — for a
   * traveller with no country, or a country with no rate in force. Without this the
   * refusal was invisible and the row simply kept its old figure, which is worse than an
   * error because it looks like it worked.
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  const update = trpc.expenses.lineItemUpdate.useMutation({
    onSuccess: () => {
      setSaveError(null);
      onChange();
    },
    onError: (e) => setSaveError(e.message),
    // Release the route hold once the write has landed either way. On success the
    // next refetch carries what was just saved, so a re-sync is now agreement
    // rather than a clobber; on failure the guard must not stick and freeze the row
    // against every future server update.
    onSettled: () => {
      routePending.current = false;
    },
  });
  const remove = trpc.expenses.lineItemRemove.useMutation({ onSuccess: onChange });

  const [category, setCategory] = useState<string | null>(line.categoryId);
  const [amount, setAmount] = useState(minorToInput(line.amountMinor, currencyCode));
  const [km, setKm] = useState(line.mileageDistance ?? '');
  // The unit the traveller is typing in. Defaults to whatever the line was priced
  // in; the server converts to the rule's unit, so switching never changes which
  // band the distance falls into.
  const [distanceUnit, setDistanceUnit] = useState<'KM' | 'MI'>(line.mileageUnit ?? 'KM');
  // From / stops / To. Shown under the row for a mileage line; the distance it
  // measures lands in the field above rather than replacing it, so a traveller
  // can still overwrite it.
  const [route, setRoute] = useState<RouteValue>(
    (line.mileageRoute as RouteValue | null) ?? EMPTY_ROUTE,
  );
  /** Whether the distance was MEASURED rather than typed — the one fact that
   *  decides whether switching unit converts the number or reinterprets it. */
  const routeMeasured = route.stops.some((st) => st.description.trim());

  /** Capabilities of a category id, as the strategy table reads them. */
  const capsOf = (cat: string | null | undefined) => categoryItems.find((c) => c.value === cat);
  /**
   * Which extra fields this row shows, by strategy rather than by an `isMileage` test —
   * so a fourth kind is an entry in `LINE_KIND_STRATEGIES` and not another arm here.
   * The SERVER still decides the stored `kind` (see lineKinds.tsx).
   */
  const strategy = strategyFor(capsOf(category));
  const isMileage = (over?: string | null) =>
    (over !== undefined ? capsOf(over) : capsOf(category))?.isMileage ?? false;
  /** The tip already on this line, in major units, for the tip strategy's field. */
  /**
   * The tip already on this line, in major units, for the tip strategy's field.
   *
   * BLANK when there is none, not "0.00". `tipMinorOf` returns `0n` for a line with no
   * tip, and seeding that as "0.00" both misrepresents it — the server treats `tip <= 0`
   * as no tip at all — and breaks typing, since the first keystroke appends to the zero
   * and yields NaN.
   */
  const [tip, setTip] = useState(() => {
    const existing = tipMinorOf(line as never);
    return existing > 0n ? minorToInput(String(existing), currencyCode) : '';
  });

  /**
   * Re-sync from the server when the polled report genuinely changes this line
   * (e.g. extraction rebuilt the line set) — never while the row is being edited.
   * This is what lets extraction results appear without a manual page refresh.
   *
   * `routeKey` rather than `line.mileageRoute`, and this is the whole bug behind
   * "adding a line refreshes the screen" and "mileage measures once and then never
   * again". `mileageRoute` is a Json column, so Prisma hands back a NEW OBJECT on
   * every fetch even when the stored value is byte-identical — and adding a line
   * triggers a full report refetch. So this effect re-ran for EVERY row on every
   * refetch and reset all of them, discarding whatever was half-entered. A route
   * with a freshly-added stop was replaced by the server's older copy, and because
   * RouteEditor remembers the stop set it last measured, the restored route was
   * "already measured" and no new measurement ever fired.
   *
   * Serializing makes the dependency the route's VALUE, which is what the effect
   * actually cares about.
   */
  const routeKey = JSON.stringify(line.mileageRoute ?? null);
  /**
   * The server's route as a VALUE-STABLE object: one identity per distinct route,
   * reconstructed from the serialization above.
   *
   * This is what lets the effect below depend on it honestly, with no lint
   * suppression — depending on `line.mileageRoute` is the defect, and suppressing
   * the warning would only hide the next person's mistake. Round-tripping through
   * the key is the cheap way to get identity to follow content.
   */
  const routeFromServer = useMemo<RouteValue>(
    () => (JSON.parse(routeKey) as RouteValue | null) ?? EMPTY_ROUTE,
    [routeKey],
  );
  /**
   * Two INDEPENDENT reasons the re-sync must hold, tracked separately.
   *
   * One boolean could not express both: a route mutation settling while somebody is
   * still typing in the distance field would have released the guard and let the
   * reset land on their half-typed number. Whoever raised a hold releases only
   * their own.
   */
  const numFocused = useRef(false);
  const routePending = useRef(false);
  useEffect(() => {
    if (numFocused.current || routePending.current) return;
    setCategory(line.categoryId);
    setAmount(minorToInput(line.amountMinor, currencyCode));
    setKm(line.mileageDistance ?? '');
    setDistanceUnit(line.mileageUnit ?? 'KM');
    setRoute(routeFromServer);
  }, [
    line.categoryId,
    line.amountMinor,
    line.mileageDistance,
    line.mileageUnit,
    routeFromServer,
    currencyCode,
  ]);

  // A line item is category + (amount | mileage km); tax lives on the expense.
  const commit = (over?: {
    category?: string | null;
    amount?: string;
    km?: string;
    route?: RouteValue;
  }) => {
    const cat = over?.category !== undefined ? over.category : category;
    if (!cat) return;
    if (isMileage(cat)) {
      const kmVal = (over?.km ?? km).trim();
      if (!/^\d+(\.\d{1,2})?$/.test(kmVal)) return;
      const stops = over?.route ?? route;
      update.mutate({
        id: line.id,
        categoryId: cat,
        mileageDistance: kmVal,
        mileageUnit: distanceUnit,
        // The stops ride along with every commit. The server keeps an unmentioned
        // route as-is, so omitting it would leave the ones just typed unsaved; an
        // explicit null is how clearing the last stop gets persisted.
        mileageRoute: stops.stops.some((st) => st.description.trim()) ? stops : null,
      });
      return;
    }
    const amt = inputToMinor(over?.amount ?? amount, currencyCode, locale);
    if (amt == null) {
      /**
       * NOT a silent return, which is what this was.
       *
       * Unconvertible text used to drop the write on the floor and leave the typed characters
       * sitting in the field looking exactly like a saved value, until an unrelated refetch
       * replaced them minutes later (GA readiness report F06). "Not saved" is the same fact
       * whether WE refused it or the server did, so it says so through the same channel a
       * server refusal already uses on this row.
       */
      setSaveError(t('line.amountNotANumber'));
      return;
    }
    setSaveError(null);
    update.mutate({ id: line.id, categoryId: cat, amountMinor: amt });
  };

  if (!editable) {
    return (
      <LineItemReadOnlyRow
        line={line}
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
        locale={locale}
      />
    );
  }

  // Single row: [icon] · category · amount* · trash. flex-wrap so it only stacks
  // on a very narrow pane. Autosave on blur; while the amount field is focused,
  // numFocused suppresses the server re-sync (see above).
  const onNumFocus = () => {
    numFocused.current = true;
  };
  const onNumBlur = () => {
    numFocused.current = false;
    commit();
  };
  /**
   * A route edit is an edit — hold the re-sync open across it.
   *
   * The guard used to be raised only by the numeric field's focus/blur, so picking a
   * place or adding a stop was completely unprotected: the commit it triggered
   * refetched the report, and the reset above landed on top of the edit in flight.
   * Released when the row's own mutation settles, which is the point the server and
   * the screen agree again.
   */
  const holdForRouteEdit = () => {
    routePending.current = true;
  };
  // One definition, two placements: inline for a mileage line (inside MileageFields,
  // to stay on the first row) and directly after the amount for every other line.
  const deleteButton = (
    <button
      type="button"
      aria-label={t('actions.delete')}
      className="flex h-10 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive"
      onClick={() => remove.mutate({ id: line.id })}
    >
      <IconTrash size={14} />
    </button>
  );
  return (
    <>
      {/*
       * The third always-both region, and the one the plan flagged as possibly needing a
       * read-only row built from nothing. It did not: the `!editable` arm above was already
       * a clean, self-contained row — icon · category · amount, no state, no mutation — so
       * this is a REUSE of markup that had merely been sitting behind an early return, not
       * an extraction of one out of the editable branch.
       *
       * Both are rendered on a draft report, at every width, and CSS picks. The reason it
       * cannot be a JS branch is this component specifically: it holds eight pieces of
       * `useState` (category, amount, km, unit, route, tip, saveError) plus two `useRef`
       * re-sync guards, and unmounting it mid-edit on a desktop window drag across 1024px
       * would discard a half-typed distance or amount with no recovery path.
       */}
      <LineItemReadOnlyRow
        line={line}
        currencyCode={currencyCode}
        currencySymbol={currencySymbol}
        locale={locale}
        className="lg:hidden"
      />
      <div className="hidden lg:contents">
        <div
          className={`flex flex-wrap items-center gap-1.5 rounded-md border p-2 ${
            saveError ? 'border-destructive' : 'border-border'
          }`}
        >
          {saveError && (
            <p role="alert" className="w-full text-destructive text-xs">
              {saveError}
            </p>
          )}
          {/* No icon span here: the Combobox trigger already prefixes the selected
          category's icon onto its own text (see design-system combobox.tsx), so one
          beside it rendered the emoji twice. The read-only row above still needs its
          own, because it has no combobox. */}
          <div className="min-w-[8rem] flex-1">
            <Combobox
              items={categoryItems}
              value={category}
              onValueChange={(v) => {
                // What a category change invalidates is DECLARED by the two strategies
                // rather than derived from one boolean here — see `fieldsToClear`.
                const clearing = fieldsToClear(capsOf(category), capsOf(v));
                setCategory(v);
                // Clearing the selection is not a line state worth persisting — a line
                // IS a category plus an amount — so nothing is written until one is
                // picked again.
                if (!v) return;
                // A category change is committed ON ITS OWN, with no amount and no
                // distance. `commit` used to be called here and would silently return
                // when switching into mileage with no distance yet — so nothing was
                // written and the row kept showing the old amount. The server owns what
                // a line of the new kind should hold: it clears the columns that no
                // longer apply and re-derives the rest.
                update.mutate({ id: line.id, categoryId: v });
                // Local fields follow. Crossing the mileage boundary invalidates both
                // sides — a typed amount is not a distance, and a measured route is not
                // a typed amount — so neither is carried across.
                if (clearing.includes('amount')) setAmount('');
                if (clearing.includes('km')) {
                  setKm('');
                  setRoute(EMPTY_ROUTE);
                }
                if (clearing.includes('tip')) setTip('');
              }}
              placeholder={t('addLine.categoryPlaceholder')}
            />
          </div>
          {/* Extra fields contributed by the row's strategy. Mileage renders its own
          component below (it needs the pricing query and the report ids); every other
          kind that wants fields supplies them here — today that is the tip. */}
          {!isMileage() && strategy.Fields && (
            <strategy.Fields
              draft={{ amount, km, tip }}
              disabled={!editable}
              currencySymbol={currencySymbol}
              labels={{ tip: t('lineKinds.tip'), tipHint: t('lineKinds.tipHint') }}
              onTipChange={(v) => setTip(v)}
              onTipCommit={() => {
                // Committed on blur, like the tax fields: a tip leaves the taxable base, so
                // writing it per keystroke would re-derive the tax on every digit.
                const minor = majorToMinor(tip.trim(), currencyCode, locale);
                update.mutate({
                  id: line.id,
                  categoryId: category ?? line.categoryId,
                  tipMinor: tip.trim() === '' ? null : String(minor ?? 0n),
                });
              }}
            />
          )}
          {isMileage() ? (
            // Distance-based: enter a distance in either unit; the amount is computed
            // server-side against the rule in force and shown read-only alongside.
            <MileageFields
              distance={km}
              onDistanceChange={setKm}
              unit={distanceUnit}
              onUnitChange={(u) => {
                // A MEASURED distance is restated in the new unit; a typed one is
                // reinterpreted. 100 km measured by the route IS 62.14 mi, whereas
                // somebody who typed 100 and pressed MI meant a hundred miles.
                const next = routeMeasured ? convertDistance(km, distanceUnit, u) : km;
                setDistanceUnit(u);
                if (next !== km) setKm(next);
                // Commit immediately: the unit changes the amount, and leaving it
                // uncommitted would show a figure the server disagrees with.
                if (isValidDistance(next)) {
                  update.mutate({
                    id: line.id,
                    categoryId: category ?? line.categoryId,
                    mileageDistance: next.trim(),
                    mileageUnit: u,
                    mileageRoute: route.stops.some((st) => st.description.trim()) ? route : null,
                  });
                }
              }}
              route={route}
              onRouteChange={(next) => {
                holdForRouteEdit();
                setRoute(next);
                // Persist the stops as they change, not only when a distance arrives. A
                // route whose distance is already correct produces no `onDistance`, so
                // without this an edited From/To was never written.
                if (isValidDistance(km)) commit({ route: next });
              }}
              onMeasuredDistance={(d) => {
                holdForRouteEdit();
                setKm(d);
                commit({ km: d });
              }}
              onDistanceFocus={onNumFocus}
              onDistanceBlur={onNumBlur}
              // The amount used to be a separate span showing `line.amountMinor` — the
              // SAVED figure, which is right until the distance is edited and then sits
              // there contradicting it until a blur commits. MileageFields owns the
              // figure now: it shows the saved one while the distance is untouched and
              // the freshly-priced one as soon as it is not.
              pricing={{
                expenseId,
                categoryId: category ?? line.categoryId,
                lineItemId: line.id,
                currency: { code: currencyCode, symbol: currencySymbol },
                saved:
                  line.mileageDistance != null
                    ? { amountMinor: line.amountMinor, distance: line.mileageDistance }
                    : null,
              }}
              // Rendered inside MileageFields so it stays on the first line: the From/To
              // block is full-width, and anything after it wraps below.
              trailing={deleteButton}
            />
          ) : (
            <>
              <MoneyInput
                symbol={currencySymbol}
                wrapperClassName="w-28"
                aria-required
                aria-label={t('line.amount')}
                placeholder={`${t('line.amount')} *`}
                locale={locale}
                /**
                 * Two different faults, one border. Blank is "required and missing"; unconvertible
                 * is "this is not an amount" — which used to be indistinguishable from a saved
                 * value, because the only consequence was a write that silently did not happen
                 * (GA readiness report F06).
                 */
                invalid={amount.trim() !== '' && inputToMinor(amount, currencyCode, locale) == null}
                value={amount}
                onFocus={onNumFocus}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={onNumBlur}
                className={amount.trim() ? '' : 'border-destructive'}
              />
              {deleteButton}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * One saved line as prose — icon · category · amount.
 *
 * The `!editable` arm of `LineItemRow`, unchanged and given a name so it can also be the
 * below-`lg` face of an EDITABLE row. It holds no state and fires no mutation, which is
 * exactly why it can be rendered twice over: there is nothing in it to lose.
 *
 * No `aria-label` and no labelled control, so it adds no second match to any `getByLabel`
 * in `e2e/support/workbench.ts` — in particular `Amount`, which `addExpense` fills and
 * blurs on every expense the suite creates. The amount here is a `<span>`.
 */
function LineItemReadOnlyRow({
  line,
  currencyCode,
  currencySymbol,
  locale,
  className,
}: {
  line: LineItemDetail;
  currencyCode: string;
  currencySymbol: string;
  locale: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-border p-2.5 text-sm ${className ?? ''}`}
    >
      {line.category.icon && <span className="shrink-0">{line.category.icon}</span>}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {localeLabel(line.category.label, locale)}
      </span>
      <span className="text-foreground tabular-nums">
        {money(Number(line.amountMinor), { code: currencyCode, symbol: currencySymbol }, locale)}
      </span>
    </div>
  );
}

// ── New line-item form ────────────────────────────────────────────────────────
function NewLineForm({
  categoryItems,
  expenseId,
  currencySymbol,
  currencyCode,
  pending,
  error,
  onDraftChange,
  onCancel,
  onSave,
}: {
  categoryItems: {
    value: string;
    label: string;
    icon?: string;
    isMileage?: boolean;
    acceptsTip?: boolean;
  }[];
  /** The parent expense — the mileage price is derived from its owner and date. */
  expenseId: string;
  currencySymbol: string;
  currencyCode: string;
  pending: boolean;
  /** Why the last save failed. Rendered in place, beside the row that caused it. */
  error?: string;
  /**
   * What this row currently holds, reported up so the totals below can project it.
   *
   * `null` while the row cannot be priced — no category yet, no valid amount, or a
   * mileage row whose amount only the server knows. `mileage: true` says the row is
   * real but unpriceable here, which the projection has to disclose rather than
   * quietly total without it.
   */
  onDraftChange?: (
    draft: { categoryId: string; amountMinor: string } | { mileage: true } | null,
  ) => void;
  onCancel: () => void;
  onSave: (data: {
    categoryId: string;
    amountMinor?: string;
    mileageDistance?: string;
    mileageUnit?: 'KM' | 'MI';
    mileageRoute?: RouteValue;
  }) => void;
}) {
  const t = useTranslations('expenses');
  const [category, setCategory] = useState<string | null>(null);
  const [km, setKm] = useState('');
  // A new line is entered in whatever unit the traveller chooses. It used not to
  // be captured here at all, so the server fell back to the RULE's unit and a
  // distance meant as miles was priced as kilometres.
  const [distanceUnit, setDistanceUnit] = useState<'KM' | 'MI'>('KM');
  const [route, setRoute] = useState<RouteValue>(EMPTY_ROUTE);
  const routeMeasured = route.stops.some((st) => st.description.trim());

  const isMileage = categoryItems.find((c) => c.value === category)?.isMileage ?? false;
  const kmValid = isValidDistance(km);
  const canSave = isMileage && Boolean(category) && kmValid;

  /**
   * Choosing a category creates the line. There is no "Add line" to press.
   *
   * The amount is optional server-side, so the row commits with the category alone and the
   * amount is typed into the real line — which is one gesture fewer than picking a category,
   * typing an amount and then confirming, and it is the point at which the line's own fields
   * (a tip, for a category that takes one) can finally appear at all. Those live on the saved
   * row and are gated on the category's capabilities, so they show the moment it exists.
   *
   * **Mileage is the exception, and the server draws the line, not this component.**
   * `computeLineFinancials` refuses a mileage line with no distance — `allowMissingDistance`
   * exists only for switching an EXISTING line into a mileage category — so auto-committing one
   * would either fail or need a flag that is deliberately scoped elsewhere. A mileage row
   * therefore still collects its distance and commits explicitly.
   */
  const commit = (categoryId: string) => {
    if (pending) return;
    onSave({ categoryId });
  };

  /**
   * Report this row up so the projected totals can include it.
   *
   * Only a mileage row has anything to report now — every other category commits the instant it
   * is chosen, so it is a real line by the time the totals are computed and is priced from the
   * server's own figures rather than projected from here.
   *
   * A mileage row reports `{ mileage: true }` rather than an amount: the rate, the YTD tier and
   * the unit conversion are all server-side, so the only honest thing it can say is "I exist and
   * you cannot price me". Reporting `null` instead would have the projection show a total that is
   * quietly missing a line.
   */
  const draft: { categoryId: string; amountMinor: string } | { mileage: true } | null =
    category && isMileage && kmValid ? { mileage: true } : null;
  // Serialised, so an unchanged draft does not re-fire the effect every render.
  const draftKey = JSON.stringify(draft);
  const report = useRef(onDraftChange);
  report.current = onDraftChange;
  useEffect(() => {
    report.current?.(draftKey === 'null' ? null : JSON.parse(draftKey));
    // No unmount cleanup: the parent's list of open rows decides which drafts count, and
    // it drops this row's id in the same action that unmounts it. Reporting null on the
    // way out would look like the thing keeping a cancelled row from inflating the
    // projection while doing nothing at all.
  }, [draftKey]);

  return (
    <div
      className={`mt-1 flex flex-col gap-1.5 rounded border border-dashed p-2 ${
        error ? 'border-destructive' : 'border-border'
      }`}
    >
      {/* The server's own words. They are already specific and actionable — "No country
          on the traveller — cannot resolve a mileage rate." tells an admin exactly what
          to set — so rewording it here would only make it vaguer. */}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="min-w-[8rem] flex-1">
          <Combobox
            items={categoryItems}
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              // Mileage needs its distance first; everything else is a line already.
              const chosen = categoryItems.find((c) => c.value === value);
              if (value && !chosen?.isMileage) commit(value);
            }}
            placeholder={t('addLine.categoryPlaceholder')}
          />
        </div>
        {isMileage && (
          <MileageFields
            distance={km}
            onDistanceChange={setKm}
            unit={distanceUnit}
            onUnitChange={(u) => {
              // Same rule as the edit row: convert what the route measured, leave
              // what a person typed.
              if (routeMeasured) setKm(convertDistance(km, distanceUnit, u));
              setDistanceUnit(u);
            }}
            route={route}
            onRouteChange={setRoute}
            // What the distance is worth, shown before the line is added rather
            // than discovered after it. No saved figure here — nothing is saved yet.
            pricing={{
              expenseId,
              categoryId: category,
              currency: { code: currencyCode, symbol: currencySymbol },
            }}
          />
        )}
      </div>
      {/* Only a mileage row has anything left to confirm. Everything else committed when its
          category was chosen, so a save button there would be a button that does nothing. */}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('addLine.cancel')}
        </Button>
        {isMileage && (
          <Button
            size="sm"
            disabled={pending || !canSave}
            onClick={() => {
              if (!category || !kmValid) return;
              onSave({
                categoryId: category,
                mileageDistance: km.trim(),
                // The unit travels with the distance, or the server prices the
                // number against the rule's unit and quietly gets it wrong.
                mileageUnit: distanceUnit,
                // Only when a route was actually measured — an empty pair of
                // blank stops is not evidence of anything.
                ...(route.stops.some((st) => st.description.trim()) ? { mileageRoute: route } : {}),
              });
            }}
          >
            {t('addLine.save')}
          </Button>
        )}
      </div>
    </div>
  );
}
