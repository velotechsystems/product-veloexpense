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
import { enumLabel, INBOX_ROUTE_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, uiPlural, uiSentence, uiAround, type UiKey } from '@/lib/i18n/catalog/ui';

import { pageTitle } from '@/lib/i18n/page-title';

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
  const { tasks, actor } = await getInbox();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('approvals.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {tasks.length === 0
              ? t('approvals.none.waiting')
              : [
                  uiPlural('approvals.count.waiting', tasks.length, {}, prefs.locale),
                  actor.role === 'ADMIN' ? t('approvals.count.admin.suffix') : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Reachable from the inbox because that is where somebody realises
              they are about to be away. No admin nav anywhere yet — HANDOFF §7. */}
          <Link href="/notifications" className="text-sm underline underline-offset-4">
            {t('nav.notifications')}
          </Link>
          <Link
            href="/approvals/delegations"
            className="text-sm underline underline-offset-4"
          >
            {t('nav.delegations')}
          </Link>
          <Link href="/expenses" className="text-sm underline underline-offset-4">
            {t('nav.my.expenses')}
          </Link>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[840px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('approvals.column.report')}</th>
              <th className="px-3 py-2 font-medium">{t('approvals.column.submitted.by')}</th>
              <th className="px-3 py-2 font-medium">{t('approvals.column.total')}</th>
              <th className="px-3 py-2 font-medium">{t('approvals.column.step')}</th>
              <th className="px-3 py-2 font-medium">{t('approvals.column.why')}</th>
              <th className="px-3 py-2 font-medium">{t('approvals.column.waiting.since')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <EmptyRow colSpan={6}>{t('approvals.empty')}</EmptyRow>
            ) : (
              tasks.map((task) => (
                <tr key={task.taskId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/expenses/${task.reportId}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {task.reportTitle}
                    </Link>
                    <p className="text-xs text-muted-foreground">{task.reportNumber ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2">{task.submitterName}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMinor(task.totalMinor, task.currencyCode, undefined, prefs.locale)}
                  </td>
                  <td className="px-3 py-2">
                    {uiSentence(
                      'approvals.step.of',
                      { step: String(task.step), steps: String(task.totalSteps) },
                      prefs.locale,
                    )}
                    {task.rungName ? (
                      <p className="text-xs text-muted-foreground">{task.rungName}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs">
                      {enumLabel(INBOX_ROUTE_COPY, task.route, prefs.locale)}
                    </span>
                    {task.route === 'DELEGATED' && task.coveringFor ? (
                      <p className="text-xs text-muted-foreground">
                        {uiSentence('approvals.covering.for', { name: task.coveringFor }, prefs.locale)}
                      </p>
                    ) : null}
                    {task.escalationLevel > 0 ? (
                      // Non-zero means the ladder was not literally met — the
                      // resolver walked past somebody absent, or fell short of
                      // the level the rung asked for. An approver seeing a report
                      // they did not expect deserves to know why.
                      <p className="text-xs text-muted-foreground">
                        {uiPlural(
                          'approvals.escalated',
                          task.escalationLevel,
                          {},
                          prefs.locale,
                        )}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatInstant(task.submittedAt, prefs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
    </div>
  );
}
