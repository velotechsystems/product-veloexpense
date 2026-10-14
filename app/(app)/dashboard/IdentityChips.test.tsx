import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chips on the landing page's identity band — the fetched half of it, and the only
 * half that can fail.
 *
 * Four things it must never do, each of which has a test below: 500 the page when
 * `users.get` throws, render an employee-status badge, render a heading of any level, or
 * lose the `data-dashboard-identity` instrument that says which source answered.
 *
 * THE THIRD ONE IS THE NEW LOAD-BEARING ONE. The reader's name is now the single `h1`
 * inside `<main>` and it renders in `page.tsx`, above every boundary. If these chips ever
 * grew a heading, `<main>` would hold two — and if they had KEPT the name, a throw the
 * `.catch` did not cover would take the heading out with it and the page would ship with
 * zero. Both directions are asserted here, because neither can be asserted from a browser:
 * `users.get` succeeds for all nine seeded actors.
 */

const h = vi.hoisted(() => ({
  session: null as unknown,
  me: null as unknown,
  throws: false,
}));

// VeloExpense: the session from the shell context, the profile from `getIdentityProfile`
// (VeloExpense's stand-in for `users.get`).
vi.mock('@/server/shell', () => ({ shellContext: async () => h.session }));
vi.mock('./identityProfile', () => ({
  getIdentityProfile: async () => {
    if (h.throws) throw new Error('FORBIDDEN');
    return h.me;
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));

import { IdentityChips } from './IdentityChips';

const session = (over: Record<string, unknown> = {}) => ({
  user: {
    id: 'u-1',
    name: 'Ada Lovelace',
    email: 'ada@e.inc',
    roleId: 'r-1',
    roleLabel: 'Employee',
    organizationId: 'o-1',
    ...over,
  },
});

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@e.inc',
  avatarUrl: null,
  employeeStatus: 'ON_LEAVE',
  role: { id: 'r-1', label: { en: 'Engineering Manager', 'fr-CA': 'Gestionnaire' } },
  department: { id: 'd-1', label: { en: 'Engineering', 'fr-CA': 'Ingénierie' } },
  ...over,
});

beforeEach(() => {
  h.session = session();
  h.me = profile();
  h.throws = false;
});

