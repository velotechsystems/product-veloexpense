/**
 * VX5-11 — /admin/billing. What this organization is on, and what it is measured at.
 *
 * Server component, no client JS, same as every other admin screen.
 *
 * ── THE THREE THINGS THIS SCREEN HAS TO GET RIGHT ───────────────────────────
 *
 * 1. **A LAPSED TENANT MUST BE TOLD WHAT STILL WORKS.** The person most likely to
 *    open this page is an administrator who has just had somebody tell them
 *    "I can't submit my expenses". The status banner leads with what is still
 *    possible — drafts save, everything is readable — before what is not, because
 *    the first question is "have we lost anything" and the answer is no.
 *
 * 2. **A TRIAL SHOWS ITS END DATE, NOT A COUNTDOWN.** "17 days left" is a number
 *    that is wrong the moment the page is cached, and it invites a reader to plan
 *    against a figure nobody promised. A date is a fact.
 *
 * 3. **NO SUBSCRIPTION IS AN ANSWER, NOT AN EMPTY STATE.** A tenant created before
 *    migration 0037 has no row, and so does `blank` in the seed. Rendering that as
 *    an empty table would read as "billing is broken"; it says what is actually
 *    true — nothing is being charged and everything works. AC-22's rule, which
 *    this project has now applied to a module being off, a queue being empty, and
 *    here.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * No amounts, no invoice, and after VX5-19 no plan catalogue either. This screen
 * shows QUANTITIES — 34 seats in September — because that is what this product
 * measures and can stand behind. Prices, plans and money belong to the VeloTech
 * platform, which owns them for every product in the suite; printing our own
 * multiplication beside theirs is how two numbers that should agree start not to.
 *
 * 4. **AND IT SAYS WHERE THE DECISIONS ARE MADE.** An administrator looking for a
 *    "change plan" button should find a sentence telling them where to go, not an
 *    absence they read as a missing feature.
 */
import Link from 'next/link';
import { EmptyRow } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { getBillingPage } from '@/app/admin/billing/actions';
import { canWrite, type SubscriptionStatus } from '@/lib/billing/plans';

/**
 * One sentence per status, and the LAPSED/CANCELLED pair leads with what still
 * works. English literals in JSX, like every other admin screen — VX4-10 is the
 * ticket that catalogues this chrome, and adding a half-catalogued screen ahead of
 * it would make that ticket's ratchet harder to read, not easier.
 */
const STATUS_COPY: Record<SubscriptionStatus, { label: string; detail: string }> = {
  TRIALING: {
    label: 'Trial',
    detail: 'Everything works. Nothing is being charged yet.',
  },
  ACTIVE: {
    label: 'Active',
    detail: 'Everything works.',
  },
  PAST_DUE: {
    // Deliberately calm: this state does NOT restrict anything, and a banner that
    // sounded like it did would have people chasing a problem that is not stopping
    // their work.
    label: 'Payment overdue',
    detail:
      'A payment did not go through and is being retried. Nothing is restricted — ' +
      'reports can still be submitted, approved and paid.',
  },
  LAPSED: {
    label: 'Lapsed',
    detail:
      'Drafts still save and everything is still readable. Reports cannot be ' +
      'submitted, approved or marked paid until this is resolved.',
  },
  CANCELLED: {
    label: 'Cancelled',
    detail:
      'Drafts still save and everything is still readable. Reports cannot be ' +
      'submitted, approved or marked paid.',
  },
  SUSPENDED: {
    // NOT a synonym for lapsed, and the copy says so. Suspension is a decision
    // somebody made; lapsing is what happens when a trial runs out or dunning
    // gives up. They restrict the same things, and telling an administrator whose
    // card is fine that they have "lapsed" sends them to fix the wrong problem.
    label: 'Suspended',
    detail:
      'This organization has been suspended by VeloTech. Drafts still save and ' +
      'everything is still readable. Get in touch to resolve it.',
  },
};

export default async function BillingPage() {
  const prefs = await readerPrefs();
  const { subscription, readings, platformConfigured } = await getBillingPage();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          What this organization is on, and what it has been measured at.
        </p>
      </header>

      {subscription === null ? (
        /* Not an empty state — a statement, and it says WHICH of two things is
         * true. AC-22's rule: "billing is switched off in this deployment" and
         * "nobody is billing this particular tenant" look identical as an empty
         * table, and only one of them is something an administrator can act on. */
        <section className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          {platformConfigured ? (
            <>
              <strong className="font-medium">Nothing is being billed for this organization.</strong>{' '}
              VeloTech has no subscription on record for it, so everything works normally
              and nothing is being charged.
            </>
          ) : (
            <>
              <strong className="font-medium">Billing is not configured in this deployment.</strong>{' '}
              VeloExpense is running without a connection to VeloTech billing. Everything
              works normally and nothing is being charged.
            </>
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-3 rounded-md border border-border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium">
              {subscription.planName ?? subscription.planCode}
            </h2>
            <span
              className={
                canWrite(subscription.status)
                  ? 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium'
                  : 'rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive'
              }
              data-testid="subscription-status"
            >
              {STATUS_COPY[subscription.status].label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {STATUS_COPY[subscription.status].detail}
          </p>
          {subscription.trialEndsAt !== null && (
            /* A DATE, not a countdown. See the header, point 2. */
            <p className="text-sm">
              Trial ends {formatInstant(subscription.trialEndsAt, prefs)}.
            </p>
          )}
          {subscription.mirroredAt !== null && (
            /* WHEN the platform said this, not just what it said. The row is a
             * mirror and can be stale — a reader who cannot see its age would
             * take a cached answer for a current one. */
            <p className="text-sm text-muted-foreground">
              Last confirmed with VeloTech {formatInstant(subscription.mirroredAt, prefs)}.
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Measured usage</h2>
        <p className="text-sm text-muted-foreground">
          Counted at the end of each period. Amounts are not shown here — what is charged
          is calculated by the payment provider, and two copies of the same arithmetic
          eventually disagree.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Period</th>
                <th className="py-2 pr-4 font-medium">Measure</th>
                <th className="py-2 pr-4 font-medium">Quantity</th>
                <th className="py-2 pr-4 font-medium">Plan</th>
                <th className="py-2 font-medium">Counted</th>
              </tr>
            </thead>
            <tbody>
              {readings.length === 0 ? (
                <EmptyRow colSpan={5}>
                  Nothing measured yet. The first reading is taken at the end of the
                  current period.
                </EmptyRow>
              ) : (
                readings.map((r) => (
                  <tr
                    key={`${r.periodStart.toISOString()}-${r.meter}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2 pr-4">{formatInstant(r.periodStart, prefs)}</td>
                    <td className="py-2 pr-4">{r.meter === 'SEAT' ? 'People' : 'Organization'}</td>
                    <td className="py-2 pr-4 tabular-nums">{r.quantity.toString()}</td>
                    <td className="py-2 pr-4">{r.planCode}</td>
                    <td className="py-2 text-muted-foreground">
                      {formatInstant(r.measuredAt, prefs)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-sm text-muted-foreground">
        Plans, prices and payment are managed by VeloTech, not in VeloExpense — this
        page shows what VeloTech holds for this organization. To change a plan or a
        payment method, get in touch.{' '}
        <Link href="/admin" className="underline underline-offset-4">
          Back to settings
        </Link>
      </p>
    </div>
  );
}
