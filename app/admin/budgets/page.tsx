/**
 * VX4-5 part 3b — /admin/budgets.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS,
 * same shape as the employee directory and the policy admin. Row forms live
 * AFTER the table because a `<form>` may not be a child of `<tr>`; the inputs
 * point at them with the HTML `form` attribute.
 *
 * ── What this screen has to be able to SAY ──────────────────────────────────
 *
 * Three empty states that mean different things, and a screen that cannot tell
 * them apart is AC-22's mistake:
 *   · the budgets module is off        → nothing here will ever fill in
 *   · accounting is off                → there are no accounts to budget against
 *   · both on, no budgets yet          → make one
 * And per period, a fourth: `rolled_up_at IS NULL` is "never calculated", which
 * `0024` is explicit is NOT the same as zero spend. A confident "$0.00 spent"
 * over a period nobody has rolled up is exactly the lie that column exists to
 * prevent, so it renders as "not yet calculated".
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMinor, minorToDecimalString } from '@/lib/money';
import {
  getBudgetsPage,
  createBudgetFromForm,
  updateBudgetFromForm,
  deleteBudgetFromForm,
  seedPeriodsFromForm,
  addThresholdFromForm,
  removeThresholdFromForm,
  addRecipientFromForm,
  removeRecipientFromForm,
} from './actions';
import {
  EmptyRow,
  ErrorBanner,
  cardClass,
  fieldClass,
  formatDate,
  labelClass,
  selectClass,
} from '@/app/expenses/ui';

export const dynamic = 'force-dynamic';

function scopeOf(b: { business_unit_name: string | null; department_name: string | null }): string {
  const parts = [b.business_unit_name, b.department_name].filter(Boolean);
  // NULL narrowing means "the whole organization" rather than "unknown" — 0024's
  // decision, and the reason its scope index is NULLS NOT DISTINCT.
  return parts.length === 0 ? 'Whole organization' : parts.join(' · ');
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const {
    budgets,
    moduleEnabled,
    accountingEnabled,
    accounts,
    departments,
    businessUnits,
    currencies,
    people,
  } = await getBudgetsPage();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Budgets</h1>
          <p className="text-sm text-muted-foreground">
            What a period is allowed to spend on one GL account, what it has spent, and who is told
            when it gets close.
          </p>
        </div>
        <Link href="/admin/modules" className="text-sm underline underline-offset-4">
          Modules
        </Link>
      </div>

      <ErrorBanner message={sp.error} />

      {!moduleEnabled ? (
        <section className={`${cardClass} p-5 text-sm`} data-testid="budgets-module-off">
          <p className="font-medium">The Budgets module is off for this organization.</p>
          <p className="mt-1 text-muted-foreground">
            Nothing below will fill in while it is: budget rows are invisible to every code path,
            not just to this screen, and reports are validated and approved exactly as before.{' '}
            <Link href="/admin/modules" className="underline underline-offset-4">
              Turn it on
            </Link>{' '}
            to start measuring against a budget.
          </p>
        </section>
      ) : null}

      {moduleEnabled && !accountingEnabled ? (
        <section className={`${cardClass} p-5 text-sm`} data-testid="budgets-accounting-off">
          <p className="font-medium">There are no GL accounts to budget against.</p>
          <p className="mt-1 text-muted-foreground">
            A budget names an account, because an account is what finance reports on — and the chart
            of accounts belongs to the Accounting module, which is off.{' '}
            <Link href="/admin/modules" className="underline underline-offset-4">
              Turn it on
            </Link>
            .
          </p>
        </section>
      ) : null}

      {/* ── the budgets ───────────────────────────────────────────────────── */}
      <section className={`${cardClass} overflow-hidden`}>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Budget</th>
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Alerts</th>
              <th className="px-3 py-2 font-medium">Periods</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {budgets.length === 0 ? (
              <EmptyRow colSpan={6}>
                {moduleEnabled
                  ? 'No budgets yet. Add one below.'
                  : 'No budgets — and none can be created while the module is off.'}
              </EmptyRow>
            ) : (
              budgets.map((b) => (
                <tr key={b.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {b.gl_account_number ? `${b.gl_account_number} — ${b.gl_account_name}` : '—'}
                      {' · '}
                      {b.currency_code} · FY{b.fiscal_year}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{scopeOf(b)}</td>
                  <td className="px-3 py-2">
                    {/* Its own visible form with its own button. The first draft
                        pointed this select at a hidden row form with no trigger,
                        which renders a control that changes nothing — a dead
                        control is worse than no control, because it reads as
                        saved. */}
                    <form action={updateBudgetFromForm} className="flex items-end gap-1">
                      <input type="hidden" name="budgetId" value={b.id} />
                      <input type="hidden" name="name" value={b.name} />
                      <select
                        name="ownerId"
                        aria-label={`Owner of ${b.name}`}
                        className={selectClass}
                        defaultValue={b.owner_id ?? ''}
                      >
                        <option value="">Nobody</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" variant="outline" size="sm">
                        Save
                      </Button>
                    </form>
                    <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                      With nobody, an alert reaches only the recipients named on a threshold.
                    </p>
                  </td>

                  {/* thresholds + their recipients */}
                  <td className="px-3 py-2">
                    {b.thresholds.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No thresholds — nothing will be sent.
                      </span>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {b.thresholds.map((t) => (
                          <li key={t.id} data-testid="budget-threshold">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {minorToDecimalString(t.threshold_bp, 2)}%
                              </span>
                              <form action={removeThresholdFromForm}>
                                <input type="hidden" name="thresholdId" value={t.id} />
                                <Button type="submit" variant="ghost" size="sm">
                                  Remove
                                </Button>
                              </form>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t.recipients.length === 0
                                ? 'Owner only'
                                : t.recipients.map((r) => r.display_name ?? r.email).join(', ')}
                            </div>
                            <form action={addRecipientFromForm} className="mt-1 flex gap-1">
                              <input type="hidden" name="thresholdId" value={t.id} />
                              <select name="userId" className={selectClass} defaultValue="">
                                <option value="" disabled>
                                  Also tell…
                                </option>
                                {people.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                              <Button type="submit" variant="outline" size="sm">
                                Add
                              </Button>
                            </form>
                            {t.recipients.map((r) => (
                              <form key={r.id} action={removeRecipientFromForm}>
                                <input type="hidden" name="recipientId" value={r.id} />
                                <Button type="submit" variant="ghost" size="sm">
                                  Remove {r.display_name ?? r.email}
                                </Button>
                              </form>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                    <form action={addThresholdFromForm} className="mt-2 flex items-end gap-1">
                      <input type="hidden" name="budgetId" value={b.id} />
                      <Input
                        name="percent"
                        inputMode="decimal"
                        placeholder="90"
                        aria-label={`Alert threshold percent for ${b.name}`}
                        className="w-20"
                      />
                      <span className="pb-2 text-sm">%</span>
                      <Button type="submit" variant="outline" size="sm">
                        Alert at
                      </Button>
                    </form>
                  </td>

                  {/* periods + the rollup */}
                  <td className="px-3 py-2">
                    {b.periods.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No periods yet — a budget with no periods measures nothing.
                      </span>
                    ) : (
                      <table className="text-xs">
                        <tbody>
                          {b.periods.map((p) => (
                            <tr key={p.id} data-testid="budget-period">
                              <td className="pr-3 text-muted-foreground">{p.starts_on}</td>
                              <td className="pr-3">
                                {formatMinor(p.amount_minor, b.currency_code, b.minor_unit)}
                              </td>
                              <td className="pr-3">
                                {/* NULL means never calculated, which is not zero
                                    spend — 0024 enforces the distinction with a
                                    CHECK and this is where it has to be visible. */}
                                {p.rolled_up_at === null ? (
                                  <span className="text-muted-foreground">not yet calculated</span>
                                ) : (
                                  <>
                                    {formatMinor(p.actual_minor, b.currency_code, b.minor_unit)}{' '}
                                    spent
                                    {p.pending_minor !== '0' ? (
                                      <>
                                        {' · '}
                                        {formatMinor(
                                          p.pending_minor,
                                          b.currency_code,
                                          b.minor_unit,
                                        )}{' '}
                                        awaiting a decision
                                      </>
                                    ) : null}
                                    {p.unconvertible_minor !== '0' ? (
                                      <>
                                        {' · '}
                                        <span className="text-destructive">
                                          {formatMinor(
                                            p.unconvertible_minor,
                                            b.currency_code,
                                            b.minor_unit,
                                          )}{' '}
                                          could not be converted
                                        </span>
                                      </>
                                    ) : null}
                                  </>
                                )}
                              </td>
                              <td className="text-muted-foreground">
                                {p.rolled_up_at === null ? '' : formatDate(p.rolled_up_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <form action={seedPeriodsFromForm} className="mt-2 flex items-end gap-1">
                      <input type="hidden" name="budgetId" value={b.id} />
                      <Input
                        name="startsOn"
                        type="date"
                        aria-label={`First period start for ${b.name}`}
                        className="w-36"
                      />
                      <Input
                        name="months"
                        defaultValue="12"
                        aria-label={`How many periods for ${b.name}`}
                        className="w-14"
                      />
                      <Input
                        name="amount"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`Amount per period for ${b.name}`}
                        className="w-24"
                      />
                      <Button type="submit" variant="outline" size="sm">
                        Add periods
                      </Button>
                    </form>
                    <p className="mt-1 max-w-[22rem] text-xs text-muted-foreground">
                      Twelve calendar months is a default, not a rule — periods carry their own
                      dates, so a 4-4-5 calendar is a different set of rows rather than a schema
                      change. Re-running only adds the months that are missing.
                    </p>
                  </td>

                  <td className="px-3 py-2">
                    <form action={deleteBudgetFromForm}>
                      <input type="hidden" name="budgetId" value={b.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* ── add a budget ──────────────────────────────────────────────────── */}
      <section className={`${cardClass} flex flex-col gap-4 p-5`}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Add a budget
        </h2>
        <form action={createBudgetFromForm} className="grid items-end gap-3 sm:grid-cols-3">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="name">
              Name
            </label>
            <Input id="name" name="name" required placeholder="Travel — Engineering" />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="glAccountId">
              GL account
            </label>
            <select id="glAccountId" name="glAccountId" required className={selectClass} defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} — {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="currencyCode">
              Currency
            </label>
            <select id="currencyCode" name="currencyCode" required className={selectClass}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="businessUnitId">
              Business unit
            </label>
            <select id="businessUnitId" name="businessUnitId" className={selectClass} defaultValue="">
              <option value="">Whole organization</option>
              {businessUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="departmentId">
              Department
            </label>
            <select id="departmentId" name="departmentId" className={selectClass} defaultValue="">
              <option value="">Whole organization</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="fiscalYear">
              Fiscal year
            </label>
            <Input
              id="fiscalYear"
              name="fiscalYear"
              inputMode="numeric"
              required
              defaultValue={String(new Date().getUTCFullYear())}
            />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="ownerId">
              Owner
            </label>
            <select id="ownerId" name="ownerId" className={selectClass} defaultValue="">
              <option value="">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <Button type="submit">Add budget</Button>
          </div>
        </form>
        <p className="text-xs text-muted-foreground">
          One budget per account and scope per fiscal year. Leaving business unit and department as
          “whole organization” makes the company-wide budget for that account — and there can only
          be one, which is what stops the same budget being created twice and every total after it
          being quietly wrong.
        </p>
      </section>
    </main>
  );
}
