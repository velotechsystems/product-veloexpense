import '@testing-library/jest-dom/vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import enCommon from '@expenseos/i18n/catalogs/en/common';
import frCommon from '@expenseos/i18n/catalogs/fr-CA/common';
// VeloExpense: the locale from the registry rather than a bare 'en' (scripts/check-i18n.mjs).
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The desktop-only notice — what it renders, what it is NOT, and what "Continue anyway"
 * actually does to the DOM.
 *
 * ─── THE COPY IS RESOLVED AGAINST THE REAL CATALOGS, NOT AN IDENTITY MOCK ────────────────
 *
 * Every other component test in this directory mocks `next-intl` with a `t` that returns its
 * own key, which is right for them: they are testing structure, and the catalog is somebody
 * else's file. It is wrong HERE, because the live bug class for a brand-new namespace is a
 * key that does not exist — next-intl renders `common.desktopOnly.title` into the page and
 * logs a MISSING_MESSAGE error, and an identity mock renders the identical string and calls
 * it a pass. So this file wraps the component in a real `NextIntlClientProvider` over the
 * catalogs read off disk, and asserts the ENGLISH SENTENCES. A missing or misplaced key
 * fails here, in the file that added it.
 *
 * FR-CA is checked for the same four keys, because `check-coverage.mjs` compares locales
 * against each other and would be perfectly happy with a `desktopOnly` block that is missing
 * from both.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH ─────────────────────────────────────────────────
 *
 * IT PROVES NOTHING ABOUT WHAT A PHONE SHOWS. jsdom applies no stylesheet, so `lg:hidden`
 * and `hidden lg:contents` are inert strings here — this file can assert that the right
 * classes are on the right elements, and it cannot assert that either element is hidden,
 * because in jsdom neither is. The suppression itself is measured in a real engine at a real
 * viewport by `e2e/desktop-notice.spec.ts`, which also proves it resolves before the first
 * paint. Read a green run here as "the tree is right", never as "the gate works".
 *
 * The corollary is the reason for the `a hidden child still mounts` case below: because the
 * hiding is CSS, React mounts the page's subtree either way, and its effects and data
 * fetches run behind the notice. That is a real cost and it is recorded as CHECKED
 * BEHAVIOUR rather than left as an assumption somebody rediscovers in a profiler.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const h = vi.hoisted(() => ({ pathname: '/admin/roles' }));

