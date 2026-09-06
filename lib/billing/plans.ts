/**
 * VX5-19 — the billing vocabulary. PURE; no `pg`, no I/O, no network.
 *
 * Rewritten from VX5-8's version, which assumed this product decided what a
 * customer pays. It does not: the VeloTech platform owns billing across the whole
 * suite. What is left here is the part that is genuinely ours — deciding what each
 * status PERMITS inside VeloExpense — plus the mapping from the platform's
 * vocabulary to ours.
 *
 * The plan catalogue that used to live beside this is gone (migration 0039).
 */

/**
 * The meters VeloExpense can be billed on.
 *
 * Kept, because the platform's per-seat billing needs a seat count and
 * **VeloExpense is the only thing that can count VeloExpense seats.** VeloLedger
 * is flat-per-org, so the platform has never had to ask a product for a number
 * before; we are the first that has to push one up. Until VX5-20 wires that push,
 * these readings are our own record and nothing consumes them.
 */
export const METERS = ['SEAT', 'TENANT', 'CARD'] as const;
export type Meter = (typeof METERS)[number];

/**
 * CARD IS DECLARED AND CANNOT BE SOURCED.
 *
 * The VCC module does not exist in VeloExpense — it is one of the ExpenseOS
 * modules never ported — so nothing here can count a card. Leaving the meter out
 * of the vocabulary would mean a type change the day VCC lands; letting it be
 * counted would mean a reading that is always zero, which is indistinguishable
 * from a customer who owes nothing.
 */
export const METERS_WITHOUT_A_SOURCE: ReadonlySet<Meter> = new Set<Meter>(['CARD']);

export function meterIsBillable(meter: Meter): boolean {
  return !METERS_WITHOUT_A_SOURCE.has(meter);
}

/**
 * Our status vocabulary, widened in 0039 to hold everything the platform returns.
 *
 * SUSPENDED is new and is NOT a synonym for LAPSED, which is why it was not
 * folded into one. The platform uses it for an account stopped by an operator —
 * a decision somebody made — where LAPSED is what happens when a trial runs out
 * or dunning gives up. They permit the same thing today; they are different
 * facts, and a screen that says "suspended" when an operator suspended you is
 * worth more than one that says "lapsed" at somebody whose card is fine.
 */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'LAPSED',
  'CANCELLED',
  'SUSPENDED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * The platform's status strings → ours.
 *
 * EXHAUSTIVE OVER WHAT THE PLATFORM DOCUMENTS (`active | trialing | past_due |
 * canceled | suspended`) and lenient about the rest: an unrecognised status
 * returns null, and `mirrorEntitlement` treats that as "do not mirror" rather
 * than guessing. A platform that adds a sixth status should make this product
 * fall back to permitting, not silently map it onto the nearest refusal.
 *
 * Note `canceled` — one L, the platform's spelling, which is also Stripe's. Ours
 * is CANCELLED. Getting that wrong is a silent no-match, so it is written once,
 * here, rather than compared inline at a call site.
 */
const FROM_PLATFORM: Record<string, SubscriptionStatus> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  suspended: 'SUSPENDED',
};

export function statusFromPlatform(status: string | null | undefined): SubscriptionStatus | null {
  if (!status) return null;
  return FROM_PLATFORM[status.trim().toLowerCase()] ?? null;
}

/**
 * ── WHAT EACH STATUS PERMITS ───────────────────────────────────────────────
 *
 * John's decision, 6 Sep: a lapsed tenant is READ-ONLY, not locked out. They sign
 * in, they read, they export; they cannot submit, approve or post. That is the
 * decent version and the one that survives PIPEDA and GDPR, under which a
 * customer keeps a right of access to their own data.
 *
 * THIS IS NOW THE FALLBACK, not the primary answer. The platform's entitlement
 * carries its own `readOnly` boolean, and `lib/billing/gate.ts` prefers it —
 * because a customer who is read-only in VeloLedger and writable in VeloExpense
 * is a support call nobody can explain. This function answers when the mirror
 * predates that column, or when the platform sent a status and no verdict.
 *
 * PAST_DUE KEEPS FULL FUNCTION, deliberately, and it is the entry most likely to
 * be "corrected" later. A payment that failed on a Friday is not a reason to stop
 * a finance team working on Monday; the provider's dunning is what escalates, and
 * it escalates to LAPSED. Making PAST_DUE read-only would mean an expired card
 * silently halts an approval queue, and the person it stops is not the person who
 * can fix it.
 */
export function canWrite(status: SubscriptionStatus): boolean {
  switch (status) {
    case 'TRIALING':
    case 'ACTIVE':
    case 'PAST_DUE':
      return true;
    case 'LAPSED':
    case 'CANCELLED':
    case 'SUSPENDED':
      return false;
  }
}

/**
 * NO MIRROR IS NOT A LAPSE, and this is the single most consequential line in the
 * file on the day it ships.
 *
 * A tenant has no mirrored entitlement when: the platform integration is not
 * configured at all; the platform has never been asked; the platform answered
 * `not_found` because this tenant signed up through VeloExpense's own front door
 * and was never provisioned by the operator console; or the platform was
 * unreachable and nothing has ever been written.
 *
 * Every one of those is permitted. A billing integration that can take a working
 * product offline by being absent or down is not a billing integration — it is a
 * single point of failure with an invoice attached. VeloLedger makes the same
 * call with its `state: 'disabled'`, and every tenant in this database today is
 * in exactly this state.
 */
export function canWriteWithoutSubscription(): boolean {
  return true;
}

/** Whether this status is one a tenant can hold more than momentarily. */
export function isLive(status: SubscriptionStatus): boolean {
  return status !== 'CANCELLED';
}
