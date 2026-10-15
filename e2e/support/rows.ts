import { expect, type Page } from '@playwright/test';

/**
 * Clear a list's default filters, when it has any.
 *
 * Tolerant of the control's absence: most tables have no default filter, and a spec that
 * had to know which do would break every time one changed.
 */
export async function clearFilters(page: Page): Promise<void> {
  const clear = page.getByRole('button', { name: /clear filters/i }).first();
  /**
   * Eight seconds, not two.
   *
   * The control only exists once the table has rendered its default filter, which is
   * after the page's tRPC round trip. A short wait no-ops, the filter stays on, the row
   * stays hidden, and the enclosing poll re-navigates — resetting the table and losing
   * the race again on every attempt. It never converges, and reports "received ''" for
   * rows that are right there.
   */
  /**
   * Retried, and verified.
   *
   * One click was not enough: the control is rendered by a pill bar that re-mounts as the
   * table's own query settles, so a click can land on a node that is replaced a moment
   * later and the filter survives. The enclosing poll then reports "no row" forever while
   * the row sits one filter away — which is why the diagnostic below says so out loud.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await clear.isVisible({ timeout: 8_000 }).catch(() => false))) return;
    await clear.click().catch(() => {});
    if (
      await clear.waitFor({ state: 'detached', timeout: 4_000 }).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
  }
}

/**
 * Waiting for a list to reflect a change that happened somewhere else.
 *
 * Playwright's `expect(locator).toContainText` retries the QUERY, not the fetch. On a
 * tRPC-backed table the rows arrive once per navigation, so polling a loaded page waits
 * for a DOM that has no reason to change — thirty seconds of re-reading the same stale
 * row, then a failure that names the right value and the wrong cause.
 *
 * That is not hypothetical: it is how "the manager's approval did not take" was diagnosed
 * for half an hour, while the database had recorded APPROVED immediately.
 *
 * These reload between attempts, so what they poll is the server's answer.
 */

/** The row for a subject in whatever list is open, matched by any unique text it carries. */
export function rowFor(page: Page, tag: string) {
  return page.getByRole('row').filter({ hasText: tag }).first();
}

/**
 * The seam `<DataTable>` maintains across BOTH of its trees.
 *
 * `DataTable.tsx:516` puts it on the table's `<tr>`; `DataTableCards.tsx:364` puts it on the
 * card's `<li>`. The two `id` prefixes differ on purpose (`data-row-` / `data-card-`), which
 * is exactly what makes them useless as a shared selector and this attribute the one thing
 * that names "a row of this listing" whichever tree is mounted.
 */
const ROW_KEY_ATTR = 'data-dt-row-key';

/**
 * The row for a subject AT ANY WIDTH — and P06's answer to "does `role=\"row\"` survive the
 * DataTable card tree at 360?".
 *
 * IT DOES NOT, ON A LISTING THAT OPTED IN. Below `768px` `useIsCompact` is true, and a page
 * that named its card columns (`mobile.title`) gets `DataTableCards` instead of the table:
 * `<ul role="list">` of `<li aria-labelledby>`, which is `listitem`, not `row`. `/expenses`
 * is such a page (`ExpenseReportsList.tsx:616`), so `rowFor` above finds NOTHING there at
 * 360 or 390 and reports "no row for …; 0 rows rendered" about a list that rendered fine.
 *
 * AND IT DOES SURVIVE ON A LISTING THAT DID NOT. `/expenses/approvals` passes no `mobile`
 * config (`ExpenseApprovalsInbox.tsx:455`), so `hasCardConfig` is false, the table tree
 * mounts at every width and `role="row"` is still there. So the answer is per-listing, which
 * is the whole reason this is an attribute and not a second role: a spec must not have to
 * know which of the forty-two listings opted in, and must not go red the day one of them
 * does.
 *
 * `rowFor` is deliberately LEFT ALONE. Widening it to `row, listitem` would sweep in every
 * `<li>` on the page — the sidebar nav, a breadcrumb, a card's own field list — on ten
 * desktop specs that are correct as they stand.
 *
 * Exactly one tree is ever in the DOM (`DataTable.tsx:109-120` selects in JS and the classes
 * are only a pre-hydration cloak), so this can never match a row twice.
 */
export function anyRowFor(page: Page, tag: string) {
  return page.locator(`[${ROW_KEY_ATTR}]`).filter({ hasText: tag }).first();
}

/**
 * Reload `url` until the row for `tag` matches `pattern`.
 *
 * `prepare` runs after every navigation, before the row is read. It exists for lists that
 * arrive FILTERED: the virtual-card requests page defaults its own-requests table to
 * `status = PENDING`, which is right for a person looking at what is outstanding and wrong
 * for a test asserting that something became Rejected — the row is not stale, it is hidden.
 */
export async function expectRowEventually(
  page: Page,
  url: string,
  tag: string,
  pattern: RegExp,
  prepare?: (page: Page) => Promise<void>,
): Promise<void> {
  await pollRowText(page, url, tag, pattern, rowFor, countRoleRows, prepare);
}

/**
 * `expectRowEventually`, on a listing whose tree depends on the viewport.
 *
 * Same poll, same intervals, same diagnostics — only the row locator differs. See
 * `anyRowFor`.
 */
export async function expectAnyRowEventually(
  page: Page,
  url: string,
  tag: string,
  pattern: RegExp,
  prepare?: (page: Page) => Promise<void>,
): Promise<void> {
  await pollRowText(page, url, tag, pattern, anyRowFor, countKeyedRows, prepare);
}

/** Reload `url` until no row for `tag` is present. */
export async function expectRowGone(page: Page, url: string, tag: string): Promise<void> {
  await pollRowGone(page, url, tag, rowFor);
}

/** `expectRowGone`, on a listing whose tree depends on the viewport. See `anyRowFor`. */
export async function expectAnyRowGone(page: Page, url: string, tag: string): Promise<void> {
  await pollRowGone(page, url, tag, anyRowFor);
}

type RowResolver = (page: Page, tag: string) => ReturnType<typeof rowFor>;

const countRoleRows = (page: Page): Promise<number> => page.getByRole('row').count();
const countKeyedRows = (page: Page): Promise<number> => page.locator(`[${ROW_KEY_ATTR}]`).count();

/**
 * The body of both `expect…Eventually`s, shared rather than copied.
 *
 * Copied, the two would drift — and the thing that would drift is the diagnostic, which is
 * the only part of this file anybody reads at 2am.
 */
async function pollRowText(
  page: Page,
  url: string,
  tag: string,
  pattern: RegExp,
  resolve: RowResolver,
  countRows: (page: Page) => Promise<number>,
  prepare?: (page: Page) => Promise<void>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(url);
        if (prepare) await prepare(page);
        const row = resolve(page, tag);
        /**
         * Wait for the row WITHIN the attempt.
         *
         * `goto` resolves on `load`, and the table's rows arrive afterwards over tRPC.
         * Reading straight away returns nothing every time — the poll then reloads
         * forever and reports "received ''" for a row that renders reliably half a
         * second later. Swallowed on purpose: a missing row is this attempt failing,
         * not the poll failing.
         */
        await row.waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
        if ((await row.count()) === 0) {
          /**
           * Say WHY nothing was found, or the failure reads "received ''" and every cause
           * looks the same: a list still loading, a list filtered, and a row that is
           * genuinely absent are three different problems with three different fixes.
           */
          const rows = await countRows(page);
          const filtered = await page.getByRole('button', { name: /clear filters/i }).count();
          return `(no row for ${tag}; ${rows} rows rendered, ${filtered ? 'A FILTER IS ACTIVE' : 'no filter'})`;
        }
        return (await row.textContent()) ?? '';
      },
      {
        // Comfortably under the per-test timeout: a poll that can consume the whole
        // budget turns every genuine failure into an unhelpful "test timeout exceeded"
        // with no assertion message at all. Learned the hard way, at 45s each.
        timeout: 20_000,
        intervals: [400, 800, 1200, 2000, 2000, 3000],
        message: `the row for ${tag} on ${url} should eventually match ${pattern}`,
      },
    )
    .toMatch(pattern);
}

async function pollRowGone(
  page: Page,
  url: string,
  tag: string,
  resolve: RowResolver,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(url);
        const row = resolve(page, tag);
        // Give the table a chance to render BEFORE concluding the row is gone, or every
        // absence assertion passes on the first attempt against an empty page.
        await row.waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
        return row.count();
      },
      {
        timeout: 20_000,
        intervals: [400, 800, 1200, 2000, 2000, 3000],
        message: `the row for ${tag} should disappear from ${url}`,
      },
    )
    .toBe(0);
}
