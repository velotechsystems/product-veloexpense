/**
 * VX4-7 part 1 — the stored half: 0027's columns, constraints and trigger, and
 * the precedence chain driven from real rows.
 * Own org slugs ('loc-co', 'loc-co-2').
 *
 * Two layers, tested separately, for the reason 0023 established and
 * `test/budgets.db.test.ts` restates: the CONSTRAINTS are driven with raw SQL
 * through the admin pool, because an importer, a support script, an HRIS sync
 * and a restored backup all reach these columns without reaching any service —
 * every one of them would still be a guarantee if `lib/i18n` were deleted. The
 * SERVICE is driven through `lib/i18n/service.ts`, because those claims are
 * about what resolution DOES.
 *
 * ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────────
 *
 * `the CHECK constraint accepts exactly SUPPORTED_LOCALES` is the whole reason
 * a duplicated list is acceptable at all. 0027 and 0028 have to restate the tags
 * because SQL cannot import TypeScript, and the alternative — no constraint —
 * was rejected when 0021 and 0023 both refused to put a company setting in
 * jsonb. So the copy is made safe instead of avoided: this test reads the
 * accepted set back out of the constraint's own definition and compares it to
 * the registry IN BOTH DIRECTIONS.
 *
 * ExpenseOS is the cautionary case, one level up: their CI coverage gate opens
 * by restating `['en', 'fr-CA']`, so the gate polices a list it also holds a
 * stale copy of. A third locale there is not merely unchecked — every loop
 * iterates the stale pair and PASSES. A duplicated list with a test is fine. A
 * duplicated list without one fails open.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { DEFAULT_TIMEZONE } from '@/lib/i18n/resolve';
import {
  getOrgDefaults,
  getUserPrefs,
  listTimeZones,
  loadReaderPrefs,
  loadReaderPrefsByEmail,
  setOrgDefaults,
  setUserPrefs,
} from '@/lib/i18n/service';
import { localized } from '@/lib/notifications/catalog';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/**
 * Both writes are audited and both now REQUIRE an actor, deliberately: an
 * optional actor is an audit call the next caller forgets, which is MT-3's rule
 * ("a gate at the edge is a gate the next caller forgets") applied to the trail
 * rather than to a permission.
 */
const actorRow = () => ({ id: readerId, name: 'Reader', role: 'EMPLOYEE' });

let orgId: string;
let otherOrgId: string;
let readerId: string;
let otherTenantUserId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('loc-co','Loc Co'), ('loc-co-2','Loc Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'loc-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'loc-co-2').id;

  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'reader@loc.test','Reader','019e3000-0000-7000-8000-000000000004') RETURNING id`,
      [orgId],
    );
    readerId = u.rows[0].id;
  });
  await withOrg(otherOrgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'reader@loc2.test','Reader Two','019e3000-0000-7000-8000-000000000004') RETURNING id`,
      [otherOrgId],
    );
    otherTenantUserId = u.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

/** The newest audit sequence, so a test can read only what it caused. */
async function highWaterMark(): Promise<string> {
  const { rows } = await admin.query<{ seq: string }>(
    `SELECT COALESCE(max(sequence), 0)::text AS seq FROM audit_entry`,
  );
  return rows[0].seq;
}

/** Put both rows back to the shipped state between groups. */
async function reset() {
  await admin.query(
    `UPDATE organization SET default_locale = $1, default_timezone = 'UTC'`,
    [DEFAULT_LOCALE],
  );
  await admin.query(`UPDATE app_user SET locale = NULL, timezone = NULL`);
}

