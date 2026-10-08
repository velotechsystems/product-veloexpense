import '@testing-library/jest-dom/vitest';
import { ALL_PERMISSIONS, permissions as P, type RbacUser, SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/server/trpc'; // VeloExpense: the ExpenseOS-shaped session (server/trpc.ts)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sidebar decides what the product LOOKS like it can do.
 *
 * It is cosmetic — every page enforces its own permission server-side — but a menu that
 * lies in either direction is a real problem: an entry somebody cannot open is a dead
 * end they will report as broken, and a missing entry hides a page they are entitled to
 * and can reach by URL anyway.
 *
 * Three gates compose here, and the tests pin each independently:
 *
 *   · **Module** — a section bound to a module disappears when that module is off, and
 *     so does an item inside a CORE section whose page is module-gated (policy admin
 *     under expense-management). Without the item-level gate the link renders and the
 *     page 404s.
 *   · **Permission** — a list of permissions is ANY-of, not all-of, because a page whose
 *     own gate is a disjunction (`/expenses/all` admits read-all OR reimburse) was
 *     hidden from half the people entitled to it when the menu named one permission.
 *   · **`canSeeOthers`** — People is gated on a computed fact (do you have reports?),
 *     not on a static permission, so it is filtered separately.
 *
 * An empty section renders as nothing at all, rather than as a heading with no items.
 */

const h = vi.hoisted(() => ({
  /**
   * `/dashboard`, repointed from `/my-info` when that route was deleted. It is the
   * landing surface, so it is also the honest default for "where the reader is" — but
   * the value matters to exactly one describe (`which entry is marked current`), and
   * every case there sets `h.pathname` itself. Nothing else in this file reads it.
   */
  pathname: '/dashboard',
  /** What `expenseApprovals.myTasks` resolves to — the Approvals badge's source. */
  pendingTasks: undefined as { items: unknown[] } | undefined,
  /** Whether the query was enabled, so "an employee never asks" is checkable. */
  tasksEnabled: undefined as boolean | undefined,
}));

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    expenseApprovals: {
      myTasks: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
          h.tasksEnabled = opts?.enabled;
          return { data: opts?.enabled === false ? undefined : h.pendingTasks };
        },
      },
    },
  },
}));

vi.mock('@/i18n/navigation', () => ({
  usePathname: () => h.pathname,
  // `className` IS forwarded, because the real `Link` forwards it and the small-screen gate
  // is expressed entirely as a class on this element. A mock that dropped it reported every
  // nav row as unclassed, which is a green run on a gate that is not there.
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
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    /**
     * WIDENED to carry the values argument, because a label with no values is
     * indistinguishable from a label whose values were dropped.
     *
     * The stub used to take `(key)` and throw the second argument away, so the section
     * disclosure — whose entire user-facing content is an ICU `select` over `state` and a
     * plural over `count` — rendered as the bare key `nav.sectionHiddenToggle` in BOTH
     * states and for EVERY count. A test could then assert the control's text and learn
     * nothing about the two things the control is for: which state it is in, and how many
     * destinations THIS reader lost in THIS section (ADR-0005 D7).
     *
     * The suffix is appended ONLY when values are passed, which is why this is not a
     * rewrite of the file's 16 existing `nav.*` assertions: every other call site in
     * `Sidebar.tsx` passes one argument, takes the `values === undefined` branch, and
     * renders the same `<namespace>.<key>` string it always did, byte for byte.
     *
     * Keys are sorted so the rendered string does not depend on the object literal's
     * property order in `Sidebar.tsx` — reordering two arguments is not a behaviour change
     * and must not be a test failure.
     *
     * This is NOT an ICU formatter and must not become one. It does not resolve the select
     * or the plural; `Sidebar.nav.test.ts` is where the real catalog strings are proved to
     * resolve in EN and FR-CA. What this renders is the ARGUMENTS, which is exactly the
     * half `Sidebar.nav.test.ts` cannot see.
     */
    const t = (key: string, values?: Record<string, unknown>) => {
      const base = ns ? `${ns}.${key}` : key;
      if (!values) return base;
      const args = Object.keys(values)
        .sort()
        .map((k) => `${k}=${String(values[k])}`)
        .join(',');
      return `${base}(${args})`;
    };
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
// Its own surface, with its own tests; it would drag the trpc client in with it.
vi.mock('./ProfilePopover', () => ({
  ProfilePopover: ({ name, roleLabel }: { name: string; roleLabel: string }) => (
    <div>
      <span>{name}</span>
      <span>{roleLabel}</span>
    </div>
  ),
}));

/**
 * VeloExpense: this file tests ExpenseOS's sidebar MECHANICS — the RBAC, module and
 * small-screen gates, the disclosure, the badge — against ExpenseOS's whole menu, as it does
 * in ExpenseOS. So VeloExpense's route bridge is switched off here (every item at its
 * ExpenseOS path, no VeloExpense items); `Sidebar.veloexpense.test.tsx` tests the bridge.
 */
vi.mock('./veloexpenseNav', () => ({
  VELOEXPENSE_ITEMS: {},
  veloExpenseRoute: (to: string) => to,
}));

import { AppSidebar, SECTIONS } from './Sidebar';

const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'u-1',
    name: 'Ada Lovelace',
    email: 'ada@e.inc',
    roleId: SYSTEM_ROLE_IDS.employee,
    roleLabel: 'Employee',
    ...over,
  }) as unknown as Session['user'];

const rbac = (permissions: string[]): RbacUser =>
  ({ permissions, roleId: 'r', userId: 'u-1' }) as unknown as RbacUser;

/** Every module the product ships, so a test can isolate the permission gate. */
const ALL_MODULES = new Set(
  SECTIONS.flatMap((s) => [
    ...(s.moduleSlug ? [s.moduleSlug] : []),
    ...s.items.flatMap((i) => (i.moduleSlug ? [i.moduleSlug] : [])),
  ]),
);

const show = (over: Partial<Parameters<typeof AppSidebar>[0]> = {}) =>
  render(
    <AppSidebar
      user={user()}
      rbac={rbac([])}
      canSeeOthers={false}
      activeModules={ALL_MODULES}
      {...over}
    />,
  );

const linkTo = (href: string) =>
  screen.queryAllByRole('link').find((a) => a.getAttribute('href') === href);

/**
 * Everything the product ships, so a fixture can isolate the small-screen gate from the
 * permission gate the way `ALL_MODULES` isolates it from the module gate.
 *
 * `ALL_PERMISSIONS` is derived from the permission registry itself (`packages/rbac`), so a
 * permission added tomorrow is in this fixture the same day and no test has to be edited to
 * keep "a reader who can see everything" meaning what it says.
 */
const EVERY_PERMISSION = [...ALL_PERMISSIONS] as string[];

/**
 * ───────────────────────── THE QUERY CONVENTION, AND WHY IT IS ONE ─────────────────────────
 *
 * NEVER `screen.getByRole('button')` in this file. Six sections render six disclosure
 * controls, and under the mocked `useTranslations` their accessible names collide the moment
 * two sections lose the same number of destinations — HOME loses one and VIRTUAL CARDS loses
 * one, so the collision exists in the shipped fixture, not in a hypothetical one. A global
 * singular query throws "found multiple elements" and it throws intermittently, as a function
 * of which permissions a fixture happens to hold. That is a designed-in flake, so it is closed
 * here in a helper rather than discovered in CI.
 *
 * Every control below is reached by naming its SECTION first — by the section's heading text,
 * which is the only stable, human-meaningful handle the markup offers. There is deliberately
 * no `id`, no `aria-controls` and no `data-testid` to query by: the revealed rows are
 * interleaved siblings of rows that were always visible, so there is nothing for an idref to
 * point at that is not the whole-section wrapper this change deleted.
 */

/** Every section rendering this heading — plural, because two `AppSidebar`s can be mounted. */
const sectionsByHeading = (container: HTMLElement, heading: string): HTMLElement[] =>
  within(container)
    .getAllByText(heading)
    .map((label) => {
      // `SidebarSection` renders `<div class="mb-1">` with the heading as its first child and
      // the items after it, so the heading's parent IS the section. Asserted rather than
      // assumed: if the design system ever wraps the heading, every case below would silently
      // start scoping to the wrong element and still pass.
      const section = label.parentElement;
      expect(section, `the ${heading} heading has no element around it`).not.toBeNull();
      return section as HTMLElement;
    });

/** The one section with this heading, in a render that mounted one sidebar. */
const sectionByHeading = (container: HTMLElement, heading: string): HTMLElement => {
  const found = sectionsByHeading(container, heading);
  expect(found, `expected exactly one ${heading} section in this render`).toHaveLength(1);
  return found[0];
};

/** That section's disclosure control. Scoped, so the six identical names cannot collide. */
const controlIn = (section: HTMLElement) => within(section).getByRole('button');

/** The section's nav rows in DOM order, as `[href, label]` — what a reveal must NOT change. */
const rowsIn = (section: HTMLElement) =>
  [...section.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent] as const);

