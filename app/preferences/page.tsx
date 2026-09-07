/**
 * VX4-7 part 1 — /preferences.
 *
 * Server component, plain form, no client JS.
 *
 * The two selects each carry an empty option that reads "Follow the company
 * (<what the company says>)" rather than a blank line. Naming the inherited
 * value is the whole point: a blank option makes "no preference" look like
 * "unset", so a reader who wants Canadian English and works at a Canadian
 * English company cannot tell whether choosing it explicitly does anything. It
 * does — it stops them moving when the company moves — and the label is where
 * that becomes visible.
 */
import Link from 'next/link';
import { ErrorBanner, cardClass, fieldClass, labelClass, selectClass } from '@/app/expenses/ui';
import { Button } from '@/components/ui/button';
import { localeName } from '@/lib/i18n/locales';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, type UiKey } from '@/lib/i18n/catalog/ui';
import { getPreferencesPage, savePreferencesFromForm } from './actions';

export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  const { error, changed } = await searchParams;
  const page = await getPreferencesPage();
  // VX4-10. The reader's own locale, which on THIS page is the one being edited —
  // so a person who has just switched language sees the new one applied to the
  // screen that switched it, which is the least surprising thing it could do.
  const { locale } = await readerPrefs();
  const t = (key: UiKey) => uiText(key, locale);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('preferences.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('preferences.lede')}</p>
      </header>

      <ErrorBanner message={error} />
      {changed ? (
        <p className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary">
          {t('preferences.saved')}
        </p>
      ) : null}

      <form action={savePreferencesFromForm} className={`${cardClass} flex flex-col gap-5 p-5`}>
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="locale">
            {t('preferences.language.label')}
          </label>
          <select
            id="locale"
            name="locale"
            defaultValue={page.locale ?? ''}
            className={selectClass}
            data-testid="my-locale"
          >
            {/* An em dash, not nested parentheses. `localeName` already returns
                "English (Canada)", so the first draft rendered "Follow the
                company (English (Canada))" — which only looking at the page
                caught, and which reads as a typo rather than as a setting. */}
            <option value="">
              {t('preferences.follow.company')} {localeName(page.companyLocale)}
            </option>
            {page.locales.map((locale) => (
              <option key={locale} value={locale}>
                {localeName(locale)}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="timeZone">
            {t('preferences.timezone.label')}
          </label>
          <select
            id="timeZone"
            name="timeZone"
            defaultValue={page.timeZone ?? ''}
            className={selectClass}
            data-testid="my-timezone"
          >
            <option value="">
              {t('preferences.follow.company')} {page.companyTimeZone}
            </option>
            <option value="UTC">UTC</option>
            {page.zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="my-sample">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('preferences.sample.date')}</dt>
              <dd className="font-medium">{page.sample.date}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('preferences.sample.money')}</dt>
              <dd className="font-medium">{page.sample.money}</dd>
            </div>
          </dl>
          <Button type="submit">{t('preferences.save')}</Button>
        </div>
      </form>

      <p className="text-sm text-muted-foreground">
        {t('preferences.notifications.lede')}{' '}
        <Link href="/notifications/preferences" className="underline underline-offset-4">
          {t('preferences.notifications.link')}
        </Link>
        .
      </p>
    </main>
  );
}
