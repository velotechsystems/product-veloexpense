/**
 * Every checkbox and radio on the ported admin drawers has an accessible name (flag f10).
 *
 * Base UI's checkbox and radio are a `<span role=…>` beside a hidden `<input>`, and a
 * `<label>` — wrapping or `for=` — names only the input, which is aria-hidden. So a
 * screen reader announced "checkbox, not checked" with nothing to say what it was for.
 * The browser is the only place the accessible name is computed for real, so this is an
 * e2e: it opens each create drawer and asks for the name of every such control in it.
 */
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './helpers';

const SCREENS: Array<{ path: string; add: string }> = [
  { path: '/admin/expense-categories', add: 'Add category' },
  { path: '/admin/business-units', add: 'Add business unit' },
  { path: '/admin/job-levels', add: 'Add level' },
  { path: '/admin/fiscal-years', add: 'Add fiscal year' },
  { path: '/admin/mileage-rates', add: 'Add rate' },
  { path: '/admin/per-diem-rates', add: 'Add rate' },
  { path: '/admin/policy-rules', add: 'New Rule' },
];

async function unnamedControls(page: Page): Promise<string[]> {
  const dialog = page.getByRole('dialog');
  const out: string[] = [];
  for (const role of ['checkbox', 'radio'] as const) {
    const controls = dialog.getByRole(role);
    const n = await controls.count();
    for (let i = 0; i < n; i += 1) {
      const name = (await controls.nth(i).evaluate((el) => {
        // The name a screen reader gets: aria-labelledby, then aria-label.
        const by = el.getAttribute('aria-labelledby');
        if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        return el.getAttribute('aria-label') ?? '';
      })).trim();
      if (!name) out.push(`${role} #${i + 1}`);
    }
  }
  return out;
}

test.describe('as an admin', () => {
  test.use({ storageState: ADMIN_STATE });

  for (const screen of SCREENS) {
    test(`every checkbox and radio in ${screen.path}'s drawer has a name`, async ({ page }) => {
      await page.goto(screen.path);
      await page.getByRole('button', { name: screen.add }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const controls = page.getByRole('dialog').getByRole('checkbox').or(page.getByRole('dialog').getByRole('radio'));
      await expect(controls.first()).toBeVisible();
      expect(await unnamedControls(page), screen.path).toEqual([]);
      // And Playwright's own reading of the accessibility tree agrees, for the first one.
      await expect(controls.first()).toHaveAccessibleName(/\S/);
    });
  }
});
