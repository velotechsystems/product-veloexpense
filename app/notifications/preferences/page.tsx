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
 * EMAIL and SLACK are shown and disabled. Nothing delivers on them until VX2-8,
 * and a live toggle for a channel that cannot deliver is precisely the dead
 * control NT-2 found in ExpenseOS — where the schema documents an `inApp`
 * preference key that no code has ever read. Hiding the two columns instead
 * would make the screen look finished and the roadmap invisible.
 */
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { enumLabel, CHANNEL_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { getPreferencesPage, setPreferenceFromForm } from '../actions';

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
  searchParams: Promise<{ error?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error } = await searchParams;
  const { grid } = await getPreferencesPage();

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
                        no delivery until email and Slack ship
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

      <p className="text-xs text-muted-foreground">
        Preference changes are recorded in the audit trail. The messages you mute are not — so if a
        report ever seems to have gone quiet, the trail can say when the setting changed and who
        changed it.
      </p>
    </Screen>
  );
}
