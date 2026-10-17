/**
 * VX2-7 — /notifications/preferences.
 *
 * ── The one thing this screen has to get right ──────────────────────────────
 *
 * There are THREE states per cell, not two: on, off, and no opinion. "No
 * opinion" is not a tidier way of saying "on" — it means this person follows the
 * default wherever the product later moves it, and somebody who explicitly chose
 * on stays on regardless. That distinction is the entire reason the stored map
 * holds only overrides (GAP-AUDIT NT-3), and a two-state toggle would make it
 * unreachable: the moment you rendered a default as a checked box and saved the
 * form, everybody would be pinned to today's default forever.
 *
 * So each cell is three radio buttons and the column says what "default" means.
 *
 * SLACK is live once the organization has connected its Slack app (w5-02a, /admin/slack),
 * and shown and disabled until then: a live toggle for a channel that cannot deliver is
 * precisely the dead control NT-2 found in ExpenseOS — where the schema documents an `inApp`
 * preference key that no code has ever read. Hiding the column instead would make the
 * screen look finished and the roadmap invisible. EMAIL is live: it delivers since VX2-8,
 * though this screen kept it disabled until w5-00 found that comment emails — and so the
 * digest — could not be turned on.
 *
 * Under the grid, when Slack is connected: ExpenseOS's "Slack account" — whether Slack knows
 * who you are, and the one button that can correct it (`SlackLink`).
 */
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { enumLabel, CHANNEL_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { formatInstant } from '@/lib/i18n/format';
import type { ReaderPrefs } from '@/lib/i18n/resolve';
import { loadCatalog } from '@expenseos/i18n/load';
import { forgetSlackLinkFromForm, getPreferencesPage, setPreferenceFromForm } from '../actions';

import { pageTitle } from '@/lib/i18n/page-title';
import { PageHeader, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.notifications.preferences');
}

export const dynamic = 'force-dynamic';

export default async function NotificationPreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; relinked?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error, relinked } = await searchParams;
  const { grid, slackLink } = await getPreferencesPage();

  return (
    <Screen>
      <PageHeader
        title="Notification preferences"
        description={
          <>
            What you are told about, and where. Leave a choice on <strong>Default</strong> to follow
            whatever the product ships.
          </>
        }
      />

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Turning something off is not the same as leaving it default.</p>
        <p className="mt-1 text-muted-foreground">
          <strong>Default</strong> means you follow the product: if we later decide a message should
          be quieter or louder, you move with it. <strong>On</strong> and <strong>Off</strong> are
          your decision and stay put. Muting an in-app message hides it from your list — including
          messages that already arrived, which come back if you turn it on again, because nothing is
          thrown away.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {grid.map((event) => (
          <section key={event.eventType} className="rounded-lg border border-border p-4">
            <h2 className="font-medium">{event.name}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{event.description}</p>
            <div className="flex flex-wrap gap-6">
              {event.channels.map((cell) => (
                <form
                  key={cell.channel}
                  action={setPreferenceFromForm}
                  className="flex flex-col gap-1.5"
                >
                  <input type="hidden" name="eventType" value={event.eventType} />
                  <input type="hidden" name="channel" value={cell.channel} />
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{enumLabel(CHANNEL_COPY, cell.channel, prefs.locale)}</span>
                    {cell.deliverable ? null : (
                      <span className="text-xs text-muted-foreground">
                        not connected for your organization yet
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    {(
                      [
                        ['true', 'On'],
                        ['false', 'Off'],
                        ['default', `Default (${cell.shipsOn ? 'on' : 'off'})`],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} className="flex items-center gap-1.5">
                        <input
                          type="radio"
                          name="enabled"
                          value={value}
                          disabled={!cell.deliverable}
                          defaultChecked={
                            cell.overridden ? String(cell.enabled) === value : value === 'default'
                          }
                        />
                        {label}
                      </label>
                    ))}
                    <Button type="submit" size="sm" variant="outline" disabled={!cell.deliverable}>
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {cell.overridden
                      ? `Your choice: ${cell.enabled ? 'on' : 'off'}`
                      : `Following the default (${cell.shipsOn ? 'on' : 'off'})`}
                  </p>
                </form>
              ))}
            </div>
          </section>
        ))}
      </div>

      {slackLink ? <SlackLink link={slackLink} relinked={Boolean(relinked)} prefs={prefs} /> : null}

      <p className="text-xs text-muted-foreground">
        Preference changes are recorded in the audit trail. The messages you mute are not — so if a
        report ever seems to have gone quiet, the trail can say when the setting changed and who
        changed it.
      </p>
    </Screen>
  );
}

/**
 * Whether Slack knows who you are — and the one button that can correct it.
 *
 * A Slack DM is addressed to a Slack user id resolved from the ExpenseOS email address
 * once and then cached on the User row, because `users.lookupByEmail` is rate-limited. The
 * cache is refreshed on a timer and repaired automatically when Slack rejects the id, but
 * neither helps the person who has just changed the email on their Slack account and is
 * looking at a Slack column they ticked days ago, wondering why nothing arrives. They are
 * the only one who knows the answer changed, so they get the button.
 *
 * Rendered under the toggles rather than as its own card: it explains the Slack COLUMN,
 * and away from it the sentence "your Slack account is linked" has nothing to attach to.
 *
 * w5-02a — ExpenseOS's `SlackLink` (`profile/NotificationPreferences.tsx`, 1e682dd6), with its
 * catalog copy (`notifications.prefs.slackLink`). VeloExpense: a server component posting a
 * form, where ExpenseOS's is a client component with a tRPC mutation; "Cleared" arrives as a
 * query value after the redirect. English for now, as the rest of this screen is.
 */
async function SlackLink({
  link,
  relinked,
  prefs,
}: {
  link: { linked: boolean; checkedAt: Date | null };
  relinked: boolean;
  prefs: ReaderPrefs;
}) {
  const cat = await loadCatalog('en');
  const copy =
    ((cat.notifications as { prefs?: { slackLink?: Record<string, string> } } | undefined)?.prefs
      ?.slackLink ?? {}) as Record<string, string>;
  const t = (key: string) => copy[key] ?? key;
  const { linked, checkedAt } = link;
  // Three states, not two. "Never looked up" is not "Slack has no account for you": the
  // first resolves itself the moment a Slack notification is due, and telling somebody
  // their address is unknown to Slack when nobody has asked yet sends them to fix Slack.
  const status = linked ? 'linked' : checkedAt ? 'notLinked' : 'unknown';

  return (
    <section className="rounded-lg border border-border p-4">
      <h2 className="font-medium">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t(status)}</p>
      {checkedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('checkedAt').replace('{date}', formatInstant(checkedAt, prefs))}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
      <form action={forgetSlackLinkFromForm} className="mt-3 flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline">
          {t('relink')}
        </Button>
        {relinked ? <span className="text-xs text-muted-foreground">{t('relinked')}</span> : null}
      </form>
    </section>
  );
}
