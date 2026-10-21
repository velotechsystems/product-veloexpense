// w5-04 — ported from ExpenseOS `packages/integrations-google/src/mappers.test.ts`, as it stands at
// 67db2e33 (#582). VeloExpense: the addresses are `example.test` and the companies fictional.
import { describe, expect, it } from 'vitest';
import { mapGoogleUserToDirectoryUser } from './mappers';

/**
 * Google Directory payload → the normalized `DirectoryUser` this package writes.
 *
 * `applyDirectoryUserToDb` treats every field here as CANONICAL: Google owns them, and a
 * blank in Google clears ours. So a mapping error here is not a cosmetic problem — it is
 * written straight over the org graph on every sign-in and every night:
 *
 *   · a missed `managerEmail` breaks the approval chain walk;
 *   · a missed `archived` or deleted flag leaves a terminated employee ACTIVE, with live
 *     cards;
 *   · a wrong `primary` pick assigns somebody the wrong title (→ job level → approver) or
 *     the wrong country.
 *
 * Equally pinned is what is NOT read. Department and business unit are owned by VeloExpense,
 * legal entity by NetSuite's subsidiary; reading Google's cost centre or building here
 * would only invite a second writer for them.
 *
 * Every field is defensively coerced because the Directory payload is sparse in practice:
 * plenty of real accounts have no organizations array at all.
 */

const base = { id: '1001', primaryEmail: 'Ada.Lovelace@EXAMPLE.TEST' };

