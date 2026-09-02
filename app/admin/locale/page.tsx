/**
 * VX4-7 part 1 — /admin/locale.
 *
 * A plain `<form action={serverAction}>`, no client JS, like every other admin
 * screen in the product. One form, two selects, one button: the company's
 * language and the company's clock are one decision made at one moment, so
 * splitting them into two forms would only add a state where somebody has
 * changed the language and not yet the zone.
 *
 * ── WHY THE SAMPLE ROW IS ON THIS SCREEN ────────────────────────────────────
 *
 * `en-CA` and `en-US` are one letter apart in a dropdown and a completely
 * different reading of `03/04/2026`. An admin choosing between them from the tag
 * alone is choosing blind, and the consequence lands on somebody else's expense
 * report months later. So the screen renders one fixed instant and one fixed
 * amount under the CURRENT setting — 0023 put a contrast ratio on the branding
 * screen for the same reason, and IL-1 is the case for it: upstream shipped `en`
 * for years believing it was Canadian, which nobody could see because nothing
 * showed them.
 *
 * The instant is deliberately 02:30 UTC, which is the previous day in every
 * North American zone. A zone setting whose preview never changed the date would
 * look decorative.
 */
import { ErrorBanner, cardClass, fieldClass, labelClass, selectClass } from '@/app/expenses/ui';
import { Button } from '@/components/ui/button';
import { localeName } from '@/lib/i18n/locales';
import { getLocalePage, saveLocaleFromForm } from './actions';

export default async function AdminLocalePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  const { error, changed } = await searchParams;
  const page = await getLocalePage();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Language and time</h1>
        <p className="text-sm text-muted-foreground">
          How dates, times and amounts are written for everyone in this organization. An employee
          who sets their own preference keeps it; everyone else follows what you choose here.
        </p>
      </header>

      <ErrorBanner message={error} />
      {changed ? (
        <p className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary">
          Saved.
        </p>
      ) : null}

      <form action={saveLocaleFromForm} className={`${cardClass} flex flex-col gap-5 p-5`}>
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="locale">
            Language and formatting
          </label>
          <select
            id="locale"
            name="locale"
            defaultValue={page.locale}
            className={selectClass}
            data-testid="org-locale"
          >
            {page.locales.map((locale) => (
              <option key={locale} value={locale}>
                {localeName(locale)} — {locale}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="timeZone">
            Time zone
          </label>
          <select
            id="timeZone"
            name="timeZone"
            defaultValue={page.timeZone}
            className={selectClass}
            data-testid="org-timezone"
          >
            {/* UTC is offered explicitly and first. It is the shipped default and
                the only honest answer for a company that has not decided — see
                0027 on why the column does not default to America/Toronto. It is
                also filtered out of `listTimeZones`, which returns only names
                containing a slash. */}
            <option value="UTC">UTC</option>
            {page.zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Timestamps recorded by the product — when a report was submitted, approved or paid —
            are shown in this zone. Dates people type, like the date on an expense, are calendar
            dates and do not move.
          </p>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium">How each option reads</h2>
            <p className="text-xs text-muted-foreground" data-testid="sample-caption">
              4 March 2026, 02:30 UTC, shown in {page.timeZoneInUse}
            </p>
          </div>
          {/* A table, not three paragraphs: the question an admin has here is
              comparative — "which of these do I want" — and a table is what puts
              $10,799.00 directly above CA$10,799.00. That pair IS IL-1. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="locale-sample">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-4 font-medium">Language</th>
                  <th className="py-1.5 pr-4 font-medium">Date and time</th>
                  <th className="py-1.5 font-medium">Amounts</th>
                </tr>
              </thead>
              <tbody>
                {page.samples.map((s) => (
                  <tr key={s.locale} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-4">
                      <span className={s.current ? 'font-medium' : ''}>{s.name}</span>
                      {s.current ? (
                        <span className="ml-2 rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary">
                          in use
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{s.date}</td>
                    <td className="py-2 tabular-nums">{s.money}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Changes are recorded in the audit trail.
            </p>
            <Button type="submit">Save</Button>
          </div>
        </div>
      </form>
    </main>
  );
}
