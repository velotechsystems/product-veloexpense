/**
 * VX5-21 — the plan's own entitlement projection, as a VOCABULARY. PURE; no
 * `pg`, no I/O, no network.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `lib/billing/entitlements.ts` has received `features` and `limits` from the
 * platform on every call since VX5-19, typed as `Record<string, unknown>`, and
 * **nothing has ever read either**. A grep across `lib/` and `app/` returned zero
 * consumers. The only gate that fires is `readOnly`/`canWrite`, which is binary:
 * a tenant may write, or it may not. Every tier is therefore the same product
 * from the inside, and the three prices on the marketing site were a claim no
 * code could keep.
 *
 * This is the reader. It turns two untyped JSON blobs into a value with a
 * vocabulary, so that `lib/modules/service.ts` and the cap call sites have
 * something to ask rather than something to parse.
 *
 * ── THE CONTRACT, AND WHY IT IS STATED HERE RATHER THAN INFERRED ───────────
 *
 * The two products already in `seed-plans.ts` disagree with each other. VeloCRM
 * puts `maxUsers` in `features`; VeloLedger puts `includedSeats` and
 * `entitiesCap` in `limits`. VeloCRM says `aiCreditsPerSeat`; VeloLedger says
 * `aiCreditsIncluded`. There is no house rule to follow, so this file states one
 * rather than copying whichever product was read last:
 *
 *   **`features` holds what a tier may DO — booleans, plus the module list.**
 *   **`limits` holds how MUCH — numbers.**
 *
 * `maxUsers` is therefore in `limits` here, which is VeloLedger's placement and
 * not VeloCRM's. That is a deliberate deviation and the reason is that "25" is
 * not a feature.
 *
 * NO TOLERANCE FOR THE OTHER PLACEMENT. This reader looks in exactly one place
 * for each key. Accepting a cap from either blob is the shape GAP-AUDIT AC-4
 * warns about — *"Port the encryption; do not port the tolerance"* — where a
 * lenient reader plus a second writer means two sources of truth and no way to
 * tell which one a value came from. A key in the wrong blob is absent, and absent
 * is a defined state with defined behaviour (below).
 *
 * ── ABSENT, NULL, AND MALFORMED ARE THREE DIFFERENT ANSWERS ────────────────
 *
 * This is the whole design, and getting it wrong is how a billing projection
 * takes a customer offline:
 *
 *   · ABSENT   — the key is not in the blob. The platform did not say. For a cap
 *                this means unenforced; for the module list it means UNGATED.
 *   · NULL     — the key is present and null. The platform said "no limit".
 *                VeloLedger's Enterprise row uses exactly this (`entitiesCap:
 *                null`), so it is an existing convention, not an invention.
 *   · MALFORMED — present but not the expected type. Treated as ABSENT, never
 *                coerced. `Number("abc")` is `NaN` and `Number(null)` is `0`, and
 *                a cap that silently became 0 would refuse every invite in the
 *                tenant. A blob we cannot parse is a blob we did not receive.
 *
 * ── FAIL-OPEN ON ABSENCE, FAIL-CLOSED ON PRESENCE ──────────────────────────
 *
 * `modules` absent means every module this build can serve is permitted.
 * `modules: []` means none are. `modules: ['accounting']` means that one.
 *
 * **This looks like it contradicts `module_entitlement`, which says ABSENCE MEANS
 * OFF, and it does not.** They answer different questions. That table records
 * what a TENANT was given, and a missing row there means nobody gave it to them —
 * fail-closed is right, because the alternative is "a tenant is using something
 * nobody sold them" (migration 0021's words). This field records what a PLAN
 * includes, and a missing key here means the platform did not answer — the same
 * state `canWriteWithoutSubscription` handles, where answering "no" would take
 * every tenant offline on deploy. Most tenants today have no mirrored
 * subscription at all; a reader that disabled their modules on the strength of a
 * blob that was never sent would be a far worse bug than the one this file fixes.
 *
 * The distinction in one line: **we fail closed on what a tenant was granted, and
 * open on what we were told.**
 */

/**
 * The numeric caps this product understands.
 *
 * A closed union rather than free strings, so a typo in a call site does not
 * compile and `LIMITS_WITHOUT_AN_ENFORCER` below cannot name something that does
 * not exist.
 */
export const CAPS = [
  /** Seats — people who can sign in. Enforced where an account is created. */
  'maxUsers',
  /** Contractual floor. Informational: nothing refuses a tenant for being small. */
  'minUsers',
  /** Expenses a tenant may create in a rolling year. */
  'expensesPerYear',
  /** Receipt-AI actions per seat per month. NO COUNTER EXISTS — see below. */
  'receiptAiPerSeat',
  /** Metered AI credits per seat per month. NO METER EXISTS — see below. */
  'aiCreditsPerSeat',
] as const;
export type Cap = (typeof CAPS)[number];

/**
 * CAPS THIS BUILD CANNOT ENFORCE, AND THE PRECEDENT FOR SAYING SO OUT LOUD.
 *
 * `lib/billing/plans.ts` declares `METERS_WITHOUT_A_SOURCE` for exactly this
 * situation and its comment is the argument: a `CARD` counter returning 0 was
 * written first and is *"exactly wrong: a meter reading of zero is
 * indistinguishable from a customer who genuinely owes nothing, so the failure
 * would be invisible on every invoice and in every test. Absence, by contrast, is
 * loud."*
 *
 * The same holds here from the other side. There is no counter for a receipt-AI
 * action and no meter for an AI credit — `METERS` is `['SEAT','TENANT','CARD']`
 * and `lib/billing/metering.ts` has counters for two of them. A plan can carry
 * `aiCreditsPerSeat: 40` today and this product cannot tell you whether the
 * tenant has used one. Pretending otherwise would mean a ceiling that silently
 * never fires, which is the most expensive kind of limit: the customer believes
 * it is there and so do we.
 *
 * So the cap PARSES — the value is real and belongs in the projection for a
 * screen to display — and `capIsEnforced` says no. `test/plan-entitlement.test.ts`
 * asserts that every member of this set has no enforcement call site, so the day
 * somebody builds the counter the test fails and tells them to remove the member.
 */
