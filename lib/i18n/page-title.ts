/**
 * UD-16 — every page names itself.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * Until this existed, `app/layout.tsx` held the ONLY `generateMetadata` in the
 * product, and it returned `Acme Inc · VeloExpense` for all thirty-two routes.
 * Every browser tab said the same thing. So did every bookmark, every entry in
 * back-history, and every page announcement a screen reader makes on navigation
 * — which is the half of this that is an accessibility defect and not a polish
 * item: a blind user tabbing between two windows of this product has nothing to
 * tell them apart, and `aria-current` on a nav link does not help somebody who
 * never sees the nav.
 *
 * Upstream's #398 is the same family: three pages lacked an entry in a
 * hand-maintained title map. Ours is that defect with no map at all, which is
 * worse in the only way that matters — theirs was three pages, ours was all of
 * them.
 *
 * ── WHY A HELPER RATHER THAN A MAP ─────────────────────────────────────────
 *
 * The obvious fix is one file holding `{ '/approvals': 'Approvals', … }`. That is
 * exactly what upstream had, and exactly what dropped three pages: a map is a
 * second list of the routes, it drifts from the first, and nothing tells you when
 * it has. UD-9 is the standing note about hand-kept correspondences in this tree
 * and this project has paid for it three times.
 *
 * So the title lives ON the page, as a `generateMetadata` export of two lines,
 * and `scripts/check-page-titles.mjs` discovers the route set by GLOBBING it —
 * which means adding a route without a title is a failure rather than an omission
 * nobody notices. There is no list to keep in step, only a rule every file must
 * satisfy.
 *
 * ── THE TITLES ARE CATALOGUE COPY ──────────────────────────────────────────
 *
 * `uiText`, not a literal, and this is the reason UD-16 waited for VX4-10 rather
 * than shipping on its own: a tab title is read by a person in their own
 * language, and thirty-one English literals in `generateMetadata` would have been
 * thirty-one new un-catalogued strings that no gate could see — `visibleStrings`
 * walks `document.body` and a `<title>` is in `<head>`. Copy the crawl cannot
 * reach is precisely the copy that needs a catalogue and a compiler.
 */
import type { Metadata } from 'next';
import { readerPrefs } from '@/lib/i18n/request';
import { uiText, type UiKey } from '@/lib/i18n/catalog/ui';

/**
 * A page's own title, resolved in the reader's locale.
 *
 * Composed with the tenant's name by the `title.template` in `app/layout.tsx`, so
 * a page says `Approvals` and a tab says `Approvals · Acme Inc · VeloExpense`.
 * The order is the root layout's argument and worth repeating because it decides
 * whether this helps at all: a browser truncates the END of a tab title, so the
 * part that distinguishes one tab from another has to come FIRST. `Acme Inc ·
 * VeloExpense · Appro…` would have been thirty-one titles that still all look
 * identical in a narrow tab.
 */
export async function pageTitle(key: UiKey): Promise<Metadata> {
  const prefs = await readerPrefs();
  return { title: uiText(key, prefs.locale) };
}

/**
 * A page titled by its own DATA — a report's title, an employee's name.
 *
 * Not catalogued, deliberately, and it is the same rule as everywhere else in
 * this product: the customer's words are the customer's. `absolute` rather than a
 * plain string so the template does not wrap it — a report called "Q3 travel"
 * should read `Q3 travel · Acme Inc`, and the fallback is what a page shows when
 * the record is missing or unreadable, which is a catalogued sentence because
 * that one IS ours.
 */
export async function dataTitle(fallbackKey: UiKey, name: string | null): Promise<Metadata> {
  const prefs = await readerPrefs();
  const text = name?.trim();
  return { title: text ? text : uiText(fallbackKey, prefs.locale) };
}
