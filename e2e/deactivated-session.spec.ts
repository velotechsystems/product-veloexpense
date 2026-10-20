/**
 * f04 — a signed-in person whose account is deactivated (or whose access is turned off)
 * while their session is still open.
 *
 * The flag said they got a 500 on `/`. By 20 Oct that was gone, but what replaced it was
 * not right either: `/` and `/dashboard` were a blank 200 and `/expenses` told them "That
 * is an administrator screen", which is not what happened to them. Now every page shows
 * why, with a way to sign out (app/account-unavailable.tsx, drawn by the root layout).
 *
 * ExpenseOS signs such a person out (its session callback returns null on `deletedAt`) and
 * the layout sends them to /login; VeloExpense's shared auth kit has no such hook, so the
 * page says it and the button does the signing out.
 *
 * Uses the seeded employee and puts them back afterwards, as seat-push.spec does.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

const EMPLOYEE_STATE = 'e2e/.auth/employee.json';
const EMPLOYEE = 'employee@demo.test';

async function sql(text: string, values: unknown[] = []) {
  const pool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    await pool.query(text, values);
  } finally {
    await pool.end();
  }
}

const restore = () =>
  sql(`UPDATE app_user SET employee_status = 'ACTIVE', deleted_at = NULL, has_access = true WHERE email = $1`, [
    EMPLOYEE,
  ]);

test.describe.configure({ mode: 'serial' });
test.afterEach(restore);

test('a deactivated account is told so on every page, not shown a blank page or an error', async ({ browser }) => {
  await sql(`UPDATE app_user SET employee_status = 'DEACTIVATED', deleted_at = now() WHERE email = $1`, [EMPLOYEE]);
  const ctx = await browser.newContext({ storageState: EMPLOYEE_STATE });
  const page = await ctx.newPage();
  for (const path of ['/', '/dashboard', '/expenses']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(500);
    await expect(page.getByTestId('account-unavailable-reason'), path).toHaveText(
      /This account has been deactivated/,
    );
    await expect(page.getByText('That is an administrator screen')).toHaveCount(0);
  }
  // The way out: signing out lands on the sign-in page.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test('access turned off says that instead', async ({ browser }) => {
  await sql(`UPDATE app_user SET has_access = false WHERE email = $1`, [EMPLOYEE]);
  const ctx = await browser.newContext({ storageState: EMPLOYEE_STATE });
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page.getByTestId('account-unavailable-reason')).toHaveText(
    /access to this organization has been turned off/,
  );
  await ctx.close();
});

test('an active employee sees their dashboard, not the refusal', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: EMPLOYEE_STATE });
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByTestId('account-unavailable-reason')).toHaveCount(0);
  await ctx.close();
});
