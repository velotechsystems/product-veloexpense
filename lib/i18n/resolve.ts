/**
 * VX4-7 — whose locale is this, and which clock. PURE, same rule as
 * `locales.ts`: this decides precedence, it does not fetch anything.
 *
 * Ported from ExpenseOS `packages/i18n/src/negotiate.ts` (pinned 5a11a647).
 * Their precedence, documented in that file's own header:
 *
 *   1. Explicit URL segment   2. User preference column   3. Locale cookie
 *   4. Accept-Language         5. DEFAULT_LOCALE
 *
 * and IL-2's finding about it: `resolveLocale` HAS NO NON-TEST CALLERS. The
 * whole chain is dead code, because `apps/web/src/i18n/request.ts:11-17`
 * resolves from the URL segment alone. Rung 1 did not just win — by winning
 * always, it made rungs 2 through 4 unreachable and untested.
 *
 * ── OUR CHAIN, AND A CALLER FOR EVERY RUNG ──────────────────────────────────
 *
 *   1. `app_user.locale`            — the reader said so themselves.
 *   2. `organization.default_locale` — the company said so.
 *   3. Accept-Language               — the browser's guess.
 *   4. DEFAULT_LOCALE                — the constant.
 *
 * Two removals from theirs. The URL SEGMENT is argued in `locales.ts`: our
 * routes are flat, and being first is what killed their precedence. The COOKIE
 * is removed because it was upstream's stand-in for a stored preference, and we
 * store the preference — a cookie rung would be a second, un-auditable place a
 * locale can come from, and the first support ticket about it ("why is my
 * account in French on this laptop only") is unanswerable from the database.
 *
 * ── WHY THE COMPANY OUTRANKS THE BROWSER, which is not upstream's order ─────
 *
 * Theirs puts Accept-Language above the default and has no company rung at all
 * (IL-2: "there is no company default column at all — which is the one a
 * multi-tenant product needs first"). Inserting the company ABOVE the browser is
 * a deliberate choice: `default_locale` is an administrative decision somebody
 * made and can be held to, and an `Accept-Language` header is a guess made by
 * whatever browser happens to be open. A French-configured browser at an
 * en-CA company should see the company's product, not a half-French one — the
 * employee who genuinely wants French sets their own preference, which is
 * rung 1 and outranks both.
 *
 * Accept-Language therefore matters in exactly one place, and it is a real one:
 * BEFORE ANYBODY IS SIGNED IN. `/login` has no user AND no tenant — checked, not
 * assumed: `lib/branding/request.ts` resolves the organization from the SESSION
 * and returns `NONE` without one, and 0023 records that pre-auth tenant
 * resolution waits for host-based tenancy in Phase 5 (BR-1/BR-8). So on the one
 * screen every user meets first, rungs 1 and 2 are both empty and
 * `Accept-Language` is the only signal in existence. Rung 4 catches a request
 * whose header is absent or names nothing we serve.
 *
 * When Phase 5 lands host-based tenancy, rung 2 starts answering pre-auth too
 * and will outrank the header there, which is the same order as everywhere else
 * and needs no change here.
 */
import { DEFAULT_LOCALE, isLocale, SUPPORTED_LOCALES, type Locale } from './locales';

/** The default clock, and the meaning of a NULL timezone column. */
export const DEFAULT_TIMEZONE = 'UTC';

/**
 * What a screen needs to render dates and money for one reader.
 *
 * Locale and timezone travel TOGETHER, in one object, deliberately. They are
 * two independent facts — a Vancouver employee at a Toronto company reads
 * `en-CA` on `America/Vancouver` — and every formatter needs both, so passing
 * them separately means every signature grows two parameters and the second one
 * gets forgotten at half the call sites. `lib/money.ts` already demonstrates the
 * failure mode from the other side: it has had a `locale` parameter since VX1,
 * and all 23 call sites let it default.
 */
export interface ReaderPrefs {
  locale: Locale;
  /** An IANA zone name, e.g. `America/Toronto`. Validated on write by `0027`. */
  timeZone: string;
}

export interface ResolveInput {
  /** `app_user.locale` — NULL means "follow the company". */
  userLocale?: string | null;
  /** `organization.default_locale` — NOT NULL in the database. */
  orgLocale?: string | null;
  /** The request's `Accept-Language`, when there is no tenant context. */
  acceptLanguage?: string | null;
}

