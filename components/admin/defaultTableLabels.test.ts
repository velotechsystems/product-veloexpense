import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_LABELS, DEFAULT_TABLE_LABELS } from './defaultTableLabels';

/**
 * The English label bag the smaller admin pages share.
 *
 * Two exports off one string set, because the two consumers want different shapes: the
 * design-system `<TableSettingsButton>` expects a `settings` object carrying `groupBy`
 * (it can render the group-by radio), while the app's own `<DataTable>` labels schema
 * omits it. A page that reaches for the wrong one renders `undefined` in a menu — which
 * is why the difference is asserted rather than assumed.
 */

describe('the shared label bags', () => {
  it('gives the column menu every entry it renders', () => {
    /** A missing key here is a literal "undefined" in a header menu. */
    for (const key of [
      'menu',
      'sortAsc',
      'sortDesc',
      'filter',
      'hide',
      'cancel',
      'clear',
      'apply',
      'value',
    ]) {
      expect(DEFAULT_TABLE_LABELS.colMenu[key as 'menu'], key).toBeTruthy();
    }
  });

  it('names every filter operator the editor can offer', () => {
    for (const key of [
      'op_contains',
      'op_doesNotContain',
      'op_equals',
      'op_doesNotEqual',
      'op_isEmpty',
      'op_isNotEmpty',
    ]) {
      expect(DEFAULT_TABLE_LABELS.colMenu[key as 'op_contains'], key).toBeTruthy();
    }
  });

  it('carries groupBy on the settings shape and not on the table shape', () => {
    /** The whole reason there are two exports. */
    expect(DEFAULT_SETTINGS_LABELS).toHaveProperty('groupBy');
    expect(DEFAULT_TABLE_LABELS.settings).not.toHaveProperty('groupBy');
  });

  it('describes all three densities, since the control is a three-way', () => {
    expect(DEFAULT_SETTINGS_LABELS.densityCompact).toBeTruthy();
    expect(DEFAULT_SETTINGS_LABELS.densityNormal).toBeTruthy();
    expect(DEFAULT_SETTINGS_LABELS.densityComfortable).toBeTruthy();
  });

  it('builds both shapes from the same strings, so they cannot disagree', () => {
    /** Two hand-maintained copies would drift, and the drift shows as one page calling
     *  a thing by a different name than its neighbour. */
    expect(DEFAULT_SETTINGS_LABELS.trigger).toBe(DEFAULT_TABLE_LABELS.settings.trigger);
    expect(DEFAULT_SETTINGS_LABELS.columns).toBe(DEFAULT_TABLE_LABELS.settings.columns);
  });

  it('is plain English, with nothing left as a translation key', () => {
    /** These pages deliberately do not wire next-intl; a leaked `table.foo` key would
     *  render literally. */
    const values = JSON.stringify(DEFAULT_TABLE_LABELS);
    expect(values).not.toMatch(/table\.[a-z]/i);
  });
});