vi.mock('@/i18n/navigation', () => ({
  usePathname: () => h.pathname,
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { DesktopOnlyNotice } from './DesktopOnlyNotice';

/**
 * The shipped registry's only `desktop` row, and a route ruled `limited`.
 *
 * `UNGATED` means "not gated", not "not ruled": `/dashboard` was unlisted when this was
 * written and P02 ruled it `limited`, which renders the page untouched. That makes it the
 * better subject for every negative below — the notice has to key on `desktop` rather than
 * on the registry merely having heard of the route.
 */
const GATED = '/admin/roles';
const UNGATED = '/dashboard';

const NOTICE = 'desktop-only-notice';
const CONTENT = 'desktop-only-content';

const copy = enCommon.desktopOnly;

function mount(children: React.ReactNode = <p>the page</p>) {
  return render(
    <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={{ common: enCommon }}>
      <DesktopOnlyNotice>{children}</DesktopOnlyNotice>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  h.pathname = GATED;
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('on a route ruled `desktop`', () => {
  it('renders no focus anchor until the reader has chosen', () => {
    // Absent on every un-acknowledged render, which is every desktop render — so the
    // byte-identical-geometry claim in `e2e/desktop-notice.spec.ts` is measuring a tree with
    // nothing extra in it at all, rather than one with an out-of-flow element it has to argue
    // is harmless.
    mount();
    expect(screen.queryByTestId('desktop-only-focus-anchor')).not.toBeInTheDocument();
  });

  it('renders exactly one notice, and puts the page in a wrapper that hides it below lg', () => {
    mount();
    // EXACTLY one, not "at least one". `crawl-mobile.spec.ts` fails a route that renders two,
    // and the shape that produces two — the component mounted in both the layout and a page —
    // is a plausible future edit rather than a hypothetical.
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
    expect(screen.getByTestId(NOTICE)).toHaveClass('lg:hidden');
    expect(screen.getByTestId(CONTENT)).toHaveClass('hidden', 'lg:contents');
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('titles itself with an h2, because TopBar already owns the h1', () => {
    mount();
    const heading = screen.getByRole('heading', { name: copy.title });
    expect(heading.tagName).toBe('H2');
  });

  it('is not a dialog', () => {
    /**
     * No `role="dialog"`, no `aria-modal`, no focus trap. Below `lg` the page is not behind
     * the notice, it is `display: none` — out of the layout, the accessibility tree and the
     * tab order. Announcing a modal over content that is not there tells a screen-reader
     * user the opposite of what is true.
     */
    mount();
    const notice = screen.getByTestId(NOTICE);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(notice.querySelector('[aria-modal]')).toBeNull();
    expect(notice.getAttribute('role')).toBeNull();
    expect(notice.getAttribute('aria-modal')).toBeNull();
  });

  it('resolves its four keys against the catalogs on disk, in both locales', () => {
    mount();
    // The English sentences themselves. A missing key renders `common.desktopOnly.title`,
    // which is a string an identity mock would have produced too — hence real sentences.
    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.continueAnyway })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.goToDashboard })).toBeInTheDocument();

    // FR-CA is not rendered here — one render per locale would be testing next-intl. What
    // matters is that the block exists with the same four keys and no empty values, which
    // `check-coverage.mjs` cannot catch when a block is missing from both locales.
    for (const key of ['title', 'body', 'continueAnyway', 'goToDashboard'] as const) {
      expect(frCommon.desktopOnly[key], `fr-CA common.desktopOnly.${key}`).toBeTruthy();
      expect(frCommon.desktopOnly[key]).not.toBe(enCommon.desktopOnly[key]);
    }
  });

  it('offers a way out that goes to the dashboard', () => {
    // VeloExpense: whose dashboard is the home page.
    mount();
    expect(screen.getByRole('link', { name: copy.goToDashboard })).toHaveAttribute('href', '/');
  });

  it('makes "Continue anyway" the PRIMARY action, first in reading order', () => {
    /**
     * THE BUTTON HIERARCHY, ASSERTED RATHER THAN ASSUMED.
     *
     * This shipped backwards once — "Go to dashboard" first and solid, "Continue anyway"
     * second and neutral — and nothing here noticed, because every other case in this file
     * looks the two controls up by accessible name and never asks which one the eye lands on.
     *
     * ADR-0005: *"'Continue anyway' always works. It is the primary action, one tap, with no
     * confirmation dialog and no friction"*, and the plan's inclusive-design gate names the
     * inverted arrangement as the dark pattern it is mitigating. Promoting the escape hatch
     * over the destination the reader actually asked for is obstruction dressed as
     * helpfulness — so both halves are pinned: the DOM ORDER and the EMPHASIS.
     *
     * The emphasis is read off the `default` variant's own classes (`bg-primary`,
     * `text-primary-foreground`) rather than a variant prop, because the styling is what a
     * reader sees; `variant="secondary"` on the link is asserted the same way, so a change
     * that quietly levels the two — both solid, or both neutral — is red here too.
     */
    mount();
    const notice = screen.getByTestId(NOTICE);

    const controls = [...notice.querySelectorAll('button, a')];
    expect(controls.map((el) => el.textContent)).toEqual([copy.continueAnyway, copy.goToDashboard]);

    const primary = screen.getByRole('button', { name: copy.continueAnyway });
    // VeloExpense kit: the `default` variant's colours are the brand button roles.
    expect(primary).toHaveClass('bg-brand-button', 'text-brand-on-button');

    const secondary = screen.getByRole('link', { name: copy.goToDashboard });
    expect(secondary).toHaveClass('bg-secondary', 'text-secondary-foreground');
    expect(secondary).not.toHaveClass('bg-brand-button');

    // Both stay `sm` (VeloExpense kit: `lg`, the kit's 36px size): the hierarchy is carried by colour and order, not by making one
    // control a harder target than the other on a phone.
    expect(primary.className).toContain('h-9');
    expect(secondary.className).toContain('h-9');
  });

  it('mounts the page behind it, hidden — recorded as checked behaviour, not as a bug', () => {
    /**
     * The cost of a CSS gate: the suppressed subtree is REAL. It hydrates, its effects run
     * and its queries fire, all behind `display: none`. That is the trade taken for a notice
     * that resolves before the first paint and works with JavaScript off, and it is pinned
     * here so a future reader finds it as a decision rather than as a surprise. If a page's
     * mount ever becomes expensive enough to matter, this assertion is where the argument
     * for a different mechanism starts.
     */
    const mounted = vi.fn();
    function HeavyChild() {
      useEffect(() => mounted(), []);
      return <p>expensive</p>;
    }
    mount(<HeavyChild />);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByText('expensive')).toBeInTheDocument();
  });
});

describe('Continue anyway', () => {
  it('UNMOUNTS the notice rather than hiding it, and hands focus to the content', async () => {
    /**
     * The single most likely thing to be got subtly wrong in this component, and the reason
     * it is asserted three ways.
     *
     * `crawl-mobile.spec.ts`'s contract is exactly one VISIBLE notice; a notice kept in the
     * DOM behind a class fails it — `toBeVisible()` on a `display: none` element is false, so
     * the count would be 1 and the visibility assertion would go red on every crawled
     * `desktop` route. It is also wrong on its own terms: a hidden-but-mounted notice leaves
     * its heading and both controls in the tab order above a page the reader just asked for.
     */
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: copy.continueAnyway }));

    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
    const content = screen.getByTestId(CONTENT);
    expect(content).toHaveClass('contents');
    expect(content).not.toHaveClass('hidden');
    /**
     * Focus lands INSIDE the content container, on the `sr-only` anchor that is its first
     * child. Not on the wrapper itself, and the reason is measured rather than stylistic:
     * `display: contents` generates no box, and Chromium 148 refuses to focus such an element
     * even with `tabIndex={-1}` (probed during this build — `activeElement` stayed `<body>`).
     * jsdom has no layout at all and would happily focus the wrapper, so this assertion
     * deliberately pins the shape that works in a real engine rather than the one that works
     * here. `e2e/desktop-notice.spec.ts` is where it is proved against Blink.
     */
    const anchor = screen.getByTestId('desktop-only-focus-anchor');
    expect(anchor).toHaveFocus();
    expect(content).toContainElement(anchor);
  });

  it('remembers the choice against the MATCHED PREFIX, not the full path', async () => {
    /**
     * Visiting `/admin/roles/anything` and continuing writes `/admin/roles` — one decision
     * about one feature. Keyed on the full path instead, the same notice reappears on every
     * click inside the Role Builder, which teaches the reader to dismiss it unread.
     */
    const user = userEvent.setup();
    h.pathname = '/admin/roles/deep/inside';
    mount();
    await user.click(screen.getByRole('button', { name: copy.continueAnyway }));
    expect(JSON.parse(sessionStorage.getItem('eos.desktopOk') ?? 'null')).toEqual(['/admin/roles']);
  });

  it('covers every path under the prefix on a later render', async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.click(screen.getByRole('button', { name: copy.continueAnyway }));
    first.unmount();

    h.pathname = '/admin/roles/some-role-id';
    mount();
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
    expect(screen.getByTestId(CONTENT)).toHaveClass('contents');
  });

  it('does not move focus when the choice is merely restored from storage', async () => {
    // A page load that silently steals focus into a wrapper is a hijack. Focus moves on the
    // reader's click and on nothing else.
    const user = userEvent.setup();
    const first = mount();
    await user.click(screen.getByRole('button', { name: copy.continueAnyway }));
    first.unmount();

    mount();
    expect(screen.queryByTestId('desktop-only-focus-anchor')).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('does not leak the choice to an unrelated prefix', () => {
    sessionStorage.setItem('eos.desktopOk', JSON.stringify(['/somewhere/else']));
    mount();
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
  });

  it('ignores a stored value that is not our array', () => {
    // Another feature's key collision, a truncated write, a hand-edited devtools value.
    sessionStorage.setItem('eos.desktopOk', '{"not":"an array"}');
    mount();
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
  });
});

