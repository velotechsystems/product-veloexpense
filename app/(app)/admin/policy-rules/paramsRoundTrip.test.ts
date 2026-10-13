import { describe, expect, it } from 'vitest';
import { formToParams, type ParamSpecField, paramsComplete, paramsToForm } from './params';

/**
 * Rule params survive the trip from a stored row to the form and back.
 *
 * The dangerous part is money. A threshold is stored in MINOR units as a digit string
 * (BigInt-safe), and typed in MAJOR units. Get the conversion backwards in either
 * direction and the rule still saves, still validates, and fires at the wrong number by
 * a factor of a hundred — an admin who types 1,000 gets a rule that trips at $10, and
 * nothing anywhere says so.
 *
 * The booleans matter for a subtler reason: `AUDIT_THRESHOLD` reads an ABSENT switch as
 * ON (`params.requirePurpose !== false`). So a form that seeds a missing boolean to
 * `false` would silently disable half the rule the moment somebody opened and re-saved
 * it without touching anything.
 */

const SPEC = [
  { name: 'thresholdMinor', kind: 'moneyMinor', required: true },
  { name: 'requirePurpose', kind: 'boolean', default: true },
  { name: 'requireAttendees', kind: 'boolean', default: true },
] as const;

const MILEAGE_SPEC = [
  { name: 'maxKmPerEntry', kind: 'number', required: false },
  { name: 'maxKmPerMonth', kind: 'number', required: false },
] as const;

describe('paramsToForm', () => {
  it('shows a stored minor-unit threshold in major units', () => {
    const form = paramsToForm([...SPEC], { thresholdMinor: '100000' }, 'CAD');
    expect(form.thresholdMinor).toBe('1000.00');
  });

  it('defaults an ABSENT switch to the kind default, not false', () => {
    // Opening and re-saving an existing rule must not turn its requirements off.
    const form = paramsToForm([...SPEC], { thresholdMinor: '100000' }, 'CAD');
    expect(form.requirePurpose).toBe(true);
    expect(form.requireAttendees).toBe(true);
  });

  it('respects a switch explicitly stored as false', () => {
    const form = paramsToForm(
      [...SPEC],
      { thresholdMinor: '100000', requireAttendees: false },
      'CAD',
    );
    expect(form.requireAttendees).toBe(false);
    expect(form.requirePurpose).toBe(true);
  });

  it('leaves an unset money field blank rather than showing 0.00', () => {
    // "0.00" would read as a configured zero threshold, which is a real and different
    // setting — it means "every claim".
    expect(paramsToForm([...SPEC], {}, 'CAD').thresholdMinor).toBe('');
  });

  it('honours a zero-exponent currency', () => {
    // ¥100,000 is 100000 minor units, not 1000. A hardcoded /100 would be wrong here.
    expect(paramsToForm([...SPEC], { thresholdMinor: '100000' }, 'JPY').thresholdMinor).toBe(
      '100000',
    );
  });
});

describe('formToParams', () => {
  it('stores major-unit input as minor units', () => {
    const out = formToParams(
      [...SPEC],
      { thresholdMinor: '1000', requirePurpose: true, requireAttendees: true },
      'CAD',
      'en',
    );
    expect(out.thresholdMinor).toBe('100000');
  });

  it('keeps the threshold a STRING, so a large one cannot lose precision', () => {
    const out = formToParams([...SPEC], { thresholdMinor: '1000' }, 'CAD', 'en');
    expect(typeof out.thresholdMinor).toBe('string');
  });

  it('handles decimals without float drift', () => {
    // 1234.56 → 123456. A naive `* 100` gives 123455.99999999999.
    expect(formToParams([...SPEC], { thresholdMinor: '1234.56' }, 'CAD', 'en').thresholdMinor).toBe(
      '123456',
    );
  });

  it('omits a blank optional rather than sending an empty value', () => {
    const out = formToParams(
      [...MILEAGE_SPEC],
      { maxKmPerEntry: '100', maxKmPerMonth: '' },
      'CAD',
      'en',
    );
    expect(out).toEqual({ maxKmPerEntry: 100 });
    expect('maxKmPerMonth' in out).toBe(false);
  });

  it('keeps a deliberate zero threshold', () => {
    // Zero is not "unset": it means the rule applies to every claim. Dropping it would
    // silently turn a strict rule into an inert one.
    expect(formToParams([...SPEC], { thresholdMinor: '0' }, 'CAD', 'en').thresholdMinor).toBe('0');
  });

  it('always sends booleans, so an off switch is stored as off', () => {
    const out = formToParams(
      [...SPEC],
      { thresholdMinor: '10', requirePurpose: false, requireAttendees: true },
      'CAD',
      'en',
    );
    expect(out.requirePurpose).toBe(false);
    expect(out.requireAttendees).toBe(true);
  });

  it('round-trips', () => {
    const stored = { thresholdMinor: '250000', requirePurpose: true, requireAttendees: false };
    const back = formToParams([...SPEC], paramsToForm([...SPEC], stored, 'CAD'), 'CAD', 'en');
    expect(back).toEqual(stored);
  });
});

