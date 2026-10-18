// w5-04 — ported from ExpenseOS `packages/integrations-google/src/mappers.ts` (1e682dd6).
// VeloExpense: `GoogleUser` is stated in ./types rather than imported from `googleapis` (see
// ./client.ts). The field semantics below — cost centre is the legal entity, the building is
// the business unit — are ExpenseOS's, and hold for any tenant whose Workspace is filled in
// the same way; a value that matches nothing in the tenant changes nothing (./apply.ts).
import type { DirectoryUser, GoogleUser } from './types';

interface Org {
  primary?: boolean | null;
  name?: string | null;
  title?: string | null;
  department?: string | null;
  costCenter?: string | null;
}
interface Address {
  primary?: boolean | null;
  countryCode?: string | null;
}
interface Location {
  type?: string | null;
  buildingId?: string | null;
}
interface Relation {
  type?: string | null;
  value?: string | null;
}
interface ExternalId {
  type?: string | null;
  value?: string | null;
}

/**
 * Pick the primary entry from a list, falling back to the first
 * element when no entry is flagged `primary: true`.
 */
function preferPrimary<T extends { primary?: boolean | null }>(
  list: T[] | undefined | null,
): T | undefined {
  if (!list || list.length === 0) return undefined;
  return list.find((x) => x.primary === true) ?? list[0];
}

/**
 * Translate the raw Directory API user payload into ExpenseOS's
 * normalized DirectoryUser shape. Everything that could plausibly be
 * absent from the payload is defensively coerced to null.
 */
export function mapGoogleUserToDirectoryUser(user: GoogleUser): DirectoryUser {
  const email = (user.primaryEmail ?? '').toLowerCase();

  const givenName = user.name?.givenName ?? null;
  const familyName = user.name?.familyName ?? null;

  const avatarUrl = user.thumbnailPhotoUrl ?? null;

  const orgs = (user.organizations ?? []) as Org[];
  const primaryOrg = preferPrimary(orgs);
  const department = primaryOrg?.department ?? null;
  /**
   * COST CENTER IS THE LEGAL ENTITY, and `organizations[].name` is the business unit.
   *
   * That is the opposite of the obvious reading, and it is what the data says. The HR roster
   * — the source of truth across every system — states one company per person under "Payroll
   * Company Name", and that value is written into Google's Cost Center. It is a LEGAL ENTITY:
   * where ExpenseOS already held one, it agreed with the payroll company for 347 of 354
   * people.
   *
   * Business unit is a different axis entirely — the REGIONAL unit — and the roster has no
   * column for it: EBlock Inc. alone spreads across Ontario, Quebec, BC, the Prairies,
   * Atlantic, Corporate and CA Digital. Reading Cost Center as the business unit therefore
   * offered a company name to a lookup table full of regions, matched nothing, and left the
   * roster's authority stranded one field away from where it belonged.
   */
  const entity = primaryOrg?.costCenter ?? null;
  const title = primaryOrg?.title ?? null;

  /**
   * BUSINESS UNIT COMES FROM THE BUILDING.
   *
   * ADP owns Google now and states no business unit — it has no such column. What it does
   * state is a work location, which lands in `locations[].buildingId`, and the regional unit
   * follows from it: everyone at Logistic Centre - Edmonton is EBlock Prairies, Halifax is
   * EBlock Atlantic, West GTA is EBlock Ontario. Those strings are ADP's own Location
   * Description — Google only relays them — so they are carried as `adp` external ids on the
   * business unit they roll up to, and the mapping is data rather than a table in here.
   *
   * Two buildings say nothing useful and are LEFT to resolve to nothing — "Remote", which
   * 368 people share and which names no region at all, and the head offices, where the seed
   * disagrees with itself. A miss changes nothing, so those people keep the unit they have.
   */
  const locations = (user.locations ?? []) as Location[];
  const businessUnit = locations.find((l) => l.buildingId)?.buildingId ?? null;

  const addresses = (user.addresses ?? []) as Address[];
  const primaryAddress = preferPrimary(addresses);
  const country = primaryAddress?.countryCode ?? null;

  const externalIds = (user.externalIds ?? []) as ExternalId[];
  const orgExternalId = externalIds.find((e) => e.type === 'organization');
  const employeeId = orgExternalId?.value ?? null;

  let employeeStatus: DirectoryUser['employeeStatus'] = 'ACTIVE';
  if (user.archived) employeeStatus = 'TERMINATED';
  else if (user.suspended) employeeStatus = 'DEACTIVATED';

  const terminationDate = user.archived && user.deletionTime ? new Date(user.deletionTime) : null;

  const relations = (user.relations ?? []) as Relation[];
  const managerRelation = relations.find((r) => r.type === 'manager');
  const managerEmail = managerRelation?.value?.toLowerCase() ?? null;

  return {
    email,
    firstName: givenName,
    lastName: familyName,
    avatarUrl,
    department,
    businessUnit,
    entity,
    title,
    country,
    /** Directory doesn't expose currency — leave null. App layer
     *  infers from country if needed. */
    homeCurrency: null,
    employeeId,
    employeeStatus,
    terminationDate,
    managerEmail,
  };
}