describe('the identity chips', () => {
  it('shows the two facts the band fetches: role and department', async () => {
    render(await IdentityChips());
    expect(screen.getByText('Engineering Manager')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('renders the role and the department as chips, not as a grey sub-line', async () => {
    /**
     * `IdentityBannerChip`, never a re-typed class string. The arbitration that extracted
     * `IdentityBanner` named the chip explicitly, because the duplicated region it was
     * authorized to remove contained two byte-identical copies of that class string — so a
     * call site that re-types it reproduces the defect one file over.
     */
    const { container } = render(await IdentityChips());
    const chips = container.querySelectorAll('span.rounded-full');
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toHaveClass('bg-white/15', 'text-white');
  });

  it('carries no employee-status badge', async () => {
    /**
     * The profile page shows one and keeps it. This band omits it deliberately: a status
     * badge on the first screen after sign-in states something the reader already knows, in
     * a colour that implies an action, on a page with no action to take (ADR-0002 D6).
     * Deleting this test to add the badge back is the mistake this test exists to catch.
     */
    render(await IdentityChips());
    expect(screen.queryByText(/on.?leave/i)).not.toBeInTheDocument();
    expect(screen.queryByText('ON_LEAVE')).not.toBeInTheDocument();
  });

  it('renders no heading at all, at any level', async () => {
    /**
     * The invariant `<main>` depends on, from the other side. The reader's name is the one
     * `h1` inside `<main>` and `page.tsx` owns it; a heading down here would make two, and
     * it would make two only in a browser, where nothing counts them. Asserted by ROLE and
     * not by tag, so an `aria-level`'d div would fail this too.
     */
    render(await IdentityChips());
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('renders no name — the name belongs to the page, above every boundary', async () => {
    /**
     * Not cosmetic. Were the name printed here it would sit UNDER `PanelBoundary`, and a
     * throw the `.catch` above does not cover would replace it with the boundary's fallback
     * — leaving `<main>` with no `h1` at all. That the name is absent from this subtree is
     * what makes "exactly one `h1` inside `<main>`, and it is the reader's name" an
     * invariant rather than a hope.
     */
    const { container } = render(await IdentityChips());
    expect(container.textContent).not.toMatch(/Ada/);
  });

  it('publishes `fresh` when the profile answered', async () => {
    /**
     * The E2E instrument, and the reason it exists. `dashboard.spec.ts` used to prove the
     * fresh profile was preferred over the session snapshot by matching the full name
     * exactly — which stopped proving anything the moment the name became the `h1` and came
     * from the session: the degraded path prints the identical string whenever the two
     * agree, and they agree for all nine seeded actors. This attribute names the source.
     */
    const { container } = render(await IdentityChips());
    expect(container.querySelector('[data-dashboard-identity]')).toHaveAttribute(
      'data-dashboard-identity',
      'fresh',
    );
  });

  it('falls back to the session when users.get throws, instead of taking the page down', async () => {
    /**
     * `users.get` throws FORBIDDEN when `canViewUser` says no, NOT_FOUND when the row is
     * gone, and whatever the database throws underneath. These chips are the one way the
     * landing page could 500, so the throw stops here and the one fact the session already
     * holds is drawn instead.
     */
    h.throws = true;
    render(await IdentityChips());
    expect(screen.getByText('Employee')).toBeInTheDocument();
    // No department in the session, so none is drawn — and no em dash standing in for it.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.getByText('Employee').closest('[data-dashboard-identity]')).toHaveAttribute(
      'data-dashboard-identity',
      'session',
    );
  });

  it('still publishes the instrument when the throw leaves it nothing to draw', async () => {
    /**
     * A custom role with an empty label, plus a throw: no chips, and the wrapper renders
     * anyway. The attribute reports WHICH SOURCE answered, so a run where `users.get`
     * throws for everybody is exactly the run in which an instrument that vanished with
     * its chips would report nothing at all — which reads as "the page did not render".
     */
    h.throws = true;
    h.session = session({ roleLabel: '' });
    const { container } = render(await IdentityChips());
    expect(container.querySelectorAll('span.rounded-full')).toHaveLength(0);
    expect(container.querySelector('[data-dashboard-identity]')).toHaveAttribute(
      'data-dashboard-identity',
      'session',
    );
  });

  it('prefers the fresh role label over the session snapshot, which is always English', async () => {
    /**
     * `auth.ts:35-43`'s `resolveRoleLabel` returns `label.en` unconditionally, so
     * `session.user.roleLabel` is a MONOLINGUAL snapshot rather than merely a stale one.
     * Only the fresh row can be localized, which is why the fetch is worth having at all
     * for a two-word label.
     */
    render(await IdentityChips());
    expect(screen.getByText('Engineering Manager')).toBeInTheDocument();
    expect(screen.queryByText('Employee')).not.toBeInTheDocument();
  });

  it('draws no department chip when the profile has none', async () => {
    h.me = profile({ department: null });
    const { container } = render(await IdentityChips());
    expect(container.querySelectorAll('span.rounded-full')).toHaveLength(1);
    expect(screen.getByText('Engineering Manager')).toBeInTheDocument();
  });

  it('renders nothing without a session', async () => {
    h.session = null;
    expect(await IdentityChips()).toBeNull();
  });

  it('lets an unbounded customer-authored label wrap rather than pin the row', async () => {
    /**
     * Department labels are `getLocalized(...)` strings of whatever length the workspace
     * typed. `IdentityBannerChip` carries no `whitespace-nowrap` on purpose — the band's
     * reflow fix (SC 1.4.10) depends on this row being allowed to wrap and, inside a chip,
     * to break. Pinning it hands the horizontal scrollbar straight back, on the first
     * screen of every authenticated session.
     */
    h.me = profile({
      department: { id: 'd-1', label: { en: 'Corporate Real Estate and Workplace Services' } },
    });
    const { container } = render(await IdentityChips());
    const chip = screen.getByText('Corporate Real Estate and Workplace Services');
    expect(chip).not.toHaveClass('whitespace-nowrap');
    expect(chip).not.toHaveClass('truncate');
    // The wrapper is `display: contents`, so each chip stays a DIRECT child of the band's
    // wrapping flex row instead of the two of them becoming one unshrinkable flex item.
    expect(container.firstElementChild).toHaveClass('contents');
  });
});
