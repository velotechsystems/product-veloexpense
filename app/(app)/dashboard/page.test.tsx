import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The landing page every authenticated visit is redirected to — its element tree, read
 * rather than mounted.
 *
 * IT MAKES ONE DECISION THAT IS NOT COMPOSITION. With no session it renders NOTHING rather
 * than a header addressed to nobody. The route is behind the `(app)` layout's auth gate, so
 * a sessionless render means the gate is mid-redirect, and drawing a nameless band into
 * that gap is a flash of a half-page on every cold sign-in.
 *
 * THE ASSERTIONS MOVED FROM TEXT TO PROPS, AND THAT IS NOT A WORKAROUND. The greeting is
 * gone; the reader's name is now the `h1` of an `IdentityBanner`, which means the name is a
 * PROP on a design-system component rather than a text child of anything this page renders.
 * `textOf` walks `props.children` and never invokes a child component, so it cannot see a
 * prop — see `bannerOf` below, which reads the element this page actually built. The
 * banner's own rendering is `identity-banner.test.tsx`'s job; what belongs here is what the
 * PAGE decided to hand it.
 *
 * AND ONE STRUCTURAL ASSERTION THAT NOTHING ELSE CAN MAKE. The band sits OUTSIDE every
 * `PanelBoundary` and the chips sit inside one. That is the whole reason "exactly one `h1`
 * inside `<main>`, and it is the reader's name" is an invariant rather than a hope: a throw
 * anywhere under a boundary cannot reach the heading. It is unobservable from a browser —
 * `users.get` succeeds for all nine seeded actors — so it is asserted here, against the
 * tree's shape.
 *
 * Ported from ExpenseOS (550b2945) with the page (w4-09). VeloExpense, each marked below: the
 * shell context in place of `auth()` and the module / RBAC reads, no travel card, the
 * `/preferences` link, no photos, and the setup checklist (d72).
 */

const h = vi.hoisted(() => ({
  session: null as { user?: Record<string, unknown> } | null,
  permissions: [] as string[],
  activeModules: new Set<string>(),
  /**
   * How many non-deleted users this reader manages — the second half of `canSeeOthers`,
   * which the small-screen notice below is almost entirely a function of. Default 0, so
   * every pre-existing case in this file describes a reader with no reports.
   */
  reportCount: 0,
  /** Whether `db.user.count` was reached at all, so the `readAll` short-circuit is checkable. */
  countCalls: 0,
}));

/**
 * VeloExpense: the page reads the reader, the `RbacUser`, the active modules and
 * `canSeeOthers` from the request's shell context (`server/shell.ts`) rather than calling
 * `auth()`, `activeModuleSlugs` and `resolveRbacUser` itself. The stub builds that context
 * from this file's inputs exactly as ExpenseOS's mocks fed the page — and resolves
 * `canSeeOthers` through the REAL `canSeeOthersFor`, as the shell does, so the
 * small-screen cases below still exercise the derivation and its `readAll` short-circuit.
 * No session, or one with no user on it, is a `null` shell, as `shellContext` answers.
 */
// VeloExpense: `pageTitle` and the checklist's banner read the reader's locale through
// `@/lib/i18n/request`, which reaches next-auth; nothing here is signed in through it.
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/server/shell', () => ({
  shellContext: async () => {
    if (!h.session?.user) return null;
    const { canSeeOthersFor } = await import('@/app/(app)/canSeeOthers');
    const rbac = { id: 'u-1', permissions: h.permissions };
    return {
      user: h.session.user,
      rbac,
      activeModules: h.activeModules,
      canSeeOthers: await canSeeOthersFor(rbac as never),
      organizationName: 'Acme',
    };
  },
}));
/**
 * The ONLY query this page's inputs reach: `(app)/layout.tsx`'s `canSeeOthers` derivation,
 * shared through `../canSeeOthers`. It is stubbed rather than asserted on beyond
 * `countCalls`, which exists so the `P.user.readAll` short-circuit — an admin never issues
 * it — is checkable. (VeloExpense: `@/lib/db/prisma`'s `db`, ExpenseOS's `@expenseos/db`.)
 */
vi.mock('@/lib/db/prisma', () => ({
  db: {
    user: {
      count: async () => {
        h.countCalls += 1;
        return h.reportCount;
      },
    },
  },
}));
/**
 * `IdentityChips` reaches the profile read (ExpenseOS's server-side tRPC caller;
 * VeloExpense's `getIdentityProfile`). It is never INVOKED here — neither walk below calls a
 * child component — but importing the page still resolves its module graph, so it is stubbed.
 *
 * THE THROW IS DELIBERATE, AND IT NOW DOES TWO JOBS. If a future edit awaits the chips
 * inline in the page, this makes it visible instead of silently doing IO in a unit test.
 * And because it throws unconditionally, every assertion in this file already runs against
 * a profile fetch that FAILS — which is precisely the degraded path the heading has to
 * survive. The name reaching the banner comes from the session and from nothing else, so the
 * fetch's outcome cannot move it.
 */
