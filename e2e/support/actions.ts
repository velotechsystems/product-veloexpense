import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Pressing a drawer or dialog action, and knowing it landed.
 *
 * Every mutation in this app closes its drawer or dialog on success, so the control
 * DETACHING is the acknowledgement. Two failures live here, and both were diagnosed the
 * long way round before this helper existed:
 *
 *   · **A press that is never acknowledged.** Clicking and navigating on immediately
 *     cancels the request in flight. The click reports success, nothing is written, and
 *     the failure surfaces two steps later as "the status never changed" — which points
 *     at the server rather than at the press.
 *   · **A press that was refused.** An earlier version accepted a DISABLED button as
 *     acknowledgement, so a confirm that never enabled — a required note left empty —
 *     reported success and failed later on the status. A disabled control is the
 *     precondition, never the outcome.
 */

/**
 * Press `name` and wait for it to go away.
 *
 * `scope` matters when a label is ambiguous: "Issue card" names both the button in the row
 * and the dialog's submit, and the row's copy stays in the DOM behind the dialog — so an
 * unscoped wait for detachment can never succeed however well the press worked.
 */
export async function pressAndSettle(
  page: Page,
  name: string | RegExp,
  scope?: Locator,
): Promise<void> {
  const button = (scope ?? page).getByRole('button', { name, exact: typeof name === 'string' });
  await expect(button.first(), `"${String(name)}" should be pressable`).toBeEnabled({
    timeout: 30_000,
  });
  await button.first().click();

  /**
   * One retry, and only while the control is still ENABLED.
   *
   * React re-renders these drawers as their queries settle, so a click can arrive at a
   * node that has already been replaced — the browser reports a successful click on a
   * detached listener and nothing happens. Re-pressing is safe precisely because the
   * button is still enabled: an in-flight mutation disables it, and a completed one
   * removes it, so "still enabled" means nothing has started.
   */
  const settled = await button.waitFor({ state: 'detached', timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (!settled && (await button.count()) > 0 && (await button.first().isEnabled())) {
    await button.first().click();
  }

  await expect
    .poll(async () => button.count(), {
      timeout: 20_000,
      message: `the "${String(name)}" action should be acknowledged — the control should go away`,
    })
    .toBe(0);
}
