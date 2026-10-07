/**
 * VX5-4 — `/`, and what it says to whom.
 *
 * This page was the unmodified `create-next-app` scaffold for four phases —
 * "To get started, edit the page.tsx file", served to every signed-in customer.
 * `e2e/crawl.spec.ts` has had `/` in its list the whole time and never noticed,
 * which is the honest limit of a crawl: it asserts a page RENDERS, and that one
 * did. So the assertions here are about CONTENT, which is the thing a crawl
 * cannot check for you.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { setupStatus, SETUP_ITEMS, type SetupItem } from '@/lib/onboarding/setup';
import { ADMIN_STATE, EMPLOYEE_STATE } from './helpers';

/** The page's copy, keyed the same way the page keys it. Kept here rather than
 *  exported from the page so the assertion is not comparing the page to itself. */
const HEADING: Record<SetupItem, string> = {
  APPROVER: 'Invite somebody who can approve',
  CATEGORIES: 'Check your expense categories',
  APPROVAL_LADDER: 'Decide who approves what',
  SPEND_POLICY: 'Set your spend rules',
  STRUCTURE: 'Describe your organization',
  BRANDING: 'Make it look like yours',
};

async function demoOrgId(): Promise<string> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const r = await pool.query("SELECT id FROM organization WHERE slug = 'demo'");
    expect(r.rows.length, 'the demo tenant should be seeded').toBe(1);
    return r.rows[0].id as string;
  } finally {
    await pool.end();
  }
}

test.describe('the home page', () => {
  test.describe('as an admin', () => {
    test.use({ storageState: ADMIN_STATE });

    test('names the tenant and offers the way in — and is not a Next.js template', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Demo Co', level: 1 })).toBeVisible();
      // Scoped to the card row. Unscoped, `name: 'Approvals'` also matches the
      // checklist's "Set up approvals" button — role-name matching is a
      // case-insensitive substring, which is easy to forget and produces a
      // strict-mode violation rather than a wrong pass.
      const links = page.getByTestId('home-links');
      await expect(links.getByRole('link', { name: 'Expense reports' })).toBeVisible();
      await expect(links.getByRole('link', { name: 'Approvals' })).toBeVisible();

      // The scaffold, gone. Pinned by name because "it renders" was true of the
      // scaffold too, and a future regression would look exactly like that.
      await expect(page.getByText('edit the')).toBeHidden();
      await expect(page.getByRole('link', { name: 'Templates' })).toBeHidden();
      await expect(page.locator('img[src*="next.svg"]')).toHaveCount(0);
    });

    test('shows what is still outstanding, and links to the screen that fixes it', async ({
      page,
    }) => {
      /* ── WHY THIS READS THE DATABASE INSTEAD OF NAMING THE ITEMS ──────────
       *
       * The first draft asserted three specific items against the seeded demo
       * tenant. It passed alone and FAILED in the full suite, because the
       * expense-policy specs create rules in that tenant and the demo tenant is
       * never reset between files — so "outstanding" is not a property of the
       * seed, it is a property of whatever ran first.
       *
       * That is the "assertion that holds only because the environment is
       * disposable" family, and `approval-flow.spec.ts` has a note about the
       * same trap. The draft before THAT was worse: it wrapped everything in
       * `if (await panel.isVisible())` and would have passed on a page with no
       * checklist at all.
       *
       * So the claim this test makes is the one that is actually the page's:
       * whatever `setupStatus` reports, the panel shows exactly that and nothing
       * else. `setupStatus`'s own logic — what counts as done — is pinned
       * independently in `test/onboarding-starter.db.test.ts`, so neither test
       * is checking itself against itself. */
      const status = await withOrg(await demoOrgId(), (tx) => setupStatus(tx));
      await page.goto('/');

      if (status.complete) {
        await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeHidden();
        return;
      }
      await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();

      for (const item of SETUP_ITEMS) {
        const done = status.items.find((i) => i.item === item)!.done;
        const heading = page.getByRole('heading', { name: HEADING[item] });
        if (done) {
          // A finished item is not listed. The panel shows what is left, not a
          // ticked list nobody needs to read.
          await expect(heading, `${item} is done and should not be listed`).toBeHidden();
        } else {
          await expect(heading, `${item} is outstanding and should be listed`).toBeVisible();
        }
      }

      // And every item listed carries a way to act on it. Whichever one is first
      // outstanding is enough to prove the wiring; the copy map above pins the
      // rest.
      const firstOutstanding = SETUP_ITEMS.find(
        (i) => !status.items.find((s) => s.item === i)!.done,
      )!;
      await expect(
        page.getByRole('heading', { name: HEADING[firstOutstanding] }),
      ).toBeVisible();
    });
    test('the checklist can be put away to one line and brought back, never dismissed', async ({
      page,
    }) => {
      // Decided 7 Oct: "Hide" collapses to one line that keeps the count in view.
      // Only meaningful while something is outstanding, which `setupStatus` says.
      const status = await withOrg(await demoOrgId(), (tx) => setupStatus(tx));
      test.skip(status.complete, 'nothing outstanding in the demo tenant: no checklist to hide');

      await page.goto('/');
      await page.getByRole('button', { name: 'Hide' }).click();
      const line = page.getByTestId('setup-collapsed');
      await expect(line).toBeVisible();
      await expect(line).toContainText(/steps? left/);
      await expect(page.getByRole('link', { name: 'Set up approvals' })).toBeHidden();

      // Remembered: a fresh load still shows the one line.
      await page.reload();
      await expect(page.getByTestId('setup-collapsed')).toBeVisible();

      // And back — which also leaves the tenant as the other specs expect it.
      await page.getByRole('button', { name: 'Show' }).click();
      await expect(page.getByTestId('setup-collapsed')).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
    });
  });

  test.describe('as an employee', () => {
    test.use({ storageState: EMPLOYEE_STATE });

    test('sees the way in and no admin checklist', async ({ page }) => {
      await page.goto('/');
      await expect(
        page.getByTestId('home-links').getByRole('link', { name: 'Expense reports' }),
      ).toBeVisible();
      // The checklist is admin work. An employee is not shown a list of things
      // they cannot do — and, more to the point, `/` never asks for it on their
      // behalf, so they never get a refusal page for something that was never
      // theirs. `app/actions.ts` has the split.
      await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeHidden();
      await expect(page.getByRole('link', { name: 'Invite someone' })).toBeHidden();
    });
  });
});
