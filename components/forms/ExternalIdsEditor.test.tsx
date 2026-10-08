import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type ExternalIdEntry,
  ExternalIdsEditor,
  entriesFromMap,
  mapFromEntries,
} from './ExternalIdsEditor';

/**
 * The `{ systemKey: externalId }` editor behind every federated entity — User, BusinessUnit,
 * LegalEntity, Department, Account, Role.
 *
 * These IDs are how ExpenseOS correlates its records with NetSuite's and Google's, so the
 * failure modes are all about data silently going missing or landing under the wrong key:
 * a duplicate that collapses, a trailing space that makes `netsuite ` a different system
 * from `netsuite`, or a row the user filled in half-way that vanishes on save. None of
 * those announce themselves — they show up later as a sync that skips a record.
 */

const LABELS = {
  key: 'System',
  value: 'External ID',
  addRow: 'Add row',
  removeRow: 'Remove',
  help: 'Map this record to outside systems.',
};

/** The tenant's own systems, as the editor now receives them: a code and what to call it. */
const SOURCES = [
  { code: 'netsuite', label: 'NetSuite' },
  { code: 'google', label: 'Google Workspace' },
  { code: 'concur', label: 'Concur' },
] as const;

describe('mapFromEntries', () => {
  const row = (key: string, value: string, i = 0): ExternalIdEntry => ({
    rowId: `r${i}`,
    key,
    value,
  });

  it('reduces rows to a plain map', () => {
    expect(mapFromEntries([row('netsuite', '123'), row('google', 'abc', 1)])).toEqual({
      netsuite: '123',
      google: 'abc',
    });
  });

  it('TRIMS both key and value', () => {
    /**
     * The quiet one. `'netsuite '` and `'netsuite'` are different object keys, so an
     * untrimmed paste creates a second system nothing looks up — the record simply never
     * correlates, with no error anywhere.
     */
    expect(mapFromEntries([row('  netsuite  ', '  123  ')])).toEqual({ netsuite: '123' });
  });

  it('drops a row missing its key or its value', () => {
    // A half-filled row is not a mapping. Writing `{'': '123'}` or `{netsuite: ''}` would
    // put a meaningless entry into the stored map.
    expect(mapFromEntries([row('netsuite', ''), row('', '123', 1), row('   ', '   ', 2)])).toEqual(
      {},
    );
  });

  it('keeps the LAST value when a key repeats', () => {
    // Documented, not desired: the editor flags duplicates visually but this helper cannot
    // reject them, so one of the two is lost. The surrounding form is what has to block
    // submit — asserted here so the collapse is a known consequence rather than a surprise.
    expect(mapFromEntries([row('netsuite', 'first'), row('netsuite', 'second', 1)])).toEqual({
      netsuite: 'second',
    });
  });

  it('returns an empty map for no rows', () => {
    expect(mapFromEntries([])).toEqual({});
  });
});

describe('entriesFromMap', () => {
  it('turns a stored map into rows', () => {
    const rows = entriesFromMap({ netsuite: '123' }, SOURCES);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'netsuite', value: '123' });
  });

  it('gives every row a distinct id, so React does not reuse the wrong one', () => {
    // Duplicate keys mean duplicate ids unless the index is part of them — and two rows
    // sharing a key would then edit as one.
    const rows = entriesFromMap({ a: '1', b: '2', c: '3' });
    expect(new Set(rows.map((r) => r.rowId)).size).toBe(3);
  });

  it('marks an unrecognised system as a custom key', () => {
    // Otherwise it would render in a dropdown that has no such option, and the key would
    // silently change to whatever the select defaulted to.
    const rows = entriesFromMap({ netsuite: '1', homegrown: '2' }, SOURCES);
    expect(rows.find((r) => r.key === 'netsuite')?.customKey).toBe(false);
    expect(rows.find((r) => r.key === 'homegrown')?.customKey).toBe(true);
  });

  it('leaves the decision open when there is no list to decide against', () => {
    /**
     * The source list is FETCHED, and callers build rows from a stored map before it
     * lands. Answering "custom" there would show a free-text box for `netsuite` on every
     * form that opens first; `undefined` lets the editor resolve it once the list arrives.
     */
    expect(entriesFromMap({ netsuite: '1' })[0].customKey).toBeUndefined();
  });

  it('stringifies a non-string value rather than rendering undefined', () => {
    // Stored JSON is not type-checked at the boundary, so a numeric ID can arrive.
    const rows = entriesFromMap({ netsuite: 123 as unknown as string });
    expect(rows[0].value).toBe('123');
  });

  it('round-trips with mapFromEntries', () => {
    // Opening the editor and saving without touching anything must not change the data.
    const original = { netsuite: '123', google: 'abc', homegrown: 'x' };
    expect(mapFromEntries(entriesFromMap(original, SOURCES))).toEqual(original);
  });
});

/** The editor, holding its own rows the way a real form does. */
function Host({ initial = {} as Record<string, string>, onMap = vi.fn() }) {
  const [entries, setEntries] = useState<ExternalIdEntry[]>(() => entriesFromMap(initial, SOURCES));
  return (
    <>
      <ExternalIdsEditor
        entries={entries}
        onChange={(next) => {
          setEntries(next);
          onMap(mapFromEntries(next));
        }}
        sources={SOURCES}
        labels={LABELS}
      />
      <output data-testid="map">{JSON.stringify(mapFromEntries(entries))}</output>
    </>
  );
}

const storedMap = () => JSON.parse(screen.getByTestId('map').textContent ?? '{}');
const rows = () => screen.getAllByPlaceholderText('External ID');

