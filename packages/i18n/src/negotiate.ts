import { match } from '@formatjs/intl-localematcher';
import Negotiator from 'negotiator';
import { DEFAULT_LOCALE, isLocale, type Locale, SUPPORTED_LOCALES } from './locales';

/**
 * Resolve the active locale for a request. Precedence (highest first):
 *   1. Explicit URL segment (caller passes `urlLocale` from the path).
 *   2. User preference column (caller passes `userPref` from session).
 *   3. Locale cookie (NEXT_LOCALE).
 *   4. Accept-Language header negotiation.
 *   5. DEFAULT_LOCALE.
 *
 * The middleware uses this on every navigation; the auth callback uses
 * it on sign-in to write User.localePref if it isn't already set.
 */
export type ResolveInput = {
  urlLocale?: string | null;
  userPref?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
};

export function resolveLocale(input: ResolveInput): Locale {
  if (isLocale(input.urlLocale)) return input.urlLocale;
  if (isLocale(input.userPref)) return input.userPref;
  if (isLocale(input.cookieLocale)) return input.cookieLocale;

  if (input.acceptLanguage) {
    const languages = new Negotiator({
      headers: { 'accept-language': input.acceptLanguage },
    }).languages();
    try {
      const matched = match(languages, SUPPORTED_LOCALES as readonly string[], DEFAULT_LOCALE);
      if (isLocale(matched)) return matched;
    } catch {
      // intl-localematcher throws on malformed Accept-Language; fall through.
    }
  }

  return DEFAULT_LOCALE;
}
