import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ACTORS, type Actor, signIn } from './support/actors';
import { IGNORED_CONSOLE as SHARED_IGNORED_CONSOLE } from './support/console-noise';
import { crawlableRoutes } from './support/routes';

/**
 * VeloExpense: ExpenseOS's `e2e/crawl-roles.spec.ts` (1e682dd6), ported with the role-matrix
 * people (`scripts/seed.mjs`). Two changes, marked where they are made: there is no locale in
 * a URL (VeloExpense offers English only, `i18n/request.ts`), and the roles are VeloExpense's
 * seven actors (`e2e/support/actors.ts`) rather than ExpenseOS's nine. ExpenseOS's
 * `crawl.spec.ts`, which this header compares itself to, is VeloExpense's `e2e/crawl.spec.ts`.
 *
 * Walk every page as EVERY seeded role, and report what is broken for whom.
 *
 * `crawl.spec.ts` already walks every route — as one person, the admin whose session the
 * default storage state holds. That is the reader for whom the app is least likely to
 * break: an admin holds every permission, so every query they issue is answered, every
 * gate they meet is open, and the whole class of "this screen assumes data the caller is
 * not allowed to see" is invisible to them.
 *
 * That class is not hypothetical here. The GA audit was run entirely as a system admin
 * and said so; UAT then ran as a super user for the same reason ("we did super user
 * because it doesn't always work correctly swapping between the QA roles"). So on the two
 * occasions this product has been examined end-to-end by a person, both examined it as
 * the one role that cannot see permission-shaped bugs. Nine roles are seeded and eight of
 * them had never had their pages opened.
 *
 * WHAT A GREEN RUN MEANS. Every route, for every role, either renders without a server
 * error / error boundary / uncaught exception, or is refused cleanly (404 from a module
 * gate, or the app's own not-found). Console is clean, no visible field shows a raw uuid,
 * and every link the role's own sidebar offers them resolves.
 *
 * WHAT IT DOES NOT MEAN. That any control does the right thing — that is per-feature
 * intent and belongs in a spec that knows the feature. And a refusal is only checked for
 * being CLEAN, not for being CORRECT: whether an ap-clerk should be able to reach
 * /admin/roles is `permissions.spec.ts`'s question, not this file's. This one asks
 * "does anything catch fire", role by role.
 *
 * Reported as a matrix (`e2e-role-crawl.md`), because the interesting output is not a
 * list of failures — it is which cells of role × route differ from the admin column.
 */

/**
 * Which locale to walk. `E2E_LOCALE=fr-CA` walks the French half.
 *
 * Worth its own dimension rather than a spot check, because a missing catalog key is not
 * cosmetic here: next-intl RAISES on one, the component throws, and the page goes blank.
 * Two shipped that way — `notifications.prefs.catTitle.budgetThreshold` and
 * `workflows.subject.TRAVEL_REQUEST` — and neither could be caught by
 * `check-used-keys`, which scans for LITERAL keys and so cannot see an interpolated
 * `t(`catTitle.${key}`)`. Only opening the page in that locale finds them.
 *
 * The report is named per locale so an fr-CA run does not overwrite the English one.
 */
// VeloExpense: English only and no locale segment, so `LOCALE` names the report and no URL.
const LOCALE = process.env.E2E_LOCALE ?? 'en';
const REPORT = LOCALE === 'en' ? 'e2e-role-crawl.md' : `e2e-role-crawl.${LOCALE}.md`;

/** Route discovery and the shell-exclusion set are shared with `crawl.spec.ts` and
 *  `interact-roles.spec.ts` — see `support/routes.ts`, which carries the reasoning for
 *  every excluded route. */
const ROUTES = crawlableRoutes();

const ROLES = Object.keys(ACTORS) as Actor[];

/**
 * Noise that says nothing about the app's health. Deliberately short: a missing i18n key
 * is NOT on it, because two live bugs sat in this console output while it was — the shared
 * list in `support/console-noise.ts` carries that history and is the only copy now.
 *
 * THE FAVICON ENTRY IS THIS SPEC'S ALONE and is not in the shared list, because
 * `crawl.spec.ts` treats a failed `app/icon.png` load as a finding (spec FR-6). This crawl
 * walks 52 routes as each of nine roles, so one missing icon would be ~470 identical
 * console entries in a matrix report whose value is the cells that differ between roles.
 * Extended here rather than hoisted: hoisting it would silently switch a real finding off
 * in the other two crawlers.
 */
const IGNORED_CONSOLE = [...SHARED_IGNORED_CONSOLE, /Failed to load resource.*favicon/i];

type Outcome = 'ok' | 'gated' | 'broken';

interface Cell {
  actor: Actor;
  route: string;
  outcome: Outcome;
  status: number;
  /** Rendered text length, so an empty shell can be told from a page with content. */
  contentLength: number;
  problems: string[];
}