/** Those same rows' class attributes — what a reveal must change, and the only thing it may. */
const classesIn = (section: HTMLElement) =>
  [...section.querySelectorAll('a')].map((a) => a.getAttribute('class'));

/**
 * Everything in a section still carrying ANY below-`lg` suppression.
 *
 * The attribute-substring selector rather than `.max-lg\\:hidden` on purpose: it also catches
 * `max-lg:sr-only`, `max-lg:opacity-0` and any other `max-lg:*` variant a future change might
 * reach for to hide a row "properly". A reveal that swapped one suppression class for another
 * would satisfy an exact-class assertion and ship a feature that reveals nothing.
 */
const suppressedIn = (section: HTMLElement) => [...section.querySelectorAll('[class*="max-lg:"]')];

beforeEach(() => {
  h.pathname = '/dashboard';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('what everybody sees', () => {
  it('always offers the reader a personal page, gated by no permission', () => {
    /**
     * REWRITTEN, NOT DELETED — the invariant outlived the page that carried it. This read
     * `linkTo('/my-info')`, whose route is gone; what it was actually asserting is that
     * HOME opens with a personal surface reachable by a reader holding NO permissions at
     * all (`rbac([])` is `show()`'s default), and Dashboard carries that now.
     *
     * Worth keeping as its own case even though `Sidebar.nav.test.ts` pins Dashboard's
     * POSITION: that file reads the SECTIONS data, and this one renders. A `requires:`
     * added to the Dashboard item would leave the data-level test green and blank the
     * landing entry for an employee — which is this assertion, and only this one.
     */
    show();
    expect(linkTo('/dashboard')).toBeDefined();
  });

  it('names the reader and their role in the footer', () => {
    show();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('translates a system role rather than showing its stored label', () => {
    /**
     * The four seeded roles have catalog entries; using the stored label would print
     * English to a French reader.
     */
    show({ user: user({ roleId: SYSTEM_ROLE_IDS.admin, roleLabel: 'Administrator' }) });
    expect(screen.getByText('nav.profile.roleAdmin')).toBeInTheDocument();
  });

  it('falls back to the stored label for a custom role', () => {
    // A role built in the Role Builder has no catalog entry, and never will.
    show({ user: user({ roleId: 'custom-1', roleLabel: 'AP Clerk' }) });
    expect(screen.getByText('AP Clerk')).toBeInTheDocument();
  });

  it('falls back to the email when the session has no composed name', () => {
    show({ user: user({ name: '' }) });
    expect(screen.getByText('ada@e.inc')).toBeInTheDocument();
  });
});

describe('the permission gate', () => {
  it('hides an entry the reader has no permission for', () => {
    show();
    expect(linkTo('/expenses')).toBeUndefined();
  });

  it('shows it once they do', () => {
    show({ rbac: rbac([P.expense.report.readOwn]) });
    expect(linkTo('/expenses')).toBeDefined();
  });

  it('treats a list of permissions as ANY of them', () => {
    /**
     * `/expenses/all` admits read-all OR reimburse. Naming only one hid the entry from
     * every reader who held the other — while they could still open the page by URL.
     */
    show({ rbac: rbac([P.expense.report.reimburse]) });
    expect(linkTo('/expenses/all')).toBeDefined();
  });

  it('shows the same entry for the other permission in the list', () => {
    show({ rbac: rbac([P.expense.report.readAll]) });
    expect(linkTo('/expenses/all')).toBeDefined();
  });

  it('hides it when the reader holds neither', () => {
    show({ rbac: rbac([P.expense.report.readOwn]) });
    expect(linkTo('/expenses/all')).toBeUndefined();
  });
});

describe('the module gate', () => {
  it('hides a whole section when its module is off', () => {
    /**
     * Sections are bound to modules, so a tenant without expense management does not
     * see a menu full of links that 404.
     */
    show({ rbac: rbac([P.expense.report.readOwn]), activeModules: new Set<string>() });
    expect(linkTo('/expenses')).toBeUndefined();
  });

  it('shows it once the module is installed and active', () => {
    show({
      rbac: rbac([P.expense.report.readOwn]),
      activeModules: new Set(['expense-management']),
    });
    expect(linkTo('/expenses')).toBeDefined();
  });

  it('hides a module-gated item that lives in a core section', () => {
    /**
     * The item-level gate exists for exactly this: the section is core, so it shows,
     * but the page behind this one item needs a module — and without the gate the link
     * renders and the page 404s.
     */
    const gated = SECTIONS.flatMap((s) =>
      s.moduleSlug ? [] : s.items.filter((i) => i.moduleSlug),
    );
    expect(gated.length).toBeGreaterThan(0);
    const item = gated[0];
    const permissions = item.requires
      ? Array.isArray(item.requires)
        ? [...item.requires]
        : [item.requires]
      : [];
    show({ rbac: rbac(permissions as string[]), activeModules: new Set<string>() });
    expect(linkTo(item.to)).toBeUndefined();
  });

  it('shows that item when its module is on', () => {
    const gated = SECTIONS.flatMap((s) =>
      s.moduleSlug ? [] : s.items.filter((i) => i.moduleSlug),
    );
    const item = gated[0];
    const permissions = item.requires
      ? Array.isArray(item.requires)
        ? [...item.requires]
        : [item.requires]
      : [];
    show({
      rbac: rbac(permissions as string[]),
      activeModules: new Set([item.moduleSlug as string]),
    });
    expect(linkTo(item.to)).toBeDefined();
  });
});

describe('People', () => {
  it('is hidden from somebody with nobody to see', () => {
    /**
     * Gated on a computed fact — read-all, or having reports — rather than on a static
     * permission, which is why it is filtered by its own flag.
     */
    show({ canSeeOthers: false });
    expect(linkTo('/users')).toBeUndefined();
  });

  it('appears for a manager', () => {
    show({ canSeeOthers: true });
    expect(linkTo('/users')).toBeDefined();
  });
});

describe('empty sections', () => {
  it('renders no heading for a section whose every item is hidden', () => {
    /**
     * A heading with nothing under it reads as a loading failure, and there are a dozen
     * sections most readers see none of.
     */
    show({ rbac: rbac([]), canSeeOthers: false });
    expect(screen.queryByText('nav.sections.administration')).not.toBeInTheDocument();
  });

  it('keeps a section that has one surviving item', () => {
    show({ rbac: rbac([P.expense.report.readOwn]) });
    expect(screen.getByText('nav.sections.expenseManagement')).toBeInTheDocument();
  });
});

describe('which entry is marked current', () => {
  /**
   * `NavLink` marks the current row with `aria-current="page"` and nothing else — the
   * highlight itself is inline `style`, which is not assertable. So currency is read off
   * the ARIA attribute, which is also the only part of it a screen reader gets.
   */
  const currentRows = (container: HTMLElement) => [
    ...container.querySelectorAll('[aria-current="page"]'),
  ];

  it('marks the Dashboard entry, and only it, on /dashboard', () => {
    /**
     * Rewritten, because the world it described is gone. It read: Notifications and Expense
     * reports both point at `/dashboard` until each module has its own route, so a naive
     * `to === pathname` lit two rows — and it asserted `toBeLessThanOrEqual(1)`.
     *
     * Both halves are now wrong. Nothing is parked on `/dashboard` any more (see
     * `Sidebar.nav.test.ts`), and "at most one" is satisfied by ZERO — which is exactly the
     * silent failure the old `pathname !== '/dashboard' || item.key === 'expenseReports'`
     * clause produced once Dashboard became a nav item: it rejected the Dashboard row for
     * having the wrong key and `expenseReports` for having the wrong route, so no row lit
     * and the reader could not tell where they were. That bug would have passed this test.
     *
     * So: exactly one, and it is Dashboard. The permissions are kept from the old case to
     * hold `notifications` and `expenseReports` visible — the two former squatters must be
     * on screen and NOT marked for the assertion to mean anything.
     */
    h.pathname = '/dashboard';
    const { container } = show({
      rbac: rbac([P.notification.readOwn, P.expense.report.readOwn]),
    });
    expect(screen.getByText('nav.items.notifications')).toBeInTheDocument();
    expect(screen.getByText('nav.items.expenseReports')).toBeInTheDocument();

    const rows = currentRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('nav.items.dashboard');
  });
});

/**
 * A manager had no reason to open the Approvals queue, because nothing anywhere said
 * there was anything in it — so a submitted report was found only by opening its email
 * notification (UAT A6: "Kati could not see Naveed's expense report in ExpenseOS status
 * screen. I had to open the notification").
 */
describe('the approvals badge', () => {
  const APPROVER = ['expense.report.approve'];

  it('says how many approvals are waiting', () => {
    h.pendingTasks = { items: [{}, {}, {}] };
    render(
      <AppSidebar
        user={user()}
        rbac={rbac(APPROVER)}
        canSeeOthers
        activeModules={new Set(['expense-management'])}
      />,
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows nothing at all when the queue is empty', () => {
    // A badge reading "0" is a notification that there is nothing to notify about.
    h.pendingTasks = { items: [] };
    render(
      <AppSidebar
        user={user()}
        rbac={rbac(APPROVER)}
        canSeeOthers
        activeModules={new Set(['expense-management'])}
      />,
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('never asks for a count an employee could not act on', () => {
    /** The answer is always zero for somebody who cannot approve, and it would be asked
     *  on every page load. */
    h.pendingTasks = { items: [{}] };
    h.tasksEnabled = undefined;
    render(
      <AppSidebar
        user={user()}
        rbac={rbac([])}
        canSeeOthers
        activeModules={new Set(['expense-management'])}
      />,
    );
    expect(h.tasksEnabled).toBe(false);
  });
});

/**
 * The FOURTH gate: routes ruled `desktop` in `mobileReadiness.ts`, hidden below `lg`.
 *
 * ─── WHY EVERY ASSERTION HERE IS ABOUT A CLASS AND NOT ABOUT ABSENCE ─────────────────────
 *
 * The other three gates delete the entry. This one must not, and the reason is that this
 * component RENDERS TWICE: `AppShell` mounts a persistent `lg:block` copy and an off-canvas
 * copy, and the off-canvas copy is ALSO the desktop nav whenever the reader has unpinned the
 * sidebar. A JavaScript filter would therefore remove `/admin/roles` from the nav of an
 * unpinned 1280px window — the one place it is certainly usable. `max-lg:hidden` hides it
 * exactly where it cannot be used and nowhere else.
 *
 * jsdom applies no stylesheet, so nothing here can assert that the entry is invisible at
 * 360px; it asserts the class is on the right element, and `e2e/desktop-notice.spec.ts`
 * measures the consequence in a real engine. The EMPTY-SECTION arithmetic — the case that
 * ships visibly broken, as a labelled heading with nothing under it — is pinned as pure
 * logic against an injected table in `Sidebar.nav.test.ts`, because the shipped registry
 * does not produce it today and a test that needs it to would be red the day it does.
 */
describe('the small-screen gate', () => {
  /** Everything an admin can reach, so Administration is fully populated. */
  const ADMIN = [P.admin.role.list, P.admin.apiKey.list, P.notification.readOwn];

  it('marks a `desktop` route hidden below lg, and leaves it in the DOM', () => {
    show({ rbac: rbac(ADMIN) });
    const roles = linkTo('/admin/roles');
    expect(roles, '/admin/roles must still be in the nav for the desktop copy').toBeDefined();
    expect(roles).toHaveClass('max-lg:hidden');
  });

  it('leaves a route that is not ruled `desktop` alone', () => {
    /**
     * This read "leaves every unruled route alone" until P02 ruled `/dashboard` `limited`,
     * and the rename is the point rather than tidying: the subject is no longer an unlisted
     * route, so what it proves has got stronger. `phoneHiddenRoutes` filters on
     * `disposition === 'desktop'` alone, and this route now HAS a registry row that
     * `dispositionFor` answers with — so a filter that hid anything merely because the table
     * knows about it would fail here, which it could not while the subject was unlisted.
     */
    show({ rbac: rbac(ADMIN) });
    const dashboard = linkTo('/dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard).not.toHaveClass('max-lg:hidden');
  });

  it('no longer wraps Administration when every item this fixture can see is ruled `desktop`', async () => {
    /**
     * INVERTED A SECOND TIME, NOT DELETED — and the count goes 1 → 0, which is the direction
     * that needs the most guarding, because ZERO wrappers is also what a build that lost the
     * small-screen gate altogether produces. So the inversion never stands alone: three
     * further conjuncts below have to hold with it, and each of them is false on a different
     * way of breaking this. Do not loosen any of them to an inequality, and do not split them
     * into separate cases — it is their conjunction that carries the meaning.
     *
     *   · the wrapper count is 0                  — false if the wrapper came back
     *   · ADMINISTRATION still has a heading      — false if the section was filtered away
     *   · its two rows carry `max-lg:hidden`      — false if the gate was deleted outright
     *     THEMSELVES, not via an ancestor           or moved into JavaScript
     *   · a control in the section inverts them   — false if the disclosure is a no-op
     *
     * WHY IT INVERTED. The whole-section `max-lg:hidden` wrapper is gone: an emptied section
     * used to be hidden entire, heading included, and is now rendered with a disclosure
     * control as its last child instead (ADR-0009). The D6 obligation the wrapper discharged —
     * ADMINISTRATION must not render on a phone as a labelled heading with nothing under it —
     * is discharged now by the control being unconditional wherever the section lost anything.
     * The fourth conjunct is where that obligation is actually asserted.
     *
     * The five paragraphs below are the record of the FIRST inversion, in 2026 when P10's
     * `/admin/*` batch emptied this fixture's ADMINISTRATION and made the wrapper branch fire
     * for the first time in the product's life. They are kept because the fixture arithmetic
     * they explain — why this renders TWO of fourteen items, and why NETSUITE is dropped whole
     * rather than wrapped — is still exactly right and is still the thing a reader gets wrong.
     * Only their last paragraph is retired: the section is no longer WRAPPED, it is revealed
     * in place, and the reason given there for wrapping rather than removing is now the reason
     * the items keep the class on themselves.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────
     *
     * INVERTED, NOT DELETED. This read "keeps Administration on screen, because it still has
     * phone-visible items" and asserted ZERO wrappers, which was true while `/admin/roles`
     * was the only `desktop` row this fixture could see. P10's `/admin/*` batch ruled
     * `/admin/api-keys` too, and those two are the whole of ADMINISTRATION for `ADMIN` — so
     * the section is now emptied below `lg` and the wrapper branch fires. It had never fired
     * in the product's life before that commit.
     *
     * READ THE FIXTURE, NOT THE PRODUCT, from this case. `ADMIN` holds three permissions, so
     * the ADMINISTRATION it renders is two items out of fourteen, and it was emptied here a
     * batch before the real nav's was.
     *
     * THAT GAP HAS NOW CLOSED, and this paragraph used to say otherwise. It read "on the real
     * nav the section still has one phone-visible item — `/admin/assistant-feedback`" and
     * that stopped being true the moment P10's module-gated batch ruled that route `desktop`:
     * it was ADMINISTRATION's fourteenth and last, so the section empties on the real nav too.
     * `Sidebar.nav.test.ts`'s data-level case now names three emptied sections — COMPLIANCE &
     * AUDIT, ADMINISTRATION, NETSUITE — and is where the product-level claim lives.
     *
     * WHAT DID NOT CHANGE IS THIS FIXTURE'S ANSWER, and the reason is worth stating so nobody
     * reads the wrapper count as a product fact. `/admin/assistant-feedback` requires
     * `admin.help.manage`, which `ADMIN` does not hold, so this render never had a third
     * ADMINISTRATION item to lose. NETSUITE's ten need the `netsuite.*` permissions, which
     * `ADMIN` does not hold either, so that section renders no items at all and is dropped
     * whole rather than wrapped — an EMPTY section is not an EMPTIED one, which
     * `Sidebar.nav.test.ts` pins separately. One wrapper, before and after.
     *
     * The heading assertion stays and is the point of the pairing: the section is WRAPPED,
     * not removed, because this component renders twice and the off-canvas copy is the
     * desktop nav for an unpinned 1280px window. `max-lg:hidden` hides it exactly where it
     * cannot be used; a JavaScript filter would have taken it away where it can.
     *   ^ RETIRED by this change, as described above: not wrapped, revealed in place. The
     *     last two sentences still hold verbatim and are now the reason the ROWS carry
     *     `max-lg:hidden` rather than being filtered out.
     */
    const ue = userEvent.setup();
    const { container } = show({ rbac: rbac(ADMIN) });

    const wrapped = container.querySelectorAll('div.max-lg\\:hidden');
    expect(wrapped, 'no section is wrapped any more; the items carry their own gate').toHaveLength(
      0,
    );

    // …and NOT because the section stopped rendering.
    expect(screen.getByText('nav.sections.administration')).toBeInTheDocument();

    // …and NOT because the small-screen gate was deleted: the two rows still carry it, on
    // themselves, which is the only place it can be while they sit in their authored order.
    expect(linkTo('/admin/roles')).toHaveClass('max-lg:hidden');
    expect(linkTo('/admin/api-keys')).toHaveClass('max-lg:hidden');

    // …and the section carries a control that inverts exactly those two.
    const section = sectionByHeading(container, 'nav.sections.administration');
    await ue.click(controlIn(section));
    expect(linkTo('/admin/roles')).not.toHaveClass('max-lg:hidden');
    expect(linkTo('/admin/api-keys')).not.toHaveClass('max-lg:hidden');
  });

  it('names the landmark from the catalog rather than from the design system', () => {
    /**
     * The design-system `Sidebar` defaults `aria-label` to the literal 'Primary navigation'
     * — a user-facing string, in English, reaching a screen reader in both locales. The
     * mocked `useTranslations` here returns `<namespace>.<key>`, so the assertion is that
     * the app SUPPLIED one, and `Sidebar.nav.test.ts` is where the key is proved to resolve.
     */
    const { container } = show({ rbac: rbac(ADMIN) });
    // Queried as the `aside` rather than by role. The design-system `Sidebar` renders an
    // `<aside>`, whose implicit role is `complementary` and not `navigation` — a real and
    // separate finding, recorded here rather than fixed, because changing the landmark
    // element is a design-system change with every consumer's blast radius.
    const nav = container.querySelector('aside');
    expect(nav).toHaveAttribute('aria-label', 'nav.primaryNavigation');
  });

  it('tells the reader that something is hidden, when something is', () => {
    /**
     * The discoverability mitigation. Hiding nav entries silently leaves a reader who knows
     * the Role Builder exists concluding that the product lost it or that their access was
     * revoked; naming the reason in words is the cheapest honest fix and the alternative to
     * a dark pattern.
     */
    show({ rbac: rbac(ADMIN) });
    expect(screen.getByText('nav.moreOnLargerScreen')).toBeInTheDocument();
  });

  it('says nothing to a reader for whom nothing was hidden', () => {
    /**
     * An employee cannot see `/admin/roles` in the first place, so telling them pages are
     * hidden behind a screen size is simply false — and it is the kind of false that sends
     * somebody hunting for a feature they were never entitled to.
     */
    show({ rbac: rbac([P.expense.report.readOwn]) });
    expect(linkTo('/admin/roles')).toBeUndefined();
    expect(screen.queryByText('nav.moreOnLargerScreen')).not.toBeInTheDocument();
  });
});

/**
 * The per-section disclosure — the affordance that replaced the whole-section wrapper.
 *
 * ─── WHAT THIS PINS, AND WHAT IT CANNOT ──────────────────────────────────────────────────
 *
 * A section that loses at least one destination below `lg` renders a `lg:hidden` button as
 * its last child, and activating it removes `max-lg:hidden` from that section's hidden rows
 * — the rows THEMSELVES, in their authored positions. Nothing is mounted, unmounted, moved,
 * re-rendered or wrapped. That is the whole mechanism, and it is the mechanism precisely
 * because the hidden rows are not adjacent: in EXPENSE MANAGEMENT and HOME the hidden ones
 * are interleaved with visible ones, so any wrapper — `<details>`, a `<div id>` — would have
 * had to reorder the nav below `lg` or cover only its tail.
 *
 * jsdom applies no stylesheet and resolves no media query, so NOTHING here establishes that
 * any of this is visible at 360px or invisible at 1280px. Every assertion below is about a
 * class attribute, an element's position among its siblings, and an ARIA attribute. The
 * consequence — that a phone reader taps the control, sees the row, taps the row and lands on
 * "Continue anyway" — is claimed only by `e2e/desktop-notice.spec.ts`, which has never been
 * executed on this machine or in CI. A green run of this file is not evidence for it.
 *
 * NO FAKE TIMERS IN THIS FILE, EVER. `userEvent` schedules its own delays through the real
 * clock; the day `vi.useFakeTimers()` is added here for some unrelated case, every `await`
 * below hangs until the suite times out, and the failure will look like the sidebar rather
 * than like the timers.
 */
describe('the per-section disclosure', () => {
  /** Everything an admin can reach, so ADMINISTRATION is fully emptied below `lg`. */
  const ADMIN = [P.admin.role.list, P.admin.apiKey.list, P.notification.readOwn];

  /** A reader who can see everything the product ships. */
  const everything = () => show({ rbac: rbac(EVERY_PERMISSION), canSeeOthers: true });

  /**
   * The sections that lose at least one destination below `lg` for a reader who can see
   * everything — written out, in `SECTIONS` order, rather than derived from the component.
   *
   * Derived from `phoneHiddenRoutes` it would be a tautology: the same function that decides
   * where the control renders would decide where the test expects one. Written out, it is a
   * claim about the shipped product that goes red when the registry moves — which is the
   * point. It moved three times in the four days before this was written. If it goes red,
   * re-measure and edit this list; do not make it resilient.
   *
   * The other two labelled sections — APPROVALS and FINANCE & REPORTING — lose nothing and
   * are asserted below to carry no control at all, which is the half of the claim a count
   * alone would miss.
   */
  const LOSES_SOMETHING = [
    'nav.sections.home',
    'nav.sections.expenseManagement',
    'nav.sections.vcc',
    'nav.sections.complianceAudit',
    'nav.sections.administration',
    'nav.sections.ledger',
  ];

  it('renders one control per section that loses something, and none anywhere else', () => {
    const { container } = everything();

    // The list above is written in `SECTIONS` order, and this is what says so — otherwise the
    // document-order assertion below would be pinning the list against itself.
    const authored = SECTIONS.filter((sec) => sec.sectionKey).map(
      (sec) => `nav.sections.${sec.sectionKey}`,
    );
    expect(authored.filter((h) => LOSES_SOMETHING.includes(h))).toEqual(LOSES_SOMETHING);

    const controls = within(container).getAllByRole('button');
    expect(
      controls,
      'exactly six sections lose something for a reader who sees everything',
    ).toHaveLength(LOSES_SOMETHING.length);
    expect(
      controls.map((b) => (b.parentElement as HTMLElement).firstElementChild?.textContent),
      'the controls appear in `SECTIONS` order, each inside the section it signposts',
    ).toEqual(LOSES_SOMETHING);

    for (const heading of ['nav.sections.approvals', 'nav.sections.financeReporting']) {
      const section = sectionByHeading(container, heading);
      expect(
        within(section).queryAllByRole('button'),
        `${heading} loses nothing below lg, so it must not offer to reveal anything`,
      ).toHaveLength(0);
    }
  });

  it('puts the control where the section is: its last child, directly after the last row', () => {
    /**
     * Done-when 1 is "signposted WHERE IT WAS", and this is as close as a DOM with no
     * stylesheet gets to it. Position among siblings is the assertable half of "where";
     * the other half is that the section is not somewhere else on the page, which the
     * scoping helper establishes by construction.
     *
     * The control being AFTER the rows is a deliberate cost, not an accident: a reader who
     * expands with the keyboard is left focused after the content they just revealed. That is
     * the shape of every "Load more" control and it was carried forward by UX as a known
     * consequence — so it is pinned here rather than being quietly repaired by someone who
     * mistakes it for a bug.
     */
    const { container } = everything();
    for (const heading of LOSES_SOMETHING) {
      const section = sectionByHeading(container, heading);
      const control = controlIn(section);
      const rows = [...section.querySelectorAll('a')];
      expect(section.lastElementChild, `${heading}: the control is the section's last child`).toBe(
        control,
      );
      expect(
        control.previousElementSibling,
        `${heading}: the control sits directly after the last nav row, not before or among them`,
      ).toBe(rows[rows.length - 1]);
    }
  });

  it('carries `lg:hidden` and never `max-lg:hidden`, and the row carries the inverse', async () => {
    /**
     * THE INVERSION GUARD, and both directions are written out because getting it backwards
     * is invisible to every other assertion in this file and catastrophic in a browser.
     *
     * `lg:hidden` compiles to a rule that applies AT AND ABOVE 64rem; `max-lg:hidden` to one
     * that applies BELOW it. Swap them and the control appears only on desktop — where it does
     * nothing, since the rows it reveals are already visible — while a phone reader gets the
     * silence this whole task exists to end, and the desktop nav loses 39 destinations. Both
     * builds pass "the control renders" and "the row has a suppression class".
     */
    const ue = userEvent.setup();
    const { container } = show({ rbac: rbac(ADMIN) });
    const section = sectionByHeading(container, 'nav.sections.administration');
    const control = controlIn(section);

    // The control is the SMALL-screen affordance: gone at `lg` and above, where it is useless.
    expect(control).toHaveClass('lg:hidden');
    expect(control).not.toHaveClass('max-lg:hidden');

    // The row is the exact inverse: kept at `lg` and above, suppressed below it.
    expect(linkTo('/admin/roles')).toHaveClass('max-lg:hidden');
    expect(linkTo('/admin/roles')).not.toHaveClass('lg:hidden');

    // Revealing must not swap them either: the control stays small-screen-only, and the row
    // must not acquire the desktop suppression on its way to being revealed.
    await ue.click(control);
    expect(control).toHaveClass('lg:hidden');
    expect(control).not.toHaveClass('max-lg:hidden');
    expect(linkTo('/admin/roles')).not.toHaveClass('max-lg:hidden');
    expect(linkTo('/admin/roles')).not.toHaveClass('lg:hidden');
  });

  it('leaves nothing suppressed in the section the reader opened', async () => {
    /**
     * CONTRACT ONE. A disclosure that reveals only some of what it counted is worse than none:
     * the reader is told a number, acts on it, and gets fewer rows than they were promised
     * with no indication that anything is still missing.
     *
     * The second assertion is the broad one and is not redundant. `.max-lg\:hidden` is today's
     * suppression; `[class*="max-lg:"]` is any of them. A change that revealed by swapping
     * `max-lg:hidden` for `max-lg:sr-only` would pass the first and fail the second, and it is
     * the second that states the actual requirement.
     *
     * Scoped to the opened section on purpose — NETSUITE is checked to be untouched in the
     * same breath, because "expanding one section expands all of them" is a real way to get
     * the shared `expanded` set wrong and every single-section assertion would still pass.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    const section = sectionByHeading(container, 'nav.sections.administration');
    const elsewhere = sectionByHeading(container, 'nav.sections.ledger');
    const suppressedElsewhere = suppressedIn(elsewhere).length;
    expect(
      suppressedIn(section).length,
      'nothing to reveal means nothing is proved',
    ).toBeGreaterThan(0);

    await ue.click(controlIn(section));

    expect(
      section.querySelectorAll('.max-lg\\:hidden'),
      'the opened section hides nothing',
    ).toHaveLength(0);
    expect(
      suppressedIn(section),
      'and hides nothing under any other `max-lg:*` variant',
    ).toHaveLength(0);
    expect(suppressedIn(elsewhere), 'one section opened, not all of them').toHaveLength(
      suppressedElsewhere,
    );
  });

  it('reveals the same items in the same order, and changes only their class', async () => {
    /**
     * CONTRACT TWO, and EXPENSE MANAGEMENT is the fixture because it is the hard one: eight of
     * its ten rows are hidden and the two survivors are FIRST and THIRD, so anything that
     * revealed by re-rendering a list, or by moving the hidden rows into a wrapper, would
     * reorder this section and this assertion would catch it.
     *
     * The last assertion is not a flourish. The order comparison alone is satisfied by a build
     * where the button does nothing at all — collapsed, expanded and collapsed again would be
     * three identical lists, and the case would pass green on a dead control. The class
     * attribute having changed is what makes the other three comparisons mean something.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    const section = sectionByHeading(container, 'nav.sections.expenseManagement');
    const control = controlIn(section);

    const collapsed = rowsIn(section);
    const collapsedClasses = classesIn(section);
    expect(collapsed.length, 'a one-row section would not test order at all').toBeGreaterThan(1);

    await ue.click(control);
    const expanded = rowsIn(section);
    const expandedClasses = classesIn(section);

    await ue.click(control);
    const recollapsed = rowsIn(section);

    expect(expanded, 'revealing changed an href or a label').toEqual(collapsed);
    expect(recollapsed, 'collapsing again changed an href or a label').toEqual(collapsed);
    expect(classesIn(section), 'the round trip did not return the rows to their start').toEqual(
      collapsedClasses,
    );
    expect(
      expandedClasses,
      'the class attribute never changed — this passes on a build where the button is dead',
    ).not.toEqual(collapsedClasses);
  });

  it('keeps a partially-emptied EXPENSE MANAGEMENT in its authored order, revealed or not', async () => {
    /**
     * The same section measured against a different oracle: not "it is consistent with itself
     * across states", but "it is in the order `SECTIONS` authors it in". Self-consistency is
     * satisfied by a build that renders the same wrong order twice.
     *
     * PARTIALLY emptied is asserted, not assumed. The interesting property of this section is
     * that revealed rows land BETWEEN rows that were never hidden; if a registry change ever
     * ruled all ten `desktop`, this case would quietly become a duplicate of the
     * fully-emptied ADMINISTRATION cases and stop testing interleaving at all.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    const authored = SECTIONS.find((sec) => sec.sectionKey === 'expenseManagement')?.items.map(
      (i) => i.to,
    );
    expect(authored, 'EXPENSE MANAGEMENT is gone from SECTIONS').toBeDefined();

    const section = sectionByHeading(container, 'nav.sections.expenseManagement');
    const hrefs = () => [...section.querySelectorAll('a')].map((a) => a.getAttribute('href'));

    expect(hrefs()).toEqual(authored);
    expect(suppressedIn(section).length, 'nothing is hidden here any more').toBeGreaterThan(0);
    expect(
      suppressedIn(section).length,
      'every row is hidden here now — this is no longer a PARTIALLY emptied section',
    ).toBeLessThan(hrefs().length);

    await ue.click(controlIn(section));

    expect(hrefs(), 'revealing reordered the section').toEqual(authored);
    expect(suppressedIn(section)).toHaveLength(0);
  });

  it('counts what this reader lost, not what the section holds', async () => {
    /**
     * ADR-0005 D7, expressed as arithmetic. The number on the control is `phone.hidden.size`
     * for THIS render — post-RBAC, post-module, post-registry — and never the product's global
     * figure. A control reading "Show 14 more pages" to somebody entitled to two of them tells
     * a warehouse clerk that twelve administrative destinations exist and they cannot have
     * them, which is the disclosure D7 forbids.
     *
     * Both readers are rendered here rather than in two cases, because the claim is the
     * CONTRAST: same section, same product, two different honest answers.
     */
    const narrow = show({ rbac: rbac(ADMIN) });
    const wide = show({ rbac: rbac(EVERY_PERMISSION), canSeeOthers: true });

    const authored = SECTIONS.find((sec) => sec.sectionKey === 'administration')?.items.length ?? 0;
    expect(
      authored,
      'ADMINISTRATION must hold more than the narrow fixture can see',
    ).toBeGreaterThan(2);

    const narrowSection = sectionByHeading(narrow.container, 'nav.sections.administration');
    expect(within(narrowSection).getAllByRole('link')).toHaveLength(2);
    expect(controlIn(narrowSection).textContent).toBe(
      'nav.sectionHiddenToggle(count=2,state=collapsed)',
    );

    const wideSection = sectionByHeading(wide.container, 'nav.sections.administration');
    expect(within(wideSection).getAllByRole('link')).toHaveLength(authored);
    expect(controlIn(wideSection).textContent).toBe(
      `nav.sectionHiddenToggle(count=${authored},state=collapsed)`,
    );
  });

  it('flips `aria-expanded`, and its accessible name with it, false → true → false', async () => {
    /**
     * The state is announced twice on purpose and by decision: `aria-expanded` carries it for
     * assistive technology, and the label itself flips because UX owns the microcopy and ruled
     * that a reader who has expanded a section should be offered the way back in words.
     * Frontend's recorded dissent is that a name which flips is announced twice per activation;
     * if the on-device pass agrees, the fix is one catalog key and this assertion, and no
     * change to the mechanism.
     *
     * The two must never disagree, which is why they are asserted together in every state:
     * the accessible name IS the button's text content, so a stale second name — an
     * `aria-label` added beside it — would show up here as a name that stopped tracking.
     */
    const ue = userEvent.setup();
    const { container } = show({ rbac: rbac(ADMIN) });
    const control = controlIn(sectionByHeading(container, 'nav.sections.administration'));

    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(control.textContent).toBe('nav.sectionHiddenToggle(count=2,state=collapsed)');

    await ue.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'true');
    expect(control.textContent).toBe('nav.sectionHiddenToggle(count=2,state=expanded)');

    await ue.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(control.textContent).toBe('nav.sectionHiddenToggle(count=2,state=collapsed)');
  });

  it('gives each of two mounted copies its own state', async () => {
    /**
     * ADR-0005 D3's standing fact: `AppShell` mounts this component TWICE — a persistent
     * `lg:block` copy and an off-canvas copy which is also the desktop nav of an unpinned
     * 1280px window. The disclosure state is `useState`, so each copy owns its own, and that
     * is the design rather than an oversight: the persistent copy's buttons are `lg:hidden`,
     * so at every width they are out of the box tree, the a11y tree and the tab order, and
     * their state can never be changed by anybody.
     *
     * What this forbids is the reflex fix — lifting the set to a module-level singleton, or to
     * a context — which would make opening the drawer's ADMINISTRATION silently open the
     * persistent copy's too, and would leave the drawer's state alive after it was closed.
     */
    const ue = userEvent.setup();
    const { container } = render(
      <>
        <AppSidebar
          user={user()}
          rbac={rbac(ADMIN)}
          canSeeOthers={false}
          activeModules={ALL_MODULES}
        />
        <AppSidebar
          user={user()}
          rbac={rbac(ADMIN)}
          canSeeOthers={false}
          activeModules={ALL_MODULES}
        />
      </>,
    );

    const copies = sectionsByHeading(container, 'nav.sections.administration');
    expect(copies, 'both copies render the section').toHaveLength(2);
    const [first, second] = copies;
    const suppressedInSecond = suppressedIn(second).length;
    expect(suppressedInSecond).toBeGreaterThan(0);

    await ue.click(controlIn(first));

    expect(suppressedIn(first), 'the copy that was activated revealed its rows').toHaveLength(0);
    expect(suppressedIn(second), 'the other copy must not have moved').toHaveLength(
      suppressedInSecond,
    );
    expect(controlIn(second)).toHaveAttribute('aria-expanded', 'false');
  });

  it('points nothing at anything: no `id`, no idref, in either state', async () => {
    /**
     * AN EXECUTABLE ABSENCE RULE, and it is executable because the alternative — a comment
     * saying "do not add `aria-controls`" — is the kind of instruction that survives exactly
     * until the next accessibility review suggests one out of habit.
     *
     * There is nothing for an idref to point AT. The rows a control reveals are interleaved
     * siblings of rows that were always visible, so the only element that could ever have
     * carried the target id is the whole-section wrapper this change deleted — and writing
     * `aria-controls` would mean reintroducing that wrapper under a different justification,
     * one conflict later. `useId()` does not rescue it either: the component renders twice, so
     * a hand-written id would be duplicated in the document, and a generated one would point
     * at a wrapper that still does not exist.
     *
     * The sidebar emits none of these attributes at all today, so this asserts zero across the
     * whole render rather than only over the new markup — a tighter scope would let one appear
     * next door and go unnoticed. If a legitimate one is ever added elsewhere, narrow the
     * scope to the sections; do not delete the case.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    const ATTRS = ['id', 'aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby'];
    const audit = () => ATTRS.map((a) => `${a}=${container.querySelectorAll(`[${a}]`).length}`);
    const none = ATTRS.map((a) => `${a}=0`);

    expect(audit()).toEqual(none);
    await ue.click(controlIn(sectionByHeading(container, 'nav.sections.administration')));
    expect(audit(), 'expanding a section minted an id or an idref').toEqual(none);
  });

  it('keeps the footnote when one section has been opened', async () => {
    /**
     * The footnote describes the DEFAULT state of the nav, and opening one section does not
     * falsify it: five other sections are still collapsed and are still hiding 25 more
     * destinations from this reader.
     *
     * This is the weaker of the two footnote cases and it is here for the reason the plan
     * named it — it is the branch the mechanism obviously has. It passes on a build that hides
     * the footnote at full reveal, which is why the case below exists and is the binding one.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    expect(screen.getByText('nav.moreOnLargerScreen')).toBeInTheDocument();

    await ue.click(controlIn(sectionByHeading(container, 'nav.sections.administration')));

    // The reason the footnote is still true after this particular click, asserted rather than
    // asserted in the test's name: NETSUITE is still collapsed and is still hiding rows.
    expect(
      suppressedIn(sectionByHeading(container, 'nav.sections.ledger')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('nav.moreOnLargerScreen')).toBeInTheDocument();
  });

  it('keeps the footnote even when every section has been opened', async () => {
    /**
     * DECIDED 2026-09-18 by the operator: `nav.moreOnLargerScreen` stays PERMANENTLY visible.
     * It does not disappear once every section has been expanded, and deleting it was never on
     * the table — its two conditionality cases are named in this task's "must not break".
     *
     * This is the case that actually pins that decision. "Expand one section, the footnote
     * survives" is satisfied by a build that hides it at full reveal; only expanding every
     * control and finding it still there rules that build out.
     *
     * The suppression sweep in the middle is the proof that the loop did what it says: if a
     * click ever stopped toggling, or if `getAllByRole` stopped finding the six controls, the
     * footnote assertion alone would pass while nothing had actually been revealed.
     */
    const ue = userEvent.setup();
    const { container } = everything();
    const controls = within(container).getAllByRole('button');
    expect(controls).toHaveLength(LOSES_SOMETHING.length);

    // Non-vacuity, and it is not a formality: the sweep below asserts that NOTHING carries a
    // `max-lg:*` class, which is also exactly what a build that lost the small-screen gate
    // altogether renders. Establishing that 39 rows DO carry it first is what turns that
    // assertion from "the gate is gone" into "the gate was inverted by these six clicks".
    expect(
      [...container.querySelectorAll('[class*="max-lg:"]')].length,
      'nothing was suppressed to begin with — the sweep below would prove nothing',
    ).toBeGreaterThan(0);

    for (const control of controls) {
      await ue.click(control);
    }

    expect(
      [...container.querySelectorAll('[class*="max-lg:"]')],
      'every section is open, so nothing anywhere is still suppressed below lg',
    ).toHaveLength(0);
    expect(
      screen.getByText('nav.moreOnLargerScreen'),
      'the footnote is permanent — it is not a function of how much has been revealed',
    ).toBeInTheDocument();
  });
});
