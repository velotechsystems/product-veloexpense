import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ACTORS, type Actor, signIn } from './support/actors';
import { crawlableRoutes } from './support/routes';

/*
 * VeloExpense: ExpenseOS's `e2e/interact-roles.spec.ts` (1e682dd6), ported with the role-matrix
 * people (`scripts/seed.mjs`). Two changes, marked: no locale in a URL (English only,
 * `i18n/request.ts`), and the roles are VeloExpense's seven actors (`e2e/support/actors.ts`).
 */

/**
 * Click the controls on every page, as every seeded role, and report what breaks.
 *
 * `crawl.spec.ts` has a controls pass already — as the admin, on six buttons per route.
 * This is the same idea widened along the axis that matters: the person doing the
 * clicking. A dialog that reads `data.rows[0].name` is fine for somebody whose query
 * returned rows and throws for somebody whose permissions returned none, and only one of
 * those two people has ever opened it.
 *
 * NON-DESTRUCTIVE ONLY. `SAFE_CLICK` is an allowlist of things that open, filter or
 * reveal; `NEVER_CLICK` vetoes anything that writes, removes or decides, and the veto is
 * applied after the allowlist so a name matching both is refused. A crawler let loose on
 * a UI that can delete a legal entity or approve a report would destroy its own fixtures
 * and then report whatever it happened to hit.
 *
 * Escape between clicks rather than a re-navigation: re-loading the page for every button
 * is the correct-but-slow version, and with nine roles it turns a five-minute pass into an
 * hour. Escape closes base-ui dialogs, drawers and popovers; the visibility check before
 * each click is what catches the case where it did not.
 *
 * WHAT A GREEN RUN MEANS: no control on any page, for any role, threw or produced an
 * error boundary. NOT that any of them did the right thing — that needs a spec that knows
 * the feature.
 */

// VeloExpense: English only and no locale segment, so `LOCALE` names the report and no URL.
const LOCALE = process.env.E2E_LOCALE ?? 'en';
const REPORT = LOCALE === 'en' ? 'e2e-role-interact.md' : `e2e-role-interact.${LOCALE}.md`;

/** Route discovery and the shell-exclusion set are shared with `crawl.spec.ts` and
 *  `crawl-roles.spec.ts` — see `support/routes.ts`, which carries the reasoning for every
 *  excluded route. This file used to keep its own copy of the set that was one entry
 *  short: it walked `/offline`, which the other two already excluded. Sharing the set
 *  drops it here too, which costs nothing — that page has no `<button>` and no `<tab>`,
 *  so it contributed zero clicks. */
const ROUTES = crawlableRoutes();
const ROLES = Object.keys(ACTORS) as Actor[];

/** Opens, filters or reveals. Never writes. */
const SAFE_CLICK =
  /^(add|new|create|edit|settings|filter|group|export|columns|refresh|view|open|expand|show|details|search|preview|sort|manage|configure)\b/i;
/**
 * Applied AFTER the allowlist, so "Add and submit" is refused rather than admitted.
 *
 * `print` is on it for a different reason from the rest: it is not destructive, it opens
 * a `window.open` print view. Headless Chrome never fires `afterprint`, so the handler
 * that closes that window never runs and the tabs accumulate for the rest of the pass.
 */
const NEVER_CLICK =
  /(delete|remove|archive|submit|approve|reject|deactivate|revoke|close|freeze|cancel|reset|sign out|log out|purge|run|send|post|push|sync|issue|pay|reimburse|decide|return|withdraw|recall|apply|save|confirm|print)/i;

/** How many controls to try per page. Enough to reach a page's real affordances without
 *  turning nine roles into an hour. */
const MAX_CLICKS = 5;

interface Finding {
  actor: Actor;
  route: string;
  control: string;
  detail: string;
}
const findings: Finding[] = [];
let clicks = 0;
const tabsOpened: { actor: Actor; route: string; count: number }[] = [];

