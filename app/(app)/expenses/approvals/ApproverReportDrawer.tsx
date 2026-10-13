'use client';

/**
 * ApproverReportDrawer — the read-only counterpart to the submitter's report
 * workbench, opened from the approvals inbox. Renders the full report tree (expenses →
 * line items → receipts) without any edit affordances, and drives the approver
 * actions: Approve / Reject (with note) / Return-for-edit (with note), plus the
 * AP "mark reimbursed" action on an approved report. Every action re-checks
 * authority server-side (task eligibility for decide/return; the reimburse
 * permission for reimbursement). It's a write surface, so it stays
 * non-dismissible (close via the footer buttons).
 *
 * Ported from ExpenseOS (550b2945) with the inbox (w4-05/w4-07, d71). VeloExpense: no
 * "mark reimbursed" here (d71) — VeloExpense's reimbursement screen stays the one place AP
 * pays, so `canReimburse` is accepted and unused; an expense may have no date yet.
 */
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Input,
  StatusBadge,
} from '@expenseos/design-system';
import { IconAlertTriangle, IconFileText } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { type CurrencyLike, displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { localeLabel, SEVERITY_KEY, statusBadgeProps } from '../_shared';

type ReportDetail = inferRouterOutputs<AppRouter>['expenseApprovals']['report'];
type ExpenseDetail = ReportDetail['expenses'][number];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground text-sm">{children}</div>
    </div>
  );
}