describe('paramsComplete', () => {
  it('refuses a required money param left blank', () => {
    // The point of the gate: a rule with no threshold saves, validates, and does nothing.
    expect(paramsComplete([...SPEC], [], { thresholdMinor: '' })).toBe(false);
    expect(paramsComplete([...SPEC], [], { thresholdMinor: '1000' })).toBe(true);
  });

  it('accepts a threshold of zero as filled in', () => {
    expect(paramsComplete([...SPEC], [], { thresholdMinor: '0' })).toBe(true);
  });

  it('ignores booleans when deciding completeness', () => {
    // A switch always has a value, so it can never be the thing that is missing.
    expect(
      paramsComplete([...SPEC], [], {
        thresholdMinor: '1000',
        requirePurpose: false,
        requireAttendees: false,
      }),
    ).toBe(true);
  });

  it('enforces an at-least-one-of group', () => {
    const group = ['maxKmPerEntry', 'maxKmPerMonth'];
    expect(paramsComplete([...MILEAGE_SPEC], group, { maxKmPerEntry: '', maxKmPerMonth: '' })).toBe(
      false,
    );
    expect(
      paramsComplete([...MILEAGE_SPEC], group, { maxKmPerEntry: '', maxKmPerMonth: '500' }),
    ).toBe(true);
  });

  it('passes a kind with no params at all', () => {
    expect(paramsComplete([], [], {})).toBe(true);
  });
});

describe('what these functions do with data that is not there', () => {
  /**
   * A rule row is `params Json`, and a kind's spec can change under rows already stored.
   * So every one of these is reachable in production: a rule saved before a param
   * existed, a kind whose spec was extended, a row written by a migration with no params
   * at all. The form has to open on all of them, because the alternative is a rule
   * nobody can edit and therefore nobody can turn off.
   */

  it('opens a rule whose params column is null', () => {
    /** Rows predating the params column, and rows a migration created. */
    expect(paramsToForm(SPEC, null, 'CAD')).toEqual({
      thresholdMinor: '',
      requirePurpose: true,
      requireAttendees: true,
    });
  });

  it('opens a rule whose params are an empty object', () => {
    expect(paramsToForm(MILEAGE_SPEC, {}, 'CAD')).toEqual({
      maxKmPerEntry: '',
      maxKmPerMonth: '',
    });
  });

  it('reads a switch with no declared default as OFF', () => {
    /**
     * `default` is optional on the spec. A kind that does not state one is a kind whose
     * author did not claim a safe fallback — so the switch reads as off, and the person
     * editing decides. Seeding it ON would turn something on that nobody asked for.
     */
    const spec = [{ name: 'strict', kind: 'boolean' }] as const;
    expect(paramsToForm(spec, {}, 'CAD')).toEqual({ strict: false });
  });

  it('blanks a money param stored as something other than a digit string', () => {
    /**
     * `BigInt('12.50')` throws, and the throw would take the whole editor down rather
     * than one field. A blank box is a field the author can see and fix.
     */
    expect(paramsToForm(SPEC, { thresholdMinor: 12.5 }, 'CAD').thresholdMinor).toBe('');
  });

  it('stringifies a number param that arrives as a number', () => {
    expect(paramsToForm(MILEAGE_SPEC, { maxKmPerEntry: 400 }, 'CAD').maxKmPerEntry).toBe('400');
  });

  it('blanks a number param stored as null', () => {
    expect(paramsToForm(MILEAGE_SPEC, { maxKmPerEntry: null }, 'CAD').maxKmPerEntry).toBe('');
  });

  it('drops a threshold that is not a number rather than storing garbage', () => {
    /**
     * The box is free text. "ten" has to be dropped, not coerced — a rule saved with a
     * nonsense threshold validates, publishes, and then fires on every expense or on
     * none, and the params column says why only if somebody reads it.
     *
     * ("1,000" is no longer garbage: in `en` that is the grouped form of one thousand,
     * and dropping it silently blanked the threshold of anyone who typed it.)
     */
    expect(
      formToParams(SPEC, { thresholdMinor: 'ten', requirePurpose: true }, 'CAD', 'en'),
    ).toEqual({
      requirePurpose: true,
      requireAttendees: false,
    });
  });

  it('drops a number param that is not a number', () => {
    expect(formToParams(MILEAGE_SPEC, { maxKmPerEntry: 'lots' }, 'CAD', 'en')).toEqual({});
  });

  it('reads the threshold in the ADMIN\u2019s locale, so fr-CA notation is not dropped', () => {
    // The inverse of the render bug. `1 000,00` is what a French-Canadian admin
    // types; `Number()` gave NaN, the param was omitted, and the rule saved
    // threshold-less \u2014 which validates and then never fires.
    expect(
      formToParams(SPEC, { thresholdMinor: '1\u00A0000,00' }, 'CAD', 'fr-CA').thresholdMinor,
    ).toBe('100000');
    expect(formToParams(SPEC, { thresholdMinor: '1 000,00' }, 'CAD', 'fr-CA').thresholdMinor).toBe(
      '100000',
    );
    // And the same text in `en` is refused rather than read as 100 000,00 \u2014 a
    // silent 100x on a policy threshold is worse than a rejected form.
    expect('thresholdMinor' in formToParams(SPEC, { thresholdMinor: '1000,00' }, 'CAD', 'en')).toBe(
      false,
    );
  });

  it('treats a param missing from the form entirely as blank, not as undefined', () => {
    /** The spec is the source of truth for what a payload carries; a form built before a
     *  param was added simply does not have the key. */
    expect(formToParams(MILEAGE_SPEC, {}, 'CAD', 'en')).toEqual({});
  });

  it('refuses completeness for a required param the form has no key for', () => {
    /** Reading `undefined` as "filled" would let a threshold-less threshold rule save. */
    expect(paramsComplete(SPEC, [], { requirePurpose: true })).toBe(false);
  });

  it('refuses an at-least-one-of group whose fields are all absent', () => {
    expect(paramsComplete(MILEAGE_SPEC, ['maxKmPerEntry', 'maxKmPerMonth'], {})).toBe(false);
  });
});

