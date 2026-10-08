// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { adminToRjsf, buildLookupSchema, rjsfToAdmin } from './AdminLookupForm';
import type { AdminFormState, ExtraFieldDef } from './AdminLookupPage';

// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`). The French-off behaviour is tested in
// AdminLookupPage.veloexpense.test.tsx.
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));

/**
 * The admin-lookup drawer's schema and its two adapters.
 *
 * The adapters exist because `AdminFormState.extras` is a **string map** while RJSF
 * types each field for real, and the two type systems disagree in exactly the way
 * that loses data silently:
 *
 *   · A boolean handed over as the string `'true'` renders an UNCHECKED box, and the
 *     first change writes `false` back — so opening a drawer and saving it turns a
 *     flag off without anybody touching it.
 *   · An unchecked box arrives back as `undefined`, which has to read as `false`
 *     rather than "unset", or clearing the box keeps the old value.
 *
 * Both directions are pinned below. Everything else here is the schema shape the
 * drawer depends on: `labelEn`/`labelFr` required (a lookup row with no French label
 * is an untranslatable row in a bilingual product), and RJSF's own submit button
 * suppressed because the Drawer footer owns Save.
 */

const LABELS = {
  labelEn: 'Label (EN)',
  labelFr: 'Label (FR)',
  descriptionEn: 'Description (EN)',
  descriptionFr: 'Description (FR)',
  externalIds: 'External IDs',
  externalIdsHelp: 'Keys the upstream systems know this row by.',
  active: 'Active',
  editor: { key: 'System', value: 'ID', addRow: 'Add', removeRow: 'Remove', help: 'help' },
};

const build = (extraFields?: ExtraFieldDef[], mode: 'create' | 'edit' = 'create') =>
  buildLookupSchema({ mode, extraFields, labels: LABELS });

const form = (over: Partial<AdminFormState> = {}): AdminFormState => ({
  labelEn: 'Atlantic',
  labelFr: 'Atlantique',
  descriptionEn: '',
  descriptionFr: '',
  externalIds: [],
  active: true,
  extras: {},
  ...over,
});

