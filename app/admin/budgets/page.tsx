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
  labelClass,
  } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, ROOMY_CELLS, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.budgets');
}

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
  const prefs = await readerPrefs();
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
    <Screen width="wide">
      <PageHeader
        title="Budgets"
        description="What a period is allowed to spend on one GL account, what it has spent, and who is told when it gets close."
      />

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
      <section className={`${cardClass} overflow-hidden ${ROOMY_CELLS}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Budget</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Alerts</TableHead>
              <TableHead>Periods</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {budgets.length === 0 ? (
              <EmptyRow colSpan={6}>
                {moduleEnabled
                  ? 'No budgets yet. Add one below.'
                  : 'No budgets — and none can be created while the module is off.'}
              </EmptyRow>
            ) : (
              budgets.map((b) => (
                <TableRow key={b.id} className="align-top">
                  <TableCell>
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {b.gl_account_number ? `${b.gl_account_number} — ${b.gl_account_name}` : '—'}
                      {' · '}
                      {b.currency_code} · FY{b.fiscal_year}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{scopeOf(b)}</TableCell>
                  <TableCell>
                    {/* Its own visible form with its own button. The first draft
                        pointed this select at a hidden row form with no trigger,
                        which renders a control that changes nothing — a dead
                        control is worse than no control, because it reads as
                        saved. */}
                    <form action={updateBudgetFromForm} className="flex items-end gap-1">
                      <input type="hidden" name="budgetId" value={b.id} />
                      <input type="hidden" name="name" value={b.name} />
                      <NativeSelect
                        name="ownerId"
                        className="min-w-40"
                        aria-label={`Owner of ${b.name}`}
                        defaultValue={b.owner_id ?? ''}
                      >
                        <option value="">Nobody</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </NativeSelect>
                      <Button type="submit" variant="outline" size="sm">
                        Save
                      </Button>
                    </form>
                    <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                      With nobody, an alert reaches only the recipients named on a threshold.
                    </p>
                  </TableCell>

                  {/* thresholds + their recipients */}
                  <TableCell>
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
                              <NativeSelect name="userId" className="min-w-40" defaultValue="">
                                <option value="" disabled>
                                  Also tell…
                                </option>
                                {people.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </NativeSelect>
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
                  </TableCell>

                  {/* periods + the rollup */}
                  <TableCell>
                    {b.periods.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No periods yet — a budget with no periods measures nothing.
                      </span>
                    ) : (
                      <Table className="text-xs">
                        <TableBody>
                          {b.periods.map((p) => (
                            <TableRow key={p.id} data-testid="budget-period">
                              <TableCell className="text-muted-foreground">{p.starts_on}</TableCell>
                              <TableCell>
                                {formatMinor(p.amount_minor, b.currency_code, b.minor_unit, prefs.locale)}
                              </TableCell>
                              <TableCell>
                                {/* NULL means never calculated, which is not zero
                                    spend — 0024 enforces the distinction with a
                                    CHECK and this is where it has to be visible. */}
                                {p.rolled_up_at === null ? (
                                  <span className="text-muted-foreground">not yet calculated</span>
                                ) : (
                                  <>
                                    {formatMinor(p.actual_minor, b.currency_code, b.minor_unit, prefs.locale)}{' '}
                                    spent
                                    {p.pending_minor !== '0' ? (
                                      <>
                                        {' · '}
                                        {formatMinor(
                                          p.pending_minor,
                                          b.currency_code,
                                          b.minor_unit,
                                          prefs.locale,
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
                                            prefs.locale,
                                          )}{' '}
                                          could not be converted
                                        </span>
                                      </>
                                    ) : null}
                                  </>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {p.rolled_up_at === null ? '' : formatInstant(p.rolled_up_at, prefs)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
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
                  </TableCell>

                  <TableCell>
                    <form action={deleteBudgetFromForm}>
                      <input type="hidden" name="budgetId" value={b.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      {/* ── add a budget ──────────────────────────────────────────────────── */}
      <section className={`${cardClass} flex flex-col gap-4 p-5`}>
        <h2 className="velo-eyebrow">
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
            <NativeSelect id="glAccountId" name="glAccountId" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} — {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="currencyCode">
              Currency
            </label>
            <NativeSelect id="currencyCode" name="currencyCode" required>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="businessUnitId">
              Business unit
            </label>
            <NativeSelect id="businessUnitId" name="businessUnitId" defaultValue="">
              <option value="">Whole organization</option>
              {businessUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="departmentId">
              Department
            </label>
            <NativeSelect id="departmentId" name="departmentId" defaultValue="">
              <option value="">Whole organization</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </NativeSelect>
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
            <NativeSelect id="ownerId" name="ownerId" defaultValue="">
              <option value="">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
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
    </Screen>
  );
}
