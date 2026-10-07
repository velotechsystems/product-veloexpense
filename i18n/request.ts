import { DEFAULT_LOCALE, loadCatalog } from '@expenseos/i18n';
import { getRequestConfig } from 'next-intl/server';
import { pseudoEnabled } from '@/lib/i18n/pseudo';
import { readerPrefs } from '@/lib/i18n/request';
import { pseudoizeMessages } from './pseudo-messages';

/**
 * Server-side request config for next-intl — ported from ExpenseOS `src/i18n/request.ts`.
 *
 * VeloExpense: ExpenseOS reads the locale from the URL segment (`/fr-CA/...`). VeloExpense has
 * no locale in its URLs; the reader's language is a stored preference (`readerPrefs`, user
 * over organization), and today every VeloExpense locale is English (en-CA, en-US). Decided
 * 7 Oct: English only for now — ExpenseOS's fr-CA catalogues are ported but not offered.
 *
 * So next-intl's locale is ExpenseOS's catalogue locale, `en`, for every reader: ported code
 * passes it to `getLocalized` and `Intl` exactly as ExpenseOS does. The time zone is the
 * reader's own, which ExpenseOS also took from the user.
 *
 * With `PSEUDO_LOCALE=1` (the crawl's server only) the messages are pseudoized, so ported
 * screens are measured by the same crawl as VeloExpense's own.
 */
export default getRequestConfig(async () => {
  const { timeZone } = await readerPrefs();
  const locale = DEFAULT_LOCALE;
  const catalog = await loadCatalog(locale);
  const messages = pseudoEnabled() ? pseudoizeMessages(catalog) : catalog;
  return { locale, messages, timeZone };
});