export const LIMITS_WITHOUT_AN_ENFORCER: ReadonlySet<Cap> = new Set<Cap>([
  'receiptAiPerSeat',
  'aiCreditsPerSeat',
]);

/**
 * Caps that are information, not limits: nothing refuses a tenant for being
 * under them. `minUsers` is a contractual floor a screen may show. Separate from
 * `LIMITS_WITHOUT_AN_ENFORCER` because the reason differs — that set is "should
 * refuse, cannot yet count"; this one is "never refuses, by design".
 *
 * `capIsEnforced('minUsers')` used to answer `true`, alongside `maxUsers` and
 * `expensesPerYear`, none of which anything enforced. A function whose job is to
 * say whether a limit is real said yes three times about limits nothing kept.
 */
export const INFORMATIONAL_CAPS: ReadonlySet<Cap> = new Set<Cap>(['minUsers']);

/**
 * Does a refusal exist for this cap? True only for a cap with an enforcement
 * call site in `lib/` — `test/plan-entitlement.test.ts` checks both directions.
 */
export function capIsEnforced(cap: Cap): boolean {
  return !LIMITS_WITHOUT_AN_ENFORCER.has(cap) && !INFORMATIONAL_CAPS.has(cap);
}

/**
 * A parsed plan entitlement.
 *
 * `caps` is a Partial on purpose: a key that is PRESENT with value `null` means
 * unlimited, and a key that is ABSENT means the platform did not say. Collapsing
 * those two into one would lose the only distinction that matters here.
 */
export interface PlanEntitlement {
  /**
   * Module codes this tier includes, or `null` when the platform did not say.
   * `null` is ungated; `[]` is nothing. See the header.
   */
  modules: readonly string[] | null;
  /** Boolean feature flags, by key. Absent keys are simply not present. */
  flags: Readonly<Record<string, boolean>>;
  /** Numeric caps. Present-and-null = unlimited; absent = not stated. */
  caps: Readonly<Partial<Record<Cap, number | null>>>;
}

/** What a tenant with no mirrored subscription gets: everything, ungated. */
export const UNGATED: PlanEntitlement = Object.freeze({
  modules: null,
  flags: Object.freeze({}),
  caps: Object.freeze({}),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse the platform's two blobs into a projection.
 *
 * Never throws. A caller handed malformed JSON from a third party should get a
 * conservative value, not an exception in the middle of a page render — and
 * "conservative" here means UNGATED, for the reason the header gives at length.
 */
export function parsePlanEntitlement(
  features: unknown,
  limits: unknown,
): PlanEntitlement {
  const f = asRecord(features);
  const l = asRecord(limits);

  // ── modules ───────────────────────────────────────────────────────────────
  let modules: readonly string[] | null = null;
  if (f && 'modules' in f) {
    const raw = f.modules;
    if (Array.isArray(raw)) {
      // Every element must be a string. One bad element makes the whole list
      // untrustworthy: silently dropping it would produce a ceiling narrower than
      // the one the platform sent, which is a downgrade nobody ordered.
      modules = raw.every((m) => typeof m === 'string')
        ? Object.freeze([...(raw as string[])])
        : null;
    }
    // A `modules` key that is not an array is malformed, and malformed is absent.
  }

  // ── flags ─────────────────────────────────────────────────────────────────
  const flags: Record<string, boolean> = {};
  if (f) {
    for (const [key, value] of Object.entries(f)) {
      if (key === 'modules') continue;
      // Only real booleans. A truthy string is not a flag, and coercing one is
      // how `"false"` becomes `true`.
      if (typeof value === 'boolean') flags[key] = value;
    }
  }

  // ── caps ──────────────────────────────────────────────────────────────────
  const caps: Partial<Record<Cap, number | null>> = {};
  if (l) {
    for (const cap of CAPS) {
      if (!(cap in l)) continue;
      const value = l[cap];
      if (value === null) {
        caps[cap] = null; // explicitly unlimited
      } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        caps[cap] = value;
      }
      // Anything else is malformed → absent. Deliberately NOT coerced.
    }
  }

  return {
    modules,
    flags: Object.freeze(flags),
    caps: Object.freeze(caps),
  };
}

/**
 * Does this plan permit the module?
 *
 * Separated as a pure function so the rule — the one piece with a real invariant
 * — is testable without a database, the same shape as `isStaleReading` in
 * VeloCRM's seats service.
 */
export function planPermitsModule(plan: PlanEntitlement, code: string): boolean {
  if (plan.modules === null) return true; // not stated → ungated
  return plan.modules.includes(code);
}

/**
 * Is `count` within the cap, given the plan?
 *
 * `true` when the cap is absent (not stated), when it is null (unlimited), or
 * when the count is at or below it. The comparison is `<=` because a cap of 25
 * means twenty-five are allowed, not twenty-four.
 */
export function withinCap(plan: PlanEntitlement, cap: Cap, count: number): boolean {
  if (!(cap in plan.caps)) return true;
  const limit = plan.caps[cap];
  if (limit === null || limit === undefined) return true;
  return count <= limit;
}

/** A flag, defaulting to `fallback` when the platform did not send it. */
export function flag(plan: PlanEntitlement, key: string, fallback = true): boolean {
  return key in plan.flags ? plan.flags[key] : fallback;
}
