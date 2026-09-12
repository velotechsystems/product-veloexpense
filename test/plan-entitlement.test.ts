/**
 * VX5-21 — the plan projection parser. Pure; no database.
 *
 * The parser's whole job is telling three states apart — absent, null, malformed
 * — so most of this file is about those rather than about happy paths.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPS,
  LIMITS_WITHOUT_AN_ENFORCER,
  UNGATED,
  capIsEnforced,
  flag,
  parsePlanEntitlement,
  planPermitsModule,
  withinCap,
  type Cap,
} from '@/lib/billing/plan-entitlement';

describe('the module ceiling', () => {
  it('is UNGATED when the platform did not send a modules key', () => {
    // The deploy-day case. Most tenants have no mirrored subscription at all, and
    // a parser that read absence as "no modules" would switch every one of them
    // off the moment this shipped.
    const plan = parsePlanEntitlement({ sso: true }, {});
    expect(plan.modules).toBeNull();
    expect(planPermitsModule(plan, 'accounting')).toBe(true);
    expect(planPermitsModule(plan, 'anything-at-all')).toBe(true);
  });

  it('grants NOTHING for an explicitly empty list, which is not the same as absent', () => {
    const plan = parsePlanEntitlement({ modules: [] }, {});
    expect(plan.modules).toEqual([]);
    expect(planPermitsModule(plan, 'accounting')).toBe(false);
  });

  it('grants exactly what is listed', () => {
    const plan = parsePlanEntitlement({ modules: ['accounting', 'analytics'] }, {});
    expect(planPermitsModule(plan, 'accounting')).toBe(true);
    expect(planPermitsModule(plan, 'analytics')).toBe(true);
    expect(planPermitsModule(plan, 'budgets')).toBe(false);
    expect(planPermitsModule(plan, 'compliance')).toBe(false);
  });

  it('treats a malformed modules value as ABSENT rather than as empty', () => {
    // The direction matters. Reading a broken blob as "no modules" would turn a
    // platform bug into an outage for the customer; reading it as "not stated"
    // leaves them where they were.
    for (const bad of ['accounting', 42, true, { accounting: true }]) {
      expect(parsePlanEntitlement({ modules: bad }, {}).modules).toBeNull();
    }
  });

  it('rejects the WHOLE list when one element is not a string', () => {
    // Dropping the bad element would produce a ceiling narrower than the one the
    // platform sent — a downgrade nobody ordered.
    const plan = parsePlanEntitlement({ modules: ['accounting', 7] }, {});
    expect(plan.modules).toBeNull();
  });
});

describe('caps — absent, null and malformed are three answers', () => {
  it('absent means unenforced', () => {
    const plan = parsePlanEntitlement({}, {});
    expect('maxUsers' in plan.caps).toBe(false);
    expect(withinCap(plan, 'maxUsers', 10_000)).toBe(true);
  });

  it('null means unlimited, and is PRESENT', () => {
    // VeloLedger's Enterprise row uses `entitiesCap: null`, so this is an
    // existing platform convention rather than something invented here.
    const plan = parsePlanEntitlement({}, { maxUsers: null });
    expect('maxUsers' in plan.caps).toBe(true);
    expect(plan.caps.maxUsers).toBeNull();
    expect(withinCap(plan, 'maxUsers', 10_000)).toBe(true);
  });

  it('a number is the cap, and the boundary is inclusive', () => {
    const plan = parsePlanEntitlement({}, { maxUsers: 25 });
    expect(withinCap(plan, 'maxUsers', 24)).toBe(true);
    expect(withinCap(plan, 'maxUsers', 25)).toBe(true); // 25 means 25 are allowed
    expect(withinCap(plan, 'maxUsers', 26)).toBe(false);
  });

  it('NEVER coerces a malformed cap — the failure mode is locking a tenant out', () => {
    // `Number(null)` is 0 and `Number("")` is 0. A cap that silently became 0
    // would refuse every invite in the tenant, and it would do it quietly.
    for (const bad of ['25', '', true, {}, [], 2.5, -1, Number.NaN]) {
      const plan = parsePlanEntitlement({}, { maxUsers: bad });
      expect('maxUsers' in plan.caps).toBe(false);
      expect(withinCap(plan, 'maxUsers', 10_000)).toBe(true);
    }
  });

  it('reads a cap ONLY from limits, never from features', () => {
    // VeloCRM puts maxUsers in `features`. This product states one placement and
    // reads one placement — tolerating both is how two sources of truth start.
    const plan = parsePlanEntitlement({ maxUsers: 5 }, {});
    expect('maxUsers' in plan.caps).toBe(false);
    expect(withinCap(plan, 'maxUsers', 500)).toBe(true);
  });

  it('ignores keys it does not know, rather than failing', () => {
    const plan = parsePlanEntitlement({}, { maxUsers: 25, storageGb: 100, whatever: 3 });
    expect(plan.caps.maxUsers).toBe(25);
    expect(Object.keys(plan.caps)).toEqual(['maxUsers']);
  });
});

describe('flags', () => {
  it('takes only real booleans', () => {
    const plan = parsePlanEntitlement({ sso: true, multiEntity: false, other: 'true' }, {});
    expect(plan.flags).toEqual({ sso: true, multiEntity: false });
  });

  it('defaults an unstated flag to permitted, matching the module rule', () => {
    const plan = parsePlanEntitlement({}, {});
    expect(flag(plan, 'sso')).toBe(true);
    expect(flag(plan, 'sso', false)).toBe(false);
  });

  it('does not leak `modules` into the flags', () => {
    const plan = parsePlanEntitlement({ modules: ['accounting'], sso: true }, {});
    expect(Object.keys(plan.flags)).toEqual(['sso']);
  });
});

describe('malformed blobs as a whole', () => {
  it('never throws, and degrades to UNGATED', () => {
    for (const bad of [null, undefined, 'nonsense', 42, [], true]) {
      const plan = parsePlanEntitlement(bad, bad);
      expect(plan.modules).toBeNull();
      expect(plan.flags).toEqual({});
      expect(plan.caps).toEqual({});
    }
  });

  it('UNGATED is what a tenant with no subscription gets', () => {
    expect(UNGATED.modules).toBeNull();
    expect(planPermitsModule(UNGATED, 'accounting')).toBe(true);
    expect(withinCap(UNGATED, 'maxUsers', 1e9)).toBe(true);
  });
});

describe('LIMITS_WITHOUT_AN_ENFORCER — the caps this build cannot police', () => {
  it('names only real caps', () => {
    for (const cap of LIMITS_WITHOUT_AN_ENFORCER) {
      expect(CAPS).toContain(cap);
    }
  });

  it('is not vacuous, and not everything', () => {
    // A set that is empty marks nothing; a set that is everything means no cap is
    // enforced and the projection is decoration. Same guard shape as
    // `test/billing-plans.test.ts` uses for METERS_WITHOUT_A_SOURCE.
    expect(LIMITS_WITHOUT_AN_ENFORCER.size).toBeGreaterThan(0);
    expect(LIMITS_WITHOUT_AN_ENFORCER.size).toBeLessThan(CAPS.length);
    expect(CAPS.some((c) => capIsEnforced(c))).toBe(true);
  });

  it('still PARSES an unenforceable cap, because a screen may show it', () => {
    const plan = parsePlanEntitlement({}, { aiCreditsPerSeat: 40 });
    expect(plan.caps.aiCreditsPerSeat).toBe(40);
    expect(capIsEnforced('aiCreditsPerSeat')).toBe(false);
  });

  /**
   * THE GUARD THAT MATTERS: an unenforceable cap must have no enforcement call
   * site anywhere in `lib/`.
   *
   * The failure this catches is somebody adding `withinCap(plan,
   * 'aiCreditsPerSeat', n)` against a counter that does not exist, producing a
   * ceiling that can never fire — the most expensive kind of limit, because the
   * customer believes it is there and so do we.
   *
   * When the counter IS built, this test fails and says so. That is the intended
   * lifecycle: the test is how the set gets emptied, not an obstacle to emptying
   * it.
   */
  it('has no enforcement call site in lib/ for any member', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        // The declaration itself is where these names are allowed to appear.
        if (full.endsWith('lib/billing/plan-entitlement.ts')) continue;
        const text = readFileSync(full, 'utf8');
        for (const cap of LIMITS_WITHOUT_AN_ENFORCER) {
          if (text.includes(cap)) offenders.push(`${full} mentions ${cap}`);
        }
      }
    };
    walk('lib');
    expect(offenders).toEqual([]);
  });
});

describe('the cap vocabulary is closed', () => {
  it('every CAP is either enforced or explicitly declared unenforceable', () => {
    // There is no third state. A cap nobody has decided about is a cap that will
    // be half-implemented.
    for (const cap of CAPS satisfies readonly Cap[]) {
      expect(typeof capIsEnforced(cap)).toBe('boolean');
    }
  });
});