// ── The travel cabin rule's two param shapes ─────────────────────────────────

const CABIN_SPEC: ParamSpecField[] = [
  {
    name: 'cabin',
    kind: 'enum',
    options: ['PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'],
    required: true,
  },
  { name: 'allowedJobLevelIds', kind: 'lookupIds', entity: 'jobLevel', required: false },
];

const VP = '019f9a10-0000-7000-8000-00000000e001';

describe('cabin + job-level params', () => {
  it('round-trips a cabin and an id list unchanged', () => {
    const stored = { cabin: 'BUSINESS', allowedJobLevelIds: [VP] };
    const form = paramsToForm(CABIN_SPEC, stored, 'CAD');
    expect(form).toEqual({ cabin: 'BUSINESS', allowedJobLevelIds: [VP] });
    expect(formToParams(CABIN_SPEC, form, 'CAD', 'en')).toEqual(stored);
  });

  it('keeps a cabin as its literal, never coerced to a number', () => {
    // The `else` branch below `moneyMinor` runs `Number(text)`, which would turn a cabin
    // name into NaN and drop it — the rule would then save and do nothing.
    expect(formToParams(CABIN_SPEC, { cabin: 'FIRST' }, 'CAD', 'en').cabin).toBe('FIRST');
  });

  it('SENDS an empty id list rather than omitting it', () => {
    /**
     * "First class is nobody" is `[]`, and it is a real configuration. Omitting it would
     * land on the schema's `.default([])` and mean the same thing today — but only by
     * coincidence, and a kind that later read an absent list as "unrestricted" would
     * silently invert the policy.
     */
    const out = formToParams(CABIN_SPEC, { cabin: 'FIRST', allowedJobLevelIds: [] }, 'CAD', 'en');
    expect('allowedJobLevelIds' in out).toBe(true);
    expect(out.allowedJobLevelIds).toEqual([]);
  });

  it('reads a corrupt id list as empty rather than coercing its members', () => {
    // `String(7)` would send "7" back to a schema expecting uuids, which fails on save
    // with a message about a value nobody typed.
    expect(
      paramsToForm(CABIN_SPEC, { allowedJobLevelIds: [VP, 7, null] }, 'CAD').allowedJobLevelIds,
    ).toEqual([VP]);
    expect(
      paramsToForm(CABIN_SPEC, { allowedJobLevelIds: 'nope' }, 'CAD').allowedJobLevelIds,
    ).toEqual([]);
  });

  it('counts an empty id list as complete, but a missing cabin as not', () => {
    // The list may be empty on purpose; the cabin may not — a rule with no cabin named
    // short-circuits and does nothing.
    expect(paramsComplete(CABIN_SPEC, [], { cabin: 'BUSINESS', allowedJobLevelIds: [] })).toBe(
      true,
    );
    expect(paramsComplete(CABIN_SPEC, [], { cabin: '', allowedJobLevelIds: [VP] })).toBe(false);
  });
});
