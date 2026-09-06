/**
 * VX5-8 — the billing vocabulary. PURE; no `pg`, no I/O.
 *
 * Separate from `service.ts` for the reason `lib/policy/rules.ts` is separate
 * from `lib/policy/service.ts`: the rules about what a status MEANS are worth
 * testing without a database, and a pure module is the only version of that which
 * stays honest — the moment it can query, a test can pass because of a row.
 */

/**
 * The three meters the plan names — "metering by seats/tenants/cards" — and John
 * chose all three on 6 Sep.
 *
 * A runtime array deriving the type, the house pattern (`SEVERITIES`,
 * `AUDIT_ACTIONS`): the values have to be iterable at runtime for the catalogue
 * screen and checkable at compile time everywhere else, and two hand-kept copies
 * of the same list is UD-9's defect.
 */
export const METERS = ['SEAT', 'TENANT', 'CARD'] as const;
export type Meter = (typeof METERS)[number];

/**
 * CARD IS DECLARED AND CANNOT BE SOURCED, and that is stated here as well as in
 * the migration's CHECK because a constraint refuses without explaining.
 *
 * The VCC module does not exist in VeloExpense — it is one of the ExpenseOS
 * modules never ported — so nothing in this product can count a card. Leaving the
 * meter out of the vocabulary would mean a migration and a type change the day VCC
 * lands; letting a plan use it would mean an invoice line that is always zero,
 * which is indistinguishable from a customer who owes nothing. So: expressible,
 * unattachable, and the day it becomes real this set shrinks by one entry.
 */
export const METERS_WITHOUT_A_SOURCE: ReadonlySet<Meter> = new Set<Meter>(['CARD']);

export function meterIsBillable(meter: Meter): boolean {
  return !METERS_WITHOUT_A_SOURCE.has(meter);
}

export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'LAPSED',
  'CANCELLED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * ── THE ONE RULE THIS FILE EXISTS FOR ───────────────────────────────────────
 *
 * John's decision, 6 Sep: a lapsed tenant is READ-ONLY, not locked out. They sign
 * in, they read, they export; they cannot submit, approve or post.
 *
 * That is the decent version and it is also the one that survives contact with
 * PIPEDA and GDPR, under which a customer keeps a right of access to their own
 * data — a company locked out of its own expense records has a support ticket at
 * best and a regulator's question at worst.
 *
 * PAST_DUE KEEPS FULL FUNCTION, deliberately, and it is the entry most likely to
 * be "corrected" by somebody later. A payment that failed on a Friday is not a
 * reason to stop a finance team working on Monday; the provider's own dunning is
 * what escalates, and it escalates to LAPSED. Making PAST_DUE read-only would mean
 * an expired card silently halts an approval queue, and the person who could fix
 * it is not the person it stops.
 *
 * A FUNCTION RATHER THAN A SET, because the caller should have to ask a question
 * rather than read a list — `canWrite(status)` at a call site says what it is
 * deciding, where `WRITABLE.has(status)` says only that somebody once grouped
 * these together.
 */
export function canWrite(status: SubscriptionStatus): boolean {
  switch (status) {
    case 'TRIALING':
    case 'ACTIVE':
    case 'PAST_DUE':
      return true;
    case 'LAPSED':
    case 'CANCELLED':
      return false;
  }
}

/**
 * NO TENANT IS NOT THE SAME AS A LAPSED TENANT.
 *
 * Every tenant created since 0037 gets a subscription inside `createOrganization`'s
 * transaction, so a missing row means one of two things: a tenant created BEFORE
 * this migration, or a bug. Neither should silently become read-only — the first
 * would take every existing customer offline on deploy, and the second would hide
 * itself as a billing state.
 *
 * So absence is writable, and it is a decision rather than a default. The write
 * gate ticket has to pass `null` here explicitly, which means somebody reads this
 * comment before making the other choice.
 */
export function canWriteWithoutSubscription(): boolean {
  return true;
}

/** Whether this status is one a tenant can hold more than momentarily. */
export function isLive(status: SubscriptionStatus): boolean {
  return status !== 'CANCELLED';
}