export interface ResolveTimeZoneInput {
  /** `app_user.timezone` — NULL means "follow the company". */
  userTimeZone?: string | null;
  /** `organization.default_timezone` — NOT NULL in the database. */
  orgTimeZone?: string | null;
}

export function resolveLocale(input: ResolveInput): Locale {
  if (isLocale(input.userLocale)) return input.userLocale;
  if (isLocale(input.orgLocale)) return input.orgLocale;

  const negotiated = negotiateLocale(input.acceptLanguage);
  if (negotiated !== null) return negotiated;

  return DEFAULT_LOCALE;
}

/**
 * The reader's clock: their own, else the company's, else UTC.
 *
 * There is no browser rung here and there cannot be, and the reason is
 * structural rather than an omission: THE PRODUCT SHIPS NO CLIENT JAVASCRIPT
 * (the receipt drawer is the single exception), and a timezone is not in any
 * request header. `Intl.DateTimeFormat().resolvedOptions().timeZone` is the only
 * way to learn it and it runs in a browser. So a zone is either stored or
 * guessed, and the only honest guess is UTC — which is why `0027` defaults the
 * company column to `UTC` rather than to `America/Toronto`: a wrong-but-declared
 * zone is worse than an obviously neutral one, because it looks configured.
 */
export function resolveTimeZone(input: ResolveTimeZoneInput): string {
  const user = input.userTimeZone?.trim();
  if (user) return user;
  const org = input.orgTimeZone?.trim();
  if (org) return org;
  return DEFAULT_TIMEZONE;
}

/** Both at once, which is how every caller actually wants them. */
export function resolveReaderPrefs(input: ResolveInput & ResolveTimeZoneInput): ReaderPrefs {
  return { locale: resolveLocale(input), timeZone: resolveTimeZone(input) };
}

/* ── Accept-Language ──────────────────────────────────────────────────────── */

/**
 * BCP-47 "Lookup" against `SUPPORTED_LOCALES`, or null when nothing matches.
 *
 * ExpenseOS uses `negotiator` to order the header and
 * `@formatjs/intl-localematcher` to match it. Both are replaced here by the
 * twenty lines below, and the reason is not dependency asceticism: their matcher
 * is called with `DEFAULT_LOCALE` as its fallback argument, so it CANNOT RETURN
 * "no match" — every unrecognised header comes back as the default, which is
 * indistinguishable from a header that asked for the default. We want the
 * difference, because rung 4 existing separately from rung 3 is what makes the
 * chain testable.
 *
 * Matching is two passes, in this order, and the order is the whole algorithm:
 *
 *   1. EXACT tag. `en-US` asks for `en-US` and gets it.
 *   2. LANGUAGE prefix. `en-GB`, or a bare `en`, matches the first SUPPORTED
 *      locale sharing that language — `en-CA`, because it is first in the array.
 *
 * Pass 2 is where a prefix rule is legitimate and it is worth being precise
 * about why, given `locales.ts` refuses one for fallbacks. Here the prefix is
 * matching a REQUEST against what we offer: "this reader wants some flavour of
 * English, we have two, give them the house one." There it would be deciding
 * where AUTHORED COPY comes from, where guessing yields a fluent sentence in the
 * wrong language. Same string operation, opposite consequence when wrong.
 *
 * `*` is ignored rather than treated as "anything", and q=0 is a REFUSAL — the
 * one header form that says "not this one" — so both fall through to the
 * company default or the constant, which is the desired behaviour anyway.
 */
export function negotiateLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const wanted: { tag: string; q: number }[] = [];
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag.trim();
    if (tag.length === 0 || tag === '*') continue;

    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q <= 0) continue;
    wanted.push({ tag, q });
  }
  if (wanted.length === 0) return null;

  // Descending q, ties keeping header order — `Array.prototype.sort` is stable
  // in every runtime we target, so an explicit index tiebreak is not needed.
  const order = [...wanted].sort((a, b) => b.q - a.q);

  for (const { tag } of order) {
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
  }
  for (const { tag } of order) {
    const language = tag.split('-')[0].toLowerCase();
    const byLanguage = SUPPORTED_LOCALES.find((l) => l.split('-')[0].toLowerCase() === language);
    if (byLanguage) return byLanguage;
  }
  return null;
}
