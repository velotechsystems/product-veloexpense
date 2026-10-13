import { PREDICATE_FIELDS } from '@expenseos/approvals';
import { describe, expect, it } from 'vitest';
import {
  APPROVER_FILTER_FIELDS,
  APPROVER_KIND_LABEL,
  type EditorOptions,
  FIELD_LABEL,
  fieldFacets,
  fieldsForSubject,
  isNumericField,
  labelForValue,
  OP_LABEL,
  opsForField,
} from './options';

/**
 * What the condition builder is allowed to offer, and what it calls things.
 *
 * The rule that carries the weight: **a field the engine never populates for a subject must
 * not be selectable.** A condition on one of those does not error and does not warn — it
 * silently never matches, so the branch it guards is dead and the workflow routes as though
 * the condition were not there. That is indistinguishable from a routing bug, and it is why
 * the hidden sets are asserted per subject rather than trusted.
 *
 * The second is that operators follow the field's TYPE. Offering `≥` on a department would
 * build a predicate comparing two uuids, which the engine evaluates to false forever.
 */

const OPTIONS: EditorOptions = {
  jobLevels: [{ id: 'jl-1', code: 'L5', label: { en: 'Senior' }, sortOrder: 5 }],
  departments: [{ id: 'd-1', label: { en: 'Finance' } }],
  legalEntities: [{ id: 'le-1', label: { en: 'EBlock Inc.' } }],
  businessUnits: [{ id: 'bu-1', label: { en: 'Wholesale' } }],
  currencies: [{ id: 'cur-1', code: 'CAD', symbol: '$' }],
  vendors: [{ id: 'v-1', name: 'Acme' }],
  workflows: [{ key: 'wf-1', name: 'Standard' }],
  roles: [{ id: 'r-1', label: { en: 'Approver' } }],
  categories: [{ id: 'c-1', label: { en: 'Meals' } }],
  users: [{ id: 'u-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' }],
};

describe('fieldsForSubject', () => {
  it('hides the fields the engine leaves null on a card request', () => {
    /**
     * A card request is a request for a LIMIT: it has no line items, no category set, and
     * has not landed on a budget. Offering "line-item count" there builds a condition that
     * can never be true.
     */
    const fields = fieldsForSubject('VIRTUAL_CARD_REQUEST');
    for (const hidden of [
      'categoryIds',
      'requiresApproval',
      'hasPolicyViolation',
      'lineCount',
      'maxLineAmount',
      'overPerDiem',
      'perDiemOverageMinor',
      'overBudget',
      'budgetOverageMinor',
    ]) {
      expect(fields, hidden).not.toContain(hidden);
    }
  });

  it('keeps the fields a card request DOES have', () => {
    const fields = fieldsForSubject('VIRTUAL_CARD_REQUEST');
    expect(fields).toContain('amount');
    expect(fields).toContain('interval');
    expect(fields).toContain('vendorId');
  });

  it('hides interval and vendor on an expense report', () => {
    /** Both are card-request facts: a report has no spend interval and no single vendor. */
    const fields = fieldsForSubject('EXPENSE_REPORT');
    expect(fields).not.toContain('interval');
    expect(fields).not.toContain('vendorId');
    expect(fields).toContain('lineCount');
  });

  it('offers, on a report, the facts the engine now fills (VeloExpense, w4-04)', () => {
    /** VeloExpense: w4-01 hid these while the engine stated them rather than computed them;
     *  since w4-04 it computes all three, so a condition on them can match. */
    const fields = fieldsForSubject('EXPENSE_REPORT');
    for (const f of ['requiresApproval', 'overBudget', 'budgetOverageMinor'] as const) {
      expect(fields, f).toContain(f);
    }
  });

  it('offers everything for a subject with no hidden set', () => {
    /** A subject added to the engine but not yet to the hidden map gets the full list,
     *  which is visible and correctable — unlike silently hiding fields it does have. */
    expect(fieldsForSubject('TRAVEL_REQUEST')).toHaveLength(PREDICATE_FIELDS.length);
    expect(fieldsForSubject(undefined)).toHaveLength(PREDICATE_FIELDS.length);
  });
});

