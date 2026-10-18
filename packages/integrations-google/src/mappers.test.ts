// w5-04 — ported from ExpenseOS `packages/integrations-google/src/mappers.test.ts` (1e682dd6).
// VeloExpense: the addresses are `example.test` and the companies fictional (Northwind, Fabrikam).
import { describe, expect, it } from 'vitest';
import { mapGoogleUserToDirectoryUser } from './mappers';

/**
 * Google Directory payload → the normalized `DirectoryUser` this package writes.
 *
 * `applyDirectoryUserToDb` treats `employeeStatus`, `terminationDate` and `managerEmail`
 * as CANONICAL and writes them on every sync, so a mapping error here is not a cosmetic
 * problem — it is written straight over the org graph:
 *
 *   · a missed `managerEmail` breaks the approval chain walk, and an unlevelled or
 *     manager-less person is invisible to tiered routing;
 *   · a missed `archived` flag leaves a terminated employee ACTIVE, with live cards;
 *   · a wrong `primary` pick assigns somebody the wrong department, and therefore the
 *     wrong budget and the wrong approver.
 *
 * Every field is defensively coerced because the Directory payload is sparse in practice:
 * plenty of real accounts have no organizations array at all.
 */

const base = { primaryEmail: 'Ada.Lovelace@EXAMPLE.TEST' };

