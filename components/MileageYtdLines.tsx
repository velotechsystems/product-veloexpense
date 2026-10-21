import type { Locale } from '@expenseos/i18n/locales';
import { useTranslations } from 'next-intl';
import type { MileageYtdRow } from '@/server/routers/mileageBalances';

/**
 * A person's mileage year to date, one line per country: where they stand in the rule's
 * bands, then the carry-over and the not-yet-approved part as sub-lines when above 0.
 *
 * Rendered by the People drawer's "Mileage this year" row. It is deliberately plain: not
 * async, no directive, and nothing from the server at runtime (the row type is a type-only
 * import). It takes its messages from `useTranslations` itself: taking a `t` from the caller
 * instead would hide every key below from `check-used-keys`, which reads only literal keys
 * on a `useTranslations('<namespace>')` binding.
 *
 * `rows: []` says "None"; whether to mount it at all for nobody is the caller's choice.
 */
export function MileageYtdLines({ rows, locale }: { rows: MileageYtdRow[]; locale: Locale }) {
  const t = useTranslations('people.detail.mileageYtdLines');
  const tExpenses = useTranslations('expenses');

  if (rows.length === 0) {
    return <span className="text-muted-foreground">{t('none')}</span>;
  }

  const distance = (value: string | null) =>
    value === null ? '—' : Number(value).toLocaleString(locale, { maximumFractionDigits: 2 });
  // The dates are UTC midnights (an expense date, an upload's period end). Formatted in the
  // reader's zone, every one of them would show the day before anywhere west of UTC.
  const dateFormat = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' });
  const date = (value: Date | string) => dateFormat.format(new Date(value));
  const countryNames = rows.length > 1 ? regionNames(locale) : null;

  function sentence(row: MileageYtdRow, unit: string): string {
    const total = distance(row.total);
    if (row.rule === null) return t('line.noRule', { total, unit });
    // Tier COUNT, never `nextBoundary === null`: the top band of a banded rule has no
    // next boundary either, and it is not a single rate.
    if (row.rule.tiers.length <= 1) {
      return row.rule.isCarAllowance
        ? t('line.flat', { total, unit })
        : t('line.single', { total, unit });
    }
    if (row.bandIndex === 0) {
      return t('line.first', {
        total,
        boundary: distance(row.nextBoundary),
        remaining: distance(row.remaining),
        unit,
      });
    }
    // 1-based, so the message's `select` reads 2 as "second". A rule with more than three
    // tiers falls to the `other` branch ("band 4"), never to a wrong ordinal.
    const band = (row.bandIndex ?? 0) + 1;
    const from = distance(row.bandFrom);
    const past =
      row.crossedAt === null
        ? t('line.pastNoDate', { from, unit, band })
        : t('line.past', { from, unit, band, date: date(row.crossedAt) });
    // A middle band (three tiers or more) still has a boundary ahead of it.
    return row.nextBoundary === null
      ? past
      : `${past} · ${t('line.left', { remaining: distance(row.remaining), unit })}`;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const unit =
          row.unit === 'MI'
            ? tExpenses('line.mileageUnitShort.MI')
            : tExpenses('line.mileageUnitShort.KM');
        return (
          <li key={row.country} className="flex flex-col">
            <span className="break-words tabular-nums">
              {countryNames && (
                <>
                  <span className="font-medium">
                    {t('country', { country: countryNames(row.country) })}
                  </span>{' '}
                </>
              )}
              {sentence(row, unit)}
            </span>
            {Number(row.carried) > 0 && row.carriedThrough !== null && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('line.carried', {
                  carried: distance(row.carried),
                  unit,
                  date: date(row.carriedThrough),
                })}
              </span>
            )}
            {Number(row.pending) > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('line.pending', { pending: distance(row.pending), unit })}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The country's name in the reader's language, from the runtime's own region names (no
 * catalog: `common.countries.*` covers only the countries the app lists, and throws on any
 * other). Falls back to the ISO code.
 */
function regionNames(locale: Locale): (code: string) => string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    names = null;
  }
  return (code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
}
