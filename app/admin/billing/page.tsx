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
import { uiText, uiSentence, type UiKey } from '@/lib/i18n/catalog/ui';
import { canWrite, type Meter, type SubscriptionStatus } from '@/lib/billing/plans';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.billing');
}

/**
 * One sentence per status, and the LAPSED/CANCELLED pair leads with what still
 * works. English literals in JSX, like every other admin screen — VX4-10 is the
 * ticket that catalogues this chrome, and adding a half-catalogued screen ahead of
 * it would make that ticket's ratchet harder to read, not easier.
 */
/**
 * Which catalogue keys each status uses.
 *
 * A `Record<SubscriptionStatus, …>` of KEYS rather than of strings: the copy moved
 * to `lib/i18n/catalog/ui.ts` in VX4-10, and this is what keeps the guarantee that
 * moving it could have lost — a status added to the union still fails to compile
 * here. That is the exact failure CI caught on #115's first run, when the union
 * gained SUSPENDED and this map did not.
 */
const STATUS_KEYS: Record<SubscriptionStatus, { label: UiKey; detail: UiKey }> = {
  TRIALING: { label: 'billing.status.TRIALING.label', detail: 'billing.status.TRIALING.detail' },
  ACTIVE: { label: 'billing.status.ACTIVE.label', detail: 'billing.status.ACTIVE.detail' },
  PAST_DUE: { label: 'billing.status.PAST_DUE.label', detail: 'billing.status.PAST_DUE.detail' },
  LAPSED: { label: 'billing.status.LAPSED.label', detail: 'billing.status.LAPSED.detail' },
  CANCELLED: { label: 'billing.status.CANCELLED.label', detail: 'billing.status.CANCELLED.detail' },
  SUSPENDED: { label: 'billing.status.SUSPENDED.label', detail: 'billing.status.SUSPENDED.detail' },
};

export default async function BillingPage() {
  const prefs = await readerPrefs();
  const { subscription, readings, platformConfigured } = await getBillingPage();
  const t = (key: UiKey) => uiText(key, prefs.locale);
  // VX4-10. A lookup rather than a ternary, so a meter added to the vocabulary is
  // a compile error here instead of a cell that silently says "Organization".
  const METER_KEY: Record<Meter, UiKey> = {
    SEAT: 'billing.meter.seat',
    TENANT: 'billing.meter.tenant',
    CARD: 'billing.meter.card',
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('billing.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('billing.lede')}</p>
      </header>

      {subscription === null ? (
        /* Not an empty state — a statement, and it says WHICH of two things is
         * true. AC-22's rule: "billing is switched off in this deployment" and
         * "nobody is billing this particular tenant" look identical as an empty
         * table, and only one of them is something an administrator can act on. */
        <section className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          {platformConfigured ? (
            <>
              <strong className="font-medium">{t('billing.none.billed.title')}</strong>{' '}
              {t('billing.none.billed.detail')}
            </>
          ) : (
            <>
              <strong className="font-medium">{t('billing.none.unconfigured.title')}</strong>{' '}
              {t('billing.none.unconfigured.detail')}
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
              {t(STATUS_KEYS[subscription.status].label)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {t(STATUS_KEYS[subscription.status].detail)}
          </p>
          {subscription.trialEndsAt !== null && (
            /* A DATE, not a countdown. See the header, point 2. */
            <p className="text-sm">
              {uiSentence(
                'billing.trial.ends',
                { date: formatInstant(subscription.trialEndsAt, prefs) },
                prefs.locale,
              )}
            </p>
          )}
          {subscription.mirroredAt !== null && (
            /* WHEN the platform said this, not just what it said. The row is a
             * mirror and can be stale — a reader who cannot see its age would
             * take a cached answer for a current one. */
            <p className="text-sm text-muted-foreground">
              {uiSentence(
                'billing.mirrored.at',
                { date: formatInstant(subscription.mirroredAt, prefs) },
                prefs.locale,
              )}
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{t('billing.usage.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('billing.usage.lede')}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4 font-medium">{t('billing.column.period')}</th>
                <th className="py-2 pr-4 font-medium">{t('billing.column.measure')}</th>
                <th className="py-2 pr-4 font-medium">{t('billing.column.quantity')}</th>
                <th className="py-2 pr-4 font-medium">{t('billing.column.plan')}</th>
                <th className="py-2 font-medium">{t('billing.column.counted')}</th>
              </tr>
            </thead>
            <tbody>
              {readings.length === 0 ? (
                <EmptyRow colSpan={5}>{t('billing.usage.empty')}</EmptyRow>
              ) : (
                readings.map((r) => (
                  <tr
                    key={`${r.periodStart.toISOString()}-${r.meter}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2 pr-4">{formatInstant(r.periodStart, prefs)}</td>
                    <td className="py-2 pr-4">{t(METER_KEY[r.meter])}</td>
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
        {t('billing.managed.elsewhere')}{' '}
        <Link href="/admin" className="underline underline-offset-4">
          {t('billing.back')}
        </Link>
      </p>
    </div>
  );
}
