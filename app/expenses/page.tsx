/**
 * VX1-6 — /expenses, the report list.
 *
 * Server component: reads through the server action, which resolves the actor
 * inside the tenant transaction and scopes the query to their own reports (an
 * ADMIN can widen it to the whole org with ?scope=all). Filter state lives in
 * the query string, so the page is shareable and needs no client JS.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { REPORT_STATUSES, type ReportStatus } from '@/lib/expenses/service';
import { formatMinor } from '@/lib/money';
import { listReports, getWorkbenchOptions } from './actions';
import { EmptyRow, ErrorBanner, StatusBadge, selectClass } from './ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, uiPlural, uiSentence, uiAround, type UiKey } from '@/lib/i18n/catalog/ui';
import { enumLabel, REPORT_STATUS_COPY } from '@/lib/i18n/catalog/enums';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.expenses');
}

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function isStatus(value: string | undefined): value is ReportStatus {
  return !!value && (REPORT_STATUSES as readonly string[]).includes(value);
}

export default async function ExpenseReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    scope?: string;
    page?: string;
    error?: string;
  }>;
}) {
  const prefs = await readerPrefs();
  const t = (key: UiKey) => uiText(key, prefs.locale);
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? '1') || 1, 1);
  const { actor } = await getWorkbenchOptions();
  const orgWide = sp.scope === 'all' && actor.role === 'ADMIN';

  const { reports, total } = await listReports({
    submitterEmail: orgWide ? null : undefined,
    status: isStatus(sp.status) ? sp.status : null,
    search: sp.q ?? null,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set('q', sp.q);
    if (sp.status) params.set('status', sp.status);
    if (orgWide) params.set('scope', 'all');
    params.set('page', String(n));
    return `/expenses?${params.toString()}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/*
            UD-4. Upstream's A6: a manager opened this list looking for a
            colleague's submission, found their own reports, and concluded it had
            not arrived — it was in the approvals queue the whole time. *"A list
            whose scope is invisible gets read as the whole set."*

            The sub-line below has always said "submitted by you", which is worth
            noting because it makes the finding sharper rather than weaker: the
            scope was disclosed and it was disclosed in the place people skip.
            The scope belongs in the HEADING, and the sub-line keeps saying it
            too — this is a disclosure, and redundancy in a disclosure costs
            nothing when the whole defect is somebody not reading the second line.

            One string in the DOM either way, so the pseudo-locale ratchet for
            /expenses does not move (VX4-10 owns cataloguing this page's chrome).
          */}
          <h1 className="text-2xl font-semibold tracking-tight">
            {t(orgWide ? 'expenses.title.org' : 'expenses.title.own')}
          </h1>
          {/* VX4-10 part 2. Was `{total} {total === 1 ? 'report' : 'reports'}`
              concatenated with a scope clause — three JSX children assembling one
              English sentence. Catalogued as whole sentences per plural category,
              because a language with three plural forms cannot be served by a
              ternary and a language that puts the scope first cannot be served by
              concatenation. */}
          <p className="text-sm text-muted-foreground">
            {uiPlural(orgWide ? 'expenses.count.org' : 'expenses.count.own', total, {}, prefs.locale)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Still no app-wide navigation (HANDOFF §7), so the inbox is linked
              from the one page every user already visits. */}
          <Link href="/approvals" className="text-sm underline underline-offset-4">
            {t('nav.approvals')}
          </Link>
          <Button asChild>
            <Link href="/expenses/new">{t('expenses.new')}</Link>
          </Button>
        </div>
      </header>

      <ErrorBanner message={sp.error} />

      <form className="flex flex-wrap items-end gap-3" action="/expenses">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="q">
            {t('expenses.filter.search')}
          </label>
          <Input
            id="q"
            name="q"
            placeholder={t('expenses.filter.search.placeholder')}
            defaultValue={sp.q ?? ''}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="status">
            {t('expenses.filter.status')}
          </label>
          <select id="status" name="status" defaultValue={sp.status ?? ''} className={selectClass}>
            <option value="">{t('expenses.filter.status.any')}</option>
            {/* The catalogued label, not the member. `StatusBadge` two inches
                away in the table renders "Returned for changes" for the same
                value this dropdown used to spell `RETURNED` — one screen, one
                value, two spellings. The VALUE stays the member; only the text
                changes. `scripts/check-enum-options.mjs` refuses the old form,
                because the pseudo-locale crawl skips <select> by design and
                could never see it. */}
            {REPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {enumLabel(REPORT_STATUS_COPY, s, prefs.locale)}
              </option>
            ))}
          </select>
        </div>
        {actor.role === 'ADMIN' ? (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="scope" value="all" defaultChecked={orgWide} />
            {t('expenses.filter.everyone')}
          </label>
        ) : null}
        <Button type="submit" variant="outline">
          {t('expenses.filter.apply')}
        </Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('expenses.column.report')}</th>
              {orgWide ? (
                <th className="px-4 py-3 font-medium">{t('expenses.column.submitter')}</th>
              ) : null}
              <th className="px-4 py-3 font-medium">{t('expenses.column.status')}</th>
              <th className="px-4 py-3 font-medium">{t('expenses.column.expenses')}</th>
              <th className="px-4 py-3 font-medium">{t('expenses.column.receipts')}</th>
              <th className="px-4 py-3 font-medium">{t('expenses.column.created')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('expenses.column.total')}</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <EmptyRow colSpan={orgWide ? 7 : 6}>
                {/* One catalogued sentence with a `{link}` in it, split by
                    `uiAround`, rather than two entries called `…before` and
                    `…after`. A translator can move the link; with two fragments
                    they cannot, and clause order is not English's to fix. */}
                {(() => {
                  const [before, after] = uiAround('expenses.empty.start', {}, prefs.locale);
                  return (
                    <>
                      {before}
                      <Link className="underline underline-offset-4" href="/expenses/new">
                        {t('expenses.empty.start.link')}
                      </Link>
                      {after}
                    </>
                  );
                })()}
              </EmptyRow>
            ) : (
              reports.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`/expenses/${r.id}`}
                    >
                      {r.title}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">{r.number ?? '—'}</div>
                  </td>
                  {orgWide ? (
                    <td className="px-4 py-3">{r.submitter_name ?? r.submitter_email}</td>
                  ) : null}
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} locale={prefs.locale} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.expense_count}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.receipt_count}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatInstant(r.created_at, prefs)}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMinor(r.total_minor, r.currency_code, r.minor_unit, prefs.locale)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <nav className="flex items-center gap-3 text-sm">
          {page > 1 ? (
            <Link className="underline underline-offset-4" href={pageHref(page - 1)}>
              {t('pager.previous')}
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            {uiSentence(
              'expenses.page.of',
              { page: String(page), pages: String(pageCount) },
              prefs.locale,
            )}
          </span>
          {page < pageCount ? (
            <Link className="underline underline-offset-4" href={pageHref(page + 1)}>
              {t('pager.next')}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