describe('mapGoogleUserToDirectoryUser', () => {
  it('lowercases the email, because it is the join key', () => {
    // The email is what matches a Google identity to a User row. A case difference here
    // creates a duplicate placeholder person on every sync.
    expect(mapGoogleUserToDirectoryUser(base).email).toBe('ada.lovelace@example.test');
  });

  it('maps names, avatar and the primary organization', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      thumbnailPhotoUrl: 'https://x/photo.jpg',
      organizations: [
        {
          primary: true,
          name: 'Northwind Ontario',
          title: 'Engineer',
          department: 'R&D',
          costCenter: 'Northwind Inc.',
        },
      ],
      addresses: [{ primary: true, countryCode: 'CA' }],
      locations: [{ type: 'desk', buildingId: 'Logistic Centre - Edmonton' }],
    } as never);
    expect(out).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'https://x/photo.jpg',
      title: 'Engineer',
      department: 'R&D',
      country: 'CA',
    });
    /**
     * The pairing that is easy to get backwards, so it is asserted as a pair.
     *
     * HR's payroll company lands in Cost Center and is a LEGAL ENTITY; `organizations[].name`
     * carries the REGIONAL unit. Reading them the other way round hands a company name to a
     * lookup table full of regions, which matches nothing and silently leaves the person on
     * whatever they had.
     */
    expect(out.entity).toBe('Northwind Inc.');
    /**
     * And the business unit is the BUILDING, not `organizations[].name`.
     *
     * ADP owns Google and states no business unit — it has no such column. It states a work
     * LOCATION, and the region follows from it. `applyDirectoryUserToDb` turns the building
     * into the unit it rolls up to; this only has to hand it over unchanged.
     */
    expect(out.businessUnit).toBe('Logistic Centre - Edmonton');
  });

  it('prefers the entry flagged primary, not the first one', () => {
    // Google returns organizations in no guaranteed order, and taking [0] assigns the
    // wrong department — which then drives the wrong budget and the wrong approver.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      organizations: [
        { primary: false, department: 'Sales', costCenter: 'Fabrikam', name: 'Fabrikam' },
        { primary: true, department: 'R&D', costCenter: 'Northwind Inc.', name: 'Northwind Ontario' },
      ],
      addresses: [
        { primary: false, countryCode: 'US' },
        { primary: true, countryCode: 'CA' },
      ],
    } as never);
    expect(out.department).toBe('R&D');
    expect(out.entity).toBe('Northwind Inc.');
    expect(out.country).toBe('CA');
  });

  it('falls back to the first entry when none is flagged primary', () => {
    // Common in real payloads. Guessing the first is better than dropping the department
    // entirely, which would blank it on a canonical write.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      organizations: [{ department: 'Ops' }, { department: 'Sales' }],
    } as never);
    expect(out.department).toBe('Ops');
  });

  it('reads the manager from the relations list, lowercased', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      relations: [
        { type: 'assistant', value: 'PA@example.test' },
        { type: 'manager', value: 'Grace.Hopper@Example.Test' },
      ],
    } as never);
    // Lowercased for the same reason as the primary email: it is resolved by lookup.
    expect(out.managerEmail).toBe('grace.hopper@example.test');
  });

  it('returns a null manager rather than picking a different relation type', () => {
    // An assistant is not a manager. Mistaking one would route approvals to the wrong
    // person while looking entirely plausible.
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      relations: [{ type: 'assistant', value: 'pa@example.test' }],
    } as never);
    expect(out.managerEmail).toBeNull();
  });

  it('reads the employee id only from the organization external id', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      externalIds: [
        { type: 'login_id', value: 'ada' },
        { type: 'organization', value: 'E-12345' },
      ],
    } as never);
    expect(out.employeeId).toBe('E-12345');
  });

  it('ignores an external id of another type', () => {
    const out = mapGoogleUserToDirectoryUser({
      ...base,
      externalIds: [{ type: 'custom', value: 'nope' }],
    } as never);
    expect(out.employeeId).toBeNull();
  });

  describe('employee status', () => {
    it('is ACTIVE by default', () => {
      expect(mapGoogleUserToDirectoryUser(base).employeeStatus).toBe('ACTIVE');
    });

    it('is TERMINATED for an archived account', () => {
      // The status that triggers the offboarding roll-up. Missing it leaves a departed
      // employee with live cards and open drafts.
      const out = mapGoogleUserToDirectoryUser({ ...base, archived: true } as never);
      expect(out.employeeStatus).toBe('TERMINATED');
    });

    it('is DEACTIVATED for a suspended account', () => {
      const out = mapGoogleUserToDirectoryUser({ ...base, suspended: true } as never);
      expect(out.employeeStatus).toBe('DEACTIVATED');
    });

    it('treats archived as stronger than suspended', () => {
      // Both flags can be set. Terminated is the more consequential of the two, so it has
      // to win rather than depending on evaluation order.
      const out = mapGoogleUserToDirectoryUser({
        ...base,
        archived: true,
        suspended: true,
      } as never);
      expect(out.employeeStatus).toBe('TERMINATED');
    });
  });

  describe('termination date', () => {
    it('is set only when the account is archived AND has a deletion time', () => {
      const out = mapGoogleUserToDirectoryUser({
        ...base,
        archived: true,
        deletionTime: '2026-07-31T00:00:00.000Z',
      } as never);
      expect(out.terminationDate?.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    });

    it('is null for an archived account with no deletion time', () => {
      const out = mapGoogleUserToDirectoryUser({ ...base, archived: true } as never);
      expect(out.terminationDate).toBeNull();
    });

    it('is null for an active account that happens to carry a deletion time', () => {
      // Writing a termination date onto an ACTIVE person would make them look departed in
      // every report that reads the column.
      const out = mapGoogleUserToDirectoryUser({
        ...base,
        deletionTime: '2026-07-31T00:00:00.000Z',
      } as never);
      expect(out.terminationDate).toBeNull();
    });
  });

  it('never invents a home currency', () => {
    // Directory does not expose one, and `applyDirectoryUserToDb` deliberately never
    // writes it. A guessed currency would silently restate somebody's reimbursements.
    expect(mapGoogleUserToDirectoryUser(base).homeCurrency).toBeNull();
  });

  it('survives a payload with nothing but an email', () => {
    // Very common. Every optional field must come back null rather than undefined, since
    // the apply step distinguishes "absent" from "empty".
    const out = mapGoogleUserToDirectoryUser(base);
    expect(out).toEqual({
      email: 'ada.lovelace@example.test',
      firstName: null,
      lastName: null,
      avatarUrl: null,
      department: null,
      businessUnit: null,
      entity: null,
      title: null,
      country: null,
      homeCurrency: null,
      employeeId: null,
      employeeStatus: 'ACTIVE',
      terminationDate: null,
      managerEmail: null,
    });
  });

  it('produces an empty email rather than throwing when one is absent', () => {
    // Should not happen, but the caller filters on email — a throw here would abort the
    // whole sync over one malformed row.
    expect(mapGoogleUserToDirectoryUser({} as never).email).toBe('');
  });
});
