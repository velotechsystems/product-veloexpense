import { expect, test } from '@playwright/test';
import { assertProject } from './support/tap-targets';
import { PHONE_PROJECTS } from './support/phone-projects';

/**
 * f26 at a phone width: the /preferences card fits and says what it says on a desktop.
 * The e2e server receives no mail, so this is the not-configured face (see
 * `receipts-email.spec.ts` for why, and where the configured face is pinned).
 */

test('the receipts-email card fits a phone and says it is not set up', async ({ page }, info) => {
  assertProject(info, PHONE_PROJECTS);
  await page.goto('/preferences');
  const card = page.getByTestId('receipts-email-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('receipts-email-not-configured')).toBeVisible();
  const box = await card.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
