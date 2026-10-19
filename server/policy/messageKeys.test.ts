// Ported from ExpenseOS `apps/web/src/server/policy/messageKeys.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". Its travel cases were left out then and restored by w6-01.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_KINDS } from './kinds';

/**
 * Every rule the engine can raise must have a sentence to say.
 *
 * A violation renders through `policy.labels.<messageKey>` with a fallback to the RAW KEY,
 * so a rule whose label was never written does not throw, does not warn, and does not fail
 * any existing gate — it just puts the identifier on screen. A claimant reading
 *
 *     Warning: perDiemRate
 *
 * has been told nothing, and the report still blocks or warns exactly as designed.
 *
 * That is not hypothetical: `perDiemRate` shipped with no label in EITHER locale, under a
 * source comment reading "Matches the pre-existing per-diem translation key" — an assertion
 * about the catalogs that was simply untrue, and that nothing checked.
 *
 * The i18n gates could not catch it. `check-coverage` compares EN against FR-CA, and this
 * key was absent from BOTH, so they agreed. `check-used-keys` looks for `t('literal')` call
 * sites, and this one is composed at runtime from a rule's `messageKey`. The keys are only
 * knowable by reading the rule registry, which is what this test does.
 */

/** Every messageKey a rule kind can raise, de-duplicated. */
function messageKeys(): string[] {
  return [...new Set(Object.values(RULE_KINDS).map((k) => k.messageKey))];
}

/**
 * Resolve a key that may carry dots.
 *
 * `policy.generic` is the engine's last-resort messageKey, and the renderer looks it up as
 * `policy.labels.policy.generic` — a NESTED path, not a flat one. A check that only tried
 * `labels[key]` would report it missing forever, or be silenced by excluding it, and either
 * way would stop describing what a person actually sees.
 */
function resolve_(labels: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      labels,
    );
}

const CATALOGS = ['en', 'fr-CA'] as const;

function labelsFor(locale: string): Record<string, string> {
  // Resolved from the repo root, which is where vitest runs (its config sits there) —
  // `new URL(..., import.meta.url)` counts the file itself as a segment and is easy to get
  // wrong by one level, silently reading nothing.
  const raw = readFileSync(
    resolve(process.cwd(), `packages/i18n/src/catalogs/${locale}/expenses.json`),
    'utf8',
  );
  return (JSON.parse(raw) as { policy: { labels: Record<string, string> } }).policy.labels;
}

describe('policy message keys', () => {
  it.each(CATALOGS)('every rule kind has a %s label', (locale) => {
    const labels = labelsFor(locale);
    const missing = messageKeys().filter((key) => !resolve_(labels, key));
    expect(missing, `rules with no ${locale} label — they render as the raw key`).toEqual([]);
  });

  it('names a rule that has no label, rather than just failing', () => {
    /**
     * The diagnostic itself, because "expected [ 'perDiemRate' ] to equal []" is what makes
     * this actionable at 2am and "expected false to be true" is not.
     */
    const labels = { ...labelsFor('en') };
    delete labels.perDiemRate;
    const missing = messageKeys().filter((key) => !resolve_(labels, key));
    expect(missing).toContain('perDiemRate');
  });
});
