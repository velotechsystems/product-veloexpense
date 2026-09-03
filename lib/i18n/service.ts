/**
 * VX4-7 part 1 — reading and writing the two stored preferences.
 *
 * Split from `resolve.ts` on the house rule that keeps `lib/policy/rules.ts` and
 * `lib/budgets/scope.ts` pure: precedence is a decision and belongs where it can
 * be unit-tested without a database, while this file is the part that needs one.
 *
 * ── WHY THE ORG DEFAULT IS READ EVEN WHEN THE USER HAS A LOCALE ─────────────
 *
 * `loadReaderPrefs` reads both rows and hands both to `resolveReaderPrefs`,
 * rather than short-circuiting on a non-null `app_user.locale`. It is one join,
 * so the cost is nothing — and the benefit is that LOCALE and TIMEZONE resolve
 * INDEPENDENTLY. A reader who set their timezone to `America/Vancouver` and
 * never touched their language must get their zone and the company's language,
 * which a short-circuit on "the user has some preference" would get wrong in
 * whichever direction it was written.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { append, type AuditActor } from '@/lib/audit/service';
import { isLocale, SUPPORTED_LOCALES, type Locale } from './locales';
import { resolveReaderPrefs, type ReaderPrefs } from './resolve';

/** What the company has chosen, for the admin screen. */
export interface OrgDefaults {
  locale: Locale;
  timeZone: string;
}

/** What one reader has chosen, for the self-service screen. NULL = inherit. */
export interface UserPrefs {
  locale: Locale | null;
  timeZone: string | null;
}

export class LocaleError extends DomainError {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LocaleError';
    this.code = code;
  }
}

/**
 * The resolved pair for one reader, in one query.
 *
 * `organization` is NOT RLS-scoped (0023: "the one table already read by slug
 * before anybody is signed in"), so this join reaches it from inside a tenant
 * transaction without any special handling — but `app_user` IS, which is what
 * makes the `WHERE u.id = $1` safe: a caller passing another tenant's user id
 * gets zero rows rather than that user's preferences.
 */
export async function loadReaderPrefs(tx: QueryRunner, userId: string): Promise<ReaderPrefs> {
  const { rows } = await tx.query<{
    user_locale: string | null;
    user_timezone: string | null;
    org_locale: string;
    org_timezone: string;
  }>(
    `SELECT u.locale             AS user_locale,
            u.timezone           AS user_timezone,
            o.default_locale     AS org_locale,
            o.default_timezone   AS org_timezone
       FROM app_user u
       JOIN organization o ON o.id = u.organization_id
      WHERE u.id = $1`,
    [userId],
  );

  // No row is not an error and must not throw. This is called on the render path
  // of every page; a user deactivated between the session check and this query
  // should see the company's formatting, not a 500. `requireActor` is what
  // refuses the request, and it does so for its own reasons.
  const row = rows[0];
  if (!row) return resolveReaderPrefs({});

  return resolveReaderPrefs({
    userLocale: row.user_locale,
    orgLocale: row.org_locale,
    userTimeZone: row.user_timezone,
    orgTimeZone: row.org_timezone,
  });
}

/**
 * The same thing keyed by email, for the render path.
 *
 * A separate query rather than `requireActor` then `loadReaderPrefs`, because
 * those are two round trips for one fact and this runs on every page. It is also
 * deliberately NOT an authorization check: `requireActor` refuses deactivated
 * accounts and this does not care, since knowing how to format a date is not a
 * permission. Whichever page needs the actor still calls `requireActor` for its
 * own reasons.
 */
