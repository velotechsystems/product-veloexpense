/**
 * VX1-6 — /expenses/[reportId], the report workbench.
 *
 * Server component. Every mutation is a plain <form action={serverAction}>, so
 * the editor works with JavaScript disabled and there is no client state to
 * keep in sync with the database; the only client component on the page is the
 * receipt drawer, which has to be one (see receipt-drawer.tsx).
 *
 * Totals are live in the sense that matters: each line-item write recomputes
 * expense_report.total_minor inside the same transaction and revalidates this
 * path, so the figure on screen is the figure in Postgres — never a number the
 * browser added up on its own.
 *
 * Line-item rows use the HTML `form` attribute to associate their inputs with a
 * <form> rendered after the table. A <form> cannot legally live inside a <tr>,
 * and this keeps one form per row without client JS.
 *
 * Editing is gated on DRAFT (lib/expenses/service.assertDraft); a report past
 * DRAFT renders read-only. The DRAFT→SUBMITTED transition itself is VX1-8.
 */
import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMinor, minorToDecimalString } from '@/lib/money';
import {
  addExpenseFromForm,
  getReportHistory,
  getSubmitReadiness,
  getValidation,
  addLineItemFromForm,
  deleteReportFromForm,
  getDecidableTask,
  getReportWorkbench,
  getWorkbenchOptions,
  removeExpenseFromForm,
  removeLineItemFromForm,
  updateExpenseFromForm,
  updateLineItemFromForm,
  updateReportFromForm,
} from '../actions';
import { listUnattachedReceipts } from '@/app/receipts/actions';
import {
  EmptyRow,
  ErrorBanner,
  StatusBadge,
  cardClass,
  fieldClass,
  labelClass,
  selectClass,
  textareaClass,
} from '../ui';
import { formatCalendarDate, formatInstant, toDateInputValue } from '@/lib/i18n/format';
import { enumLabel, REPORT_STATUS_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { ReceiptDrawer, type ReceiptSummary } from './receipt-drawer';
import { PolicyPanel } from './policy-panel';
import { LifecycleBar, ReportHistory } from './lifecycle-bar';
import { ApprovalPanel } from './approval-panel';

export const dynamic = 'force-dynamic';

export default async function ReportWorkbenchPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const prefs = await readerPrefs();
  const { reportId } = await params;
  const { error } = await searchParams;

  const workbench = await getReportWorkbench(reportId);
  const decidable = await getDecidableTask(reportId);
  if (!workbench) notFound();

  const { report, expenses, uncodedExpenseCount } = workbench;
  const { categories, currencies, businessUnits } = await getWorkbenchOptions();
  const validation = await getValidation(reportId);
  const readiness = await getSubmitReadiness(reportId);
  const history = await getReportHistory(reportId);
  const editable = report.status === 'DRAFT';
  const minorUnit: number = report.minor_unit;
  const inbox: ReceiptSummary[] = editable ? await listUnattachedReceipts() : [];
  const money = (amount: string) =>
    formatMinor(amount, report.currency_code, minorUnit, prefs.locale);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          href="/expenses"
        >
          ← Back to reports
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{report.title}</h1>
            <StatusBadge status={report.status} locale={prefs.locale} />
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums" data-testid="report-total">
              {money(report.total_minor)}
            </div>
            <div className="font-mono text-xs text-muted-foreground">{report.number ?? '—'}</div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {report.submitter_name ?? report.submitter_email}
          {report.business_unit_name ? ` · ${report.business_unit_name}` : ''} · created{' '}
          {formatInstant(report.created_at, prefs)}
        </p>
      </header>

      <ErrorBanner message={error} />

      {!editable ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          This report is {enumLabel(REPORT_STATUS_COPY, report.status, prefs.locale).toLowerCase()} and
          can no longer be edited.
          {readiness.canRecall ? ' Recall it to a draft to make changes.' : ''}
        </p>
      ) : null}

      <LifecycleBar
        reportId={report.id}
        status={report.status}
        readiness={readiness}
        locale={prefs.locale}
      />

      {/* VX2-4: shown only when this person actually has a decision to make on
          this report. The panel and the mutation behind it both come from
          `getDecidableTask`, so a rendered button always works. */}
      {decidable ? (
        <ApprovalPanel
          taskId={decidable.taskId}
          reportId={report.id}
          step={decidable.step}
          totalSteps={decidable.totalSteps}
          rungName={decidable.rungName}
          requireReceiptViewAck={decidable.requireReceiptViewAck}
          route={decidable.route}
          coveringFor={decidable.coveringFor}
          receiptCount={decidable.receiptCount}
        />
      ) : null}

      <PolicyPanel
        reportId={report.id}
        summary={validation}
        editable={editable}
        locale={prefs.locale}
      />

      {editable && uncodedExpenseCount > 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {uncodedExpenseCount} {uncodedExpenseCount === 1 ? 'expense has' : 'expenses have'} no line
          items yet, so {uncodedExpenseCount === 1 ? 'it adds' : 'they add'} nothing to the total.
        </p>
      ) : null}

      {/* ── report header ─────────────────────────────────────────────────── */}
      <section className={`${cardClass} flex flex-col gap-5 p-5`}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Report details
        </h2>
        {editable ? (
          <form action={updateReportFromForm} className="flex flex-col gap-4">
            <input type="hidden" name="reportId" value={report.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={fieldClass}>
                <label className={labelClass} htmlFor="title">
                  Title
                </label>
                <Input id="title" name="title" required defaultValue={report.title} />
              </div>
              <div className={fieldClass}>
                <label className={labelClass} htmlFor="currencyCode">
                  Currency
                </label>
                <select
                  id="currencyCode"
                  name="currencyCode"
                  className={selectClass}
                  defaultValue={report.currency_code}
                >
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={fieldClass}>
                <label className={labelClass} htmlFor="businessUnitId">
                  Business unit
                </label>
                <select
                  id="businessUnitId"
                  name="businessUnitId"
                  className={selectClass}
                  defaultValue={report.business_unit_id ?? ''}
                >
                  <option value="">— none —</option>
                  {businessUnits.map((bu) => (
                    <option key={bu.id} value={bu.id}>
                      {bu.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`${fieldClass} sm:col-span-2`}>
                <label className={labelClass} htmlFor="purpose">
                  Business purpose
                </label>
                <textarea
                  id="purpose"
                  name="purpose"
                  className={textareaClass}
                  defaultValue={report.purpose ?? ''}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="outline">
                Save details
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Currency</dt>
              <dd>{report.currency_code}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Business unit</dt>
              <dd>{report.business_unit_name ?? '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Business purpose</dt>
              <dd>{report.purpose ?? '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* ── expenses ──────────────────────────────────────────────────────── */}
      {expenses.map((expense) => {
        const receipts: ReceiptSummary[] = expense.receipts;
        const expenseLabel =
          expense.merchant ?? (formatCalendarDate(expense.txn_date, prefs.locale) || 'Expense');
        return (
          <section key={expense.id} className={`${cardClass} flex flex-col gap-4 p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold tracking-tight">{expenseLabel}</h3>
                <p className="text-xs text-muted-foreground">
                  {formatCalendarDate(expense.txn_date, prefs.locale)} · subtotal {money(expense.subtotal_minor)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <ReceiptDrawer
                  expenseId={expense.id}
                  label={expenseLabel}
                  receipts={receipts}
                  inbox={inbox}
                  editable={editable}
                />
                {editable ? (
                  <form action={removeExpenseFromForm}>
                    <input type="hidden" name="reportId" value={report.id} />
                    <input type="hidden" name="expenseId" value={expense.id} />
                    <Button type="submit" variant="destructive" size="sm">
                      Remove expense
                    </Button>
                  </form>
                ) : null}
              </div>
            </div>

            {editable ? (
              <form action={updateExpenseFromForm} className="grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="reportId" value={report.id} />
                <input type="hidden" name="expenseId" value={expense.id} />
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`merchant-${expense.id}`}>
                    Merchant
                  </label>
                  <Input
                    id={`merchant-${expense.id}`}
                    name="merchant"
                    defaultValue={expense.merchant ?? ''}
                  />
                </div>
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`txnDate-${expense.id}`}>
                    Date
                  </label>
                  <Input
                    id={`txnDate-${expense.id}`}
                    name="txnDate"
                    type="date"
                    // NOT `formatCalendarDate` — see `toDateInputValue`. A localised
                    // value here is silently rejected by the browser and the
                    // field renders EMPTY, so saving the form clears the date.
                    defaultValue={toDateInputValue(expense.txn_date)}
                  />
                </div>
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`notes-${expense.id}`}>
                    Notes
                  </label>
                  <Input id={`notes-${expense.id}`} name="notes" defaultValue={expense.notes ?? ''} />
                </div>
                <div className="sm:col-span-3">
                  <Button type="submit" variant="outline" size="sm">
                    Save expense
                  </Button>
                </div>
              </form>
            ) : null}

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Category</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 text-right font-medium">Tax</th>
                    {editable ? <th className="px-3 py-2" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {expense.lineItems.length === 0 ? (
                    <EmptyRow colSpan={editable ? 5 : 4}>
                      No line items — code this expense below.
                    </EmptyRow>
                  ) : (
                    expense.lineItems.map((li) => (
                      <tr key={li.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          {editable ? (
                            <select
                              form={`li-${li.id}`}
                              name="categoryId"
                              className={selectClass}
                              defaultValue={li.category_id}
                            >
                              {categories.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
                                </option>
                              ))}
                              {li.category_active === false ? (
                                <option value={li.category_id}>{li.category_label} (inactive)</option>
                              ) : null}
                            </select>
                          ) : (
                            (li.category_label ?? '—')
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {editable ? (
                            <Input
                              form={`li-${li.id}`}
                              name="description"
                              defaultValue={li.description ?? ''}
                            />
                          ) : (
                            (li.description ?? '—')
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {editable ? (
                            <Input
                              form={`li-${li.id}`}
                              name="amount"
                              inputMode="decimal"
                              required
                              className="text-right"
                              defaultValue={minorToDecimalString(li.amount_minor, minorUnit)}
                            />
                          ) : (
                            money(li.amount_minor)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {editable ? (
                            <Input
                              form={`li-${li.id}`}
                              name="tax"
                              inputMode="decimal"
                              className="text-right"
                              defaultValue={minorToDecimalString(li.tax_minor, minorUnit)}
                            />
                          ) : (
                            money(li.tax_minor)
                          )}
                        </td>
                        {editable ? (
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <Button type="submit" form={`li-${li.id}`} size="xs" variant="outline">
                                Save
                              </Button>
                              <Button
                                type="submit"
                                form={`li-del-${li.id}`}
                                size="xs"
                                variant="destructive"
                              >
                                Remove
                              </Button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/30">
                    <td className="px-3 py-2 font-medium" colSpan={2}>
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {money(expense.subtotal_minor)}
                    </td>
                    <td className="px-3 py-2" colSpan={editable ? 2 : 1} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/*
              The per-row forms the table's inputs point at via form="…".
              Rendered outside the table because a <form> may not be a child of
              <tr>; hidden because the visible controls live in the cells.
            */}
            {editable
              ? expense.lineItems.map((li) => (
                  <Fragment key={`forms-${li.id}`}>
                    <form id={`li-${li.id}`} action={updateLineItemFromForm} className="hidden">
                      <input type="hidden" name="reportId" value={report.id} />
                      <input type="hidden" name="lineItemId" value={li.id} />
                    </form>
                    <form id={`li-del-${li.id}`} action={removeLineItemFromForm} className="hidden">
                      <input type="hidden" name="reportId" value={report.id} />
                      <input type="hidden" name="lineItemId" value={li.id} />
                    </form>
                  </Fragment>
                ))
              : null}

            {editable ? (
              <form action={addLineItemFromForm} className="grid items-end gap-3 sm:grid-cols-5">
                <input type="hidden" name="reportId" value={report.id} />
                <input type="hidden" name="expenseId" value={expense.id} />
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`categoryId-${expense.id}`}>
                    Category
                  </label>
                  <select
                    id={`categoryId-${expense.id}`}
                    name="categoryId"
                    required
                    className={selectClass}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={`${fieldClass} sm:col-span-2`}>
                  <label className={labelClass} htmlFor={`description-${expense.id}`}>
                    Description
                  </label>
                  <Input id={`description-${expense.id}`} name="description" />
                </div>
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`amount-${expense.id}`}>
                    Amount ({report.currency_code})
                  </label>
                  <Input
                    id={`amount-${expense.id}`}
                    name="amount"
                    inputMode="decimal"
                    required
                    placeholder="0.00"
                  />
                </div>
                <div className={fieldClass}>
                  <label className={labelClass} htmlFor={`tax-${expense.id}`}>
                    Tax
                  </label>
                  <Input id={`tax-${expense.id}`} name="tax" inputMode="decimal" placeholder="0.00" />
                </div>
                <div className="sm:col-span-5">
                  <Button type="submit" size="sm">
                    Add line item
                  </Button>
                </div>
              </form>
            ) : null}
          </section>
        );
      })}

      {/* ── add an expense ────────────────────────────────────────────────── */}
      {editable ? (
        <section className={`${cardClass} flex flex-col gap-4 p-5`}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Add an expense
          </h2>
          <form action={addExpenseFromForm} className="grid items-end gap-3 sm:grid-cols-4">
            <input type="hidden" name="reportId" value={report.id} />
            <input type="hidden" name="currencyCode" value={report.currency_code} />
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-merchant">
                Merchant
              </label>
              <Input id="new-merchant" name="merchant" placeholder="Air Canada" />
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-txnDate">
                Date
              </label>
              <Input id="new-txnDate" name="txnDate" type="date" />
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-notes">
                Notes
              </label>
              <Input id="new-notes" name="notes" />
            </div>
            <div>
              <Button type="submit">Add expense</Button>
            </div>
          </form>
        </section>
      ) : null}

      <ReportHistory events={history} prefs={prefs} />

      {editable ? (
        <form action={deleteReportFromForm} className="pt-2">
          <input type="hidden" name="reportId" value={report.id} />
          <Button type="submit" variant="destructive" size="sm">
            Delete this draft
          </Button>
        </form>
      ) : null}
    </div>
  );
}
