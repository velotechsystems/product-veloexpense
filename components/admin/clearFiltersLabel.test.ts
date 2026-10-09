import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `FilterPillBar` passes a translated clear-filters label.
 *
 * `FilterPillBar` has always accepted `clearLabel`, defaulting to the English
 * "Clear filters" — and 29 of its 30 call sites never passed one. So the one
 * untranslated string left in the product rendered on every listing page in a
 * French session, while `check-coverage` reported full EN/FR-CA parity, because a
 * hardcoded default is not a missing catalog key.
 *
 * That is the gap this closes: a source scan, because no runtime test can see a
 * default that nobody overrode, and `check-coverage` structurally cannot. It is
 * deliberately mechanical — the failure mode is somebody adding call site 31.
 */

// VeloExpense: there is no apps/web/src — the app's source is the repo's `app/` and
// `components/`.
const ROOT = join(__dirname, '..', '..');
const WEB_SRC_DIRS = [join(ROOT, 'app'), join(ROOT, 'components')];
// …and the design system ExpenseOS keeps in packages/design-system lives here under
// components/data-display and components/ui, so those are left out as ExpenseOS's are.
const DESIGN_SYSTEM = [join(ROOT, 'components', 'data-display'), join(ROOT, 'components', 'ui')];
const allTsx = () =>
  WEB_SRC_DIRS.flatMap((d) => tsxFiles(d)).filter((f) => !DESIGN_SYSTEM.some((ds) => f.startsWith(ds)));
const rel = (f: string) => f.slice(ROOT.length + 1);

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.next')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Files that render a FilterPillBar, excluding tests and type declarations. */
function callSites(): { file: string; source: string }[] {
  return allTsx()
    .filter((f) => !f.includes('.test.'))
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => source.includes('<FilterPillBar'));
}

describe('FilterPillBar clear-filters label', () => {
  it('is passed at every call site', () => {
    const missing = callSites()
      .filter(({ source }) => !source.includes('clearLabel'))
      .map(({ file }) => rel(file));
    expect(
      missing,
      `these render a FilterPillBar without clearLabel:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('finds call sites at all, so an empty pass cannot be a false negative', () => {
    // Without this, renaming the component would make the test above vacuously
    // green — the exact way a source-scanning test rots.
    // VeloExpense: ExpenseOS's floor is 10; the screens ported so far hold fewer, so the
    // floor here is what Wave 1 has — raise it as screens arrive.
    expect(callSites().length).toBeGreaterThan(5);
  });

  it('never reintroduces the literal in an app component', () => {
    // The label belongs in the catalog. A literal here means somebody worked
    // around the prop rather than through it.
    const offenders = allTsx()
      .filter((f) => !f.includes('.test.'))
      .filter((f) => readFileSync(f, 'utf8').includes("'Clear filters'"))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