describe('buildLookupSchema', () => {
  it('requires both labels, and nothing else by default', () => {
    // A row with only an English label is an untranslatable row in a product that
    // ships EN + FR-CA from day one.
    const { schema } = build();
    expect(schema.required).toEqual(['labelEn', 'labelFr']);
    expect((schema.properties?.labelEn as { minLength: number }).minLength).toBe(1);
  });

  it('suppresses RJSF’s submit button, because the Drawer footer owns Save', () => {
    // Two Save buttons in one drawer, one of them inside the scrolling body.
    const { uiSchema } = build();
    expect(uiSchema['ui:submitButtonOptions']).toMatchObject({ norender: true });
  });

  it('orders the fields, with external IDs and the active flag last', () => {
    const { uiSchema } = build([{ name: 'code', label: 'Code', kind: { kind: 'text' } }]);
    expect(uiSchema['ui:order']).toEqual([
      'labelEn',
      'labelFr',
      'descriptionEn',
      'descriptionFr',
      'code',
      'externalIds',
      'active',
    ]);
  });

  it('defaults a new row to active', () => {
    // Creating a business unit that lands inactive is a row nobody can select and
    // no error explains.
    expect((build().schema.properties?.active as { default: boolean }).default).toBe(true);
  });

  it('routes external IDs to the bespoke editor field', () => {
    /**
     * RJSF's map widget cannot express the quick-add chips, per-system dropdown or
     * duplicate detection, so the whole field is replaced — and the editor's own
     * labels have to travel with it, or it renders in English inside a French form.
     */
    const { uiSchema } = build();
    expect(uiSchema.externalIds?.['ui:field']).toBe('externalIds');
    expect(uiSchema.externalIds?.['ui:options']).toMatchObject({
      help: LABELS.externalIdsHelp,
      editorLabels: LABELS.editor,
    });
  });

  describe('extra fields', () => {
    it('types a boolean field as a boolean', async () => {
      const { schema } = build([
        { name: 'itcRecoverable', label: 'ITC', kind: { kind: 'boolean' } },
      ]);
      expect(schema.properties?.itcRecoverable).toMatchObject({ type: 'boolean', title: 'ITC' });
    });

    it('gives a picker a plain string type and lets the widget own the control', () => {
      // The country/currency vocabularies are closed sets of ~250 and ~50; an enum in
      // the schema would put all of them in the generated form.
      const { schema, uiSchema } = build([
        {
          name: 'country',
          label: 'Country',
          kind: { kind: 'picker', widget: 'country', placeholder: 'Search…', help: 'ISO 3166' },
        },
      ]);
      expect(schema.properties?.country).toMatchObject({ type: 'string' });
      expect(uiSchema.country).toMatchObject({
        'ui:widget': 'country',
        'ui:placeholder': 'Search…',
        'ui:help': 'ISO 3166',
      });
    });

    it('turns a select’s options into oneOf, so ajv rejects anything else', () => {
      const { schema } = build([
        {
          name: 'kind',
          label: 'Kind',
          kind: { kind: 'select', options: [{ value: 'A', label: 'Asset' }] },
        },
      ]);
      expect(schema.properties?.kind).toMatchObject({
        oneOf: [
          { const: '', title: '—' },
          { const: 'A', title: 'Asset' },
        ],
      });
    });

    it('gives an optional select an EMPTY branch, first', () => {
      /**
       * Without one, RJSF selects the first branch for a field nobody touched — so a
       * new department was created parented to whichever department sorted first, an
       * org-tree change nobody asked for on a field that decides approval routing and
       * budget scope. The empty branch makes "not set" both visible and the default.
       */
      const { schema } = build([
        {
          name: 'parentId',
          label: 'Parent',
          kind: {
            kind: 'select',
            placeholder: 'No parent',
            options: [
              { value: 'a', label: 'Accounting' },
              { value: 'z', label: 'Zoology' },
            ],
          },
        },
      ]);
      const oneOf = (schema.properties?.parentId as { oneOf: Array<{ const: string }> }).oneOf;
      expect(oneOf[0]).toEqual({ const: '', title: 'No parent' });
      expect(oneOf).toHaveLength(3);
    });

    it('gives a REQUIRED select no empty branch — there is nothing valid to default to', () => {
      const { schema } = build([
        {
          name: 'kind',
          label: 'Kind',
          required: true,
          kind: { kind: 'select', options: [{ value: 'A', label: 'Asset' }] },
        },
      ]);
      expect(schema.properties?.kind).toMatchObject({ oneOf: [{ const: 'A', title: 'Asset' }] });
      expect(schema.required).toContain('kind');
    });

    it('carries a required extra into the required list, with a minimum length', () => {
      // `required` alone lets an empty string through, which is the same as absent for
      // every column this feeds.
      const { schema } = build([
        { name: 'code', label: 'Code', required: true, kind: { kind: 'text', maxLength: 12 } },
      ]);
      expect(schema.required).toContain('code');
      expect(schema.properties?.code).toMatchObject({ minLength: 1, maxLength: 12 });
    });

    it('leaves an optional text field unconstrained', () => {
      const { schema, uiSchema } = build([{ name: 'note', label: 'Note', kind: { kind: 'text' } }]);
      expect(schema.properties?.note).not.toHaveProperty('minLength');
      expect(schema.properties?.note).not.toHaveProperty('maxLength');
      expect(uiSchema.note).toEqual({});
    });

    it('attaches help text to every field kind that offers it', () => {
      const { uiSchema } = build([
        { name: 'b', label: 'B', kind: { kind: 'boolean', help: 'bh' } },
        { name: 's', label: 'S', kind: { kind: 'select', options: [], help: 'sh' } },
        { name: 't', label: 'T', kind: { kind: 'text', help: 'th', placeholder: 'tp' } },
      ]);
      expect(uiSchema.b).toEqual({ 'ui:help': 'bh' });
      expect(uiSchema.s).toEqual({ 'ui:help': 'sh' });
      expect(uiSchema.t).toEqual({ 'ui:help': 'th', 'ui:placeholder': 'tp' });
    });
  });
});

describe('adminToRjsf', () => {
  it('hands a boolean extra to RJSF as a real boolean', () => {
    /**
     * The bug this prevents: `'true'` is truthy in JS but is not `true`, so RJSF's
     * checkbox renders unchecked, and its first onChange writes `false` back. Opening
     * a legal entity and saving it would silently clear `itcRecoverable`.
     */
    const fields: ExtraFieldDef[] = [
      { name: 'itcRecoverable', label: 'ITC', kind: { kind: 'boolean' } },
    ];
    expect(adminToRjsf(form({ extras: { itcRecoverable: 'true' } }), fields).itcRecoverable).toBe(
      true,
    );
    expect(adminToRjsf(form({ extras: { itcRecoverable: 'false' } }), fields).itcRecoverable).toBe(
      false,
    );
    // Absent reads as false, not as undefined — RJSF would drop the key.
    expect(adminToRjsf(form(), fields).itcRecoverable).toBe(false);
  });

  it('flattens the other extras through as-is', () => {
    const fields: ExtraFieldDef[] = [{ name: 'code', label: 'Code', kind: { kind: 'text' } }];
    expect(adminToRjsf(form({ extras: { code: 'ATL' } }), fields)).toMatchObject({
      labelEn: 'Atlantic',
      labelFr: 'Atlantique',
      code: 'ATL',
      active: true,
    });
  });

  it('survives a form state with no extras at all', () => {
    expect(adminToRjsf({ ...form(), extras: undefined as never })).toMatchObject({
      labelEn: 'Atlantic',
    });
  });
});

