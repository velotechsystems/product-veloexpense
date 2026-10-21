/**
 * VX2-7 — /notifications, the in-app inbox.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after the table because a `<form>` may not be a child of a
 * `<tr>`; the buttons point at them with the HTML `form` attribute.
 *
 * ── What this page is and is not ────────────────────────────────────────────
 *
 * It is the always-on channel. Email and Slack arrive with VX2-8 and read the
 * same rows, so this list is what "notified" means today and the floor of what
 * it will mean afterwards.
 *
 * It is NOT a second approvals queue. A notification is a sentence about
 * something that happened; the thing to do about it lives on the report. So
 * every row links to its subject and nothing is decidable here — the same reason
 * /approvals has no approve buttons.
 *
 * The sentence in each row comes from the tenant's template if they have written
 * one and from the shipped copy otherwise, and the row says which. That is not
 * decoration: it is the only way an admin who has just reworded a message can
 * see whether the wording they are reading is theirs.
 */
import Link from 'next/link';
import {
  enumLabel,
  EVENT_TYPE_COPY,
  NOTIFICATION_WORDING_COPY,
} from '@/lib/i18n/catalog/enums';
import { Button } from '@/components/ui/button';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, uiPlural, type UiKey } from '@/lib/i18n/catalog/ui';
import { getInboxPage, markAllReadFromForm, markReadFromForm } from './actions';
import { subjectPath } from '@/lib/notifications/catalog';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { PageHeader, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.notifications');
}

export const dynamic = 'force-dynamic';

/** Where a subject lives. One table, so a new subject type is one line and not a branch in
 *  three components (ExpenseOS learned this the hard way — a duplicated link table meant
 *  three subject types went out to email with no link at all, silently, "because each copy
 *  was only exercised by its own surface"). VeloExpense (w6-01): that table is now
 *  `subjectPath` in lib/notifications/catalog.ts, which the email and Slack dispatch read
 *  too — ExpenseOS's `subjectLinks.ts` — so the bell and the email cannot disagree. */
function subjectHref(subjectType: string, subjectId: string): string | null {
  return subjectPath(subjectType, subjectId);
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; unread?: string }>;
}) {
  const prefs = await readerPrefs();
  const t = (key: UiKey) => uiText(key, prefs.locale);
  const { error, unread } = await searchParams;
  const unreadOnly = unread === '1';
  const { rows, unread: unreadTotal } = await getInboxPage(unreadOnly);

  return (
    <Screen>
      <PageHeader
        title={t('notifications.title')}
        description={
          unreadTotal === 0
            ? t('notifications.none.unread')
            : uiPlural('notifications.count.unread', unreadTotal, {}, prefs.locale)
        }
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href="/notifications/preferences">{t('nav.preferences')}</Link>
            </Button>
            {unreadTotal > 0 ? (
              <form action={markAllReadFromForm}>
                <Button type="submit" variant="outline">
                  {t('notifications.mark.all.read')}
                </Button>
              </form>
            ) : null}
          </>
        }
      />

      <ErrorBanner message={error} />

      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/notifications"
          className={unreadOnly ? 'text-muted-foreground underline underline-offset-4' : 'font-medium'}
        >
          {t('notifications.filter.all')}
        </Link>
        <Link
          href="/notifications?unread=1"
          className={unreadOnly ? 'font-medium' : 'text-muted-foreground underline underline-offset-4'}
        >
          {t('notifications.filter.unread')}
        </Link>
      </div>

      <TableCard>
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t('notifications.column.what')}</TableHead>
              <TableHead>{t('notifications.column.when')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={3}>
                {unreadOnly
                  ? t('notifications.empty.unread')
                  : t('notifications.empty.all')}
              </EmptyRow>
            ) : (
              rows.map((row) => {
                const href = subjectHref(row.subjectType, row.subjectId);
                return (
                  <TableRow key={row.notificationId} className={`align-top ${ row.readAt === null ? 'bg-primary/5' : '' }`}>
                    <TableCell>
                      <p className={row.readAt === null ? 'font-medium' : ''}>
                        {href ? (
                          <Link href={href} className="underline underline-offset-4">
                            {row.body}
                          </Link>
                        ) : (
                          row.body
                        )}
                      </p>
                      {/* ExpenseOS 67db2e33 (#578): what the approver said on a return or
                          rejection, in full — it is in the report's thread too. */}
                      {row.approverNote && (
                        <span className="mt-1.5 block border-border border-l-2 pl-2 text-foreground/90 text-xs leading-relaxed">
                          <span className="block font-medium text-muted-foreground">
                            {t('notifications.approver.note')}
                          </span>
                          <span className="block whitespace-pre-line">{row.approverNote}</span>
                        </span>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {/* VX4-7 part 3. Was `{row.eventType}` — the RAW enum
                            member, on a screen every employee reads. Part 2a
                            built EVENT_TYPE_COPY and moved eleven screens onto
                            it; this site was missed, and no gate could see it
                            because rendering an enum directly is a valid
                            program. The pseudo-locale crawl found it by being
                            the only plain-English string in a bracketed page. */}
                        {enumLabel(EVENT_TYPE_COPY, row.eventType, prefs.locale)}
                        {' · '}
                        {enumLabel(
                          NOTIFICATION_WORDING_COPY,
                          row.fromTemplate ? 'TEMPLATE' : 'SHIPPED',
                          prefs.locale,
                        )}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatInstant(row.occurredAt, prefs)}
                    </TableCell>
                    <TableCell>
                      {row.readAt === null ? (
                        <Button
                          form={`read-${row.notificationId}`}
                          type="submit"
                          size="sm"
                          variant="outline"
                        >
                          {t('notifications.mark.read')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableCard>

      {/* The row forms. Outside the table, referenced by `form=` above. */}
      {rows
        .filter((r) => r.readAt === null)
        .map((r) => (
          <form
            key={r.notificationId}
            id={`read-${r.notificationId}`}
            action={markReadFromForm}
            className="hidden"
          >
            <input type="hidden" name="notificationId" value={r.notificationId} />
          </form>
        ))}

      <p className="text-xs text-muted-foreground">{t('notifications.footer')}</p>
    </Screen>
  );
}