const cells: Cell[] = [];
/** Nav links each role is offered, and whether each one resolved for them. */
const navFindings: { actor: Actor; detail: string }[] = [];
/** Pages whose content escaped its container and widened the document. */
const overflows: { actor: Actor; route: string; px: number }[] = [];

test.describe('every role, every page', () => {
  // NOT serial: a role whose first route breaks must still have its other 50 walked.
  // Run with --workers=1 so `cells` aggregates in one process.

  for (const actor of ROLES) {
    test(`${actor} can open every page without breaking one`, async ({ page }) => {
      test.setTimeout(420_000);
      await signIn(page, actor);

      for (const route of ROUTES) {
        /**
         * Tear the previous page down BEFORE listening, so its dying breath is not
         * charged to the next route.
         *
         * Without this, every role failed on `/admin/api-keys` — which is not a broken
         * page, it is merely the first route alphabetically. Navigating away cancels
         * whatever the previous page still has in flight, and next-auth's session poll
         * reports that cancellation as `ClientFetchError: Failed to fetch`. The listener
         * for route N+1 is already attached when route N is torn down, so the error
         * lands in the wrong bucket and indicts an innocent page.
         *
         * A crawler that cries wolf on its own first route is worse than no crawler: the
         * one finding it produces is false, and a reader who checks it learns to skip the
         * report.
         */
        await page.goto('about:blank');
        await page.waitForTimeout(150);

        const problems: string[] = [];
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];

        const onConsole = (m: { type(): string; text(): string }) => {
          if (m.type() !== 'error') return;
          const text = m.text();
          if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
          consoleErrors.push(text.slice(0, 200));
        };
        const onPageError = (e: Error) => pageErrors.push(String(e.message).slice(0, 200));
        page.on('console', onConsole);
        page.on('pageerror', onPageError);

        // VeloExpense: no locale segment.
        const url = route;
        let status = 0;
        try {
          const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          status = res?.status() ?? 0;
        } catch (e) {
          problems.push(`navigation failed: ${String(e).slice(0, 120)}`);
        }

        // The shell streams and tRPC queries resolve after domcontentloaded; a throw in
        // that window is the interesting one, and it is exactly what a permission-shaped
        // bug looks like — the page renders, then the query comes back empty and the
        // component that assumed a row crashes.
        await page.waitForTimeout(900);

        const body =
          (await page
            .locator('body')
            .innerText()
            .catch(() => '')) ?? '';

        if (/application error|unhandled runtime error|something went wrong/i.test(body)) {
          problems.push(
            `error boundary: ${(body.split('\n').find((l) => /error|wrong/i.test(l)) ?? '').slice(0, 120)}`,
          );
        }

        /**
         * A visible field showing a raw uuid. Base-ui pairs every combobox with a mirror
         * input carrying the real id — aria-hidden, tabindex -1, clipped to 1×1 rather
         * than display:none, so Playwright counts it visible. Excluding those two is what
         * keeps this from crying wolf on every form in the app.
         */
        const rawIds = await page
          .locator(
            'input:visible:not([aria-hidden="true"]):not([tabindex="-1"]), [role="combobox"]:visible',
          )
          .evaluateAll((els) =>
            els
              .map((el) => String((el as HTMLInputElement).value ?? el.textContent ?? '').trim())
              .filter((v) =>
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
              ),
          )
          .catch(() => [] as string[]);
        for (const v of rawIds) problems.push(`visible field shows a raw uuid (${v.slice(0, 8)}…)`);

        /**
         * The page itself scrolls sideways.
         *
         * Wide content — a table, a diagram, a code block — is supposed to scroll inside
         * its OWN container; when it escapes and widens the document instead, the whole
         * shell slides under the viewport and the sidebar goes with it. That is what a
         * column-overlap defect looks like structurally (GA readiness F44 was one), and it
         * is invisible to every assertion above because nothing throws.
         *
         * REPORTED, not failed. A few pixels of overshoot can come from a scrollbar or a
         * rounding difference rather than a layout fault, so the number is recorded and
         * judged rather than gated on — with a tolerance wide enough that only a real
         * escape trips it.
         */
        const overflow = await page
          .evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          .catch(() => 0);
        if (overflow > 24) overflows.push({ actor, route, px: overflow });

        for (const d of pageErrors) problems.push(`threw: ${d}`);
        for (const d of consoleErrors) {
          // A gated route's own 404 is classified below; the browser also logs it as a
          // failed resource load. One cause must not produce two findings.
          // VeloExpense: and its 403 — VeloExpense REFUSES a reader without the permission
          // (`forbidden()`, a 403 that says why), where ExpenseOS answers 404.
          if (status === 404 && /Failed to load resource.*404/i.test(d)) continue;
          if (status === 403 && /Failed to load resource.*403/i.test(d)) continue;
          problems.push(`console: ${d}`);
        }
        if (status >= 500) problems.push(`HTTP ${status}`);

        page.off('console', onConsole);
        page.off('pageerror', onPageError);

        /**
         * 404 is REFUSAL, not breakage.
         *
         * Pages are gated on their platform module and on permissions, and a route the
         * caller may not have answers 404 on purpose — that is the server-side half of
         * the menu gating, and it is the correct behaviour rather than a defect. Recorded
         * separately so a reader can tell "not for you" from "broken".
         */
        const outcome: Outcome =
          problems.length > 0 ? 'broken' : status === 404 || status === 403 ? 'gated' : 'ok';

        cells.push({ actor, route, outcome, status, contentLength: body.length, problems });
      }

      /**
       * Every link this role's OWN sidebar offers them has to resolve for them.
       *
       * The sharper half of the crawl. A route being 404 for an ap-clerk is fine; a route
       * being 404 for an ap-clerk WHILE THEIR OWN MENU OFFERS IT is a dead end shipped to
       * exactly the person who was told to go there — which is how `/notifications` came
       * to work and be unreachable, and the inverse of how five nav items pointed at
       * pages that did not exist (GA readiness F01).
       */
      // VeloExpense: no locale segment.
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const navHrefs = await page
        .locator('nav a[href^="/"], aside a[href^="/"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''))
        .catch(() => [] as string[]);
      for (const href of [...new Set(navHrefs)].filter((h) => h && !h.includes('#'))) {
        const res = await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => null);
        const st = res?.status() ?? 0;
        if (st >= 400) {
          navFindings.push({ actor, detail: `menu offers ${href}, which answers ${st}` });
        }
      }

      const broken = cells.filter((c) => c.actor === actor && c.outcome === 'broken');
      expect(
        broken,
        `${actor}: ${broken.length} route(s) broke — ` +
          broken.map((b) => `${b.route} [${b.problems.join('; ')}]`).join(' | '),
      ).toHaveLength(0);
    });
  }

  test.afterAll(() => {
    const byRoute = new Map<string, Map<Actor, Cell>>();
    for (const c of cells) {
      if (!byRoute.has(c.route)) byRoute.set(c.route, new Map());
      byRoute.get(c.route)?.set(c.actor, c);
    }

    const mark = (c: Cell | undefined) =>
      c === undefined ? '·' : c.outcome === 'ok' ? '✓' : c.outcome === 'gated' ? '–' : '✗';

    const broken = cells.filter((c) => c.outcome === 'broken');
    const lines: string[] = [
      `# Role crawl — every page, as every seeded role (${LOCALE})`,
      '',
      `Roles: ${ROLES.length} · Routes each: ${ROUTES.length} · Page loads: ${cells.length}`,
      `Broken cells: ${broken.length} · Menu dead ends: ${navFindings.length}`,
      '',
      '`✓` rendered · `–` refused cleanly (404/403 — a module or permission gate) · `✗` broke',
      '',
      `| Route | ${ROLES.join(' | ')} |`,
      `|---|${ROLES.map(() => '---').join('|')}|`,
    ];
    for (const route of ROUTES) {
      const row = byRoute.get(route);
      lines.push(`| \`${route}\` | ${ROLES.map((r) => mark(row?.get(r))).join(' | ')} |`);
    }

    if (broken.length) {
      lines.push('', '## What broke', '', '| Role | Route | Problem |', '|---|---|---|');
      for (const b of broken) {
        lines.push(
          `| ${b.actor} | \`${b.route}\` | ${b.problems.join('<br>').replace(/\|/g, '\\|')} |`,
        );
      }
    }
    if (navFindings.length) {
      lines.push('', '## Menu dead ends', '', '| Role | Detail |', '|---|---|');
      for (const n of navFindings) lines.push(`| ${n.actor} | ${n.detail} |`);
    }
    if (overflows.length) {
      /** Reported, not failed — see the note at the measurement. Deduped by route,
       *  because a layout fault is a property of the page, not of who opened it. */
      const byRoute = new Map<string, number>();
      for (const o of overflows) byRoute.set(o.route, Math.max(byRoute.get(o.route) ?? 0, o.px));
      lines.push(
        '',
        '## Pages that scroll sideways',
        '',
        'Content escaped its container and widened the document. Wide content is supposed',
        'to scroll inside its own box; when it does not, the shell slides under the viewport.',
        '',
        '| Route | Overshoot |',
        '|---|---|',
      );
      for (const [route, px] of [...byRoute].sort((a, b) => b[1] - a[1])) {
        lines.push(`| \`${route}\` | ${px}px |`);
      }
    }
    if (!broken.length && !navFindings.length) {
      lines.push(
        '',
        'Nothing broke. Every route, for every role, either rendered or was refused',
        'cleanly — and every link each role was offered resolved for them.',
        '',
        'This says nothing about whether any control does the right thing.',
      );
    }
    writeFileSync(REPORT, `${lines.join('\n')}\n`);
    console.log(`\nrole crawl → ${REPORT} (${broken.length} broken, ${cells.length} loads)`);
  });
});
