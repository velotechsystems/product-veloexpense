/**
 * VX2-4 — /approvals, the approver's inbox.
 *
 * "What is waiting on ME": tasks assigned to me, tasks assigned to somebody who
 * delegated to me, and role pools I hold. Deliberately NOT everything an admin
 * could decide — an admin reaches other people's approvals from the report
 * itself, because an inbox that lists the whole tenant is not an inbox.
 *
 * Deciding happens on the report, not here. An approver who has not opened the
 * report has not seen what they are approving, and one-click approval from a
 * list is how a rubber stamp gets built by accident.
 */
import Link from 'next/link';
import { formatMinor } from '@/lib/money';
import { getInbox } from './actions';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';

export const dynamic = 'force-dynamic';

const ROUTE_LABEL: Record<string, string> = {
  ASSIGNED: 'Assigned to you',
  DELEGATED: 'Covering',
  ROLE_POOL: 'Your role',
};

/*
 * `undefined` for `minorUnit` below is DELIBERATE and preserves today's exact
 * behaviour: this screen's query does not select `currency.minor_unit`, so the
 * formatter's default of 2 is what has always been used here.
 *
 * That is a real gap and it is NOT this ticket's — `lib/analytics/service.ts`
 * already carries the warning ("formatMinor(x, 'JPY', 2) prints a hundredth of
 * …"), and five queries across approvals, reimbursements and the ledger queue
 * would each need the currency join to close it. Harmless while the product
 * ships CAD and USD, both of which have a minor unit of 2. Writing `undefined`
 * rather than a literal `2` is what keeps it visible as an absence instead of
 * baking the assumption in. Boarded, not folded into a locale PR.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error } = await searchParams;
  const { tasks, actor } = await getInbox();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="text-sm text-muted-foreground">
            {tasks.length === 0
              ? 'Nothing waiting on you'
              : `${tasks.length} waiting on you${actor.role === 'ADMIN' ? ' — other people’s approvals are on their reports, not here' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Reachable from the inbox because that is where somebody realises
              they are about to be away. No admin nav anywhere yet — HANDOFF §7. */}
          <Link href="/notifications" className="text-sm underline underline-offset-4">
            Notifications
          </Link>
          <Link
            href="/approvals/delegations"
            className="text-sm underline underline-offset-4"
          >
            Delegations
          </Link>
          <Link href="/expenses" className="text-sm underline underline-offset-4">
            My expenses
          </Link>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[840px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Report</th>
              <th className="px-3 py-2 font-medium">Submitted by</th>
              <th className="px-3 py-2 font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Step</th>
              <th className="px-3 py-2 font-medium">Why you</th>
              <th className="px-3 py-2 font-medium">Waiting since</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <EmptyRow colSpan={6}>
                Nothing to approve. Reports appear here when somebody submits one that routes to
                you.
              </EmptyRow>
            ) : (
              tasks.map((t) => (
                <tr key={t.taskId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/expenses/${t.reportId}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {t.reportTitle}
                    </Link>
                    <p className="text-xs text-muted-foreground">{t.reportNumber ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2">{t.submitterName}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMinor(t.totalMinor, t.currencyCode, undefined, prefs.locale)}
                  </td>
                  <td className="px-3 py-2">
                    {t.step} of {t.totalSteps}
                    {t.rungName ? (
                      <p className="text-xs text-muted-foreground">{t.rungName}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs">
                      {ROUTE_LABEL[t.route]}
                    </span>
                    {t.route === 'DELEGATED' && t.coveringFor ? (
                      <p className="text-xs text-muted-foreground">for {t.coveringFor}</p>
                    ) : null}
                    {t.escalationLevel > 0 ? (
                      // Non-zero means the ladder was not literally met — the
                      // resolver walked past somebody absent, or fell short of
                      // the level the rung asked for. An approver seeing a report
                      // they did not expect deserves to know why.
                      <p className="text-xs text-muted-foreground">
                        routed {t.escalationLevel} step{t.escalationLevel === 1 ? '' : 's'} from the
                        rung
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatInstant(t.submittedAt, prefs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Open a report to approve, return or reject it — the decision lives with the thing you are
        deciding on. Going away?{' '}
        <Link href="/approvals/delegations" className="underline underline-offset-4">
          Arrange cover
        </Link>{' '}
        — you keep your queue, your stand-in gains the ability to decide.
      </p>
    </div>
  );
}
