/**
 * VX3-3 — the adapter registry's guards. No database.
 *
 * These assert that the checks FIRE. A throw at module load cannot be tested for
 * directly, which is why `assertAdapterShape` and `assertNoDuplicateSlugs` are
 * exported rather than inlined into the loop — the alternative is a guard nobody
 * has ever seen work, which is the shape NT-5 recorded: "the test named a
 * behaviour it could not observe."
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AccountingAdapter } from '@/lib/integrations/contract';
import {
  assertAdapterShape,
  assertNoDuplicateSlugs,
  adapterFor,
  adaptersWithCapability,
  isKnownAdapter,
  listAdapters,
  supports,
} from '@/lib/integrations/registry';

function adapter(over: Partial<AccountingAdapter> = {}): AccountingAdapter {
  return {
    slug: 'fake',
    name: 'Fake',
    description: 'd',
    capabilities: [],
    configFields: [],
    async testConnection() {
      return { ok: true, detail: 'ok' };
    },
    ...over,
  };
}

const saved = process.env.INTEGRATIONS_ENABLE_STUB;
afterEach(() => {
  if (saved === undefined) delete process.env.INTEGRATIONS_ENABLE_STUB;
  else process.env.INTEGRATIONS_ENABLE_STUB = saved;
});

describe('assertAdapterShape', () => {
  it('accepts an adapter whose declarations match its methods', () => {
    expect(() =>
      assertAdapterShape(
        adapter({
          capabilities: ['POST_EXPENSE_REPORT'],
          async postExpenseReport() {
            return { externalId: 'x' };
          },
        }),
      ),
    ).not.toThrow();
  });

  it('REFUSES a declared capability with no method behind it', () => {
    // The guard AC-5 wishes ExpenseOS had: it declares capabilities, validates the
    // strings at boot, and never connects "declared" to "implemented" at all.
    expect(() => assertAdapterShape(adapter({ capabilities: ['POST_EXPENSE_REPORT'] }))).toThrow(
      /declares POST_EXPENSE_REPORT but implements no postExpenseReport/,
    );
  });

  it('refuses a capability that is not in the taxonomy', () => {
    expect(() =>
      assertAdapterShape(adapter({ capabilities: ['POST_INVOICE' as never] })),
    ).toThrow(/unknown capability/);
  });
});

describe('assertNoDuplicateSlugs', () => {
  it('refuses two adapters claiming one slug', () => {
    expect(() => assertNoDuplicateSlugs([adapter(), adapter()])).toThrow(/claim the slug 'fake'/);
  });

  it('accepts distinct slugs', () => {
    expect(() =>
      assertNoDuplicateSlugs([adapter(), adapter({ slug: 'other' })]),
    ).not.toThrow();
  });
});

describe('availability is read at CALL time', () => {
  it('hides the stub when the flag is unset, and shows it when set', () => {
    // The bug this pins: the first version read process.env at module load, so a
    // test could not vary it — imports are hoisted and the registry loaded first.
    delete process.env.INTEGRATIONS_ENABLE_STUB;
    expect(listAdapters().map((a) => a.slug)).not.toContain('stub-ledger');
    expect(isKnownAdapter('stub-ledger')).toBe(false);
    expect(adapterFor('stub-ledger')).toBeNull();

    process.env.INTEGRATIONS_ENABLE_STUB = '1';
    expect(listAdapters().map((a) => a.slug)).toContain('stub-ledger');
    expect(supports('stub-ledger', 'POST_EXPENSE_REPORT')).toBe(true);
    expect(adaptersWithCapability('PULL_CHART_OF_ACCOUNTS').map((a) => a.slug)).toContain(
      'stub-ledger',
    );
  });

  it('an unknown slug is null rather than a throw', () => {
    // A tenant can hold an installation of an adapter a later deploy removed; the
    // screen should say so rather than 500.
    expect(adapterFor('netsuite')).toBeNull();
    expect(supports('netsuite', 'POST_EXPENSE_REPORT')).toBe(false);
  });
});