test.describe('every role, every control', () => {
  for (const actor of ROLES) {
    test(`${actor} can click every control without breaking one`, async ({ page }) => {
      test.setTimeout(900_000);
      await signIn(page, actor);

      for (const route of ROUTES) {
        // VeloExpense: no locale segment.
        const url = route;

        // Tear the previous page down before listening, so its cancelled in-flight
        // requests are not charged to this route's controls.
        await page.goto('about:blank');
        await page.waitForTimeout(120);

        const thrown: string[] = [];
        const onPageError = (e: Error) => thrown.push(String(e.message).slice(0, 160));
        page.on('pageerror', onPageError);

        const res = await page
          .goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => null);
        const status = res?.status() ?? 0;
        // Gated for this role — the render crawl records that; there is nothing to click.
        if (status === 0 || status >= 400) {
          page.off('pageerror', onPageError);
          continue;
        }
        await page.waitForTimeout(700);

        /**
         * Tabs first, because they reveal controls that do not exist until their panel is
         * shown — a page whose second tab throws looks perfectly healthy to a crawler that
         * only ever sees the first.
         */
        const tabs = page.getByRole('tab');
        const tabCount = await tabs.count().catch(() => 0);
        if (tabCount > 1) {
          tabsOpened.push({ actor, route, count: tabCount });
          for (let i = 0; i < Math.min(tabCount, 6); i += 1) {
            const tab = tabs.nth(i);
            if (!(await tab.isVisible().catch(() => false))) continue;
            await tab.click({ timeout: 4_000 }).catch(() => undefined);
            await page.waitForTimeout(350);
            const body =
              (await page
                .locator('body')
                .innerText()
                .catch(() => '')) ?? '';
            if (/application error|unhandled runtime error|something went wrong/i.test(body)) {
              findings.push({
                actor,
                route,
                control: `tab #${i + 1}`,
                detail: 'produced an error page',
              });
            }
          }
        }

        const names = await page
          .getByRole('button')
          .evaluateAll((els) =>
            els
              .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
              .filter(Boolean),
          )
          .catch(() => [] as string[]);
        const clickable = [...new Set(names)]
          .filter((n) => SAFE_CLICK.test(n) && !NEVER_CLICK.test(n))
          .slice(0, MAX_CLICKS);

        for (const name of clickable) {
          const button = page.getByRole('button', { name, exact: true }).first();
          if (!(await button.isVisible().catch(() => false))) continue;
          if (!(await button.isEnabled().catch(() => false))) continue;
          await button.click({ timeout: 5_000 }).catch(() => undefined);
          clicks += 1;
          await page.waitForTimeout(450);

          const body =
            (await page
              .locator('body')
              .innerText()
              .catch(() => '')) ?? '';
          if (/application error|unhandled runtime error|something went wrong/i.test(body)) {
            findings.push({ actor, route, control: name, detail: 'produced an error page' });
          }

          // Close whatever opened, so the next control is not clicked through an overlay.
          await page.keyboard.press('Escape').catch(() => undefined);
          await page.waitForTimeout(200);
        }

        page.off('pageerror', onPageError);
        for (const detail of thrown) {
          findings.push({ actor, route, control: '(while clicking)', detail: `threw: ${detail}` });
        }
      }

      const mine = findings.filter((f) => f.actor === actor);
      expect(
        mine,
        `${actor}: ${mine.length} control(s) broke — ` +
          mine.map((f) => `${f.route} "${f.control}" ${f.detail}`).join(' | '),
      ).toHaveLength(0);
    });
  }

  test.afterAll(() => {
    const lines: string[] = [
      `# Control interaction — every page, as every seeded role (${LOCALE})`,
      '',
      `Roles: ${ROLES.length} · Routes each: ${ROUTES.length} · Controls clicked: ${clicks}`,
      `Tabbed pages exercised: ${tabsOpened.length} · Findings: ${findings.length}`,
      '',
      'Non-destructive controls only — things that open, filter or reveal. Nothing that',
      'writes, removes or decides is ever clicked.',
      '',
    ];
    if (findings.length) {
      lines.push('## What broke', '', '| Role | Route | Control | Detail |', '|---|---|---|---|');
      for (const f of findings) {
        lines.push(
          `| ${f.actor} | \`${f.route}\` | ${f.control.replace(/\|/g, '\\|')} | ${f.detail.replace(/\|/g, '\\|')} |`,
        );
      }
    } else {
      lines.push(
        'Nothing broke. No control on any page, for any role, threw or produced an error',
        'boundary.',
        '',
        'This says nothing about whether any of them did the right thing.',
      );
    }
    writeFileSync(REPORT, `${lines.join('\n')}\n`);
    console.log(
      `\ncontrol interaction → ${REPORT} (${findings.length} findings, ${clicks} clicks)`,
    );
  });
});
