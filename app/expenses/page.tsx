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
import { EmptyRow, ErrorBanner, StatusBadge, formatDate, selectClass } from './ui';

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
          <h1 className="text-2xl font-semibold tracking-tight">Expense reports</h1>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? 'report' : 'reports'}
            {orgWide ? ' across your organization' : ' submitted by you'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Still no app-wide navigation (HANDOFF §7), so the inbox is linked
              from the one page every user already visits. */}
          <Link href="/approvals" className="text-sm underline underline-offset-4">
            Approvals
          </Link>
          <Button asChild>
            <Link href="/expenses/new">New report</Link>
          </Button>
        </div>
      </header>

      <ErrorBanner message={sp.error} />

      <form className="flex flex-wrap items-end gap-3" action="/expenses">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="q">
            Search
          </label>
          <Input id="q" name="q" placeholder="Title or EXP number" defaultValue={sp.q ?? ''} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" defaultValue={sp.status ?? ''} className={selectClass}>
            <option value="">Any</option>
            {REPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {actor.role === 'ADMIN' ? (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="scope" value="all" defaultChecked={orgWide} />
            Everyone&rsquo;s reports
          </label>
        ) : null}
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Report</th>
              {orgWide ? <th className="px-4 py-3 font-medium">Submitter</th> : null}
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Expenses</th>
              <th className="px-4 py-3 font-medium">Receipts</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <EmptyRow colSpan={orgWide ? 7 : 6}>
                No reports yet. <Link className="underline underline-offset-4" href="/expenses/new">Start one</Link>.
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
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.expense_count}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.receipt_count}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(r.created_at)}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMinor(r.total_minor, r.currency_code, r.minor_unit)}
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
              Previous
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link className="underline underline-offset-4" href={pageHref(page + 1)}>
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
