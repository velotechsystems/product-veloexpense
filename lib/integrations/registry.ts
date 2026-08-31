/**
 * VX3-3 — the adapter registry. PURE; no `pg`.
 *
 * Static, so the module graph is visible to the compiler and to Turbopack. The
 * alternative — `await import(`@/lib/integrations/${slug}`)` — decouples more and
 * checks nothing: a typo in a slug becomes a runtime error on a tenant's posting
 * attempt rather than a build failure.
 *
 * ── Two guards at module load, and the second is the one that matters ────────
 *
 * 1. NO DUPLICATE SLUGS. Same shape as `EVENT_KEY_MAP`'s collision throw in
 *    `lib/notifications/catalog.ts` (VX2-7).
 * 2. A DECLARED CAPABILITY MUST HAVE ITS METHOD. An adapter that lists
 *    `POST_EXPENSE_REPORT` without `postExpenseReport` fails here, at import,
 *    rather than with a `TypeError: not a function` in the middle of posting
 *    somebody's approved report. This is the guard AC-5 wishes ExpenseOS had: it
 *    declares capabilities, validates the STRINGS at boot, and then never consults
 *    them — so "declared" and "implemented" were never connected at all.
 */
import {
  CAPABILITY_METHOD,
  isCapability,
  type AccountingAdapter,
  type Capability,
} from '@/lib/integrations/contract';
import { quickBooksAdapter } from '@/lib/integrations/quickbooks';
import { stubAdapter, stubOAuthAdapter } from '@/lib/integrations/stub';
import { veloLedgerAdapter } from '@/lib/integrations/veloledger';

/**
 * Every adapter this build contains, enabled or not.
 *
 * The SHAPE of each is validated at module load, below — a duplicate slug or a
 * declared-but-unimplemented capability is a startup failure, which is the whole
 * point of a static registry.
 *
 * Which of them a tenant may CONNECT is decided at call time by `enabled()`. That
 * split is deliberate and the first version got it wrong: reading `process.env`
 * here at module load meant a test could not set the flag, because ES imports are
 * hoisted and this file loads before any statement in the test body runs. NT-14
 * wrote the rule down for `appOrigin()` — "read at CALL time, not module load" —
 * and it applies to anything a test needs to vary.
 */
const ALL_ADAPTERS: AccountingAdapter[] = [
  veloLedgerAdapter,
  quickBooksAdapter,
  stubAdapter,
  stubOAuthAdapter,
];

/**
 * The shape checks. Exported so `test/integration-registry.test.ts` can assert
 * they FIRE, which a throw at module load cannot be tested for.
 */
export function assertAdapterShape(adapter: AccountingAdapter): void {
  for (const capability of adapter.capabilities) {
    if (!isCapability(capability)) {
      throw new Error(`adapter '${adapter.slug}' declares unknown capability '${capability}'`);
    }
    const method = CAPABILITY_METHOD[capability];
    if (typeof adapter[method] !== 'function') {
      throw new Error(
        `adapter '${adapter.slug}' declares ${capability} but implements no ${String(method)}() — ` +
          `a declared capability that is not there fails on a real report, at the worst moment`,
      );
    }
  }

  // VX3-8: the same argument, for the auth mode. An adapter that says OAUTH2 and
  // cannot mint an authorize URL, exchange a code or refresh a token would fail
  // halfway through a redirect the admin has already been sent on — with the
  // browser at the far end and nothing to come back to. Cheaper at import.
  if (adapter.auth === 'OAUTH2') {
    for (const method of ['authorizeUrl', 'exchangeCode', 'refreshTokens'] as const) {
      if (typeof adapter[method] !== 'function') {
        throw new Error(
          `adapter '${adapter.slug}' declares auth 'OAUTH2' but implements no ${method}() — ` +
            `an incomplete redirect flow breaks after the admin has already left the product`,
        );
      }
    }
  }
}

export function assertNoDuplicateSlugs(adapters: AccountingAdapter[]): void {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.slug)) {
      throw new Error(
        `two accounting adapters claim the slug '${adapter.slug}' — a tenant's ` +
          `installation names one adapter and this makes that ambiguous`,
      );
    }
    seen.add(adapter.slug);
  }
}

// At module load, over every adapter in the build. Neither check depends on the
// environment, so neither belongs in `enabled()`.
assertNoDuplicateSlugs(ALL_ADAPTERS);
for (const adapter of ALL_ADAPTERS) assertAdapterShape(adapter);

/**
 * The adapters a tenant may actually connect, read at CALL time.
 *
 * VX3-8 MOVED THIS DECISION INTO THE ADAPTERS. It used to read:
 *
 *     const stubOk = process.env.INTEGRATIONS_ENABLE_STUB === '1';
 *     return ALL_ADAPTERS.filter((a) => a.slug !== 'stub-ledger' || stubOk);
 *
 * — one slug named in a shared file, deciding another module's business. Exactly
 * the shape `npm run check:vendor` fails the build on; it only survived because
 * "stub-ledger" is not a vendor name. An adapter now answers for itself through
 * `available()`, and adding a third gated adapter touches nothing here.
 *
 * That is also what lets QuickBooks ship dormant: it reports unavailable while the
 * platform's client credentials are absent, so no tenant can see it, and it appears
 * the day those variables are set — with no migration and no deploy of new code.
 *
 * Default TRUE when an adapter does not implement it: an adapter with no
 * prerequisites is always connectable, and that keeps VeloLedger unchanged.
 */
function enabled(): AccountingAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.available?.() ?? true);
}

export function listAdapters(): AccountingAdapter[] {
  return enabled().sort((a, b) => a.name.localeCompare(b.name));
}

export function isKnownAdapter(slug: string): boolean {
  return enabled().some((a) => a.slug === slug);
}

/**
 * The adapter for a slug, or null.
 *
 * Null rather than a throw: a tenant can hold an installation of an adapter that
 * a later deploy removed, and the screen listing their integrations should say so
 * rather than 500. The POSTING path is where absence must be an error.
 */
export function adapterFor(slug: string): AccountingAdapter | null {
  return enabled().find((a) => a.slug === slug) ?? null;
}

/**
 * Adapters that can do a thing. THE function core is meant to use — it never asks
 * which vendor a tenant is on.
 */
export function adaptersWithCapability(capability: Capability): AccountingAdapter[] {
  return listAdapters().filter((a) => a.capabilities.includes(capability));
}

/** Whether an installed adapter can do a thing. */
export function supports(slug: string, capability: Capability): boolean {
  return adapterFor(slug)?.capabilities.includes(capability) ?? false;
}
