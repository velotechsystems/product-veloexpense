/**
 * VX1-7 — /admin/expense-policies (ExpenseOS Module 9's admin surface).
 *
 * Server component posting plain <form action={serverAction}>, same as the
 * employee directory: no client JS, no client state. Rule TYPES come from the
 * code registry (lib/policy/rules.ts) and are fixed; what an admin edits here
 * are the INSTANCE rows — severity, threshold, category scope, effective dates,
 * on/off — which take effect on the next validation, no deploy.
 *
 * Row forms live after the table because a <form> may not be a child of <tr>;
 * the inputs point at them with the HTML `form` attribute.
 */
import { Fragment } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { minorToDecimalString } from '@/lib/money';
import {
  RULE_DEFINITIONS,
  RULE_KINDS,
  SEVERITIES,
  ruleDefinition,
  severityExceeds,
} from '@/lib/policy/rules';
import {
  createPolicyFromForm,
  deletePolicyFromForm,
  getPoliciesPage,
  setPolicyCurrencyFromForm,
  restoreStarterRulesFromForm,
  updatePolicyFromForm,
} from './actions';
import {
  EmptyRow,
  ErrorBanner,
  SeverityBadge,
  cardClass,
  fieldClass,
  labelClass,
  selectClass,
} from '@/app/expenses/ui';

export const dynamic = 'force-dynamic';

function thresholdValue(params: Record<string, unknown>): string {
  const raw = params?.thresholdMinor;
  if (raw === undefined || raw === null || raw === '') return '';
  return minorToDecimalString(String(raw), 2);
}

