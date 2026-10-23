/**
 * ISO-3166-1 alpha-2 country codes, and how to render one.
 *
 * A hardcoded list rather than a dependency: the set of country codes is stable
 * reference data that changes every few years, and the NAMES — the part that
 * actually varies by locale — come from `Intl.DisplayNames`, which the platform
 * already ships. A package would give us the same codes plus an English-only
 * name table we'd then have to translate ourselves.
 *
 * The list is deliberately complete rather than "the countries we operate in".
 * A mileage rate for a country nobody has an entity in yet is a legitimate thing
 * to configure ahead of time, and a picker that can't express it sends people
 * back to typing raw codes — which is what this replaces.
 */

/** Every assigned alpha-2 code, in code order. */
export const COUNTRY_CODES = [
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

/**
 * f75: is this an assigned ISO-3166-1 alpha-2 code, exactly as stored (uppercase)? The one
 * check every writer of a person's country uses — `users.update`, the Google directory sync
 * and mileage rules — so "XX" is refused everywhere rather than only by the picker.
 */
export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && COUNTRY_SET.has(value);
}

/** One `Intl.DisplayNames` per locale — constructing it is not free and these
 *  lists are rendered per keystroke while filtering. */
const nameCache = new Map<string, Intl.DisplayNames>();

function displayNames(locale: string): Intl.DisplayNames | null {
  const cached = nameCache.get(locale);
  if (cached) return cached;
  try {
    const dn = new Intl.DisplayNames([locale], { type: 'region' });
    nameCache.set(locale, dn);
    return dn;
  } catch {
    return null;
  }
}

/**
 * The country's name in `locale`, falling back to the code itself.
 *
 * Never throws and never returns empty: this feeds table cells and a picker, and
 * a blank where a country should be is worse than an unfriendly "ZZ".
 */
export function countryName(code: string | null | undefined, locale: string): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  const dn = displayNames(locale);
  if (!dn) return upper;
  try {
    return dn.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/**
 * The regional-indicator flag for a code — two code points, no image asset.
 *
 * Renders as a flag on macOS/iOS and as the two boxed letters elsewhere, which is
 * an acceptable degradation because the code is exactly what an admin typed and
 * recognises. Returns '' for anything that isn't two ASCII letters.
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + (upper.charCodeAt(0) - 65),
    0x1f1e6 + (upper.charCodeAt(1) - 65),
  );
}

/**
 * `{ value, label, icon }` items for a country Combobox, sorted by NAME in the
 * active locale — an alphabetical list of codes is alphabetical in nobody's
 * language.
 */
export function countryItems(locale: string): { value: string; label: string; icon: string }[] {
  return COUNTRY_CODES.map((code) => ({
    value: code,
    label: `${countryName(code, locale)} (${code})`,
    icon: countryFlag(code),
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}
