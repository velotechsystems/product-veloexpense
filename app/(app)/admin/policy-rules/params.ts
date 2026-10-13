/**
 * Rule-param conversion, in its own module.
 *
 * Split out so the tests can import it without pulling the component's graph, which
 * reaches `next-intl`'s navigation and therefore `next/navigation` — unresolvable under
 * vitest. Pure functions with no React and no i18n, which is also simply where they
 * belong.
 *
 * The dangerous part is money: a threshold is STORED in minor units as a digit string
 * (BigInt-safe past 2^53) and TYPED in major units. Reverse either direction and the
 * rule still saves, still validates, and fires at a hundred times the intended figure.
 */

import { majorToMinor, minorToMajorInput } from '@/lib/format';

export type ParamSpecField = {
  name: string;
  kind: 'moneyMinor' | 'number' | 'boolean' | 'enum' | 'lookupIds';
  required?: boolean;
  default?: boolean;
  /** `enum` only — the wire values, in the order the picker offers them. */
  options?: readonly string[];
  /** `lookupIds` only — which lookup table the picker draws its rows from. */
  entity?: 'jobLevel';
};

/**
 * The form's value for one param.
 *
 * `string[]` is here for `lookupIds`, and it is the reason this is a union rather than
 * `string | boolean`: an id SET held as a comma-joined string would have to be split and
 * re-joined at three call sites, and the first uuid containing a comma would be a very
 * confusing bug to find. (There is no such uuid. That is not a reason to depend on it.)
 */
export type ParamFormValue = string | boolean | string[];

/**
 * A stored `params` object → the form's string/boolean shape.
 *
 * Money arrives as a minor-unit digit string and is shown in MAJOR units, because a
 * threshold box that silently means cents is how you get a rule that fires at $10 when
 * somebody typed 1000 meaning $1,000.
 */
export function paramsToForm(
  spec: readonly ParamSpecField[],
  stored: unknown,
  currency: string,
): Record<string, ParamFormValue> {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const out: Record<string, ParamFormValue> = {};
  for (const f of spec) {
    const v = raw[f.name];
    if (f.kind === 'lookupIds') {
      // Non-strings dropped rather than coerced: a stray number in a uuid array is
      // corrupt data, and `String(7)` would send it back to the server as "7".
      out[f.name] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } else if (f.kind === 'boolean') {
      // Absent means the kind's documented default, not `false` — AUDIT_THRESHOLD
      // reads a missing switch as ON.
      out[f.name] = typeof v === 'boolean' ? v : (f.default ?? false);
    } else if (f.kind === 'moneyMinor') {
      // Stored as a digit STRING to stay BigInt-safe past 2^53; the display helper
      // takes a bigint, so parse rather than widen its signature.
      out[f.name] = typeof v === 'string' && v !== '' ? minorToMajorInput(BigInt(v), currency) : '';
    } else {
      out[f.name] = v == null ? '' : String(v);
    }
  }
  return out;
}

/** The form's shape → the payload `paramsSchema` validates. Omits blank optionals. */
export function formToParams(
  spec: readonly ParamSpecField[],
  form: Record<string, ParamFormValue>,
  currency: string,
  /** The reader's locale — `majorToMinor` parses the typed amount in it, so a
   *  rule threshold entered as `1 000,00` in FR-CA is read as 1000, not
   *  dropped. */
  locale: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec) {
    const v = form[f.name];
    if (f.kind === 'lookupIds') {
      /**
       * Always sent, INCLUDING when empty, where every other kind omits a blank.
       *
       * An empty allow-list is a real configuration and not an absent one: "first class
       * is nobody" is exactly `[]`. Omitting it would land on the schema's `.default([])`
       * and mean the same thing today, but only by coincidence — a kind that later reads
       * an absent list as "unrestricted" would silently invert the policy.
       */
      out[f.name] = Array.isArray(v) ? v : [];
      continue;
    }
    if (f.kind === 'boolean') {
      out[f.name] = Boolean(v);
      continue;
    }
    const text = Array.isArray(v) ? '' : String(v ?? '').trim();
    if (text === '') continue; // absent, rather than zero — zero is a real threshold
    if (f.kind === 'moneyMinor') {
      const minor = majorToMinor(text, currency, locale);
      if (minor != null) out[f.name] = minor.toString();
    } else if (f.kind === 'enum') {
      // The literal, verbatim. Not `Number(text)`, which is what the `else` below would
      // have done to it — a cabin name is not a quantity.
      out[f.name] = text;
    } else {
      const n = Number(text);
      if (Number.isFinite(n)) out[f.name] = n;
    }
  }
  return out;
}

/** Is every required param present, and any at-least-one-of group satisfied? */
export function paramsComplete(
  spec: readonly ParamSpecField[],
  atLeastOneOf: readonly string[],
  form: Record<string, ParamFormValue>,
): boolean {
  const filled = (name: string) => {
    const v = form[name];
    return Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '';
  };
  for (const f of spec) {
    // `lookupIds` is excluded alongside `boolean`: an empty allow-list is a valid
    // configuration (see `formToParams`), so requiring one filled would make "nobody may
    // book first class" unsaveable.
    if (f.kind !== 'boolean' && f.kind !== 'lookupIds' && f.required && !filled(f.name)) {
      return false;
    }
  }
  if (atLeastOneOf.length > 0 && !atLeastOneOf.some(filled)) return false;
  return true;
}