describe('rjsfToAdmin', () => {
  const data = (over: Record<string, unknown> = {}) =>
    ({
      labelEn: 'Atlantic',
      labelFr: 'Atlantique',
      descriptionEn: '',
      descriptionFr: '',
      externalIds: [],
      active: true,
      ...over,
    }) as never;

  it('reads an unchecked box as false, not as "leave it alone"', () => {
    // RJSF drops an unchecked boolean from formData entirely.
    const fields: ExtraFieldDef[] = [{ name: 'flag', label: 'Flag', kind: { kind: 'boolean' } }];
    expect(rjsfToAdmin(data(), fields).extras.flag).toBe('false');
    expect(rjsfToAdmin(data({ flag: true }), fields).extras.flag).toBe('true');
    // Anything that is not literally `true` is false — a stray string must not read
    // as "on" just by being truthy.
    expect(rjsfToAdmin(data({ flag: 'true' }), fields).extras.flag).toBe('false');
  });

  it('uppercases a code field that asked for it, and a picker’s value', () => {
    /**
     * Country and currency codes are compared byte-for-byte against ISO tables and
     * against `Currency.code`; a lowercase `cad` matches nothing and produces a legal
     * entity whose currency the money helpers cannot resolve.
     */
    const fields: ExtraFieldDef[] = [
      { name: 'code', label: 'Code', kind: { kind: 'text', uppercase: true } },
      { name: 'country', label: 'Country', kind: { kind: 'picker', widget: 'country' } },
      { name: 'note', label: 'Note', kind: { kind: 'text' } },
    ];
    const out = rjsfToAdmin(data({ code: 'atl', country: 'ca', note: 'Keep me' }), fields);
    expect(out.extras).toEqual({ code: 'ATL', country: 'CA', note: 'Keep me' });
  });

  it('turns an absent or null extra into an empty string', () => {
    // `String(null)` is `"null"`, which would be written to the column verbatim.
    const fields: ExtraFieldDef[] = [{ name: 'code', label: 'Code', kind: { kind: 'text' } }];
    expect(rjsfToAdmin(data({ code: null }), fields).extras.code).toBe('');
    expect(rjsfToAdmin(data(), fields).extras.code).toBe('');
  });

  it('stringifies a non-string extra rather than passing the value through', () => {
    const fields: ExtraFieldDef[] = [{ name: 'seq', label: 'Seq', kind: { kind: 'text' } }];
    expect(rjsfToAdmin(data({ seq: 12 }), fields).extras.seq).toBe('12');
  });

  it('defaults the labels and treats a missing active flag as active', () => {
    // Only an explicit `false` deactivates: a form that never rendered the checkbox
    // must not deactivate the row it was editing.
    const out = rjsfToAdmin({ externalIds: [] } as never, undefined);
    expect(out).toMatchObject({ labelEn: '', labelFr: '', active: true, extras: {} });
    expect(rjsfToAdmin(data({ active: false }), undefined).active).toBe(false);
  });

  it('coerces a non-array externalIds to an empty list', () => {
    // The editor indexes into it; a scalar there is a crash in the drawer.
    expect(rjsfToAdmin(data({ externalIds: 'nope' }), undefined).externalIds).toEqual([]);
  });

  it('round-trips a full form state unchanged', () => {
    /**
     * The property that makes the pair safe: opening a drawer and saving it without
     * touching anything must produce the state it started from.
     */
    const fields: ExtraFieldDef[] = [
      { name: 'code', label: 'Code', kind: { kind: 'text', uppercase: true } },
      { name: 'flag', label: 'Flag', kind: { kind: 'boolean' } },
    ];
    const start = form({
      descriptionEn: 'east',
      descriptionFr: 'est',
      externalIds: [{ rowId: 'r1', key: 'netsuite', value: '42' }],
      active: false,
      extras: { code: 'ATL', flag: 'true' },
    });
    expect(rjsfToAdmin(adminToRjsf(start, fields), fields)).toEqual(start);
  });
});
