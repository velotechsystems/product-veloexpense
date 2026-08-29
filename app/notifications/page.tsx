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
import { Button } from '@/components/ui/button';
import { EmptyRow, ErrorBanner, formatDate } from '@/app/expenses/ui';
import { getInboxPage, markAllReadFromForm, markReadFromForm } from './actions';

export const dynamic = 'force-dynamic';

/** Where a subject lives. One table, so a new subject type is one line here and
 *  not a branch in three components (ExpenseOS learned this the hard way — a
 *  duplicated link table meant three subject types went out to email with no
 *  link at all, silently, "because each copy was only exercised by its own
 *  surface"). */
const SUBJECT_PATH: Record<string, (id: string) => string> = {
  EXPENSE_REPORT: (id) => `/expenses/${id}`,
};

function subjectHref(subjectType: string, subjectId: string): string | null {
  return SUBJECT_PATH[subjectType]?.(subjectId) ?? null;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; unread?: string }>;
}) {
  const { error, unread } = await searchParams;
  const unreadOnly = unread === '1';
  const { rows, unread: unreadTotal } = await getInboxPage(unreadOnly);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {unreadTotal === 0
              ? 'Nothing unread'
              : `${unreadTotal} unread`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* No global navigation exists anywhere in the app yet, so the
              surfaces cross-link each other. Not a substitute for a real nav
              with an unread badge on it — see HANDOFF §7. */}
          <Link href="/approvals" className="text-sm underline underline-offset-4">
            Approvals
          </Link>
          <Link
            href="/notifications/preferences"
            className="text-sm underline underline-offset-4"
          >
            Preferences
          </Link>
          {unreadTotal > 0 ? (
            <form action={markAllReadFromForm}>
              <Button type="submit" variant="outline">
                Mark all read
              </Button>
            </form>
          ) : null}
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/notifications"
          className={unreadOnly ? 'text-muted-foreground underline underline-offset-4' : 'font-medium'}
        >
          Everything
        </Link>
        <Link
          href="/notifications?unread=1"
          className={unreadOnly ? 'font-medium' : 'text-muted-foreground underline underline-offset-4'}
        >
          Unread only
        </Link>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">What happened</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={3}>
                {unreadOnly
                  ? 'Nothing unread.'
                  : 'Nothing yet. Submitted reports, approvals and returns land here.'}
              </EmptyRow>
            ) : (
              rows.map((row) => {
                const href = subjectHref(row.subjectType, row.subjectId);
                return (
                  <tr
                    key={row.notificationId}
                    className={`border-t border-border align-top ${
                      row.readAt === null ? 'bg-primary/5' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <p className={row.readAt === null ? 'font-medium' : ''}>
                        {href ? (
                          <Link href={href} className="underline underline-offset-4">
                            {row.body}
                          </Link>
                        ) : (
                          row.body
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row.eventType}
                        {row.fromTemplate ? ' · your wording' : ' · shipped wording'}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(row.occurredAt)}
                    </td>
                    <td className="px-3 py-2">
                      {row.readAt === null ? (
                        <Button
                          form={`read-${row.notificationId}`}
                          type="submit"
                          size="sm"
                          variant="outline"
                        >
                          Mark read
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

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

      <p className="text-xs text-muted-foreground">
        Open a report to act on it — a notification says what happened, the report is where you do
        something about it.
      </p>
    </div>
  );
}
