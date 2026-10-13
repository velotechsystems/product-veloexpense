// Ported from ExpenseOS `apps/web/src/server/policy/paramsSpec.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RULE_KINDS } from './kinds';

/**
 * A rule kind that takes parameters must declare how to edit them.
 *
 * The Rule Builder cannot introspect `paramsSchema` — it is a Zod schema living on the
 * server — so the drawer posted a literal `params: {}` and **every kind with parameters
 * was uneditable**. RECEIPT_THRESHOLD, MILEAGE_MAX and AUDIT_THRESHOLD could all be
 * created from the UI and would then sit there doing nothing, because each one
 * short-circuits on a missing threshold. Creatable, valid, and inert.
 *
 * That is a bad failure to leave undetectable, so the registry is now checked against
 * itself: probe each `paramsSchema` with a representative object, and if it ACCEPTS a
 * field, a matching `paramsSpec` entry has to exist. The next kind with a threshold
 * cannot repeat the omission quietly.
 */

/**
 * Kinds allowed to accept params without a spec, each with the reason.
 *
 * ExpenseOS lists `REQUIRES_APPROVED_TRAVEL` here (two uuid-array params the editor
 * cannot render). VeloExpense: that kind is travel and is not carried, so nothing is
 * exempt; the list stays as the place a future exemption would be recorded.
 */
const SPEC_EXEMPT = new Set<string>([]);

/** A probe carrying every param name any kind uses, plus a decoy. */
const PROBE = {
  thresholdMinor: '1000',
  maxKmPerEntry: 100,
  maxKmPerMonth: 1000,
  requirePurpose: true,
  requireAttendees: true,
  exemptJobLevelIds: [],
  exemptUserIds: [],
  // ExpenseOS's travel kinds' params. VeloExpense carries none of those kinds; the names
  // stay in the probe so a kind that ever reuses one is still checked.
  cabin: 'BUSINESS',
  allowedJobLevelIds: [],
  tolerancePercent: 10,
  absoluteFloorMinor: '20000',
} as const;

/** A value the spec's declared TYPE says the schema should accept. */
const PROBE_VALUE: Record<string, unknown> = {
  moneyMinor: '1000',
  number: 100,
  boolean: true,
  // A member of the only enum in the registry today. A wrong literal here would report a
  // failure against the KIND rather than against the machinery, which is why the value is
  // read from the field's own `options` below when it has them.
  enum: 'BUSINESS',
  lookupIds: ['019f9a10-0000-7000-8000-000000000001'],
};

describe('rule-kind params specs', () => {
  it('covers the registry, so an empty pass cannot be a false negative', () => {
    expect(Object.keys(RULE_KINDS).length).toBeGreaterThan(8);
  });

  it('declares a paramsSpec for every param its schema accepts', () => {
    /**
     * Which names does a schema actually DECLARE? Not readable from a parse result —
     * every one of these schemas is `.passthrough()`, so the output echoes unknown keys
     * and a naive check flags names the kind has never heard of. (First version of this
     * test did exactly that and accused RECEIPT_THRESHOLD of six mileage params.)
     *
     * Detected behaviourally instead, which also avoids depending on Zod's internal
     * `_def` shape across versions: a DECLARED key carries a type constraint and so
     * rejects a wrong-typed value, while a passthrough key accepts anything at all.
     */
    const WRONG_TYPE = { notAValidValueForAnyDeclaredParam: true };
    const declaresKey = (
      schema: { safeParse: (v: unknown) => { success: boolean } },
      key: string,
    ) =>
      schema.safeParse(PROBE).success && !schema.safeParse({ ...PROBE, [key]: WRONG_TYPE }).success;

    const offenders: string[] = [];
    for (const [code, kind] of Object.entries(RULE_KINDS)) {
      if (SPEC_EXEMPT.has(code)) continue;
      const declared = new Set((kind.paramsSpec ?? []).map((f) => f.name));
      for (const name of Object.keys(PROBE)) {
        if (declaresKey(kind.paramsSchema, name) && !declared.has(name)) {
          offenders.push(`${code}.${name}`);
        }
      }
    }
    expect(
      offenders,
      `These params are accepted by a kind's schema but have no paramsSpec entry, so an ` +
        `admin cannot set them and the rule saves inert:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('declares nothing a schema would reject', () => {
    /**
     * The mirror image: a spec field whose declared TYPE the schema refuses is a form
     * control that always fails on save.
     *
     * Each field is varied inside a complete payload rather than submitted alone — a
     * schema with a required sibling (AUDIT_THRESHOLD needs `thresholdMinor`) rejects a
     * lone optional field for a reason that says nothing about that field's type.
     */
    const offenders: string[] = [];
    for (const [code, kind] of Object.entries(RULE_KINDS)) {
      for (const field of kind.paramsSpec ?? []) {
        // An `enum` field declares its own legal values; use one of those rather than a
        // guess, so this test measures the schema and not the literal chosen here.
        const value =
          field.kind === 'enum' && field.options?.length
            ? field.options[0]
            : PROBE_VALUE[field.kind];
        if (!kind.paramsSchema.safeParse({ ...PROBE, [field.name]: value }).success) {
          offenders.push(`${code}.${field.name} (${field.kind})`);
        }
      }
    }
    expect(offenders, `Spec fields their own schema rejects:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('names only real param fields in paramsAtLeastOneOf', () => {
    const offenders: string[] = [];
    for (const [code, kind] of Object.entries(RULE_KINDS)) {
      const declared = new Set((kind.paramsSpec ?? []).map((f) => f.name));
      for (const name of kind.paramsAtLeastOneOf ?? []) {
        if (!declared.has(name)) offenders.push(`${code}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // VeloExpense: ExpenseOS's 'gives TRAVEL_CABIN_CLASS an editable cabin and job-level list'
  // pins a travel kind, which is not carried.

  it('gives AUDIT_THRESHOLD a money threshold and two switches', () => {
    // The kind this work was for, pinned concretely so a refactor of the generic
    // machinery cannot quietly drop it.
    const spec = RULE_KINDS.AUDIT_THRESHOLD.paramsSpec ?? [];
    expect(spec.find((f) => f.name === 'thresholdMinor')).toMatchObject({
      kind: 'moneyMinor',
      required: true,
    });
    // Both default ON, matching the evaluator's `!== false` reading of an absent param.
    expect(spec.find((f) => f.name === 'requirePurpose')).toMatchObject({
      kind: 'boolean',
      default: true,
    });
    expect(spec.find((f) => f.name === 'requireAttendees')).toMatchObject({
      kind: 'boolean',
      default: true,
    });
  });
});