describe('operators per field type', () => {
  it('lets a numeric field compare', () => {
    for (const f of [
      'amount',
      'maxLineAmount',
      'lineCount',
      'perDiemOverageMinor',
      'budgetOverageMinor',
    ] as const) {
      expect(isNumericField(f), f).toBe(true);
      expect(opsForField(f), f).toEqual(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']);
    }
  });

  it('restricts an id or enum field to equality and set membership', () => {
    /** `departmentId >= x` compares two uuids — a predicate that is false forever, built
     *  by an admin who thought they were narrowing a range. */
    for (const f of [
      'departmentId',
      'currency',
      'interval',
      'employeeStatus',
      'categoryIds',
    ] as const) {
      expect(isNumericField(f), f).toBe(false);
      expect(opsForField(f), f).toEqual(['eq', 'neq', 'in', 'nin']);
    }
  });
});

describe('the facets a field offers', () => {
  it('resolves ids to localized labels', () => {
    expect(fieldFacets('departmentId', OPTIONS, 'en')).toEqual([
      { value: 'd-1', label: 'Finance' },
    ]);
    expect(fieldFacets('legalEntityId', OPTIONS, 'en')).toEqual([
      { value: 'le-1', label: 'EBlock Inc.' },
    ]);
    expect(fieldFacets('businessUnitId', OPTIONS, 'en')).toEqual([
      { value: 'bu-1', label: 'Wholesale' },
    ]);
    expect(fieldFacets('categoryIds', OPTIONS, 'en')).toEqual([{ value: 'c-1', label: 'Meals' }]);
  });

  it('prefixes a job level with its code, which is what orders them', () => {
    /** Levels are compared by rank, and the code is the rank an admin recognises — two
     *  levels can share a display name across entities. */
    expect(fieldFacets('jobLevelId', OPTIONS, 'en')).toEqual([
      { value: 'jl-1', label: 'L5 — Senior' },
    ]);
  });

  it('labels a currency by its code, not its symbol', () => {
    /** '$' is ambiguous across CAD and USD, and this list is how a threshold picks one. */
    expect(fieldFacets('currency', OPTIONS, 'en')).toEqual([{ value: 'cur-1', label: 'CAD' }]);
  });

  it('names vendors', () => {
    expect(fieldFacets('vendorId', OPTIONS, 'en')).toEqual([{ value: 'v-1', label: 'Acme' }]);
  });

  it('offers the spend intervals the card model actually has', () => {
    expect(fieldFacets('interval', OPTIONS, 'en')?.map((f) => f.value)).toEqual([
      'ONE_TIME',
      'MONTHLY',
      'QUARTERLY',
      'ANNUAL',
      'TOTAL',
    ]);
  });

  it('offers the employee statuses', () => {
    expect(fieldFacets('employeeStatus', OPTIONS, 'en')?.map((f) => f.value)).toEqual([
      'ACTIVE',
      'ON_LEAVE',
      'DEACTIVATED',
      // VeloExpense: no TERMINATED status (0004).
    ]);
  });

  it('offers booleans as the STRINGS the engine stores', () => {
    /**
     * The engine emits boolean facts as 'true' / 'false' strings, so a facet carrying a
     * real boolean would build a predicate that never equals the fact. Pinned for all four.
     */
    for (const f of [
      'requiresApproval',
      'hasPolicyViolation',
      'overPerDiem',
      'overBudget',
    ] as const) {
      expect(fieldFacets(f, OPTIONS, 'en'), f).toEqual([
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ]);
    }
  });

  it('offers nothing for a free-typed or unsourced field', () => {
    /** Null means "type a value", which is right for a number and for an id with no option
     *  source yet — an empty ARRAY would render a picker with nothing in it. */
    for (const f of ['amount', 'lineCount', 'glAccountId', 'userId'] as const) {
      expect(fieldFacets(f, OPTIONS, 'en'), f).toBeNull();
    }
  });

  it('returns an empty list, not a crash, before the options load', () => {
    /** The editor renders while its options query is in flight. */
    for (const f of [
      'departmentId',
      'currency',
      'vendorId',
      'jobLevelId',
      'categoryIds',
    ] as const) {
      expect(fieldFacets(f, undefined, 'en'), f).toEqual([]);
    }
  });

  it('falls back to the id when a label has no entry for the locale', () => {
    /** Better a uuid than an empty row: the admin can at least tell two apart. */
    const sparse: EditorOptions = { ...OPTIONS, departments: [{ id: 'd-2', label: {} }] };
    expect(fieldFacets('departmentId', sparse, 'en')).toEqual([{ value: 'd-2', label: 'd-2' }]);
  });
});

describe('labelForValue', () => {
  it('resolves a stored id to what the admin picked', () => {
    expect(labelForValue('departmentId', 'd-1', OPTIONS, 'en')).toBe('Finance');
  });

  it('shows the raw value when it resolves to nothing', () => {
    /** A department deleted after the condition was written. Showing the id says "this no
     *  longer exists" — showing blank says the condition has no value. */
    expect(labelForValue('departmentId', 'd-gone', OPTIONS, 'en')).toBe('d-gone');
  });

  it('shows a free-typed value as itself', () => {
    expect(labelForValue('amount', '5000', OPTIONS, 'en')).toBe('5000');
  });
});

describe('the label tables', () => {
  it('names every predicate field', () => {
    /** A field added to the engine and not here renders as `undefined` in the builder. */
    for (const f of PREDICATE_FIELDS) {
      expect(FIELD_LABEL[f], f).toBeTruthy();
    }
  });

  it('names every operator the builder can produce', () => {
    for (const op of [...opsForField('amount'), ...opsForField('departmentId')]) {
      expect(OP_LABEL[op], op).toBeTruthy();
    }
  });

  it('names all three approver kinds', () => {
    expect(Object.keys(APPROVER_KIND_LABEL).sort()).toEqual(['filter', 'manager', 'managerChain']);
  });

  it('offers approver filters only on the approver’s own attributes', () => {
    /**
     * A `filter` approver is matched against the CANDIDATE, so an amount or a category —
     * facts about the subject — would be meaningless here. Job-level ordering is a
     * dedicated min-level control rather than a filter, so it appears as an identity only.
     */
    for (const f of APPROVER_FILTER_FIELDS) {
      expect(FIELD_LABEL[f], f).toBeTruthy();
    }
    expect(APPROVER_FILTER_FIELDS).not.toContain('amount');
    expect(APPROVER_FILTER_FIELDS).not.toContain('categoryIds');
  });
});
