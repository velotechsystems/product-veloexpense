/**
 * VX2-4 — /approvals, the approver's inbox.
 *
 * "What is waiting on ME": tasks assigned to me, and tasks open to me to take — a pool,
 * or the no-manager fallback. Deliberately NOT everything an admin could decide — an
 * admin reaches other people's approvals from the report itself, because an inbox that
 * lists the whole tenant is not an inbox.
 *
 * w4-00c: read from ExpenseOS's engine (`getInbox` → `loadMyExpenseApprovalTasks`). A task
 * is routed to a delegate when it is created, so "covering for" and the ladder's step and
 * rung columns are gone with the ladder. When the engine stops reading a very large pool
 * part-way (`capped`), the page says so rather than presenting a prefix as the queue.
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
import { enumLabel, INBOX_ROUTE_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, uiPlural, uiSentence, uiAround, type UiKey } from '@/lib/i18n/catalog/ui';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { PageHeader, Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.approvals');
}

export const dynamic = 'force-dynamic';

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
  // `t` is the translator here, so the row variable below is `task`. It used to
  // be `t`, which would have shadowed this the moment a catalogued string was
  // needed inside a row — a silent one, since `t.step` and `t('key')` are both
  // valid on their own types.
  const t = (key: UiKey) => uiText(key, prefs.locale);
  const { error } = await searchParams;
  const { tasks, actor, capped, cappedAt } = await getInbox();

  return (
    <Screen>
      <PageHeader
        title={t('approvals.title')}
        description={
          tasks.length === 0
            ? t('approvals.none.waiting')
            : [
                uiPlural('approvals.count.waiting', tasks.length, {}, prefs.locale),
                actor.isAdmin ? t('approvals.count.admin.suffix') : null,
              ]
                .filter(Boolean)
                .join(' ')
        }
        actions={
          // Delegations stays one click away: the inbox is where somebody realises
          // they are about to be away. Everything else is in the sidebar now.
          <Button asChild variant="outline">
            <Link href="/approvals/delegations">{t('nav.delegations')}</Link>
          </Button>
        }
      />

      <ErrorBanner message={error} />
      {capped ? (
        <p className="text-sm text-muted-foreground">
          {uiSentence('approvals.capped', { n: String(cappedAt) }, prefs.locale)}
        </p>
      ) : null}

      <TableCard>
        <Table className="min-w-[840px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t('approvals.column.report')}</TableHead>
              <TableHead>{t('approvals.column.submitted.by')}</TableHead>
              <TableHead>{t('approvals.column.total')}</TableHead>
              <TableHead>{t('approvals.column.why')}</TableHead>
              <TableHead>{t('approvals.column.waiting.since')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <EmptyRow colSpan={5}>{t('approvals.empty')}</EmptyRow>
            ) : (
              tasks.map((task) => (
                <TableRow key={task.taskId}>
                  <TableCell>
                    <Link
                      href={`/expenses/${task.report.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {task.report.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">{task.report.number ?? '—'}</p>
                  </TableCell>
                  <TableCell>{task.report.submitter.firstName ?? task.report.submitter.email}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatMinor(task.report.totalMinor, task.report.currency.code, undefined, prefs.locale)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{enumLabel(INBOX_ROUTE_COPY, task.route, prefs.locale)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatInstant(task.report.submittedAt, prefs)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableCard>

      <p className="text-xs text-muted-foreground">
        {(() => {
          const [before, after] = uiAround('approvals.footer', {}, prefs.locale);
          return (
            <>
              {before}
              <Link href="/approvals/delegations" className="underline underline-offset-4">
                {t('approvals.footer.link')}
              </Link>
              {after}
            </>
          );
        })()}
      </p>
    </Screen>
  );
}
