/**
 * VX3-4 — /admin/ledger-queue. What has been handed to the ledger, and what has not.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS. Row
 * forms live after the table because a `<form>` may not be a child of a `<tr>`.
 *
 * ── What this screen is careful to say ──────────────────────────────────────
 *
 * IT DRAFTS; IT DOES NOT POST. `draft_bill`'s own banner is "agents draft AP
 * vendor bills; humans post via UI", so a report reaching VeloLedger is a DRAFT
 * bill waiting for somebody there. The screen says so, because "posted" otherwise
 * reads as "in the ledger and final" — the same care VX2-9's screen takes to say
 * that marking a report reimbursed does not move money.
 *
 * NEEDS REVIEW IS NOT A FAILURE, and it is the one row an operator must not
 * ignore. It means the ledger accepted a bill and we failed to record that — so
 * the risk is a DUPLICATE if it is retried blindly. The screen says check the
 * ledger first, and there is no bulk retry.
 *
 * A PENDING QUEUE WITH NOTHING CONNECTED IS A CONFIGURATION PROBLEM, not a
 * backlog, so that case gets its own sentence rather than looking like slowness.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMinor } from '@/lib/money';
import { EmptyRow, ErrorBanner, formatDate } from '@/app/expenses/ui';
import {
  cancelFromForm,
  dryRunFromForm,
  getQueuePage,
  retryFromForm,
  sendNowFromForm,
} from './actions';

export const dynamic = 'force-dynamic';

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'waiting',
  POSTED: 'drafted in the ledger',
  FAILED: 'failed, will retry',
  DEAD: 'out of attempts',
  CANCELLED: 'withheld',
  NEEDS_REVIEW: 'needs review',
};

export default async function LedgerQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; preview?: string }>;
}) {
  const { error, preview } = await searchParams;
  // The dry run's result travels in the query string rather than being re-read,
  // so what is shown belongs to the button that was pressed. A malformed value is
  // ignored rather than thrown on — it is a preview, not a record.
  let previewed: {
    reportTitle: string;
    reportNumber: string | null;
    currencyCode: string;
    totalMinor: string;
    problems: string[];
    lines: Array<{
      description: string;
      amountMinor: string;
      categoryLabel: string;
      glAccountNumber: string | null;
      glAccountName: string | null;
    }>;
  } | null = null;
  try {
    previewed = preview ? JSON.parse(preview) : null;
  } catch {
    previewed = null;
  }
  const { rows, summary, connected } = await getQueuePage();
  const waiting = summary.PENDING + summary.FAILED;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ledger queue</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length === 0
              ? 'Nothing has been queued yet'
              : `${waiting} waiting · ${summary.POSTED} drafted · ${summary.NEEDS_REVIEW} need review · ${summary.DEAD} out of attempts`}
          </p>
        </div>
        <Link href="/admin/integrations" className="text-sm underline underline-offset-4">
          Integrations
        </Link>
      </header>

      {summary.POSTED > 0 ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">Drafted is not posted.</strong> A drafted
          bill is waiting for somebody in the ledger to review and post it, and their post can still
          refuse it — most often because an account is a rollup there, or because the company
          requires a business unit and department that no default supplies. Neither is something
          VeloExpense can see, so a report shown as drafted here may still be sitting unposted
          there. The account numbers themselves are checked before drafting.
        </p>
      ) : null}

      <ErrorBanner message={error} />

      {previewed ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h2 className="text-lg font-medium">
            Dry run — {previewed.reportTitle}
            {previewed.reportNumber ? ` · ${previewed.reportNumber}` : ''}
          </h2>
          {previewed.problems.length === 0 ? (
            <p className="text-sm">
              <strong className="font-medium">Nothing here would stop this posting.</strong> Which
              is not the same as the ledger accepting it — a closed accounting period or a missing
              vendor can only be found by asking, and those are the two commonest real failures.
              Nothing was sent and nothing was written.
            </p>
          ) : (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <strong className="font-medium">This would not post:</strong>
              <ul className="mt-1 list-disc pl-5">
                {previewed.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium">Would post to</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {previewed.lines.map((line, index) => (
                  <tr key={`${line.description}-${index}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      {line.description}
                      <span className="block text-xs text-muted-foreground">
                        {line.categoryLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {line.glAccountNumber ? (
                        `${line.glAccountNumber} — ${line.glAccountName}`
                      ) : (
                        <span className="text-destructive">no account mapped</span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatMinor(line.amountMinor, previewed.currencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            Total {formatMinor(previewed.totalMinor, previewed.currencyCode)}
          </p>
        </section>
      ) : null}

      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        An approved report becomes a <strong>draft bill</strong> in the connected ledger. Somebody
        there reviews and posts it — nothing here writes to a ledger directly, and nothing here
        pays anybody.
      </p>

      {!connected && waiting > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            {waiting} report(s) are waiting and no ledger is connected.
          </strong>{' '}
          This is a configuration gap rather than a backlog — nothing is being retried against
          anything. Connect one on the{' '}
          <Link href="/admin/integrations" className="underline underline-offset-4">
            integrations screen
          </Link>
          ; the queue drains on its own afterwards, including these.
        </div>
      ) : null}

      {summary.NEEDS_REVIEW > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            {summary.NEEDS_REVIEW} post(s) need a person to look at the ledger.
          </strong>{' '}
          The ledger may already hold a bill for these — retrying without checking is how a
          reimbursement gets billed twice. Nothing automatic will touch them.
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Report</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Detail</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>
                Nothing queued. An approved report is added here automatically.
              </EmptyRow>
            ) : (
              rows.map((row) => {
                const needsReview = row.status === 'NEEDS_REVIEW';
                const retryable =
                  row.status === 'DEAD' || row.status === 'CANCELLED' || needsReview;
                return (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <Link
                        href={`/expenses/${row.report_id}`}
                        className="font-medium underline underline-offset-4"
                      >
                        {row.report_title}
                      </Link>
                      <p className="text-xs text-muted-foreground">{row.report_number ?? '—'}</p>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.total_minor === null
                        ? '—'
                        : formatMinor(row.total_minor, row.currency_code ?? 'CAD')}
                    </td>
                    <td className="px-3 py-2">
                      <span className={needsReview || row.status === 'DEAD' ? 'text-destructive' : ''}>
                        {STATUS_TEXT[row.status] ?? row.status}
                      </span>
                      {row.attempts > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                        </span>
                      ) : null}
                      {row.posted_at ? (
                        <span className="block text-xs text-muted-foreground">
                          {formatDate(row.posted_at)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.external_id ? (
                        <span className="block">ledger id {row.external_id}</span>
                      ) : null}
                      {row.last_error ? (
                        <span className="block text-muted-foreground">{row.last_error}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button form={`dry-${row.id}`} type="submit" size="sm" variant="outline">
                          Preview
                        </Button>
                        {row.status === 'PENDING' || row.status === 'FAILED' ? (
                          <Button form={`send-${row.id}`} type="submit" size="sm" variant="outline">
                            Send now
                          </Button>
                        ) : null}
                        {retryable ? (
                          <Button form={`retry-${row.id}`} type="submit" size="sm" variant="outline">
                            {needsReview ? 'Retry anyway' : 'Retry'}
                          </Button>
                        ) : null}
                        {row.status !== 'POSTED' && row.status !== 'CANCELLED' ? (
                          <>
                            <Input
                              form={`cancel-${row.id}`}
                              name="reason"
                              placeholder="why"
                              className="w-32"
                              aria-label={`Reason for withholding ${row.report_title}`}
                            />
                            <Button
                              form={`cancel-${row.id}`}
                              type="submit"
                              size="sm"
                              variant="outline"
                            >
                              Withhold
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Row forms, outside the table, referenced by `form=` above. */}
      {rows.map((row) => (
        <div key={row.id} className="hidden">
          <form id={`dry-${row.id}`} action={dryRunFromForm}>
            <input type="hidden" name="id" value={row.id} />
          </form>
          <form id={`send-${row.id}`} action={sendNowFromForm}>
            <input type="hidden" name="id" value={row.id} />
          </form>
          <form id={`retry-${row.id}`} action={retryFromForm}>
            <input type="hidden" name="id" value={row.id} />
          </form>
          <form id={`cancel-${row.id}`} action={cancelFromForm}>
            <input type="hidden" name="id" value={row.id} />
          </form>
        </div>
      ))}
    </div>
  );
}