describe('0027 — the columns mean what the registry means', () => {
  it('every new tenant starts at the default locale, in UTC', async () => {
    // The DEFAULT on the column, not something a service writes: an org created
    // by a seed, an importer or a support script gets a usable locale without
    // anybody remembering to set one.
    const { rows } = await admin.query(
      `INSERT INTO organization (slug, name) VALUES ('loc-co-3','Loc Co 3')
       RETURNING default_locale, default_timezone`,
    );
    expect(rows[0].default_locale).toBe(DEFAULT_LOCALE);
    expect(rows[0].default_timezone).toBe(DEFAULT_TIMEZONE);
    await admin.query(`DELETE FROM organization WHERE slug = 'loc-co-3'`);
  });

  it('the CHECK constraint accepts exactly SUPPORTED_LOCALES', async () => {
    // Direction 1: read the accepted set out of the constraint's own definition.
    // `pg_get_constraintdef` returns the SQL Postgres actually enforces, so this
    // cannot pass by reading the migration file I wrote.
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'organization_default_locale_supported'`,
    );
    expect(rows).toHaveLength(1);
    const accepted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(accepted).toEqual([...SUPPORTED_LOCALES].sort());

    // Direction 2: the database actually takes each one. A constraint whose TEXT
    // lists a tag the column then rejects (a collation quirk, a stray space) would
    // pass direction 1 alone.
    for (const locale of SUPPORTED_LOCALES) {
      await expect(
        admin.query(`UPDATE organization SET default_locale = $1 WHERE id = $2`, [locale, orgId]),
      ).resolves.toBeDefined();
    }
    await reset();
  });

  it('the same constraint guards app_user, and NULL is allowed there only', async () => {
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'app_user_locale_supported'`,
    );
    const accepted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(accepted).toEqual([...SUPPORTED_LOCALES].sort());

    // NULL means "follow the company" — a real answer, not missing data.
    await expect(
      admin.query(`UPDATE app_user SET locale = NULL WHERE id = $1`, [readerId]),
    ).resolves.toBeDefined();
    // …and the company column cannot be NULL, because there is no such thing as
    // a company with no locale.
    await expect(
      admin.query(`UPDATE organization SET default_locale = NULL WHERE id = $1`, [orgId]),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it('refuses the bare subtag this ticket retagged away from', async () => {
    // IL-1's actual bug as a stored value. `en` is the tag upstream shipped for
    // years believing it meant Canadian English, and it is what any row written
    // before 0027 would contain — so the column refusing it is what stops the
    // old spelling coming back through an importer.
    // `fr-CA` joins this list in part 2a: it was accepted after 0027 and is
    // refused after 0028, which is the retirement expressed as a constraint.
    for (const bad of ['en', 'fr', 'en-ca', 'en_CA', 'fr-FR', 'fr-CA', '']) {
      await expect(
        admin.query(`UPDATE organization SET default_locale = $1 WHERE id = $2`, [bad, orgId]),
      ).rejects.toThrow(/organization_default_locale_supported/);
    }
    await reset();
  });
});

describe('0027 — the timezone trigger', () => {
  it('accepts a real IANA zone on both tables', async () => {
    await expect(
      admin.query(`UPDATE organization SET default_timezone = 'America/Vancouver' WHERE id = $1`, [
        orgId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      admin.query(`UPDATE app_user SET timezone = 'Europe/Paris' WHERE id = $1`, [readerId]),
    ).resolves.toBeDefined();
    await reset();
  });

  it('refuses a zone that does not exist, naming it', async () => {
    // The failure this prevents is not an error message — it is
    // `Intl.DateTimeFormat` throwing a RangeError inside a server component on
    // every render of every page showing a date, for one tenant, which reads as
    // an outage rather than as a typo in a settings row.
    await expect(
      admin.query(`UPDATE organization SET default_timezone = 'America/Torono' WHERE id = $1`, [
        orgId,
      ]),
    ).rejects.toThrow(/America\/Torono is not an IANA timezone name/);
    await expect(
      admin.query(`UPDATE app_user SET timezone = 'Mars/Olympus' WHERE id = $1`, [readerId]),
    ).rejects.toThrow(/Mars\/Olympus is not an IANA timezone name/);
  });

  it('says "blank" for a blank zone rather than blaming the zone name', async () => {
    // A BEFORE trigger runs ahead of the row's CHECK constraints, so
    // `organization_default_timezone_nonempty` never gets to speak. The first
    // probe of 0027 produced `"     is not an IANA timezone name"`, which sends
    // whoever reads it looking for a typo that is not there. The trigger now owns
    // the wording and the CHECK remains the structural guarantee.
    await expect(
      admin.query(`UPDATE organization SET default_timezone = '   ' WHERE id = $1`, [orgId]),
    ).rejects.toThrow(/timezone is blank; use NULL to follow the company default/);
    await expect(
      admin.query(`UPDATE app_user SET timezone = '' WHERE id = $1`, [readerId]),
    ).rejects.toThrow(/timezone is blank/);
  });

  it('allows NULL on app_user, which is how a reader clears a preference', async () => {
    await expect(
      admin.query(`UPDATE app_user SET timezone = NULL WHERE id = $1`, [readerId]),
    ).resolves.toBeDefined();
  });

  it('validates on INSERT too, not only on UPDATE', async () => {
    // `BEFORE INSERT OR UPDATE OF` — an importer creating rows outright is the
    // path most likely to carry a bad zone, and it never runs an UPDATE.
    await expect(
      admin.query(
        `INSERT INTO organization (slug, name, default_timezone)
         VALUES ('loc-co-bad','Bad','Nowhere/Fake')`,
      ),
    ).rejects.toThrow(/Nowhere\/Fake is not an IANA timezone name/);
  });

  it('offers only zones the trigger will accept', async () => {
    // The picker comes from `pg_timezone_names`, not from Node's
    // `Intl.supportedValuesOf('timeZone')`, because the trigger validates against
    // the first. A picker built from the second could offer an option the database
    // then refuses — a form that shows you a choice and rejects it on submit.
    const zones = await withOrg(orgId, listTimeZones);
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain('America/Toronto');
    expect(zones).toContain('America/Vancouver');
    // Legacy aliases are filtered out: accepted by the trigger, but not what
    // anybody means, and `posixrules` has been deprecated in tzdata for years.
    expect(zones).not.toContain('EST');
    expect(zones).not.toContain('posixrules');
    // Every offered zone must actually pass the trigger. Spot-checking the ends
    // and the middle rather than all ~600, which would be a slow test asserting
    // one property.
    for (const zone of [zones[0], zones[Math.floor(zones.length / 2)], zones[zones.length - 1]]) {
      await expect(
        admin.query(`UPDATE organization SET default_timezone = $1 WHERE id = $2`, [zone, orgId]),
      ).resolves.toBeDefined();
    }
    await reset();
  });
});

describe('precedence, from real rows', () => {
  it('a reader with no preferences follows the company', async () => {
    await admin.query(
      `UPDATE organization SET default_locale = 'en-US', default_timezone = 'America/Toronto'
        WHERE id = $1`,
      [orgId],
    );
    const prefs = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    expect(prefs).toEqual({ locale: 'en-US', timeZone: 'America/Toronto' });
    await reset();
  });

  it('changing the company default MOVES a reader who never chose', async () => {
    // This is what NULL-means-inherit buys, and it is the reason the column does
    // not store a resolved value per user. Storing one would freeze today's
    // default into every row and make the company setting inert for everybody who
    // had ever loaded a page.
    const before = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    expect(before.locale).toBe(DEFAULT_LOCALE);

    await admin.query(`UPDATE organization SET default_locale = 'en-US' WHERE id = $1`, [orgId]);
    const after = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    expect(after.locale).toBe('en-US');
    await reset();
  });

  it('and does NOT move a reader who chose', async () => {
    await admin.query(`UPDATE app_user SET locale = 'en-US' WHERE id = $1`, [readerId]);
    await admin.query(`UPDATE organization SET default_locale = 'en-US' WHERE id = $1`, [orgId]);
    const prefs = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    expect(prefs.locale).toBe('en-US');
    await reset();
  });

  it('resolves locale and timezone independently from stored rows', async () => {
    // The pure test asserts this of `resolveReaderPrefs`; this asserts the LOADER
    // hands it both rungs rather than short-circuiting once it has seen any user
    // preference. A Vancouver employee at a Toronto company that runs in French.
    await admin.query(
      `UPDATE organization SET default_locale = 'en-US', default_timezone = 'America/Toronto'
        WHERE id = $1`,
      [orgId],
    );
    await admin.query(`UPDATE app_user SET timezone = 'America/Vancouver' WHERE id = $1`, [
      readerId,
    ]);
    const prefs = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    expect(prefs).toEqual({ locale: 'en-US', timeZone: 'America/Vancouver' });
    await reset();
  });

  it('by email, for the render path, gives the same answer', async () => {
    // The fixture makes the two rungs DISAGREE on both axes, and that is the
    // point rather than thoroughness for its own sake. The first version of this
    // test set only `app_user.locale` and left the company on UTC — so a loader
    // that short-circuited past the company row still returned the same pair,
    // and the test passed for a second reason. A sabotage run is what exposed it:
    // breaking the loader failed the independence test and left this one green.
    //
    // Now the reader supplies the locale, the COMPANY supplies the zone, and the
    // two values are different from each other and from the defaults, so any
    // loader that drops a rung returns something else.
    await admin.query(`UPDATE app_user SET locale = 'en-US', timezone = NULL WHERE id = $1`, [
      readerId,
    ]);
    await admin.query(
      `UPDATE organization SET default_locale = 'en-US', default_timezone = 'America/Halifax'
        WHERE id = $1`,
      [orgId],
    );

    const byId = await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId));
    const byEmail = await withOrg(orgId, (tx) =>
      loadReaderPrefsByEmail(tx, 'reader@loc.test', null),
    );
    expect(byEmail).toEqual(byId);
    // Pinned absolutely as well as relatively: `toEqual(byId)` alone would pass
    // if BOTH loaders were wrong in the same way, which is the failure mode of
    // every test that compares two implementations to each other. UD-5 req 2 in
    // miniature — assert against the source of truth, not against a sibling.
    expect(byEmail).toEqual({ locale: 'en-US', timeZone: 'America/Halifax' });
    await reset();
  });

  it('another tenant is invisible, and yields defaults rather than throwing', async () => {
    // RLS does the work: `app_user` is FORCE ROW LEVEL SECURITY, so the join finds
    // no row. Returning defaults rather than throwing is deliberate — this runs on
    // the render path of every page, and knowing how to format a date is not a
    // permission. `requireActor` is what refuses the request.
    await admin.query(`UPDATE app_user SET locale = 'en-US' WHERE id = $1`, [otherTenantUserId]);
    const prefs = await withOrg(orgId, (tx) => loadReaderPrefs(tx, otherTenantUserId));
    expect(prefs).toEqual({ locale: DEFAULT_LOCALE, timeZone: DEFAULT_TIMEZONE });
    await reset();
  });

  it('negotiates the header only when there is no row at all', async () => {
    // Pre-auth, where the header is the only signal. A signed-in reader's stored
    // or company locale must beat it — asserted here against real rows because
    // the pure test can only assert the function.
    // The header asks for a locale we DO serve, so the pre-auth rung can answer
    // it. Part 1 used `fr-CA` here; part 2a retired that locale, and a header
    // naming an unserved language now negotiates to null — which would make this
    // pass for the wrong reason, since the default is also what a failed
    // negotiation returns.
    const signedOut = await withOrg(orgId, (tx) =>
      loadReaderPrefsByEmail(tx, 'nobody@loc.test', 'en-US,en;q=0.9'),
    );
    expect(signedOut.locale).toBe('en-US');

    const signedIn = await withOrg(orgId, (tx) =>
      loadReaderPrefsByEmail(tx, 'reader@loc.test', 'en-US,en;q=0.9'),
    );
    expect(signedIn.locale).toBe(DEFAULT_LOCALE);
    await reset();
  });
});

describe('the service writes', () => {
  it('sets and reads the company defaults', async () => {
    await withOrg(orgId, (tx) =>
      setOrgDefaults(tx, orgId, actorRow(), { locale: 'en-US', timeZone: 'America/Toronto' }),
    );
    const defaults = await withOrg(orgId, (tx) => getOrgDefaults(tx, orgId));
    expect(defaults).toEqual({ locale: 'en-US', timeZone: 'America/Toronto' });
    await reset();
  });

  it('refuses to clear a company default, because there is no such state', async () => {
    await expect(
      withOrg(orgId, (tx) => setOrgDefaults(tx, orgId, actorRow(), { locale: null, timeZone: 'UTC' })),
    ).rejects.toThrow(/a locale is required/);
    await expect(
      withOrg(orgId, (tx) => setOrgDefaults(tx, orgId, actorRow(), { locale: 'en-CA', timeZone: '  ' })),
    ).rejects.toThrow(/a timezone is required/);
  });

  it('refuses an unsupported locale before the database has to', async () => {
    // Belt and braces on purpose: the CHECK is the guarantee, and this is the
    // message. A constraint violation surfacing to an admin says
    // "organization_default_locale_supported", which is true and useless.
    await expect(
      withOrg(orgId, (tx) => setOrgDefaults(tx, orgId, actorRow(), { locale: 'en', timeZone: 'UTC' })),
    ).rejects.toThrow(/en is not a supported locale/);
  });

  it('lets a reader set and then CLEAR a preference back to inherit', async () => {
    await withOrg(orgId, (tx) =>
      setUserPrefs(tx, readerId, actorRow(), { locale: 'en-US', timeZone: 'America/Vancouver' }),
    );
    expect(await withOrg(orgId, (tx) => getUserPrefs(tx, readerId))).toEqual({
      locale: 'en-US',
      timeZone: 'America/Vancouver',
    });

    // '' is what a cleared `<select>` submits, and it must become NULL — not a
    // blank string the CHECK refuses, and not a resolved copy of today's default.
    await withOrg(orgId, (tx) => setUserPrefs(tx, readerId, actorRow(), { locale: '', timeZone: '' }));
    expect(await withOrg(orgId, (tx) => getUserPrefs(tx, readerId))).toEqual({
      locale: null,
      timeZone: null,
    });

    // And the reader is now back on the company's answer, permanently.
    await admin.query(`UPDATE organization SET default_locale = 'en-US' WHERE id = $1`, [orgId]);
    expect((await withOrg(orgId, (tx) => loadReaderPrefs(tx, readerId))).locale).toBe('en-US');
    await reset();
  });

  it('records what changed, from what, on the audit trail', async () => {
    // The assertion I should have written before the audit calls, not after: the
    // point of auditing a locale change is that `03/04/2026` is the fourth of
    // March to one reader and the third of April to another, and an expense
    // report is a document people dispute months later. An audit row saying only
    // the NEW value cannot answer "what was the screen rendering in on the day I
    // read it" — so `from` is the load-bearing half, and UD-11 files its absence
    // across the rest of the product as a real gap.
    // Read FORWARD from a marker rather than clearing the table: `audit_entry`
    // is append-only by trigger (0010), so `DELETE` is refused unless a caller
    // sets `app.audit_purge` — which is exactly right, and which the first draft
    // of this test discovered by trying. `sequence` is a bigint from a sequence,
    // so it orders unambiguously where two `clock_timestamp()` values could tie.
    const mark = await highWaterMark();
    await withOrg(orgId, (tx) =>
      setOrgDefaults(tx, orgId, actorRow(), { locale: 'en-US', timeZone: 'America/Toronto' }),
    );

    const { rows } = await admin.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_entry WHERE sequence > $1 ORDER BY sequence LIMIT 1`,
      [mark],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('ORG_LOCALE_CHANGED');
    expect(rows[0].details).toMatchObject({
      fromLocale: DEFAULT_LOCALE,
      toLocale: 'en-US',
      fromTimeZone: 'UTC',
      toTimeZone: 'America/Toronto',
    });
    await reset();
  });

  it("records a reader clearing a preference as 'inherit', not as an absence", async () => {
    // `canonical()` is in the hash chain and a null detail reads as "no value
    // recorded", where the fact being recorded is "this person chose to follow
    // the company". A word that says what happened beats an absence — AU-5's
    // discipline about detail payloads.
    await withOrg(orgId, (tx) => setUserPrefs(tx, readerId, actorRow(), { locale: 'en-US' }));
    const mark = await highWaterMark();
    await withOrg(orgId, (tx) => setUserPrefs(tx, readerId, actorRow(), { locale: '' }));

    const { rows } = await admin.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_entry WHERE sequence > $1 ORDER BY sequence LIMIT 1`,
      [mark],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('USER_LOCALE_CHANGED');
    expect(rows[0].details).toMatchObject({ fromLocale: 'en-US', toLocale: 'inherit' });
    await reset();
  });

  it('passes an unknown zone through to the database rather than dropping it', async () => {
    // A writer that silently normalised an unrecognised zone to NULL would turn a
    // typo into "your preference didn't save and nothing said why". The trigger's
    // message names the zone.
    await expect(
      withOrg(orgId, (tx) => setUserPrefs(tx, readerId, actorRow(), { timeZone: 'America/Torono' })),
    ).rejects.toThrow(/America\/Torono is not an IANA timezone name/);
  });
});

describe('the retag, and the key it retagged away from', () => {
  it('no stored template still carries a bare `en` key', async () => {
    // 0027's data migration. The dev database has no authored templates, so this
    // is a floor rather than a proof — its value is as a regression guard: a
    // future seed, fixture or admin action that writes `{ en: … }` fails here.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification_template
        WHERE body ? 'en' OR subject ? 'en'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a row written with the old key renders as MISSING, not as English', async () => {
    // The assertion with teeth. If `localized` still answered from `en`, the
    // retag would look unnecessary and a half-migrated row would render as though
    // it were fine — so the migration would appear to be a no-op and the next
    // person would delete it.
    expect(localized({ en: 'Old copy' }, 'en-CA')).toBeNull();
    expect(localized({ en: 'Old copy' }, 'en-US')).toBeNull();
    expect(localized({ 'en-CA': 'New copy' }, 'en-CA')).toBe('New copy');
  });
});