vi.mock('./identityProfile', () => ({
  getIdentityProfile: async () => {
    throw new Error('IdentityChips must not run during the page test');
  },
}));
/**
 * VeloExpense: the setup checklist (d72) reads through `app/(app)/dashboard/actions.ts`'s server actions.
 * Like the chips it is a child element and never invoked here; the stubs keep its module
 * graph out of the import and throw for the same reason the profile read does.
 */
vi.mock('./actions', () => {
  const never = async () => {
    throw new Error('SetupChecklist must not run during the page test');
  };
  return { getHomeContext: never, getSetupStatus: never, setSetupCollapsedFromForm: never };
});
/**
 * The page composes three preview cards, each a client component reaching
 * `@/i18n/navigation` → next-intl's navigation factory → `next/navigation`. Nothing here is
 * ever INVOKED — both walks below read the element tree without calling a child component —
 * but importing the page still resolves the cards' module graph, so the modules they reach
 * are stubbed. What this file tests is the SERVER page; each card has its own test file.
 */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => children,
  // Reached through `SmallScreenNotice` → `Sidebar.tsx`, whose module graph resolves when the
  // page is imported even though no sidebar is ever rendered here.
  usePathname: () => '/dashboard',
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (k: string) => `${ns}.${k}`,
  useLocale: () => 'en',
}));
vi.mock('@/lib/trpc/client', () => ({ trpc: {} }));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
  getLocale: async () => 'en',
}));

import { IdentityBanner } from '@expenseos/design-system';
import { permissions as P } from '@expenseos/rbac';
import { PanelBoundary } from '@/components/PanelBoundary';
import { IdentityChips } from './IdentityChips';
import DashboardPage from './page';
import { SetupChecklist } from './SetupChecklist';
import { SmallScreenNotice } from './SmallScreenNotice';

/** VeloExpense: the page takes the `?error=` its setup checklist reports through. */
const noParams = { searchParams: Promise.resolve({}) };

/** The element tree, read rather than mounted — it is a server component. */
const textOf = (node: unknown): string => {
  const el = node as { props?: { children?: unknown } } | null;
  if (el == null || typeof el !== 'object') return String(el ?? '');
  const kids = el.props?.children;
  if (Array.isArray(kids)) return kids.map(textOf).join(' ');
  return kids === undefined ? '' : textOf(kids);
};

/**
 * Every component in the returned tree, by name.
 *
 * The cards are client components and this is a server component read rather than
 * mounted, so they render no text here — the element's own name is the only observable,
 * and "is it in the tree at all" is exactly what a gate decides.
 */
const componentNames = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const child of node) componentNames(child, out);
    return out;
  }
  if (node == null || typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const name = typeof el.type === 'function' ? (el.type as { name?: string }).name : undefined;
  if (name) out.push(name);
  return componentNames(el.props?.children, out);
};

/**
 * The `IdentityBanner` element the page built, by its props.
 *
 * Matched on the IMPORTED component by reference, not on `type.name`: a rename or a
 * minifier cannot make this quietly find nothing and pass. The name and the heading level
 * live here rather than in the rendered text because this page hands the banner resolved
 * data and mounts nothing.
 */
const bannerOf = (node: unknown): Record<string, unknown> | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = bannerOf(child);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === IdentityBanner) return (el.props ?? {}) as Record<string, unknown>;
  return bannerOf(el.props?.children);
};

/**
 * Whether a `PanelBoundary` stands between the root and the given component.
 *
 * THE POINT OF IT. `qa-engineer`'s R4: "if the header becomes the `h1` and stays inside
 * that boundary, then any throw the internal `.catch` does not cover … paints
 * `common.panelUnavailable` and the page ships with ZERO `h1`s". Containment is a property
 * of where an element sits in the tree, so this walks the tree and reports it. Returns
 * `null` when the component is not in the tree at all, so "absent" cannot pass as
 * "uncontained".
 */
const isUnderBoundary = (node: unknown, target: unknown, inside = false): boolean | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = isUnderBoundary(child, target, inside);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === target) return inside;
  return isUnderBoundary(el.props?.children, target, inside || el.type === PanelBoundary);
};

/**
 * The props of the `PanelBoundary` whose direct child is `target`.
 *
 * Separate from `isUnderBoundary` because the two questions are different: that one asks
 * whether the target is contained at all, this one asks what the containing boundary was
 * asked to draw. `null` when there is no such boundary, so a missing wrapper cannot pass
 * as a wrapper with a falsy fallback.
 */
const boundaryAround = (node: unknown, target: unknown): Record<string, unknown> | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = boundaryAround(child, target);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const child = el.props?.children as { type?: unknown } | undefined;
  if (el.type === PanelBoundary && child?.type === target) {
    return (el.props ?? {}) as Record<string, unknown>;
  }
  return boundaryAround(el.props?.children, target);
};