describe('mapGoogleUserToDirectoryUser', () => {
  it('lowercases and trims the email, because it is a join key', () => {
    // The email is the fallback match from a Google account to a User row. A case
    // difference here would create a duplicate person on every sync.
    expect(
      mapGoogleUserToDirectoryUser({ ...base, primaryEmail: '  Ada.Lovelace@EXAMPLE.TEST ' }).email,
    ).toBe('ada.lovelace@example.test');
  });

  it('reads the Google id, which is matched BEFORE email', () => {
    // The id survives a primary-email change; email does not. It is the same value as the
    // OIDC `sub` Google sign-in reports.
    expect(mapGoogleUserToDirectoryUser({ ...base, id: ' 1001 ' }).googleId).toBe('1001');
    expect(mapGoogleUserToDirectoryUser({ primaryEmail: 'x@example.test' }).googleId).toBe('');
  });

  it('maps names, avatar, the primary title and the primary country', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      thumbnailPhotoUrl: 'https://x/photo.jpg',
      organizations: [{ primary: true, title: 'Engineer' }],
      addresses: [{ primary: true, countryCode: 'ca' }],
    });
    expect(out).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'https://x/photo.jpg',
      title: 'Engineer',
      // Uppercased: ISO-3166 alpha-2 is compared as written by the tax engine.
      country: 'CA',
    });
  });

  it('does not expose department, business unit, legal entity or employee id', () => {
    /**
     * The whole point of the rewrite. VeloExpense owns department and business unit, and
     * NetSuite's subsidiary owns the legal entity. If the mapper handed these over, some
     * later caller would write them — and Google's cost centre, building and bare-leaf
     * department names would overwrite the curated values on every sign-in.
     */
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      organizations: [
        {
          primary: true,
          name: 'Northwind Ontario',
          title: 'Engineer',
          department: 'R&D',
          costCenter: 'Northwind Inc.',
        },
      ],
      locations: [{ type: 'desk', buildingId: 'Logistic Centre - Edmonton' }],
      externalIds: [{ type: 'organization', value: 'E-12345' }],
    });
    for (const key of ['department', 'businessUnit', 'entity', 'legalEntity', 'employeeId']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('prefers the entry flagged primary, not the first one', () => {
    // Google returns organizations and addresses in no guaranteed order; taking [0] would
    // assign the wrong title — and therefore the wrong job level and approver.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      organizations: [
        { primary: false, title: 'Sales Rep' },
        { primary: true, title: 'Engineer' },
      ],
      addresses: [
        { primary: false, countryCode: 'US' },
        { primary: true, countryCode: 'CA' },
      ],
    });
    expect(out.title).toBe('Engineer');
    expect(out.country).toBe('CA');
  });

  it('falls back to the first entry when none is flagged primary', () => {
    // Common in real payloads. Guessing the first is better than dropping the title,
    // which would clear the job level on a canonical write.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      organizations: [{ title: 'Ops Lead' }, { title: 'Sales Rep' }],
      addresses: [{ countryCode: 'us' }],
    });
    expect(out.title).toBe('Ops Lead');
    expect(out.country).toBe('US');
  });

  it('treats blank strings as absent', () => {
    // A whitespace-only title or name is not a value; written as-is it would read as a
    // real (empty) title and never map to a job level.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      name: { givenName: '  ', familyName: '' },
      thumbnailPhotoUrl: ' ',
      organizations: [{ primary: true, title: '   ' }],
      addresses: [{ primary: true, countryCode: ' ' }],
      relations: [{ type: 'manager', value: '  ' }],
    });
    expect(out).toMatchObject({
      firstName: null,
      lastName: null,
      avatarUrl: null,
      title: null,
      country: null,
      managerEmail: null,
    });
  });

  it('reads the manager from the relations list, lowercased', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      relations: [
        { type: 'assistant', value: 'PA@example.test' },
        { type: 'manager', value: 'Grace.Hopper@Example.test' },
      ],
    });
    // Lowercased for the same reason as the primary email: it is resolved by lookup.
    expect(out.managerEmail).toBe('grace.hopper@example.test');
  });

  it('returns a null manager rather than picking a different relation type', () => {
    // An assistant is not a manager. Mistaking one would route approvals to the wrong
    // person while looking entirely plausible.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      relations: [{ type: 'assistant', value: 'pa@example.test' }],
    });
    expect(out.managerEmail).toBeNull();
  });

  describe('employee status', () => {
    it('is ACTIVE by default', () => {
      expect(mapGoogleUserToDirectoryUser(base).employeeStatus).toBe('ACTIVE');
    });

    it('is TERMINATED for an archived account', () => {
      // The status that triggers the offboarding roll-up. Missing it leaves a departed
      // employee with live cards and open drafts.
      expect(mapGoogleUserToDirectoryUser({ ...base, archived: true }).employeeStatus).toBe(
        'TERMINATED',
      );
    });

    it('is TERMINATED for an account deleted in Google', () => {
      // A deleted account looks like any other in the payload; only the caller knows it
      // came from the `showDeleted` listing, and says so.
      const out = mapGoogleUserToDirectoryUser(base, { deleted: true });
      expect(out.employeeStatus).toBe('TERMINATED');
      expect(out.deleted).toBe(true);
    });

    it('is DEACTIVATED for a suspended account', () => {
      expect(mapGoogleUserToDirectoryUser({ ...base, suspended: true }).employeeStatus).toBe(
        'DEACTIVATED',
      );
    });

    it('treats archived and deleted as stronger than suspended', () => {
      // Both flags can be set. Terminated is the more consequential, so it has to win
      // rather than depending on evaluation order.
      expect(
        mapGoogleUserToDirectoryUser({ ...base, archived: true, suspended: true }).employeeStatus,
      ).toBe('TERMINATED');
      expect(
        mapGoogleUserToDirectoryUser({ ...base, suspended: true }, { deleted: true })
          .employeeStatus,
      ).toBe('TERMINATED');
    });

    it('is not deleted unless the caller says so', () => {
      expect(mapGoogleUserToDirectoryUser(base).deleted).toBe(false);
      expect(mapGoogleUserToDirectoryUser(base, { deleted: false }).deleted).toBe(false);
    });
  });

  describe('termination date', () => {
    it('is the deletion time of an archived account', () => {
      const out = mapGoogleUserToDirectoryUser({
        ...base,
        archived: true,
        deletionTime: '2026-07-31T00:00:00.000Z',
      });
      expect(out.terminationDate?.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    });

    it('is the deletion time of a deleted account', () => {
      const out = mapGoogleUserToDirectoryUser(
        { ...base, deletionTime: '2026-08-15T12:00:00.000Z' },
        { deleted: true },
      );
      expect(out.terminationDate?.toISOString()).toBe('2026-08-15T12:00:00.000Z');
    });

    it('is null for an archived account with no deletion time', () => {
      expect(mapGoogleUserToDirectoryUser({ ...base, archived: true }).terminationDate).toBeNull();
    });

    it('is null for a live account that happens to carry a deletion time', () => {
      // Writing a termination date onto an ACTIVE person would make them look departed in
      // every report that reads the column.
      const out = mapGoogleUserToDirectoryUser({
        ...base,
        suspended: true,
        deletionTime: '2026-07-31T00:00:00.000Z',
      });
      expect(out.terminationDate).toBeNull();
    });
  });

  it('survives a payload with nothing but an id and an email', () => {
    // Very common. Every optional field must come back null rather than undefined: the
    // apply step clears a field Google leaves blank, and undefined is not "blank".
    expect(mapGoogleUserToDirectoryUser(base)).toEqual({
      googleId: '1001',
      email: 'ada.lovelace@example.test',
      firstName: null,
      lastName: null,
      avatarUrl: null,
      title: null,
      country: null,
      employeeStatus: 'ACTIVE',
      terminationDate: null,
      managerEmail: null,
      deleted: false,
    });
  });

  it('produces an empty email and id rather than throwing when they are absent', () => {
    // Should not happen, but the sync filters on both — a throw here would abort the whole
    // run over one malformed row.
    const out = mapGoogleUserToDirectoryUser({});
    expect(out.email).toBe('');
    expect(out.googleId).toBe('');
  });
});