function dateValue(value: Date | string | null): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export default async function ExpensePoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { policies, categories, policyCurrency, currencies } = await getPoliciesPage();
  const scopeable = RULE_KINDS.filter((kind) => RULE_DEFINITIONS[kind].supportsCategoryScope);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expense policies</h1>
          <p className="text-sm text-muted-foreground">
            {policies.length} {policies.length === 1 ? 'rule' : 'rules'} · changes apply on the next
            save of a report, no deploy
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* No admin navigation exists yet; the two admin surfaces link to each
              other so neither is reachable only by typing a URL. */}
          <Link href="/admin/approval-ladder" className="text-sm underline underline-offset-4">
            Approval ladder
          </Link>
          <form action={restoreStarterRulesFromForm}>
            <Button type="submit" variant="outline">
              Restore starter rules
            </Button>
          </form>
        </div>
      </header>

      <ErrorBanner message={error} />

      {/* ── The policy currency (VX3-2 / PE-1) ────────────────────────────────
          Its own panel, above the rules, because it changes what every threshold
          in the tenant MEANS. Before this existed, `thresholdMinor` was a bare
          number compared straight against a report's amount — so 500000 was
          $5,000 on a CAD report and $5,000 on a USD one, roughly a 37% difference
          in the rule an employee actually met. */}
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-medium">Threshold currency</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every amount below is compared in this currency. A report in another currency is
              converted first, so one limit means the same thing to everybody. A rule can override
              it — useful if you have entities in more than one country.
            </p>
          </div>
          <form action={setPolicyCurrencyFromForm} className="flex items-end gap-2">
            <select
              name="policyCurrency"
              className={selectClass}
              defaultValue={policyCurrency.code}
              aria-label="Policy currency"
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline">
              Save
            </Button>
          </form>
        </div>

        {policyCurrency.unconvertible.length > 0 ? (
          // The warning an admin needs BEFORE the reports start coming back with
          // "could not be checked" notes on them. Naming the currencies makes it
          // actionable; "no rate" on its own does not.
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <strong className="font-medium">
              Amount limits cannot be enforced on {policyCurrency.unconvertible.join(', ')} reports.
            </strong>{' '}
            There is no exchange rate between{' '}
            {policyCurrency.unconvertible.length === 1 ? 'that currency' : 'those currencies'} and{' '}
            {policyCurrency.code}, so those reports get an informational note instead of a limit
            check. Rules that do not involve an amount are unaffected.
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {policyCurrency.convertible.length === 0
            ? 'No exchange rates are loaded. Reports in a single currency are unaffected.'
            : `Rates available: ${policyCurrency.convertible.join(', ')} (the reverse of each is derived).`}
        </p>
      </section>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Rule</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Severity</th>
              <th className="px-3 py-2 font-medium">Threshold</th>
              <th className="px-3 py-2 font-medium">Effective</th>
              <th className="px-3 py-2 font-medium">On</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 ? (
              <EmptyRow colSpan={7}>
                No policy rules yet. Restore the starter set above, or add one below.
              </EmptyRow>
            ) : (
              policies.map((p) => {
                const definition = ruleDefinition(p.kind);
                const takesThreshold = definition.params.some((s) => s.name === 'thresholdMinor');
                return (
                  <tr key={p.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{definition.label}</span>
                        <SeverityBadge severity={p.severity} />
                      </div>
                      <p className="max-w-md text-xs text-muted-foreground">
                        {definition.description}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      {definition.supportsCategoryScope ? (
                        <select
                          form={`policy-${p.id}`}
                          name="categoryId"
                          className={selectClass}
                          defaultValue={p.category_id ?? ''}
                        >
                          <option value="">All categories</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                              {c.active ? '' : ' (inactive)'}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted-foreground">Whole report</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        form={`policy-${p.id}`}
                        name="severity"
                        className={selectClass}
                        defaultValue={p.severity}
                      >
                        {/* A rule with a declared maximum does not offer more than
                            it will evaluate at — `createPolicy`/`updatePolicy`
                            refuse it and `validateReport` clamps it, so offering
                            the option would only be a form that answers no. The
                            "Add a rule" form below cannot do this: its kind is
                            chosen in the same submit, and narrowing the list would
                            need client JS in a screen that deliberately has none.
                            There the service's refusal is the whole gate, which is
                            MT-3's rule — gates belong below the screen. */}
                        {SEVERITIES.filter(
                          (s) =>
                            definition.maxSeverity === undefined ||
                            !severityExceeds(s, definition.maxSeverity),
                        ).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {takesThreshold ? (
                        <div className="flex items-center gap-1">
                          <Input
                            form={`policy-${p.id}`}
                            name="thresholdMinor"
                            inputMode="decimal"
                            className="max-w-28 text-right"
                            placeholder="0.00"
                            defaultValue={thresholdValue(p.params)}
                          />
                          {/* Empty = the tenant's currency, which is the case for
                              nearly every rule and is why the option is labelled
                              with the code rather than left blank. */}
                          <select
                            form={`policy-${p.id}`}
                            name="currencyCode"
                            className={selectClass}
                            defaultValue={p.currency_code ?? ''}
                            aria-label={`Currency for the ${definition.label} threshold`}
                          >
                            <option value="">{policyCurrency.code}</option>
                            {currencies
                              .filter((c) => c.code !== policyCurrency.code)
                              .map((c) => (
                                <option key={c.code} value={c.code}>
                                  {c.code}
                                </option>
                              ))}
                          </select>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <Input
                          form={`policy-${p.id}`}
                          name="effectiveFrom"
                          type="date"
                          className="max-w-36"
                          defaultValue={dateValue(p.effective_from)}
                        />
                        <Input
                          form={`policy-${p.id}`}
                          name="effectiveTo"
                          type="date"
                          className="max-w-36"
                          defaultValue={dateValue(p.effective_to)}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        form={`policy-${p.id}`}
                        type="checkbox"
                        name="enabled"
                        defaultChecked={p.enabled}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button type="submit" form={`policy-${p.id}`} size="xs" variant="outline">
                          Save
                        </Button>
                        <Button
                          type="submit"
                          form={`policy-del-${p.id}`}
                          size="xs"
                          variant="destructive"
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {policies.map((p) => (
        <Fragment key={`forms-${p.id}`}>
          <form id={`policy-${p.id}`} action={updatePolicyFromForm} className="hidden">
            <input type="hidden" name="policyId" value={p.id} />
          </form>
          <form id={`policy-del-${p.id}`} action={deletePolicyFromForm} className="hidden">
            <input type="hidden" name="policyId" value={p.id} />
          </form>
        </Fragment>
      ))}

      <section className={`${cardClass} flex flex-col gap-4 p-5`}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Add a rule
        </h2>
        <form action={createPolicyFromForm} className="grid items-end gap-3 sm:grid-cols-3">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="kind">
              Rule
            </label>
            <select id="kind" name="kind" required className={selectClass} defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {RULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {RULE_DEFINITIONS[kind].label}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="severity">
              Severity
            </label>
            <select id="severity" name="severity" className={selectClass} defaultValue="WARNING">
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="thresholdMinor">
              Threshold
            </label>
            <Input id="thresholdMinor" name="thresholdMinor" inputMode="decimal" placeholder="0.00" />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="categoryId">
              Category
            </label>
            <select id="categoryId" name="categoryId" className={selectClass} defaultValue="">
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Only {scopeable.map((k) => RULE_DEFINITIONS[k].label).join(' and ')} can be scoped to
              one category.
            </p>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="effectiveFrom">
              Effective from
            </label>
            <Input id="effectiveFrom" name="effectiveFrom" type="date" />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="effectiveTo">
              Effective to
            </label>
            <Input id="effectiveTo" name="effectiveTo" type="date" />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked />
            Enabled
          </label>

          <div className="sm:col-span-3">
            <Button type="submit">Add rule</Button>
          </div>
        </form>
      </section>

      <p className="text-sm text-muted-foreground">
        <Link className="underline underline-offset-4" href="/admin/employees">
          Employees
        </Link>
      </p>
    </div>
  );
}
