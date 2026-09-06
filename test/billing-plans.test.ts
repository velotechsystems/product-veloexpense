/**
 * VX5-8 — the billing vocabulary and the one rule that decides what a lapsed
 * customer can do. No database: these are the claims that must hold regardless of
 * what any row says.
 */
import { describe, it, expect } from 'vitest';
import {
  METERS,
  METERS_WITHOUT_A_SOURCE,
  SUBSCRIPTION_STATUSES,
  canWrite,
  canWriteWithoutSubscription,
  isLive,
  meterIsBillable,
  statusFromPlatform,
  type Meter,
  type SubscriptionStatus,
} from '@/lib/billing/plans';

describe('the meter vocabulary', () => {
  it('is the three the plan names', () => {
    expect([...METERS]).toEqual(['SEAT', 'TENANT', 'CARD']);
  });

  it('marks CARD as having no source, and the other two as billable', () => {
    expect(meterIsBillable('SEAT')).toBe(true);
    expect(meterIsBillable('TENANT')).toBe(true);
    // Not an oversight and not "unsupported": the VCC module does not exist here,
    // so nothing can count a card. The migration's CHECK enforces the same thing
    // in the database; this is the half a reader can find.
    expect(meterIsBillable('CARD')).toBe(false);
  });

  it('the unbillable set is a subset of the vocabulary', () => {
    // Guards the shape rather than the contents: a typo'd member of
    // METERS_WITHOUT_A_SOURCE would otherwise sit there marking nothing.
    for (const m of METERS_WITHOUT_A_SOURCE) {
      expect(METERS).toContain(m);
    }
  });
});

describe('what a subscription status permits', () => {
  it('answers for every status in the vocabulary — no member goes unconsidered', () => {
    // The assertion that makes `canWrite`'s switch honest. Adding a status to
    // SUBSCRIPTION_STATUSES without answering for it fails HERE at runtime and,
    // because the switch is exhaustive over the union, at compile time too.
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(typeof canWrite(status)).toBe('boolean');
    }
  });

  it('TRIALING and ACTIVE write', () => {
    expect(canWrite('TRIALING')).toBe(true);
    expect(canWrite('ACTIVE')).toBe(true);
  });

  it('LAPSED and CANCELLED do not — read-only, not locked out', () => {
    // John's decision, 6 Sep. The tenant still signs in and still reads; the
    // refusal is on writes only. That distinction lives in the write gate, but
    // this is the predicate it will consult.
    expect(canWrite('LAPSED')).toBe(false);
    expect(canWrite('CANCELLED')).toBe(false);
  });

  it('PAST_DUE STILL WRITES, and that is deliberate', () => {
    // The entry most likely to be "corrected" by a future reader, so it gets its
    // own test with the reason in it: a failed payment on a Friday must not halt
    // an approval queue on Monday, and the person it would stop is not the person
    // who can fix the card. The provider's dunning escalates to LAPSED, which is
    // where function actually stops.
    expect(canWrite('PAST_DUE')).toBe(true);
  });

  it('no subscription at all is writable — absence is not lapse', () => {
    // Every tenant created before migration 0037 has no row. Were this false, the
    // deploy that ships the write gate would take every existing customer offline.
    expect(canWriteWithoutSubscription()).toBe(true);
  });

  it('every status except CANCELLED is live — SUSPENDED included', () => {
    // SUSPENDED is live on purpose: an operator stopped the account, and it can
    // be started again. CANCELLED is the customer having left, which is terminal
    // in the platform's vocabulary and in Stripe's.
    const live = SUBSCRIPTION_STATUSES.filter(isLive);
    expect(live).toEqual(['TRIALING', 'ACTIVE', 'PAST_DUE', 'LAPSED', 'SUSPENDED']);
  });
});

describe('the types are exhaustive over the runtime arrays', () => {
  it('a Meter is exactly a member of METERS', () => {
    // Compile-time, not a runtime assertion: if the type and the array drift, this
    // file stops compiling. `test/audit-canonical.test.ts` learned the hard way
    // that asserting membership of a template-literal TYPE is a test of nothing —
    // the check has to happen in the type system.
    const all: Meter[] = [...METERS];
    const statuses: SubscriptionStatus[] = [...SUBSCRIPTION_STATUSES];
    expect(all).toHaveLength(METERS.length);
    expect(statuses).toHaveLength(SUBSCRIPTION_STATUSES.length);
  });
});

describe('the platform’s vocabulary maps onto ours', () => {
  it('covers every status the platform documents', () => {
    // active | trialing | past_due | canceled | suspended — from the platform's
    // own entitlement projection. A gap here is silent: an unmapped status
    // returns null and the tenant keeps writing, which is the right failure but
    // still a failure.
    expect(statusFromPlatform('active')).toBe('ACTIVE');
    expect(statusFromPlatform('trialing')).toBe('TRIALING');
    expect(statusFromPlatform('past_due')).toBe('PAST_DUE');
    expect(statusFromPlatform('canceled')).toBe('CANCELLED');
    expect(statusFromPlatform('suspended')).toBe('SUSPENDED');
  });

  it('accepts BOTH spellings of cancelled, which is the trap', () => {
    // The platform and Stripe write one L; this codebase writes two. A silent
    // no-match would leave a departed customer able to submit and approve.
    expect(statusFromPlatform('canceled')).toBe('CANCELLED');
    expect(statusFromPlatform('cancelled')).toBe('CANCELLED');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(statusFromPlatform('  ACTIVE ')).toBe('ACTIVE');
  });

  it('returns null for anything else rather than guessing', () => {
    // A platform that adds a sixth status must make this product fall back to
    // permitting, not map it onto the nearest refusal.
    expect(statusFromPlatform('dormant')).toBeNull();
    expect(statusFromPlatform(null)).toBeNull();
    expect(statusFromPlatform('')).toBeNull();
  });

  it('every mapped value is a member of our vocabulary', () => {
    for (const p of ['active', 'trialing', 'past_due', 'canceled', 'suspended']) {
      const mapped = statusFromPlatform(p);
      expect(mapped).not.toBeNull();
      expect(SUBSCRIPTION_STATUSES).toContain(mapped!);
    }
  });
});
