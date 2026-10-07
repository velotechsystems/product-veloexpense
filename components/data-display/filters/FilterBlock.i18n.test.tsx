import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AddFilterPill, FilterBlock } from './FilterBlock';
import { DEFAULT_FILTER_LABELS, type FilterLabels } from './types';

/**
 * The filter chrome was hardcoded English inside the design system, so a French reader saw
 * "Add filter" three times on one page among otherwise translated tiles (GA readiness
 * report F43).
 *
 * It was invisible to `check-used-keys` for exactly the reason that made it easy to miss:
 * these were never catalog keys, so no coverage tool had anything to look for. A unit test
 * is the only thing that can notice — so this asserts the strings are SUPPLIED, not that
 * any particular English wording is present.
 */
const FIELDS = ['name'] as const;
const props = {
  fields: [...FIELDS],
  fieldKinds: { name: 'text' } as const,
  facetLabels: { name: 'Name' },
  facetOptions: { name: [] },
  onAdd: () => {},
};

describe('the filter pill takes its copy from the host app', () => {
  it('renders the supplied label rather than a built-in English one', () => {
    const labels: FilterLabels = { ...DEFAULT_FILTER_LABELS, addFilter: 'Ajouter un filtre' };
    render(<AddFilterPill {...props} labels={labels} />);
    expect(screen.getByText('Ajouter un filtre')).toBeInTheDocument();
    expect(screen.queryByText('Add filter')).not.toBeInTheDocument();
  });

  it('still works for a caller that passes none', () => {
    // The defaults exist so threading this through 28 call sites could be done without
    // breaking the 29th.
    render(<AddFilterPill {...props} />);
    expect(screen.getByText('Add filter')).toBeInTheDocument();
  });

  it('takes the OPERATOR words from the host app too', () => {
    /**
     * `OP_LABELS` was a plain English const rendered straight by `FilterBlock`, so a fr-CA
     * pill read "Statut equals Approuvé" — the field and the value translated, the verb
     * between them not. #333 threaded the rest of this chrome through the bag and left the
     * operators behind on all 33 sites (GA readiness report F43).
     */
    render(
      <FilterBlock
        field="name"
        fieldKind="text"
        op="equals"
        fieldLabel="Statut"
        clauses={[{ id: 'c1', field: 'name', op: 'equals', value: 'Approuvé' }]}
        options={[]}
        onOpChange={() => {}}
        onValueChange={() => {}}
        onRemoveValue={() => {}}
        onRemoveBlock={() => {}}
        onAddValue={() => {}}
        labels={{
          ...DEFAULT_FILTER_LABELS,
          ops: { ...DEFAULT_FILTER_LABELS.ops, equals: 'égale' },
        }}
      />,
    );
    expect(screen.getByText('égale')).toBeInTheDocument();
    expect(screen.queryByText('equals')).not.toBeInTheDocument();
  });

  it('covers every string the chrome can show', () => {
    // A new hardcoded string is the failure mode this guards: the contract is the list.
    expect(Object.keys(DEFAULT_FILTER_LABELS).sort()).toEqual([
      'add',
      'addAnotherValue',
      'addFilter',
      'addValue',
      'cancel',
      'changeOperator',
      'field',
      'lastNDays',
      'operator',
      'ops',
      'removeCondition',
      'removeValue',
      'typeAValue',
      'typeOrPick',
      'value',
      'valuePlaceholder',
    ]);
  });
});