/** Add `n` rows and flip each to the free-text key, for the duplicate-key cases. */
async function addCustomRows(n: number) {
  for (let i = 0; i < n; i++) {
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[selects.length - 1], '__other__');
  }
}

describe('ExternalIdsEditor — adding a row', () => {
  /**
   * One "add" button and a picker on the row, which is the repeating-row idiom the rest of
   * the product already uses. The quick-add chips that used to sit above the list are gone:
   * they were a second way to do the same thing, and they were driven by a hardcoded list
   * of four system names rather than by the tenant's own sources.
   */
  it('adds a row that starts on the picker, not on a free-text box', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    // Nothing is stored until a system and an id are both chosen.
    expect(storedMap()).toEqual({});
  });

  it('leads the picker with a blank, so it claims no system nobody chose', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('names the systems the way the tenant does, not by their stored code', async () => {
    // The picker used to print `netsuite`; the label is what somebody configured.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const options = within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('NetSuite');
    expect(options).toContain('Google Workspace');
  });
});

describe('ExternalIdsEditor — editing rows', () => {
  it('stores a key/value pair once both are filled', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'google');
    await userEvent.type(rows()[0], 'g-1');
    expect(storedMap()).toEqual({ google: 'g-1' });
  });

  it('edits only the row that changed', async () => {
    // The update is by rowId; a lookup by index or by key would rewrite the wrong row when
    // two rows share a key.
    render(<Host initial={{ netsuite: '1', google: '2' }} />);
    const all = rows();
    await userEvent.clear(all[1]);
    await userEvent.type(all[1], '99');
    expect(storedMap()).toEqual({ netsuite: '1', google: '99' });
  });

  it('removes the right row', async () => {
    render(<Host initial={{ netsuite: '1', google: '2' }} />);
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(removes[0]);
    expect(storedMap()).toEqual({ google: '2' });
  });

  it('takes a system that is not on the list at all', async () => {
    /**
     * The escape hatch, and it has to exist: the source list is seeded from what has been
     * used, so with no way to type a new code the first id for a new system could never be
     * entered.
     */
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), '__other__');
    await userEvent.type(screen.getByPlaceholderText('System'), 'homegrown');
    await userEvent.type(rows()[0], 'x-1');
    expect(storedMap()).toEqual({ homegrown: 'x-1' });
  });
});

describe('ExternalIdsEditor — duplicate keys', () => {
  it('flags BOTH rows, not only the later one', async () => {
    /**
     * A duplicate is a pair — highlighting only the second tells the user to fix the wrong
     * one, and `mapFromEntries` silently keeps the last value, so whichever they delete
     * changes the stored ID.
     */
    render(<Host />);
    // Two rows on the same custom key.
    await addCustomRows(2);
    const keyFields = screen.getAllByPlaceholderText('System');
    await userEvent.type(keyFields[0], 'dup');
    await userEvent.type(keyFields[1], 'dup');

    // VeloExpense: the class TOKEN, not a substring — the kit's Input carries
    // `aria-invalid:border-destructive` on every field, which a substring match counts.
    const flagged = screen
      .getAllByPlaceholderText('System')
      .filter((el) => el.classList.contains('border-destructive'));
    expect(flagged).toHaveLength(2);
  });

  it('does not flag rows whose keys merely look similar', async () => {
    render(<Host />);
    await addCustomRows(2);
    const keyFields = screen.getAllByPlaceholderText('System');
    await userEvent.type(keyFields[0], 'netsuite');
    await userEvent.type(keyFields[1], 'netsuite2');

    // VeloExpense: the class TOKEN, not a substring — the kit's Input carries
    // `aria-invalid:border-destructive` on every field, which a substring match counts.
    const flagged = screen
      .getAllByPlaceholderText('System')
      .filter((el) => el.classList.contains('border-destructive'));
    expect(flagged).toHaveLength(0);
  });
});

describe('ExternalIdsEditor — the key dropdown', () => {
  it('offers the unused systems plus an escape hatch', async () => {
    render(<Host initial={{ netsuite: '123' }} />);
    // The row for `netsuite` is a known system, so its key cell is a select.
    const select = screen.getByRole('combobox');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Its own key stays selectable even though it is "used".
    expect(options).toContain('NetSuite');
    expect(options).toContain('Google Workspace');
    expect(options).toContain('(other…)');
  });

  it('hides systems already mapped to another row', async () => {
    // Choosing one would create a duplicate the user did not intend.
    render(<Host initial={{ netsuite: '1', google: '2' }} />);
    const first = screen.getAllByRole('combobox')[0];
    const options = within(first)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).not.toContain('Google Workspace');
  });

  it('switching to "(other…)" clears the key and opens a text field', async () => {
    // Leaving the old key in place would mean the free-text field opened pre-filled with a
    // system the user just said they did not want.
    render(<Host initial={{ netsuite: '123' }} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), '__other__');
    const keyField = screen.getByPlaceholderText('System');
    expect(keyField).toHaveValue('');
    // ...and the mapping is gone until a new key is typed.
    expect(storedMap()).toEqual({});
  });

  it('uses free-text keys throughout when no systems are configured', () => {
    // With no source list there is nothing to put in a dropdown, so every row must be
    // typeable or the editor cannot be used at all.
    render(
      <ExternalIdsEditor
        entries={entriesFromMap({ anything: '1' })}
        onChange={vi.fn()}
        labels={LABELS}
      />,
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('System')).toHaveValue('anything');
  });
});