export async function loadReaderPrefsByEmail(
  tx: QueryRunner,
  email: string,
  acceptLanguage?: string | null,
): Promise<ReaderPrefs> {
  const { rows } = await tx.query<{
    user_locale: string | null;
    user_timezone: string | null;
    org_locale: string;
    org_timezone: string;
  }>(
    `SELECT u.locale           AS user_locale,
            u.timezone         AS user_timezone,
            o.default_locale   AS org_locale,
            o.default_timezone AS org_timezone
       FROM app_user u
       JOIN organization o ON o.id = u.organization_id
      WHERE u.email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) return resolveReaderPrefs({ acceptLanguage });

  return resolveReaderPrefs({
    userLocale: row.user_locale,
    orgLocale: row.org_locale,
    userTimeZone: row.user_timezone,
    orgTimeZone: row.org_timezone,
    acceptLanguage,
  });
}

/** The company's own settings, for the admin screen to show and edit. */
export async function getOrgDefaults(tx: QueryRunner, orgId: string): Promise<OrgDefaults> {
  const { rows } = await tx.query<{ default_locale: string; default_timezone: string }>(
    `SELECT default_locale, default_timezone FROM organization WHERE id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) throw new LocaleError('organization not found', 'ORG_NOT_FOUND');
  // The column is constrained to SUPPORTED_LOCALES, so this cast is checked by
  // the database rather than asserted here — and `isLocale` re-checks anyway,
  // because a row can outlive a locale being retired from the registry and the
  // screen should show something rather than crash.
  return {
    locale: isLocale(row.default_locale) ? row.default_locale : SUPPORTED_LOCALES[0],
    timeZone: row.default_timezone,
  };
}