describe('when sessionStorage throws', () => {
  /**
   * Safari private browsing and a third-party-storage block both make these calls THROW
   * rather than return null. The requirement is that the route still renders: a notice with
   * no memory is a small annoyance, a blank page is an outage.
   */
  beforeEach(() => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
  });

  it('still renders the notice', () => {
    mount();
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(copy.title)).toBeInTheDocument();
  });

  it('still lets the reader through, for this page view', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: copy.continueAnyway }));
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });
});

describe('on a route nobody has ruled', () => {
  it('renders the children with no wrapper and no notice at all', () => {
    /**
     * 51 of 52 routes. They must come out of this component byte-identical to what they
     * were before it existed — no notice, and no `display: contents` wrapper either, so
     * there is nothing for a future layout bug to be blamed on.
     */
    h.pathname = UNGATED;
    mount();
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByTestId(CONTENT)).not.toBeInTheDocument();
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('renders nothing even when a stale acknowledgement is in storage', () => {
    h.pathname = UNGATED;
    sessionStorage.setItem('eos.desktopOk', JSON.stringify(['/dashboard']));
    mount();
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });
});

/**
 * Blank out `/* *\/` and `//` comments, one character for one character so line numbers and
 * offsets survive. Lifted in spirit from `scripts/check-e2e-ids.mjs`, which learned the hard
 * way that collapsing a 30-line JSDoc block moves every finding after it.
 *
 * The `//` guard spares `https://` — a `//` preceded by `:` is a URL, not a comment.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

describe('the test seam itself', () => {
  it('names the notice in exactly one place in the app source', () => {
    /**
     * THE REPO GUARD.
     *
     * `desktop-only-notice` is a contract shared with `e2e/crawl-mobile.spec.ts`, which
     * classifies a route by looking for it and fails a route that shows two. A SECOND
     * production element carrying the same `data-testid` would break that census silently —
     * the crawl would report `noticeCount: 2` on a route with one notice on screen, and the
     * reader would go looking at the wrong component.
     *
     * `data-testid`, never an `#id`: `scripts/check-e2e-ids.mjs` scans `apps/web/src` only,
     * so an `#id` placed on a design-system element is invisible to it and rots unnoticed.
     */
    /** Every non-test source file under `apps/web/src`, with its two counts. */
    const files: { path: string; attributes: number; mentions: number }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        const mentions = [...src.matchAll(/desktop-only-notice/g)].length;
        if (mentions === 0) continue;
        files.push({
          // VeloExpense: repo-relative (ExpenseOS's sources are under apps/web/src).
          path: relative(REPO, full),
          // The ATTRIBUTE, counted with COMMENTS BLANKED FIRST — same technique, and the
          // same reason, as `scripts/check-e2e-ids.mjs`. This component's own header quotes
          // the selector `[data-testid="desktop-only-notice"]`, and a guard that cannot tell
          // a comment from a second element either fails on documentation or drives the
          // documentation out. Both are worse than the check is worth.
          attributes: [...stripComments(src).matchAll(/data-testid=["']desktop-only-notice["']/g)]
            .length,
          mentions,
        });
      }
    };
    // VeloExpense: the app's sources are the repo root's source directories.
    const REPO = join(HERE, '..', '..');
    for (const dir of ['app', 'components', 'lib', 'server', 'packages', 'hooks', 'i18n'])
      walk(join(REPO, dir));

    expect(files.map((f) => f.path)).toEqual(['app/(app)/DesktopOnlyNotice.tsx']);
    expect(files[0]?.attributes, 'production elements carrying the testid').toBe(1);
  });
});
