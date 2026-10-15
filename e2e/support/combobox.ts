import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Choosing from a combobox whose options arrive over the network.
 *
 * `e2e/card-operations.spec.ts` already has a `pickOption` for a PRELOADED combobox: click
 * the trigger, wait for the option in the page-level portal, click it. That is the right
 * shape and it is not enough here.
 *
 * The expense workbench's currency picker is fed by `expenses.currencies`, a separate tRPC
 * query from the one that renders the page. Open the control before that query settles and
 * base-ui gets an EMPTY item list — and an empty combobox does not render a listbox at all,
 * so the wait for an option never resolves however long it is given. That is not a
 * hypothetical: an earlier version of this helper was a plain click-then-wait, and it sat
 * for the full five-minute test timeout on `getByRole('option', { name: 'USD' })` while the
 * two currencies were one re-open away. The failure reads as "the app has no USD", which is
 * the wrong conclusion entirely.
 *
 * So the OPEN is what retries, not just the query. Escape between attempts, because a
 * control left open swallows the next click.
 */
export async function pickCombobox(
  page: Page,
  control: Locator,
  option: string | RegExp,
): Promise<void> {
  const wanted = page.getByRole('option', { name: option });
  await expect
    .poll(
      async () => {
        if (
          !(await wanted
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false))
        ) {
          await control.click().catch(() => {});
          await wanted
            .first()
            .waitFor({ state: 'visible', timeout: 3_000 })
            .catch(() => {});
        }
        /**
         * The press happens INSIDE the attempt, not after the poll agrees.
         *
         * Splitting them looks tidier and loses: the listbox re-renders as its query
         * refetches, so an option that was visible when the poll returned is detached by
         * the time the click lands — "element was detached from the DOM, retrying",
         * forever, on an option that is right there. Whether the click LANDED is the only
         * honest success condition.
         */
        const landed = await wanted
          .first()
          .click({ timeout: 2_500 })
          .then(
            () => true,
            () => false,
          );
        if (!landed) await page.keyboard.press('Escape').catch(() => {});
        return landed;
      },
      {
        timeout: 25_000,
        intervals: [300, 600, 1_000, 2_000, 2_000, 3_000],
        message: `the combobox should offer an option matching ${String(option)}`,
      },
    )
    .toBe(true);
}
