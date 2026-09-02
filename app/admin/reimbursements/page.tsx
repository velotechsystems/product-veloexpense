/**
 * VX2-9 — /admin/reimbursements. Approved reports waiting to be paid.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after the table because a `<form>` may not be a child of a
 * `<tr>`; the inputs point at them with the HTML `form` attribute.
 *
 * ── What this screen is, and what it is careful not to claim ────────────────
 *
 * It is a QUEUE, oldest first, because that is how an AP clerk works and because
 * the report that has waited longest is the one somebody is chasing.
 *
 * It is NOT a payment run. Marking a report reimbursed asserts that money moved
 * somewhere else — VeloExpense moves no money and posts nothing to a ledger. The
 * page says so in those words, because "Mark reimbursed" invites the reading that
 * pressing it pays somebody, and the one thing worse than a queue nobody works is
 * a queue somebody works believing it does more than it does.
 *
 * GAP-AUDIT RB-6 is where that comes from: in ExpenseOS the accounting hand-off
 * happens at APPROVAL, not payment — "an approved report is a liability, so
 * NetSuite gets it now rather than when somebody remembers" — and reimbursement
 * touches no ledger at all.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMinor } from '@/lib/money';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { getPayablePage, reimburseFromForm } from './actions';

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
export default async function ReimbursementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error } = await searchParams;
  const { rows, breakGlass } = await getPayablePage();
  const total = rows.reduce((sum, r) => sum + BigInt(r.total_minor), 0n);
  const currency = rows[0]?.currency_code ?? 'CAD';
  const mixed = new Set(rows.map((r) => r.currency_code)).size > 1;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reimbursements</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length === 0
              ? 'Nothing approved is waiting to be paid'
              : `${rows.length} waiting${
                  // Only summed when there is one currency to sum. A mixed-currency
                  // total is a number that means nothing, and PE-1 (policy
                  // thresholds are currency-blind) is a live reminder of what
                  // happens when a figure quietly assumes one currency.
                  mixed ? '' : ` · ${formatMinor(total.toString(), currency, undefined, prefs.locale)}`
                }`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* No admin navigation exists yet — HANDOFF §7. */}
          <Link href="/admin/notification-delivery" className="text-sm underline underline-offset-4">
            Email delivery
          </Link>
          <Link href="/admin/approval-ladder" className="text-sm underline underline-offset-4">
            Approval ladder
          </Link>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">This does not pay anybody.</p>
        <p className="mt-1 text-muted-foreground">
          Marking a report reimbursed records that the payment was made elsewhere — in your bank, your
          payroll run or your accounting system. VeloExpense moves no money and posts no journal
          entry. The reference is for you: it is what links this record to the payment, and it is the
          only thing an auditor can reconcile against.
        </p>
        <p className="mt-2 text-muted-foreground">
          It is also the <strong>last</strong> thing that happens to a report — there is no undo. The
          submitter is notified.
        </p>
      </div>

      {mixed ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          These reports are in more than one currency, so there is no total shown. Each is paid in the
          currency it was filed in.
        </div>
      ) : null}

      {breakGlass ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p className="font-medium">Self-payment is enabled for this organization.</p>
          <p className="mt-1 text-muted-foreground">
            An administrator can mark their own report reimbursed. That is the break-glass setting a
            one-person finance team needs, and every use is recorded in the audit trail under its own
            action. If somebody else here can release payments, turn it off.
          </p>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Report</th>
              <th className="px-3 py-2 font-medium">Claimant</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Approved</th>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={6}>
                Nothing to pay. Approved reports appear here as soon as they clear their last
                approval.
              </EmptyRow>
            ) : (
              rows.map((row) => {
                const formId = `pay-${row.id}`;
                return (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <Link
                        href={`/expenses/${row.id}`}
                        className="font-medium underline underline-offset-4"
                      >
                        {row.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">{row.number ?? '—'}</p>
                    </td>
                    <td className="px-3 py-2">{row.submitter_name}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatMinor(row.total_minor, row.currency_code, undefined, prefs.locale)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatInstant(row.approved_at, prefs)}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        form={formId}
                        name="reference"
                        placeholder="EFT batch, cheque no."
                        className="w-48"
                        aria-label={`Payment reference for ${row.title}`}
                        disabled={row.blockedAsOwn}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">optional</p>
                    </td>
                    <td className="px-3 py-2">
                      {row.blockedAsOwn ? (
                        // The reason, not a missing button. An AP clerk who cannot
                        // pay one row out of twenty needs to know which and why.
                        <span className="text-xs text-muted-foreground">
                          This is your own report — somebody else has to release it.
                        </span>
                      ) : (
                        <Button form={formId} type="submit" size="sm">
                          Mark reimbursed
                        </Button>
                      )}
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
        .filter((r) => !r.blockedAsOwn)
        .map((r) => (
          <form key={r.id} id={`pay-${r.id}`} action={reimburseFromForm} className="hidden">
            <input type="hidden" name="reportId" value={r.id} />
          </form>
        ))}
    </div>
  );
}