export function ApproverReportDrawer({
  reportId,
  taskId,
  isAcknowledge = false,
  canReimburse,
  onClose,
  onDecided,
}: {
  reportId: string;
  /** The viewer's pending task on this report, when they have one. Absent for a
   *  deep-linked report they can't act on (already decided / expired). */
  taskId?: string;
  /** The task is an Acknowledge node — a single outcome (acknowledge), no
   *  reject/return. */
  isAcknowledge?: boolean;
  canReimburse: boolean;
  onClose: () => void;
  onDecided: () => void;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();

  const query = trpc.expenseApprovals.report.useQuery({ reportId });
  const report = query.data;

  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'reject' | 'return'>('idle');
  const [note, setNote] = useState('');

  const decide = trpc.expenseApprovals.decide.useMutation({
    onSuccess: onDecided,
    onError: (e) => setErr(e.message),
  });
  const returnForEdit = trpc.expenseApprovals.returnForEdit.useMutation({
    onSuccess: onDecided,
    onError: (e) => setErr(e.message),
  });
  // VeloExpense: no `markReimbursed` (d71) — see the header.

  const pending = decide.isPending || returnForEdit.isPending;
  // Deciding/returning needs the viewer's pending task; a deep-linked report
  // without one (already decided / expired) is view-only for those actions.
  const canDecide = report?.status === 'SUBMITTED' && Boolean(taskId);
  // VeloExpense: kept so the drawer's props stay ExpenseOS's; reimbursing is VeloExpense's
  // reimbursement screen's (d71).
  void canReimburse;

  // Receipt chase, on demand. The drawer lists expenses as cards with no
  // selection, so this asks for every receiptless expense on the report at once
  // — which is also the only sensible ask when you're about to decide it.
  // Per-expense precision lives on the AP cross-report view, which has a table.
  const receiptlessIds = (report?.expenses ?? [])
    .filter((e) => e.receipts.length === 0)
    .map((e) => e.id);
  const chase = trpc.expenseApprovals.chaseReceipts.useMutation({
    onSuccess: (r) => {
      setErr(null);
      setChaseNote(
        r.reports === 0 ? t('drawer.chaseNone') : t('drawer.chaseSent', { count: r.expenses }),
      );
    },
    onError: (e) => setErr(e.message),
  });
  const [chaseNote, setChaseNote] = useState<string | null>(null);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent width={600} resizable storageKey="expenses.approver.detail">
        <DrawerHeader>
          <DrawerTitle>{report?.title ?? t('drawer.fallback')}</DrawerTitle>
          {report && (
            // `flex-wrap`: the report identity line carries four items — number,
            // status, total + currency code, submitter — and the submitter's name
            // is unbounded. Unwrapped, a long name (or FR-CA's longer status
            // labels) pushed the line past the panel's right edge, where nothing
            // scrolls. Wrapping is inert at any width that already fits, so
            // there is no desktop change.
            <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span className="font-mono">{report.number}</span>
              <StatusBadge {...statusBadgeProps(report.status, t, 'Submitted')} />
              <span className="tabular-nums">
                {formatMinor(Number(report.totalMinor), report.currency, locale)}{' '}
                {report.currency.code}
              </span>
              <span>· {displayName(report.submitter)}</span>
            </div>
          )}
        </DrawerHeader>

        <DrawerBody>
          {query.isLoading && (
            <div className="text-muted-foreground text-sm">{t('list.loading')}</div>
          )}
          {err && <p className="text-destructive text-sm">{err}</p>}
          {report && (
            <div className="flex flex-col gap-4">
              {report.purpose && <Field label={t('drawer.purpose')}>{report.purpose}</Field>}

              <section>
                <h3 className="mb-1 font-medium text-foreground text-sm">
                  {t('drawer.policyWarnings')}
                </h3>
                {report.violations.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('drawer.noWarnings')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {report.violations.map((v) => {
                      const sev = SEVERITY_KEY[v.severity] ?? 'info';
                      return (
                        <li key={v.id} className="flex items-start gap-2 text-sm">
                          <IconAlertTriangle
                            size={14}
                            className={
                              sev === 'error'
                                ? 'mt-0.5 text-destructive'
                                : sev === 'warning'
                                  ? 'mt-0.5 text-warning'
                                  : 'mt-0.5 text-muted-foreground'
                            }
                          />
                          <span className="text-foreground">
                            {t(`policy.${sev}`)}: {v.message}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="font-medium text-foreground text-sm">{t('drawer.expenses')}</h3>
                {report.expenses.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('drawer.noExpenses')}</p>
                ) : (
                  report.expenses.map((e) => (
                    <ExpenseCard
                      key={e.id}
                      expense={e}
                      currency={report.currency}
                      reviewThreshold={report.extractionReviewThreshold}
                      locale={locale}
                    />
                  ))
                )}
              </section>
            </div>
          )}
        </DrawerBody>

        {/**
         * `pb-[calc(12px_+_var(--safe-area-bottom))]` replaces the bottom half of
         * `DrawerFooter`'s own `py-3`, keeping the 12px it already had and adding
         * the home-indicator inset on top. Without it the decide buttons sit
         * flush against `bottom: 0` on a notched phone — inside the gesture zone,
         * where a tap on Approve can be swallowed by the system swipe.
         *
         * LOCAL on purpose. `DrawerContent` applies `pb-[env(safe-area-inset-bottom)]`
         * only on its `side='bottom'` branch (`drawer.tsx:297-299`); every
         * right-side drawer in the product shares the gap, so fixing it in the
         * shared primitive is a design-system change with a far wider blast
         * radius than this route. Spelled with `var(--safe-area-bottom)` to match
         * the alias convention in `globals.css` and `Sidebar.tsx:131`.
         */}
        {/* `data-testid`: the only stable handle on this row. `DrawerContent`
            renders its own dismiss X AFTER `{children}` with a hardcoded English
            `aria-label="Close"`, so in EN the drawer holds two controls named
            "Close" and a spec that wants the footer's one has to scope to the
            footer. Scoping by DOM shape instead (an ancestor `div` of Approve)
            is a bet on how the row happens to nest — see
            `e2e/expenses-approvals.mobile.spec.ts`. */}
        <DrawerFooter
          data-testid="approver-drawer-footer"
          className="pb-[calc(12px_+_var(--safe-area-bottom))]"
        >
          {mode === 'idle' ? (
            // `flex-wrap`: this row holds up to five controls at once — the chase
            // note, "Request receipts", Close, and then either Acknowledge or the
            // Return / Reject / Approve triad. Unwrapped they overflow a narrow
            // panel with no scroll affordance, and `justify-end` means the control
            // pushed out is the right-most one — Approve, the primary action.
            // NOT `max-lg:flex-wrap`: the drawer is `resizable` down to
            // `minWidth = 360` (`drawer.tsx:178`), so the same overflow is
            // reachable on a wide viewport by dragging the panel narrow. This is a
            // container problem, not a viewport one, and `flex-wrap` costs nothing
            // on a row that already fits.
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {chaseNote && (
                <span className="mr-auto text-muted-foreground text-xs">{chaseNote}</span>
              )}
              {receiptlessIds.length > 0 && (
                // Ask before deciding: approving a report whose receipts are
                // missing is the thing this prevents.
                <Button
                  variant="outline"
                  size="sm"
                  disabled={chase.isPending}
                  onClick={() => {
                    setErr(null);
                    chase.mutate({ expenseIds: receiptlessIds });
                  }}
                >
                  {t('drawer.requestReceipts', { count: receiptlessIds.length })}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                {t('drawer.close')}
              </Button>
              {canDecide && isAcknowledge && (
                // A single outcome — acknowledge routes the flow forward.
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setErr(null);
                    if (taskId) decide.mutate({ taskId, approve: true });
                  }}
                >
                  {t('approvals.acknowledge')}
                </Button>
              )}
              {canDecide && !isAcknowledge && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setNote('');
                      setMode('return');
                    }}
                  >
                    {t('approvals.return')}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={pending}
                    onClick={() => {
                      setNote('');
                      setMode('reject');
                    }}
                  >
                    {t('approvals.reject')}
                  </Button>
                  <Button
                    size="sm"
                    variant="success-outline"
                    disabled={pending}
                    onClick={() => {
                      setErr(null);
                      if (taskId) decide.mutate({ taskId, approve: true });
                    }}
                  >
                    {t('approvals.approve')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="flex w-full items-center gap-2">
              <Input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  mode === 'reject'
                    ? t('approvals.rejectNotePlaceholder')
                    : t('approvals.returnNotePlaceholder')
                }
                className="flex-1"
              />
              <Button variant="ghost" size="sm" onClick={() => setMode('idle')}>
                {t('addLine.cancel')}
              </Button>
              <Button
                size="sm"
                variant={mode === 'reject' ? 'destructive-outline' : 'outline'}
                disabled={pending || (mode === 'reject' && !note.trim())}
                onClick={() => {
                  setErr(null);
                  if (mode === 'reject') {
                    if (taskId) decide.mutate({ taskId, approve: false, note: note.trim() });
                  } else {
                    returnForEdit.mutate({
                      reportId,
                      note: note.trim() || undefined,
                    });
                  }
                }}
              >
                {mode === 'reject' ? t('approvals.confirmReject') : t('approvals.confirmReturn')}
              </Button>
            </div>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** One read-only expense card: header + line items + receipts. */
function ExpenseCard({
  expense,
  currency,
  reviewThreshold,
  locale,
}: {
  expense: ExpenseDetail;
  currency: CurrencyLike;
  reviewThreshold: number;
  locale: string;
}) {
  const t = useTranslations('expenses');
  // A low-confidence, still-unverified scan — the approver should scrutinize the
  // coded figures before deciding (read-only caution; the submitter clears it by
  // verifying, which also clears it here).
  const needsReview = expense.receipts.some(
    (r) =>
      r.extraction?.status === 'EXTRACTED' &&
      r.extraction.confidence != null &&
      r.extraction.confidence < reviewThreshold &&
      !r.extraction.reviewedAt,
  );
  return (
    <div className="rounded-md border border-border bg-background p-3">
      {needsReview && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <span className="text-foreground text-xs">{t('extraction.reviewPromptApprover')}</span>
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground text-sm">
            {expense.merchant ?? t('line.noMerchant')}
          </div>
          <div className="text-muted-foreground text-xs">
            {/* VeloExpense: an expense may have no date yet. */}
            {expense.date ? new Date(expense.date).toLocaleDateString(locale) : '—'}
            {expense.placeText ? ` · ${expense.placeText}` : ''}
          </div>
        </div>
        <div className="whitespace-nowrap text-foreground text-sm tabular-nums">
          {formatMinor(Number(expense.amountMinor), currency, locale)}
        </div>
      </div>

      {expense.explanation && (
        <p className="mt-2 whitespace-pre-wrap text-foreground text-sm">{expense.explanation}</p>
      )}

      {expense.attendees.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
            {t('drawer.attendees')}
          </div>
          <ul className="flex flex-col gap-0.5">
            {expense.attendees.map((a) => (
              <li key={a.id} className="text-foreground text-sm">
                {a.name}
                {a.company ? ` · ${a.company}` : ''}
                {a.isExternal ? ` · ${t('attendee.external')}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
          {t('drawer.lineItems')}
        </div>
        {expense.lineItems.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('drawer.noLines')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {expense.lineItems.map((li) => (
              <div key={li.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {localeLabel(li.category.label, locale)}
                </span>
                <span className="text-foreground tabular-nums">
                  {formatMinor(Number(li.amountMinor), currency, locale)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {expense.receipts.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
            {t('drawer.receipts')}
          </div>
          <ul className="flex flex-col gap-1">
            {expense.receipts.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <IconFileText size={14} className="shrink-0 text-muted-foreground" />
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-primary hover:underline"
                >
                  {r.filename}
                </a>
                {r.extraction?.status === 'EXTRACTED' && (
                  <Badge variant="success">{t('extraction.done')}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