/** The root element's props, where the server's gating decision is published. */
const gates = (node: unknown) =>
  (node as { props: Record<string, unknown> }).props as {
    'data-dashboard-travel': string;
    'data-dashboard-approvals': string;
    'data-dashboard-expenses': string;
  };

/**
 * The element of a given component type that the page built, with the props it was given.
 *
 * Matched on the IMPORTED component by reference for the same reason `bannerOf` is — a rename
 * or a minifier cannot make this quietly find nothing and pass.
 */
const elementOf = (node: unknown, target: unknown): { type: unknown; props: never } | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = elementOf(child, target);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === target) return el as { type: unknown; props: never };
  return elementOf(el.props?.children, target);
};

/**
 * What the small-screen notice the PAGE built renders — `null`, or its element.
 *
 * It is invoked with the props the page handed it rather than with props composed here: the
 * whole subject of these cases is whether the page resolved the right audience, and a call
 * with locally-built props would pass on a page that resolved the wrong one. `SmallScreenNotice`
 * is a plain function whose only hook is `useTranslations`, mocked at the top of this file, so
 * calling it outside a render is safe — and this file reads element trees rather than mounting
 * them, so there is nothing to mount it into.
 */
const noticeRender = (page: unknown): { props: { className?: string } } | null => {
  const el = elementOf(page, SmallScreenNotice);
  if (!el) throw new Error('the page did not mount SmallScreenNotice at all');
  return (el.type as (p: never) => { props: { className?: string } } | null)(el.props);
};

/** Every `href` anywhere in a rendered subtree — the notice must name no destination. */
const hrefsIn = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const child of node) hrefsIn(child, out);
    return out;
  }
  if (node == null || typeof node !== 'object') return out;
  const el = node as { props?: { href?: string; children?: unknown } };
  if (typeof el.props?.href === 'string') out.push(el.props.href);
  return hrefsIn(el.props?.children, out);
};

const signedIn = () => {
  h.session = { user: { id: 'u-1', name: 'Ada Lovelace', email: 'ada@e.inc', roleId: 'r-1' } };
};

