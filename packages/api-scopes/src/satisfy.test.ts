import { describe, expect, it } from 'vitest';
import { denyReason, grantedResources, satisfies, unknownScopes } from './satisfy';
import { ALL_SCOPES, isScope, parseScope, SCOPE_RESOURCES } from './scopes';

const REPORT = 'expense_management.expense_report' as const;
const BUDGET = 'finance.budget' as const;

describe('the scope vocabulary', () => {
  it('offers a read-only variant of every resource and nothing else', () => {
    expect(ALL_SCOPES).toHaveLength(SCOPE_RESOURCES.length * 2);
    for (const r of SCOPE_RESOURCES) {
      expect(isScope(r)).toBe(true);
      expect(isScope(`${r}.readonly`)).toBe(true);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_SCOPES).size).toBe(ALL_SCOPES.length);
  });

  it('refuses a resource it does not know, however plausible', () => {
    // A typo must grant nothing AND be recognisable as a typo — never be guessed into
    // something adjacent.
    expect(parseScope('expense_management.expense_reprot')).toBeNull();
    expect(parseScope('expense_management.expense_report.readonlyy')).toBeNull();
    expect(parseScope('.readonly')).toBeNull();
    expect(parseScope('')).toBeNull();
  });
});

describe('denyReason', () => {
  it('denies everything when no scopes were granted', () => {
    // The ruled behaviour, and the safe direction: a key minted with nothing chosen has
    // been given nothing.
    expect(denyReason([], REPORT, 'read')).toEqual({ kind: 'no_scopes' });
    expect(denyReason([], REPORT, 'write')).toEqual({ kind: 'no_scopes' });
  });

  it('lets the base scope both read and write', () => {
    expect(denyReason([REPORT], REPORT, 'read')).toBeNull();
    expect(denyReason([REPORT], REPORT, 'write')).toBeNull();
  });

  it('lets a read-only scope read', () => {
    expect(denyReason([`${REPORT}.readonly`], REPORT, 'read')).toBeNull();
  });

  it('stops a read-only scope writing, and says so specifically', () => {
    // "can only read budgets" and "has no budget scope" send somebody to different
    // places, so they are different denials.
    expect(denyReason([`${REPORT}.readonly`], REPORT, 'write')).toEqual({
      kind: 'read_only',
      resource: REPORT,
    });
  });

  it('does not let one resource authorize another', () => {
    expect(denyReason([BUDGET], REPORT, 'read')).toEqual({
      kind: 'resource_not_granted',
      resource: REPORT,
    });
  });

  it('ignores scope strings it does not recognise', () => {
    // A stale scope left behind by a rename must authorize nothing rather than
    // accidentally matching by prefix.
    expect(denyReason(['expense_management.expense_reprot'], REPORT, 'read')).toEqual({
      kind: 'resource_not_granted',
      resource: REPORT,
    });
  });

  it('takes the more permissive grant when a key holds both forms', () => {
    expect(satisfies([`${REPORT}.readonly`, REPORT], REPORT, 'write')).toBe(true);
    expect(satisfies([REPORT, `${REPORT}.readonly`], REPORT, 'write')).toBe(true);
  });

  it('is not confused by a resource whose name prefixes another', () => {
    // `admin.expense_management.expense_category` contains `expense_management…` as a
    // substring. A substring match here would silently widen every key.
    const admin = 'admin.expense_management.expense_category' as const;
    expect(satisfies([admin], 'expense_management.expense_report', 'read')).toBe(false);
    expect(satisfies([admin], admin, 'write')).toBe(true);
  });
});

describe('grantedResources', () => {
  it('summarises a key for display, write outranking read', () => {
    // Sorted by resource name, so the list is stable between renders.
    expect(grantedResources([`${REPORT}.readonly`, REPORT, `${BUDGET}.readonly`])).toEqual([
      { resource: REPORT, access: 'write' },
      { resource: BUDGET, access: 'read' },
    ]);
  });

  it('drops unrecognised entries rather than displaying them', () => {
    expect(grantedResources(['nope.nope'])).toEqual([]);
  });
});

describe('unknownScopes', () => {
  it('names exactly what a mint request got wrong', () => {
    expect(unknownScopes([REPORT, 'bogus', `${BUDGET}.readonly`])).toEqual(['bogus']);
  });
});
