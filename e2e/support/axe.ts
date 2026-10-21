import type { Page } from '@playwright/test';
import type { AxeResults, Result } from 'axe-core';

/**
 * axe-core in a real browser, with nothing added to install.
 *
 * `@axe-core/playwright` is the usual wrapper and it is NOT a dependency here; `axe-core`
 * is — a root devDependency, already driving `jest-axe` in the unit tests. The wrapper does
 * two things, inject the script and call `axe.run`, and those are the two lines below. What
 * the browser adds over jsdom is the one thing the unit tests could not check: colour
 * contrast.
 *
 * The specs are CommonJS at runtime — `e2e/package.json` declares no module type on purpose
 * — so the global `require` is the resolver, and `axe-core` publishes no `exports` map, so
 * the deep path is reachable.
 *
 * VeloExpense (eos batch 5): ExpenseOS's `e2e/support/axe.ts` (67db2e33), unchanged; its
 * first caller here is the route picker's spec.
 */
const AXE_SCRIPT = require.resolve('axe-core/axe.min.js');

/** The tags axe puts on the WCAG 2.1 A and AA rules. Best-practice rules are left out on
 *  purpose — they are opinions, and NFR-12 is a conformance claim — and so is `wcag22aa`:
 *  the claim is 2.1, and 2.2 rules would make it a different claim. */
export const WCAG_21_AA_TAGS: readonly string[] = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Runs axe's default-enabled rule set against the page as it stands and returns the raw
 *  results — violations AND incomplete, because the spec needs both. */
export async function runAxe(page: Page): Promise<AxeResults> {
  await page.addScriptTag({ path: AXE_SCRIPT });
  return page.evaluate(() => (window as unknown as { axe: typeof import('axe-core') }).axe.run());
}

const isWcag21Aa = (r: Result) => r.tags.some((t) => WCAG_21_AA_TAGS.includes(t));

/** The violations that count against WCAG 2.1 AA. */
export function wcagAaViolations(results: AxeResults): Result[] {
  return results.violations.filter(isWcag21Aa);
}

/** The WCAG 2.1 AA checks axe could not decide. This is where a colour contrast it could
 *  not compute ends up — a background image, a gradient, an element it could not see
 *  through — and a page whose contrast is "unknown" has not passed. Assert it empty too. */
export function wcagAaIncomplete(results: AxeResults): Result[] {
  return results.incomplete.filter(isWcag21Aa);
}

/** One line per result, so a red test names the rule and the element, not just a count.
 *  `target` nests for shadow DOM and iframes, hence the flatten. */
export function describeViolation(v: Result): string {
  const targets = v.nodes.map((n) => n.target.flat().join(' ')).join('; ');
  return `${v.id} (${v.impact ?? 'n/a'}): ${v.help} — ${targets}`;
}