export async function getUserPrefs(tx: QueryRunner, userId: string): Promise<UserPrefs> {
  const { rows } = await tx.query<{ locale: string | null; timezone: string | null }>(
    `SELECT locale, timezone FROM app_user WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new LocaleError('employee not found', 'USER_NOT_FOUND');
  return {
    locale: isLocale(row.locale) ? row.locale : null,
    timeZone: row.timezone,
  };
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/**
 * Normalise a form's timezone field to what the column means.
 *
 * '' and '   ' both become NULL — "I have no preference" — because that is what
 * a cleared `<select>` submits, and `0027`'s CHECK refuses a blank string
 * outright. Doing it here rather than in each action is the same reasoning
 * `lib/branding/color.ts` uses for `#rrggbb`: one normalising writer, so the
 * database never has to accept a second spelling of the same fact.
 *
 * An UNKNOWN zone is deliberately NOT normalised away — it is passed through to
 * the database, which refuses it by trigger with a message naming the zone. A
 * writer that silently dropped an unrecognised zone to NULL would turn a typo
 * into "your preference didn't save and nothing said why".
 */
function normaliseZone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireSupportedLocale(value: string | null | undefined, allowNull: boolean): Locale | null {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new LocaleError('a locale is required', 'LOCALE_REQUIRED');
  }
  if (!isLocale(value)) {
    throw new LocaleError(`${value} is not a supported locale`, 'LOCALE_UNSUPPORTED');
  }
  return value;
}

/**
 * Both writes go on the hash-chained audit trail, and the reason is stronger
 * than the one `app/notifications/actions.ts` gives for preference changes.
 *
 * That file's reason is "a person can mute an event and therefore miss a
 * returned report, and 'I was never told' has to be answerable afterwards".
 * Locale is worse than that: it changes how MONEY AND DATES RENDER ON A
 * FINANCIAL RECORD. `03/04/2026` is the fourth of March to one reader and the
 * third of April to another, and an expense report is a document people dispute
 * months later. "The screen said the third of April" needs an answer, and the
 * answer is which locale that screen was rendering in on that day.
 *
 * The org write is audited for the ordinary config reason as well: it moves every
 * employee who never chose, which is the largest-blast-radius setting on the
 * screen and the one with the least visible effect on the admin's own page.
 */
async function auditPrefs(
  tx: QueryRunner,
  actor: AuditActor,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await append(tx, actor, { action, entityType: 'organization', entityId, details });
}

export async function setOrgDefaults(
  tx: QueryRunner,
  orgId: string,
  actor: AuditActor,
  patch: { locale?: string | null; timeZone?: string | null },
): Promise<OrgDefaults> {
  // NOT NULL on both columns, so neither may be cleared — the company always has
  // an answer. `requireSupportedLocale(..., false)` is what says so.
  const locale = requireSupportedLocale(patch.locale, false);
  const zone = normaliseZone(patch.timeZone);
  if (zone === null) {
    throw new LocaleError('a timezone is required', 'TIMEZONE_REQUIRED');
  }

  // Read the previous values FIRST, in the same transaction, because the audit
  // detail that answers a dispute is `from -> to` rather than `to`. UD-11 files
  // this as a gap across the product ("who changed this amount, from what, when
  // is unanswerable"); it costs one SELECT here, so it is not a gap here.
  const before = await getOrgDefaults(tx, orgId);

  const { rows } = await tx.query<{ default_locale: string; default_timezone: string }>(
    `UPDATE organization
        SET default_locale   = $2,
            default_timezone = $3,
            updated_at       = now()
      WHERE id = $1
      RETURNING default_locale, default_timezone`,
    [orgId, locale, zone],
  );
  const row = rows[0];
  if (!row) throw new LocaleError('organization not found', 'ORG_NOT_FOUND');

  await auditPrefs(tx, actor, 'ORG_LOCALE_CHANGED', orgId, {
    fromLocale: before.locale,
    toLocale: locale,
    fromTimeZone: before.timeZone,
    toTimeZone: row.default_timezone,
  });

  return { locale: locale as Locale, timeZone: row.default_timezone };
}

export async function setUserPrefs(
  tx: QueryRunner,
  userId: string,
  actor: AuditActor,
  patch: { locale?: string | null; timeZone?: string | null },
): Promise<UserPrefs> {
  // NULL IS ALLOWED HERE and it is the whole point: clearing a preference must
  // put the reader back on the company default, permanently, not pin them to
  // whatever the default happened to be on the day they cleared it.
  const locale = requireSupportedLocale(patch.locale, true);
  const zone = normaliseZone(patch.timeZone);

  const before = await getUserPrefs(tx, userId);

  const { rows } = await tx.query<{ locale: string | null; timezone: string | null }>(
    `UPDATE app_user
        SET locale     = $2,
            timezone   = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING locale, timezone`,
    [userId, locale, zone],
  );
  const row = rows[0];
  if (!row) throw new LocaleError('employee not found', 'USER_NOT_FOUND');

  // `entityType: 'app_user'`, unlike the org write, because the thing that
  // changed is a person's row — and `entityId` is the SUBJECT rather than the
  // actor, which matters the day an admin sets somebody else's locale for them.
  // Nothing does that today; the trail is what makes it answerable when
  // something does.
  //
  // 'inherit' rather than null in the details: `canonical()` is in the hash and a
  // null reads as "no value recorded" where the fact being recorded is "this
  // person chose to follow the company". AU-5's discipline about what goes in a
  // detail — a word that says what happened beats an absence.
  await append(tx, actor, {
    action: 'USER_LOCALE_CHANGED',
    entityType: 'app_user',
    entityId: userId,
    details: {
      fromLocale: before.locale ?? 'inherit',
      toLocale: locale ?? 'inherit',
      fromTimeZone: before.timeZone ?? 'inherit',
      toTimeZone: row.timezone ?? 'inherit',
    },
  });

  return { locale: isLocale(row.locale) ? row.locale : null, timeZone: row.timezone };
}

/**
 * Every IANA zone this Postgres knows, for the picker.
 *
 * From the database rather than from Node, and the two are not the same list:
 * `Intl.supportedValuesOf('timeZone')` reflects the ICU data Node was built
 * with, `pg_timezone_names` reflects the tzdata Postgres was built with, and
 * `0027`'s trigger validates against the SECOND one. Offering a picker from the
 * first would let an admin choose a zone the database then refuses — a form that
 * shows you an option and rejects it on submit.
 *
 * Filtered to names containing a `/`: the view also carries legacy aliases
 * (`EST`, `MST7MDT`, `posixrules`) which are accepted by the trigger but are not
 * what anybody means, and one of them — `posixrules` — has been deprecated
 * upstream in tzdata for years.
 */
export async function listTimeZones(tx: QueryRunner): Promise<string[]> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM pg_timezone_names WHERE name LIKE '%/%' ORDER BY name`,
  );
  return rows.map((r) => r.name);
}
