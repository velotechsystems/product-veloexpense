/**
 * `RULE_PARAM_COPY` covers every parameter every rule declares.
 *
 * ── WHY THIS IS A LOOP AND NOT A TYPE ──────────────────────────────────────
 *
 * Every other enum catalogue in `enums.ts` is an `EnumCopy<T>` over a union, and
 * gets coverage for free: the union is the key, so a missing member does not
 * compile. This one cannot be, and the reason is a real constraint rather than a
 * shortcut.
 *
 * Both parameters in the product are named `thresholdMinor`, and they are NOT
 * called the same thing — "Limit" on a per-transaction cap, "Only above" on a
 * receipt requirement. So the key has to be the PAIR, `<RuleKind>.<paramName>`,
 * and there is no union of pairs in the type system to key a `Record` on.
 *
 * What there IS, is `RULE_DEFINITIONS`, which enumerates every pair as data. So
 * coverage comes from the product's own enumeration after all — just through a
 * loop at test time instead of a type at compile time. Weaker in when it fires,
 * identical in what it guarantees.
 */
import { describe, it, expect } from 'vitest';
import { RULE_DEFINITIONS, RULE_KINDS } from '@/lib/policy/rules';
import { RULE_PARAM_COPY, ruleParamKey, enumLabel, missingCopyMarker } from '@/lib/i18n/catalog/enums';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@/lib/i18n/locales';

/** Every (kind, param) pair the product declares. */
const PAIRS = RULE_KINDS.flatMap((kind) =>
  RULE_DEFINITIONS[kind].params.map((spec) => ({ kind, name: spec.name })),
);

describe('every rule parameter has copy', () => {
  it('found some pairs at all', () => {
    // The vacuity guard. Every assertion below passes trivially against an empty
    // list, and a rule losing its params is exactly the edit that would empty it.
    expect(PAIRS.length).toBeGreaterThan(0);
  });

  it('each pair has an entry, in the default locale', () => {
    for (const { kind, name } of PAIRS) {
      const key = ruleParamKey(kind, name);
      expect(RULE_PARAM_COPY[key], `${key} has no copy`).toBeDefined();
      expect(RULE_PARAM_COPY[key][DEFAULT_LOCALE], `${key} has no ${DEFAULT_LOCALE}`).toBeTruthy();
    }
  });

  it('each pair resolves in every shipped locale, with no marker', () => {
    for (const { kind, name } of PAIRS) {
      const key = ruleParamKey(kind, name);
      for (const locale of SUPPORTED_LOCALES) {
        const text = enumLabel(RULE_PARAM_COPY, key, locale);
        expect(text, `${key} in ${locale}`).not.toBe('');
        expect(text, `${key} in ${locale}`).not.toBe(missingCopyMarker(key));
      }
    }
  });

  it('carries no copy for a pair no rule declares', () => {
    // The other direction, and the one a coverage test usually forgets: a key left
    // behind by a renamed parameter is dead copy that a translator still pays to
    // translate, and it makes the catalogue look more complete than it is.
    const declared = new Set(PAIRS.map(({ kind, name }) => ruleParamKey(kind, name)));
    const orphans = Object.keys(RULE_PARAM_COPY).filter((k) => !declared.has(k));
    expect(orphans, 'copy for parameters no rule has').toEqual([]);
  });

  it('the two same-named parameters are NOT the same words', () => {
    // The whole reason the key is a pair. If these ever coincide, somebody has
    // "simplified" the catalogue to be keyed by parameter name and the second
    // screen is now lying.
    expect(enumLabel(RULE_PARAM_COPY, 'PER_TRANSACTION_LIMIT.thresholdMinor', DEFAULT_LOCALE)).not.toBe(
      enumLabel(RULE_PARAM_COPY, 'RECEIPT_REQUIRED.thresholdMinor', DEFAULT_LOCALE),
    );
  });
});