describe('the dashboard', () => {
  beforeEach(() => {
    h.permissions = [];
    h.activeModules = new Set();
    h.reportCount = 0;
    h.countCalls = 0;
  });

  it('names the reader in the h1, from the session', async () => {
    /**
     * `nameAs` is asserted alongside the name because the two are one decision. The
     * reader's name is the top-level heading INSIDE `<main>` — not `h2`, which would
     * assert that the reader's name is a subsection of the top bar. It is not; the top bar
     * is not even inside `<main>`. The heading outline describes the content's structure,
     * not the chrome's position.
     *
     * `<main>` holds exactly one `h1` and the `<header>` above it holds another, which is
     * the honest shape of this document: no WCAG 2.2 success criterion caps a document at
     * one `h1`, the HTML spec permits one per sectioning root, and there are two landmarks
     * here. A best-practice preference, not a conformance failure.
     */
    h.session = { user: { name: 'Ada Lovelace', email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({
      name: 'Ada Lovelace',
      nameAs: 'h1',
    });
  });

  it('names the reader even though users.get throws — the h1 is session-only', async () => {
    /**
     * The degraded path, and it needs no arrangement: this file's `@/lib/trpc/server` mock
     * THROWS on every call, so every assertion in it already runs against a profile fetch
     * that fails. That is the point. The name reaching the banner is derived from `auth()`
     * alone, so the fetch's outcome cannot change it — and `auth()` has resolved before
     * this line runs, which is what leaves the heading no failure mode to contain.
     *
     * Read together with the structural assertion below: session-only text is why the
     * heading always has content, and no-boundary-above is why it is always in the tree.
     */
    h.session = { user: { name: 'Ada Lovelace', email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ name: 'Ada Lovelace' });
  });

  it('falls back to the email when the account has no display name', async () => {
    /**
     * A directory-synced account can arrive with none, and a nameless band reads as a bug
     * rather than as missing data.
     *
     * `||` AND NOT `??`, WHICH THIS TEST WOULD NOT HAVE CAUGHT ON ITS OWN. `auth.ts:690`
     * assigns `session.user.name = (token.name || '')`, so a nameless account arrives here
     * as an EMPTY STRING, never as null — and `??` would have accepted it and skipped the
     * email. The mock below supplies `null`, which both operators handle; production
     * supplies `''`, which only `||` handles. The comment is the coverage the fixture
     * cannot give.
     */
    h.session = { user: { name: null, email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ name: 'ada@e.inc' });
    h.session = { user: { name: '', email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ name: 'ada@e.inc' });
  });

  it('still renders a level-1 heading, reading nothing, for an account with neither', async () => {
    /**
     * The name of last resort. MOVED here from the greeting's test rather than deleted with
     * it, because the greeting was never what it was about: an account with no display name
     * AND no email must not have the string "null" printed at it, and — now that the name
     * is the page's only heading — must still get a heading.
     *
     * It renders EMPTY, and that is the accepted outcome rather than an overlooked one. The
     * alternative is a translated placeholder standing in for a person's name, which is a
     * new user-facing string invented for a state neither auth provider can produce (both
     * set `email`; `auth.ts` ends the session outright when it cannot resolve the row). An
     * empty heading in an unreachable state is a smaller wrong than a fabricated name in a
     * reachable one, and the previous rendering — "Welcome back, ." — was equally nameless.
     */
    h.session = { user: { name: null, email: null } };
    const page = await DashboardPage(noParams);
    expect(bannerOf(page)).toMatchObject({ name: '', nameAs: 'h1' });
    expect(textOf(page)).not.toContain('null');
    expect(JSON.stringify(bannerOf(page)?.name)).not.toContain('null');
  });

  it('derives the avatar initials from the session name, single-token and many', async () => {
    /**
     * The face is drawn from the session too, above every boundary, so its fallback text
     * has to be derivable without a fetch — the session carries ONE display-name string,
     * so the helper splits it itself: first part and last part, which is AL for "Ada
     * Lovelace" and for "Ada Byron King Lovelace" alike, and just A when there is one
     * token. This moved up from the strip with the avatar.
     */
    h.session = { user: { name: 'Ada', email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ initials: 'A' });

    h.session = { user: { name: 'Ada Byron King Lovelace', email: 'ada@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ initials: 'AL' });
  });

  it('derives initials from a non-Latin name with no space to split on', async () => {
    /** `initialsFrom` upper-cases, which is the identity map for CJK — the initials are the
     *  first character of each part, not mojibake and not an empty circle. */
    h.session = { user: { name: '陽菜 田中', email: 'hina@e.inc' } };
    expect(bannerOf(await DashboardPage(noParams))).toMatchObject({ initials: '陽田' });
  });

  it('draws the initials, never a photo, and no alt for it', async () => {
    /**
     * `session.user.image` is `token.picture`, which `auth.ts:595` sets from `avatarUrl` at
     * sign-in. The page does NOT read the fresh profile for it — that read lives under a
     * boundary in `IdentityChips`, and hoisting it up here to freshen a photo would put a
     * throwable call above the heading, which is the one thing this composition exists to
     * prevent.
     *
     * There is no `alt` prop to pass: `IdentityBanner` hides the avatar subtree from the
     * accessibility tree itself, because the name is printed as a heading immediately
     * beside it. The origin file passed `alt={fullName}` and announced the name twice.
     */
    // VeloExpense: no profile photos, so the band always draws the initials — even for a
    // session that somehow carried an image.
    h.session = { user: { name: 'Ada Lovelace', email: 'ada@e.inc', image: '/a.png' } };
    const banner = bannerOf(await DashboardPage(noParams));
    expect(banner).toMatchObject({ avatarUrl: null, initials: 'AL' });
    expect(banner).not.toHaveProperty('alt');
  });

  it('gives the profile link a 3:1 border, not the /20 the origin file has', async () => {
    /**
     * SC 1.4.11, and the one figure in this header that did not pass before the extraction.
     * `my-info/page.tsx:157` — the file this band was lifted from, since deleted — wrote
     * `border-white/20`, which measures 1.88:1 against `--color-brand-navy` and fails the
     * 3:1 required of a non-text control's boundary. `border-white/40` is 3.66:1.
     *
     * ASSERTED ON THE CLASS STRING, which is unusual here and is the point: the fix is a
     * literal in a call site, the origin literal is one `git grep` away, and transcribing
     * the wrong one is invisible in review and invisible on screen. `pages.test.tsx` cannot
     * make this assertion — its `Link` stub renders children and drops props.
     */
    signedIn();
    const action = bannerOf(await DashboardPage(noParams))?.action as
      | { props?: { className?: string; href?: string } }
      | undefined;
    // VeloExpense: ExpenseOS's `/profile` is VeloExpense's `/preferences`.
    expect(action?.props?.href).toBe('/preferences');
    expect(action?.props?.className).toContain('border-white/40');
    expect(action?.props?.className).not.toContain('border-white/20');
  });

  it('enrols the profile link in the tap-target gate, which a 30px control is invisible to', async () => {
    /**
     * `einc-tap-slop` IS ENROLMENT, NOT DECORATION, AND THAT DISTINCTION IS THE TEST.
     *
     * The control is `px-3 py-1.5 text-xs` — 30px tall, 14px under WCAG 2.2 SC 2.5.5's
     * 44px. Nothing reported that. `e2e/tap-targets.mobile.spec.ts` measures the rendered
     * `::after`, and a control declaring no slop class has no `::after`: `floored.vertical`
     * comes back `false`, the floor lane skips the control, and the negative-probe lane
     * merely agrees that it reaches nowhere. So the gate was green ABOUT this control while
     * measuring nothing about it, and `/dashboard` is already one of that file's five
     * routes. This class is what puts the control in the census; the 44px arithmetic is then
     * that file's, off the real pseudo-element, and is deliberately not restated here.
     *
     * VERTICAL ONLY. `einc-tap-slop-both` would be wrong rather than merely generous:
     * horizontal slop overflows sideways and, painting above its neighbour, wins that
     * neighbour's tap — and the neighbour is `IdentityBanner`'s `min-w-0 flex-1` name
     * column. Asserted as an exclusion too, because the two class names differ by a suffix
     * and the wrong one is invisible in review and invisible on screen.
     *
     * ASSERTED ON THE CLASS STRING for the same reason as the case above: this file reads
     * the element tree rather than rendering it, so there is no node to measure and no
     * stylesheet to measure it against. jsdom would not help — the recipe lives entirely
     * inside `@media (pointer: coarse)`.
     */
    signedIn();
    const action = bannerOf(await DashboardPage(noParams))?.action as
      | { props?: { className?: string } }
      | undefined;
    expect(action?.props?.className).toContain('einc-tap-slop');
    expect(action?.props?.className).not.toContain('einc-tap-slop-both');
  });

  it('shows no employee-status badge on the landing band', async () => {
    /**
     * ADR-0002 D6, asserted from the page side as well as from the chips' side. The badge
     * is a NODE on `IdentityBanner` rather than a boolean precisely so that this omission
     * is the absence of a construction — nothing to flip — and this is the assertion that
     * fails if somebody constructs one.
     */
    signedIn();
    expect(bannerOf(await DashboardPage(noParams))).not.toHaveProperty('statusBadge');
  });

  it('keeps the h1 outside every PanelBoundary, and the chips inside one', async () => {
    /**
     * THE INVARIANT, not a restatement of the composition. `qa-engineer`'s R4: "if the
     * header becomes the `h1` and stays inside that boundary, then any throw the internal
     * `.catch` does not cover … paints `common.panelUnavailable` and the page ships with
     * ZERO `h1`s". The band renders from the session and is uncontained because it has
     * nothing to contain; the chips fetch and are contained because they do.
     *
     * Unobservable from a browser: `users.get` succeeds for all nine seeded actors, so no
     * Playwright run ever reaches the branch this protects. Wrapping the band in a boundary
     * "for consistency" is the regression, and it would look harmless in review.
     */
    signedIn();
    const page = await DashboardPage(noParams);
    expect(isUnderBoundary(page, IdentityBanner)).toBe(false);
    expect(isUnderBoundary(page, IdentityChips)).toBe(true);
  });

  it('draws nothing rather than the standard error face when the chips fail', async () => {
    /**
     * `fallback={null}`, and the reason is `ux-ui-designer`'s: "`PanelFallback` is a
     * bordered muted box with a Retry button that reloads the page. Dropping that into a
     * navy band is wrong visually, and worse than wrong semantically — it offers a full
     * page reload to recover a DEPARTMENT LABEL. Affordances like that teach readers to
     * ignore error affordances that matter."
     *
     * `null` and `undefined` are different requests to `PanelBoundary` — omission means
     * "the standard face" — so this asserts the value, not merely its falsiness.
     */
    signedIn();
    const boundary = boundaryAround(await DashboardPage(noParams), IdentityChips);
    expect(boundary, 'no PanelBoundary wraps IdentityChips').not.toBeNull();
    expect(boundary?.fallback).toBeNull();
  });

  it('renders nothing at all without a session', async () => {
    /**
     * The `(app)` layout gates this route, so no session means the gate is mid-redirect.
     * Rendering the greeting into that gap is a flash of a half-page on every cold
     * sign-in.
     */
    h.session = null;
    expect(await DashboardPage(noParams)).toBeNull();
  });

  it('renders nothing for a session with no user on it', async () => {
    h.session = {};
    expect(await DashboardPage(noParams)).toBeNull();
  });

  /**
   * Card gating is resolved on the SERVER, published to the DOM, and — for travel —
   * decides whether the card is in the tree at all. These assertions are about WIRING
   * only; the predicate's own truth table lives next door in `selectDashboardCards.test`,
   * which is also the only place the module-off branch can be reached, since Playwright
   * cannot switch a module off and back on.
   */
  it('publishes both gates as off for a workspace with no modules installed', async () => {
    signedIn();
    h.permissions = [
      P.travel.request.createOwn,
      P.expense.report.approve,
      P.expense.report.readOwn,
    ];
    expect(gates(await DashboardPage(noParams))).toMatchObject({
      'data-dashboard-travel': 'false',
      'data-dashboard-approvals': 'false',
      'data-dashboard-expenses': 'false',
    });
  });

  it('publishes both gates as on for an installed workspace and an entitled reader', async () => {
    signedIn();
    h.activeModules = new Set(['travel', 'expense-management']);
    h.permissions = [
      P.travel.request.createOwn,
      P.expense.report.approve,
      P.expense.report.readOwn,
    ];
    expect(gates(await DashboardPage(noParams))).toMatchObject({
      'data-dashboard-travel': 'true',
      'data-dashboard-approvals': 'true',
      'data-dashboard-expenses': 'true',
    });
  });

  it('mounts no travel card even when the server says travel is on', async () => {
    /**
     * The gate is not cosmetic here. Every travel procedure sits behind
     * `moduleActive('travel')`, which THROWS `FORBIDDEN` rather than returning empty —
     * so a card mounted on a travel-off workspace paints an error panel on the first
     * screen after sign-in. Not shipping the component is also not shipping its data.
     */
    signedIn();
    h.activeModules = new Set(['travel', 'expense-management']);
    // VeloExpense: `readOwn` too, for the positive control below.
    h.permissions = [P.travel.request.createOwn, P.expense.report.readOwn];
    // VeloExpense: travel is not ported (w6), so the card is not shipped at all; the gate is
    // still published (`data-dashboard-travel`, above), and still decided by the server.
    const names = componentNames(await DashboardPage(noParams));
    expect(names).not.toContain('MyTravelRequestsCard');
    expect(names).toContain('MyExpenseReportsCard');
  });

  it('leaves the travel card out entirely for a workspace without travel', async () => {
    signedIn();
    h.activeModules = new Set(['expense-management']);
    // `readOwn` is here for the positive control below, not for the travel gate: the
    // expenses card is gated too, so a permission list without it would make the control
    // assert an absence for the wrong reason.
    h.permissions = [P.travel.request.createOwn, P.expense.report.readOwn];
    const names = componentNames(await DashboardPage(noParams));
    expect(names).not.toContain('MyTravelRequestsCard');
    // The positive control: the page really did render its "my things" row, so the
    // absence above is a gate and not an empty tree.
    expect(names).toContain('MyExpenseReportsCard');
  });

  it('mounts the approvals card only when the server says the reader may approve', async () => {
    /**
     * The gate is narrower than `/expenses/approvals` on purpose — that page also admits
     * `reimburse` and `readAll` — so this asserts the CARD follows `approve`, and nothing
     * wider. Not shipping the component is also not shipping the queue it would render.
     */
    signedIn();
    h.activeModules = new Set(['expense-management']);
    h.permissions = [P.expense.report.approve];
    expect(componentNames(await DashboardPage(noParams))).toContain('ReportsToApproveCard');
  });

  it('leaves the approvals card out entirely for a reader who cannot approve', async () => {
    /**
     * The reimburse-only AP clerk: they can open the inbox, and they get no card, because
     * the card is about work waiting on *your decision*. This is the assertion that should
     * fail if anyone ever "fixes" the narrowing by widening it.
     */
    signedIn();
    h.activeModules = new Set(['expense-management']);
    // A real AP clerk holds `readOwn` from `collectEmployeeBase()`, so this is the seeded
    // shape and not a convenience — and it keeps the positive control below meaningful now
    // that the expenses card has a gate of its own.
    h.permissions = [P.expense.report.reimburse, P.expense.report.readOwn];
    const names = componentNames(await DashboardPage(noParams));
    expect(names).not.toContain('ReportsToApproveCard');
    // The positive control: the page really did render its "my things" row, so the
    // absence above is a gate and not an empty tree.
    expect(names).toContain('MyExpenseReportsCard');
  });

  it('mounts the expenses card only when the reader may read their own reports', async () => {
    /**
     * Two mechanisms, one gate. `/expenses` calls `requireActiveModule`, so with the
     * module off every row link is a 404; and `expenses.list`, the card's only query, is
     * `withPermission(readOwn)`, which THROWS rather than returning empty, so a
     * reader without it gets an error panel with a Retry that cannot succeed. Not
     * shipping the component is also not shipping either failure.
     */
    signedIn();
    h.activeModules = new Set(['expense-management']);
    h.permissions = [P.expense.report.readOwn];
    expect(componentNames(await DashboardPage(noParams))).toContain('MyExpenseReportsCard');
  });

  it('leaves the expenses card out entirely for a reader without read-own', async () => {
    /**
     * The Role Builder case, and the reason this assertion cannot be an E2E one: every
     * SEEDED role holds `readOwn`, so no Playwright actor can reach this branch. A custom
     * role composed without it is ordinary, and it used to land on a permanent
     * `common.panelUnavailable` panel on the first screen after signing in.
     */
    signedIn();
    h.activeModules = new Set(['travel', 'expense-management']);
    h.permissions = [P.travel.request.createOwn, P.expense.report.approve];
    const names = componentNames(await DashboardPage(noParams));
    expect(names).not.toContain('MyExpenseReportsCard');
    // The positive control: the page really did render its other cards, so the absence
    // above is a gate and not an empty tree. (VeloExpense: no travel card to count.)
    expect(names).toContain('ReportsToApproveCard');
  });

  it('never calls notFound — a module gate must not 404 the landing page', async () => {
    /**
     * The whole reason the dashboard reads `activeModuleSlugs` instead of
     * `requireActiveModule`. If this page ever grows a module guard, every workspace
     * without that module gets a 404 on the first screen after sign-in. `next/navigation`
     * is not mocked here, so a `notFound()` call would throw NEXT_NOT_FOUND and this
     * would fail rather than quietly pass.
     */
    signedIn();
    await expect(DashboardPage(noParams)).resolves.not.toBeNull();
  });
  /**
   * VeloExpense (d72): the setup checklist, a VeloExpense card above ExpenseOS's. What it
   * shows, and to whom, is `e2e/dashboard.spec.ts`'s and the checklist's own; what the PAGE
   * decides is where it sits, that it is contained, and what it is handed.
   */
  describe('the setup checklist', () => {
    it('sits after the identity band and before every card, under its own boundary', async () => {
      signedIn();
      h.activeModules = new Set(['expense-management']);
      h.permissions = [P.expense.report.approve, P.expense.report.readOwn];
      const page = await DashboardPage(noParams);
      const names = componentNames(page);
      expect(names.indexOf('IdentityBanner')).toBeLessThan(names.indexOf('SetupChecklist'));
      expect(names.indexOf('SetupChecklist')).toBeLessThan(names.indexOf('ReportsToApproveCard'));
      expect(names.indexOf('SetupChecklist')).toBeLessThan(names.indexOf('MyExpenseReportsCard'));
      expect(isUnderBoundary(page, SetupChecklist)).toBe(true);
      // Contained, but the band is not: a failed setup read cannot take the heading.
      expect(isUnderBoundary(page, IdentityBanner)).toBe(false);
    });

    it('is handed the ?error= its Hide / Show form reports through', async () => {
      signedIn();
      const errorOf = (page: unknown) =>
        (elementOf(page, SetupChecklist) as { props: { error?: string } } | null)?.props.error;
      expect(errorOf(await DashboardPage({ searchParams: Promise.resolve({ error: 'Not allowed' }) }))).toBe(
        'Not allowed',
      );
      expect(errorOf(await DashboardPage(noParams))).toBeUndefined();
    });

    it('is mounted for every reader — it decides for itself who sees it', async () => {
      // The checklist renders nothing for anyone but an admin, and asks for the setup read
      // only for an admin (`app/(app)/dashboard/actions.ts`), so the page does not gate it a second time.
      signedIn();
      expect(componentNames(await DashboardPage(noParams))).toContain('SetupChecklist');
    });
  });

  /**
   * ─── THE SMALL-SCREEN NOTICE ───────────────────────────────────────────────────────────
   *
   * ADR-0005 D7 is the whole of it: a signpost "must not announce a loss to a reader whose
   * RBAC never entitled them to the destination in the first place". So the condition is
   * tested in BOTH directions, and the negative is the more important of the two — it is the
   * case that fires at every employee in the company if the predicate is ever rewired to
   * `MOBILE_READINESS`'s `desktop` keys, which carry no permission and no module slug.
   *
   * The notice itself is a client component, so what the page can be asked is (a) that it
   * mounted it with the audience IT resolved, and (b) what that audience makes it render. Both
   * are asserted from the element the page built.
   */
  describe('the small-screen notice', () => {
    it('renders nothing for an ordinary employee, who loses no destination below lg', async () => {
      /**
       * THE D7 CASE. An employee with `readOwn` and no reports sees `/dashboard` (limited) and
       * `/expenses` (limited) and nothing that is `desktop`-ruled — so there is no loss to
       * announce, and announcing one would tell them a Role Builder exists that they cannot
       * have. Measured on this branch: for a reader with no admin, audit, config, NetSuite or
       * AP permission the ONLY `desktop`-ruled nav destination is `/users`.
       */
      signedIn();
      h.activeModules = new Set(['expense-management']);
      h.permissions = [P.expense.report.readOwn];
      expect(noticeRender(await DashboardPage(noParams))).toBeNull();
    });

    it('renders for an admin, who loses most of the menu below lg', async () => {
      signedIn();
      // VeloExpense: business units, not roles — `/admin/roles` is not here until w4-10.
      h.permissions = [P.admin.businessUnit.list];
      const notice = noticeRender(await DashboardPage(noParams));
      expect(notice).not.toBeNull();
      expect(textOf(notice)).toContain('nav.smallScreenNotice');
    });

    it('hands a manager with reports canSeeOthers, which hides nothing here until /users is ported', async () => {
      /**
       * THE `canSeeOthers` CASE, and the reason the page resolves that fact rather than
       * passing `false`. `/users` is `desktop`-ruled and carries NO `requires` — its only gate
       * is "do you manage anyone" — so for this reader it is the entire predicate. Passing
       * `false` would withhold the notice from every manager with reports while their sidebar,
       * one screen away, showed the HOME disclosure control and the footnote saying something
       * WAS hidden: two surfaces of one feature, disagreeing.
       *
       * VeloExpense: `/users` is not here yet (`VELOEXPENSE_ROUTES` maps it to `null`), so it
       * is not in this manager's menu and there is no loss to announce — the notice is `null`
       * either way, and ExpenseOS's assertion that it renders becomes true when `/users` is
       * ported. What holds now is the wiring: the page hands the notice the `canSeeOthers` it
       * resolved, `true` with a report and `false` without.
       */
      signedIn();
      h.activeModules = new Set(['expense-management']);
      h.permissions = [P.expense.report.readOwn];
      h.reportCount = 1;
      const withReports = await DashboardPage(noParams);
      expect((elementOf(withReports, SmallScreenNotice) as { props: { canSeeOthers: boolean } } | null)?.props
        .canSeeOthers).toBe(true);
      expect(noticeRender(withReports)).toBeNull();

      h.reportCount = 0;
      const without = await DashboardPage(noParams);
      expect((elementOf(without, SmallScreenNotice) as { props: { canSeeOthers: boolean } } | null)?.props
        .canSeeOthers).toBe(false);
      expect(noticeRender(without)).toBeNull();
    });

    it('hides itself at lg and up, with a literal class', async () => {
      /**
       * ASSERTED ON THE CLASS STRING, which is the only place it can be asserted: Tailwind v4
       * has no JS config and no safelist and scans source TEXT, so a runtime-assembled class
       * emits no CSS while the element still carries the attribute — `build` succeeds, `lint`
       * is silent, and the notice is visible on the desktop dashboard forever. This catches
       * the attribute going missing; only review catches it being assembled.
       */
      signedIn();
      // VeloExpense: business units, not roles — `/admin/roles` is not here until w4-10.
      h.permissions = [P.admin.businessUnit.list];
      expect(noticeRender(await DashboardPage(noParams))?.props.className).toContain('lg:hidden');
    });

    it('names no destination — no link, no route list', async () => {
      /**
       * `security-specialist`'s ruling, carried into the plan: naming the hidden pages is what
       * turns a signpost into a disclosure of what this reader may not have. The sidebar's own
       * per-section controls are where a reader goes to find them.
       */
      signedIn();
      // VeloExpense: business units, not roles — `/admin/roles` is not here until w4-10.
      h.permissions = [P.admin.businessUnit.list];
      const notice = noticeRender(await DashboardPage(noParams));
      expect(hrefsIn(notice)).toEqual([]);
      expect(textOf(notice)).not.toContain('/');
    });

    it('sits above the identity band and every card', async () => {
      /**
       * Position is the feature. It is a claim about this whole screen, so a reader who meets
       * it after three previews has already formed the impression it exists to correct.
       * Nothing else pins the order of this page's children.
       */
      signedIn();
      // VeloExpense: business units, not roles — `/admin/roles` is not here until w4-10.
      h.permissions = [P.admin.businessUnit.list];
      const page = await DashboardPage(noParams);
      const children = (page as { props: { children: unknown[] } }).props.children.flat();
      const noticeAt = children.findIndex(
        (c) => (c as { type?: unknown })?.type === SmallScreenNotice,
      );
      expect(noticeAt).toBe(0);
    });

    it('hands the notice the audience the page itself resolved', async () => {
      /**
       * The wiring, separately from the decision. `activeModules` is asserted by REFERENCE
       * against the set the platform stub returned, so a page that built its own set — or read
       * the registry directly, which is the failure the architecture ruling names — fails here
       * rather than passing on a coincidentally equal value.
       */
      signedIn();
      h.activeModules = new Set(['expense-management']);
      h.permissions = [P.expense.report.readOwn];
      const el = elementOf(await DashboardPage(noParams), SmallScreenNotice) as {
        props: { rbac: { permissions: string[] }; canSeeOthers: boolean; activeModules: unknown };
      } | null;
      expect(el?.props.activeModules).toBe(h.activeModules);
      expect(el?.props.rbac.permissions).toBe(h.permissions);
      expect(el?.props.canSeeOthers).toBe(false);
    });

    it('never counts reports for an admin — readAll short-circuits the query', async () => {
      /**
       * The cost of resolving `canSeeOthers` here at all, pinned. `P.user.readAll` answers the
       * question outright, so the indexed count is issued only for readers who fail it; and for
       * those, `resolveCanSeeOthers` is `cache()`d, so a cold load shares ONE count between the
       * layout and this page rather than running two.
       */
      signedIn();
      h.permissions = [P.user.readAll];
      await DashboardPage(noParams);
      expect(h.countCalls).toBe(0);

      h.permissions = [P.expense.report.readOwn];
      await DashboardPage(noParams);
      expect(h.countCalls).toBe(1);
    });
  });
});
