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
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, uiPlural, uiSentence, type UiKey } from '@/lib/i18n/catalog/ui';
import {
  enumLabel,
  RULE_KIND_COPY,
  RULE_DESCRIPTION_COPY,
  SEVERITY_COPY,
} from '@/lib/i18n/catalog/enums';
import { joinAnd } from '@/lib/i18n/list';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.expense.policies');
}

import {
  RULE_DEFINITIONS,
  RULE_KINDS,
  SEVERITIES,
  ruleDefinition,
  severityExceeds,
  type RuleKind,
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
  } from '@/app/expenses/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, Screen } from '@/components/screen';

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
  const prefs = await readerPrefs();
  const t = (key: UiKey) => uiText(key, prefs.locale);
  // One list of rule names in this product, and it is no longer in `rules.ts`
  // — see the note above `RULE_KIND_COPY`.
  const ruleName = (kind: RuleKind) => enumLabel(RULE_KIND_COPY, kind, prefs.locale);
  const { error } = await searchParams;
  const { policies, categories, policyCurrency, currencies } = await getPoliciesPage();
  const scopeable = RULE_KINDS.filter((kind) => RULE_DEFINITIONS[kind].supportsCategoryScope);

  return (
    <Screen width="wide">
      <PageHeader
        title={t('policies.title')}
        description={uiPlural('policies.count.rules', policies.length, { tail: t('policies.count.tail') }, prefs.locale)}
        actions={
          <form action={restoreStarterRulesFromForm}>
            <Button type="submit" variant="outline">
              {t('policies.restore.starter')}
            </Button>
          </form>
        }
      />

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
            <h2 className="text-lg leading-7 font-semibold">{t('policies.currency.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('policies.currency.lede')}</p>
          </div>
          <form action={setPolicyCurrencyFromForm} className="flex items-end gap-2">
            <NativeSelect
              name="policyCurrency"
              defaultValue={policyCurrency.code}
              aria-label={t('policies.currency.aria')}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </NativeSelect>
            <Button type="submit" size="sm" variant="outline">
              {t('policies.save')}
            </Button>
          </form>
        </div>

        {policyCurrency.unconvertible.length > 0 ? (
          // The warning an admin needs BEFORE the reports start coming back with
          // "could not be checked" notes on them. Naming the currencies makes it
          // actionable; "no rate" on its own does not.
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {/* Two whole sentences per number rather than a ternary swapping
                "that currency" for "those currencies" inside one. The singular and
                plural of this sentence differ by more than a word in most
                languages, and a ternary over two English fragments is the shape
                that forbids saying so. The currency list is joined by
                `Intl.ListFormat`, so the separator is the reader's too. */}
            <strong className="font-medium">
              {uiSentence(
                'policies.unconvertible.title',
                { currencies: joinAnd(policyCurrency.unconvertible, prefs.locale) },
                prefs.locale,
              )}
            </strong>{' '}
            {uiSentence(
              policyCurrency.unconvertible.length === 1
                ? 'policies.unconvertible.one.detail'
                : 'policies.unconvertible.many.detail',
              { code: policyCurrency.code },
              prefs.locale,
            )}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {policyCurrency.convertible.length === 0
            ? t('policies.no.rates')
            : uiSentence(
                'policies.rates.available',
                { pairs: joinAnd(policyCurrency.convertible, prefs.locale) },
                prefs.locale,
              )}
        </p>
      </section>

      <TableCard>
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64">{t('policies.column.rule')}</TableHead>
              <TableHead>{t('policies.column.category')}</TableHead>
              <TableHead>{t('policies.column.severity')}</TableHead>
              <TableHead>{t('policies.column.threshold')}</TableHead>
              <TableHead>{t('policies.column.effective')}</TableHead>
              <TableHead>{t('policies.column.on')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.length === 0 ? (
              <EmptyRow colSpan={7}>{t('policies.empty')}</EmptyRow>
            ) : (
              policies.map((p) => {
                const definition = ruleDefinition(p.kind);
                const takesThreshold = definition.params.some((s) => s.name === 'thresholdMinor');
                return (
                  <TableRow key={p.id} className="align-top">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{ruleName(p.kind)}</span>
                        <SeverityBadge severity={p.severity} locale={prefs.locale} />
                      </div>
                      <p className="max-w-md text-xs text-muted-foreground">
                        {enumLabel(RULE_DESCRIPTION_COPY, p.kind, prefs.locale)}
                      </p>
                    </TableCell>
                    <TableCell>
                      {definition.supportsCategoryScope ? (
                        <NativeSelect
                          form={`policy-${p.id}`}
                          name="categoryId"
                          className="min-w-40"
                          defaultValue={p.category_id ?? ''}
                        >
                          <option value="">{t('policies.all.categories')}</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                              {c.active ? '' : t('policies.category.inactive.suffix')}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <span className="text-muted-foreground">{t('policies.whole.report')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <NativeSelect
                        form={`policy-${p.id}`}
                        name="severity"
                        className="min-w-36"
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
                            {/* `SeverityBadge` in the same row says "Must be
                                fixed"; this used to say `BLOCK`. */}
                            {enumLabel(SEVERITY_COPY, s, prefs.locale)}
                          </option>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      {takesThreshold ? (
                        <div className="flex items-center gap-1">
                          <Input
                            form={`policy-${p.id}`}
                            name="thresholdMinor"
                            inputMode="decimal"
                            className="w-28 text-right"
                            placeholder="0.00"
                            defaultValue={thresholdValue(p.params)}
                          />
                          {/* Empty = the tenant's currency, which is the case for
                              nearly every rule and is why the option is labelled
                              with the code rather than left blank. */}
                          <NativeSelect
                            form={`policy-${p.id}`}
                            name="currencyCode"
                            className="min-w-24"
                            defaultValue={p.currency_code ?? ''}
                            aria-label={uiSentence(
                              'policies.threshold.currency.aria',
                              { rule: ruleName(p.kind) },
                              prefs.locale,
                            )}
                          >
                            <option value="">{policyCurrency.code}</option>
                            {currencies
                              .filter((c) => c.code !== policyCurrency.code)
                              .map((c) => (
                                <option key={c.code} value={c.code}>
                                  {c.code}
                                </option>
                              ))}
                          </NativeSelect>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>
                      <input
                        form={`policy-${p.id}`}
                        type="checkbox"
                        name="enabled"
                        defaultChecked={p.enabled}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button type="submit" form={`policy-${p.id}`} size="xs" variant="outline">
                          {t('policies.save')}
                        </Button>
                        <Button
                          type="submit"
                          form={`policy-del-${p.id}`}
                          size="xs"
                          variant="destructive"
                        >
                          {t('policies.delete')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableCard>

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
        <h2 className="velo-eyebrow">
          {t('policies.add.title')}
        </h2>
        <form action={createPolicyFromForm} className="grid items-end gap-3 sm:grid-cols-3">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="kind">
              {t('policies.field.rule')}
            </label>
            <NativeSelect id="kind" name="kind" required defaultValue="">
              <option value="" disabled>
                {t('policies.add.choose')}
              </option>
              {RULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {ruleName(kind)}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="severity">
              {t('policies.field.severity')}
            </label>
            <NativeSelect id="severity" name="severity" defaultValue="WARNING">
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {enumLabel(SEVERITY_COPY, s, prefs.locale)}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="thresholdMinor">
              {t('policies.field.threshold')}
            </label>
            <Input id="thresholdMinor" name="thresholdMinor" inputMode="decimal" placeholder="0.00" />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="categoryId">
              {t('policies.field.category')}
            </label>
            <NativeSelect id="categoryId" name="categoryId" defaultValue="">
              <option value="">{t('policies.all.categories')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              {/* `joinAnd`, not `.join(' and ')`. The conjunction was the only
                  English word in this sentence a translator could not reach. */}
              {uiSentence(
                'policies.scopeable.only',
                { rules: joinAnd(scopeable.map(ruleName), prefs.locale) },
                prefs.locale,
              )}
            </p>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="effectiveFrom">
              {t('policies.field.effective.from')}
            </label>
            <Input id="effectiveFrom" name="effectiveFrom" type="date" />
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="effectiveTo">
              {t('policies.field.effective.to')}
            </label>
            <Input id="effectiveTo" name="effectiveTo" type="date" />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked />
            {t('policies.field.enabled')}
          </label>

          <div className="sm:col-span-3">
            <Button type="submit">{t('policies.add.submit')}</Button>
          </div>
        </form>
      </section>

      <p className="text-sm text-muted-foreground">
        <Link className="underline underline-offset-4" href="/admin/employees">
          {t('nav.employees')}
        </Link>
      </p>
    </Screen>
  );
}
