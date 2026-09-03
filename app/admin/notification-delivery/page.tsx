/**
 * VX2-8 — /admin/notification-delivery. Did the email go out, and if not, why.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after the table because a `<form>` may not be a child of a
 * `<tr>`.
 *
 * The screen exists because of NT-11: two ExpenseOS incidents where a
 * notification that did not arrive produced "no error, no log, no delivery" and
 * was "un-diagnosable across several UAT rounds". Everything on this page is in
 * service of one question — "did my approver get the email?" — and the most
 * important thing on it is the verbatim error text, not the counts.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { enumLabel, DELIVERY_STATUS_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { drainNowFromForm, getQueuePage, retryDeliveryFromForm } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  PENDING: 'border-border text-muted-foreground',
  FAILED: 'border-destructive/40 text-destructive',
  DEAD: 'border-destructive/60 text-destructive',
  SENT: 'border-primary/40 text-primary',
  CANCELLED: 'border-border text-muted-foreground',
};

const FILTERS = ['UNSETTLED', 'PENDING', 'FAILED', 'DEAD', 'SENT', 'CANCELLED'] as const;

export default async function NotificationDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error, status } = await searchParams;
  const { rows, summary, transport, filter } = await getQueuePage(status);
  const needsAttention = summary.dead + summary.failed;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Email delivery</h1>
          <p className="text-sm text-muted-foreground">
            {needsAttention === 0
              ? `${summary.pending} waiting · nothing needs attention`
              : `${needsAttention} need attention · ${summary.pending} waiting`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* No admin navigation exists yet — HANDOFF §7. */}
          <Link href="/admin/notification-templates" className="text-sm underline underline-offset-4">
            Wording
          </Link>
          <Link href="/admin/approval-ladder" className="text-sm underline underline-offset-4">
            Approval ladder
          </Link>
          <form action={drainNowFromForm}>
            <Button type="submit" variant="outline">
              Send waiting mail now
            </Button>
          </form>
        </div>
      </header>

      <ErrorBanner message={error} />

      {/* ── the transport, first, because it is the usual answer ─────────── */}
      <div
        className={`rounded-lg border p-4 text-sm ${
          transport.ok ? 'border-border bg-muted/30' : 'border-destructive/40 bg-destructive/10'
        }`}
      >
        <p className="font-medium">
          {transport.kind === 'CONSOLE'
            ? 'No mail is being sent.'
            : transport.ok
              ? 'Mail transport is reachable.'
              : 'Mail transport is NOT reachable.'}
        </p>
        <p className="mt-1 text-muted-foreground">{transport.message}</p>
        {transport.kind === 'CONSOLE' ? (
          <p className="mt-1 text-muted-foreground">
            Notifications still appear in people&rsquo;s in-app lists — that channel does not need a
            mail server. Anything queued here will be marked sent once it has been written to the
            server log.
          </p>
        ) : null}
      </div>

      {/* ── what the words mean ──────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">
          &ldquo;Sent&rdquo; means the mail server accepted it — not that it arrived.
        </p>
        <p className="mt-1 text-muted-foreground">
          <strong>Waiting</strong> means nothing has picked it up yet; if that number keeps growing,
          the scheduled send is not running and the button above will clear it.{' '}
          <strong>Failed</strong> will be tried again automatically. <strong>Dead</strong> has run
          out of attempts and needs somebody. <strong>Nothing to send</strong> means there never was
          anything — usually a recipient with no email address.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Show</span>
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === 'UNSETTLED' ? '/admin/notification-delivery' : `?status=${f}`}
            className={
              filter === f ? 'font-medium' : 'text-muted-foreground underline underline-offset-4'
            }
          >
            {f === 'UNSETTLED'
              ? 'Needs watching'
              : f === 'CANCELLED'
                ? 'Nothing to send'
                : f.charAt(0) + f.slice(1).toLowerCase()}
          </Link>
        ))}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {summary.sent} sent · {summary.pending} waiting · {summary.failed} failed · {summary.dead}{' '}
          dead · {summary.cancelled} nothing to send
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">To</th>
              <th className="px-3 py-2 font-medium">About</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Tries</th>
              <th className="px-3 py-2 font-medium">What happened</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={6}>
                {filter === 'UNSETTLED'
                  ? 'Nothing waiting and nothing failed. Everything that was queued has been sent.'
                  : 'Nothing in this state.'}
              </EmptyRow>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    {row.recipientName}
                    <p className="text-xs text-muted-foreground">
                      {/* The address we actually USED, recorded at send time, not
                          the one they have now. */}
                      {row.destination ?? row.recipientEmail}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/expenses/${row.subjectId}`}
                      className="underline underline-offset-4"
                    >
                      {row.eventType}
                    </Link>
                    <p className="text-xs text-muted-foreground">{formatInstant(row.createdAt, prefs)}</p>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${STATUS_TONE[row.status] ?? ''}`}
                    >
                      {enumLabel(DELIVERY_STATUS_COPY, row.status, prefs.locale)}
                    </span>
                    {row.status === 'SENT' && row.sentAt ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        accepted {formatInstant(row.sentAt, prefs)}
                      </p>
                    ) : null}
                    {row.status === 'FAILED' ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        next try {formatInstant(row.nextAttemptAt, prefs)}
                      </p>
                    ) : null}
                    {row.claimedAt ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        in flight, held by {row.claimedBy ?? 'a sender'}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{row.attempts}</td>
                  <td className="px-3 py-2">
                    {/* VERBATIM. Paraphrasing an SMTP rejection is how
                        "delivery failed" becomes the only thing anybody can find
                        out — which is the incident this screen exists for. */}
                    {row.lastError ? (
                      <code className="block max-w-[34rem] break-words text-xs">
                        {row.lastError}
                      </code>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'FAILED' ||
                    row.status === 'DEAD' ||
                    row.status === 'CANCELLED' ? (
                      <Button
                        form={`retry-${row.id}`}
                        type="submit"
                        size="sm"
                        variant="outline"
                      >
                        Try again
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* The row forms. Outside the table, referenced by `form=` above. */}
      {rows
        .filter((r) => r.status === 'FAILED' || r.status === 'DEAD' || r.status === 'CANCELLED')
        .map((r) => (
          <form key={r.id} id={`retry-${r.id}`} action={retryDeliveryFromForm} className="hidden">
            <input type="hidden" name="deliveryId" value={r.id} />
          </form>
        ))}

      <p className="text-xs text-muted-foreground">
        Approval links in these emails last five business days and can be used once. Trying a
        delivery again mints new links and retires the old ones, so an earlier copy of the email
        stops working.
      </p>
    </div>
  );
}
