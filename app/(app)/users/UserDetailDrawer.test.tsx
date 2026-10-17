import type React from 'react';
import '@testing-library/jest-dom/vitest';
import enPeople from '@expenseos/i18n/catalogs/en/people';
import frPeople from '@expenseos/i18n/catalogs/fr-CA/people';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';

/**
 * The people-directory detail drawer.
 *
 * It is read-only, so the risk is not a bad write — it is a confident blank. Every field
 * here is optional in the schema (a contractor with no department, a user who has never
 * logged in, an employee with no manager), and a drawer that renders those as empty
 * space reads as a page that failed rather than a person with gaps.
 *
 * Two things beyond that:
 *
 *   · **The org chart is navigable.** The manager and each direct report open their own
 *     drawer, which is what makes the reporting section worth having rather than a list
 *     of names to go and search for.
 *   · **Virtual cards are gated on the MODULE.** A tenant without the module must not
 *     see an empty "Virtual cards" section implying it has none — the section should not
 *     be there at all. The server also decides whether the caller may see them, so the
 *     query is only mounted when the module is on.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { UserDetailDrawer } from './UserDetailDrawer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  firstName: 'Dana',
  lastName: 'Patel',
  email: 'dana@e.inc',
  employeeStatus: 'ACTIVE',
  role: { id: 'r-1', label: { en: 'Approver' } },
  manager: { id: 'u-9', firstName: 'Sam', lastName: 'Ito', email: 'sam@e.inc' },
  entity: { id: 'le-1', label: { en: 'Carmigo Canada' } },
  businessUnit: { id: 'bu-1', label: { en: 'Retail' } },
  nsBusinessUnit: { id: 'nsbu-1', name: 'US Operations : EB Digital US' },
  department: { id: 'd-1', label: { en: 'Finance' } },
  jobLevel: { id: 'jl-1', label: { en: 'Senior' } },
  country: 'CA',
  homeCurrency: 'CAD',
  onLeaveAt: null,
  terminationDate: null,
  lastLoginAt: new Date().toISOString(),
  externalIds: {},
  syncDiscrepancies: [],
  ...over,
});

const report = (i: number) => ({
  id: `u-r${i}`,
  firstName: `Rep${i}`,
  lastName: 'Person',
  email: `rep${i}@e.inc`,
});

const expenseReport = (over: Record<string, unknown> = {}) => ({
  id: 'er-1',
  title: 'Toronto client visit',
  status: 'SUBMITTED',
  totalMinor: '124500',
  currencyCode: 'CAD',
  currencySymbol: '$',
  expenseCount: 4,
  date: '2026-07-14T00:00:00.000Z',
  ...over,
});

const delegation = (over: Record<string, unknown> = {}) => ({
  id: 'dg-1',
  scope: 'ALL',
  active: true,
  startsAt: '2026-07-01T00:00:00.000Z',
  endsAt: null,
  direction: 'OUTGOING',
  counterparty: { id: 'u-7', firstName: 'Wei', lastName: 'Chen', email: 'wei@e.inc' },
  ...over,
});

function setTrpc(
  data: {
    user?: unknown;
    reports?: unknown[];
    cards?: unknown[];
    /** `null` models "you may not see this"; `[]` models "there are none". */
    expenseReports?: unknown[] | null;
    delegations?: unknown[] | null;
  } = {},
  over: TrpcMockConfig = {},
) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'users.get': { data: data.user ?? user(), ...over.queries?.['users.get'] },
      'users.getDirectReports': { data: { items: data.reports ?? [] } },
      'virtualCards.list': {
        data: { items: data.cards ?? [] },
        ...over.queries?.['virtualCards.list'],
      },
      'users.activity': {
        data: {
          reports: data.expenseReports === undefined ? [] : data.expenseReports,
          delegations: data.delegations === undefined ? [] : data.delegations,
          canReadReports: data.expenseReports !== null,
          canReadDelegations: data.delegations !== null,
        },
        ...over.queries?.['users.activity'],
      },
      ...over.queries,
    },
  });
}

const onClose = vi.fn();
const onOpenUser = vi.fn();

const show = (props: Record<string, unknown> = {}) =>
  render(
    <UserDetailDrawer
      userId="u-1"
      locale={DEFAULT_LOCALE}
      onClose={onClose}
      onOpenUser={onOpenUser}
      {...props}
    />,
  );

/** The value beside a label, in the two-column field grid. */
const fieldValue = (label: string) =>
  (screen.getAllByText(label)[0].nextElementSibling as HTMLElement).textContent ?? '';

afterEach(() => {
  h.trpc = undefined;
  onClose.mockReset();
  onOpenUser.mockReset();
  vi.restoreAllMocks();
});

// ── Opening ───────────────────────────────────────────────────────────────────

describe('opening the drawer', () => {
  it('asks for nothing while it is closed', () => {
    /**
     * The drawer is always mounted so the slide animation survives; without the
     * `enabled` gate it would fetch a profile for an empty id on every page render.
     */
    const profile = vi.fn();
    const reports = vi.fn();
    setTrpc(
      {},
      {
        queries: {
          'users.get': { data: user(), onCall: profile },
          'users.getDirectReports': { data: { items: [] }, onCall: reports },
        },
      },
    );
    show({ userId: null });
    expect(profile.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
    expect(reports.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it('says nothing was found rather than rendering an empty person', () => {
    setTrpc({}, { queries: { 'users.get': { data: null } } });
    show();
    expect(screen.getByText('people.detail.notFound')).toBeInTheDocument();
  });

  it('shows a skeleton while the profile loads', () => {
    // Not "not found" — which would be a claim, and a wrong one.
    setTrpc({}, { queries: { 'users.get': { isLoading: true, data: undefined } } });
    show();
    expect(screen.queryByText('people.detail.notFound')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('closes when dismissed', async () => {
    const user_ = userEvent.setup();
    setTrpc();
    show();
    await user_.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('who the person is', () => {
  it('heads with their name, role and status', () => {
    setTrpc();
    show();
    expect(screen.getByText('Dana Patel')).toBeInTheDocument();
    expect(screen.getAllByText('Approver').length).toBeGreaterThan(0);
    expect(screen.getAllByText('people.status.ACTIVE').length).toBeGreaterThan(0);
  });

  it('falls back to the email when there is no name yet', () => {
    // A directory-synced user can arrive before the name fields are populated.
    setTrpc({ user: user({ firstName: null, lastName: null }) });
    show();
    expect(screen.getAllByText('dana@e.inc').length).toBeGreaterThan(0);
  });

  it('makes the email a mail link, since that is what it is for', () => {
    setTrpc();
    show();
    expect(screen.getByRole('link', { name: 'dana@e.inc' })).toHaveAttribute(
      'href',
      'mailto:dana@e.inc',
    );
  });

  it('tones each employee status differently', () => {
    // ACTIVE and TERMINATED reading the same is how the wrong person gets an approval.
    setTrpc();
    show();
    const active = screen.getAllByText('people.status.ACTIVE')[0].className;
    render(<div />);
    setTrpc({ user: user({ employeeStatus: 'TERMINATED' }) });
    show();
    expect(screen.getAllByText('people.status.TERMINATED')[0].className).not.toEqual(active);
  });

  it('names the leave date only for somebody on leave', () => {
    setTrpc();
    show();
    expect(screen.queryByText('people.detail.onLeaveSince')).not.toBeInTheDocument();

    setTrpc({
      user: user({ employeeStatus: 'ON_LEAVE', onLeaveAt: '2026-06-01T12:00:00.000Z' }),
    });
    show();
    expect(fieldValue('people.detail.onLeaveSince')).toContain('2026');
  });

  it('names the termination date only for somebody terminated', () => {
    setTrpc({
      user: user({ employeeStatus: 'TERMINATED', terminationDate: '2026-05-15T12:00:00.000Z' }),
    });
    show();
    expect(fieldValue('people.detail.termination')).toContain('2026');
  });
});

// ── Last login ────────────────────────────────────────────────────────────────

describe('the last login', () => {
  it('says today for a login today', () => {
    setTrpc();
    show();
    expect(fieldValue('people.detail.lastLogin')).toBe('people.lastLogin.today');
  });

  it('says yesterday for the day before', () => {
    setTrpc({ user: user({ lastLoginAt: new Date(Date.now() - 26 * 3600_000).toISOString() }) });
    show();
    expect(fieldValue('people.detail.lastLogin')).toBe('people.lastLogin.yesterday');
  });

  it('counts the days for anything within a month', () => {
    /**
     * "12 days ago" answers "is this account dormant" at a glance; a date makes the
     * reader do the arithmetic.
     */
    setTrpc({ user: user({ lastLoginAt: new Date(Date.now() - 12 * 86400_000).toISOString() }) });
    show();
    expect(fieldValue('people.detail.lastLogin')).toBe('people.lastLogin.daysAgo:12');
  });

  it('falls back to a date once the relative form stops being useful', () => {
    // "413 days ago" is not a sentence anybody reads.
    setTrpc({ user: user({ lastLoginAt: '2024-02-01T12:00:00.000Z' }) });
    show();
    expect(fieldValue('people.detail.lastLogin')).toContain('2024');
  });

  it('dashes an account that has never signed in', () => {
    setTrpc({ user: user({ lastLoginAt: null }) });
    show();
    expect(fieldValue('people.detail.lastLogin')).toBe('—');
  });
});

// ── The org chart ─────────────────────────────────────────────────────────────

describe('reporting', () => {
  it('opens the manager’s own drawer', () => {
    // The reporting section is only worth having if you can walk it.
    setTrpc();
    show();
    expect(screen.getByRole('button', { name: /Sam Ito/ })).toBeInTheDocument();
  });

  it('walks up to the manager on a click', async () => {
    const user_ = userEvent.setup();
    setTrpc();
    show();
    await user_.click(screen.getByRole('button', { name: /Sam Ito/ }));
    expect(onOpenUser).toHaveBeenCalledWith('u-9');
  });

  it('dashes a person with no manager rather than leaving a gap', () => {
    setTrpc({ user: user({ manager: null }) });
    show();
    expect(fieldValue('people.columns.manager')).toBe('—');
  });

  it('counts the direct reports in the label, and says when there are none', () => {
    setTrpc();
    show();
    expect(screen.getByText('people.detail.directReports:0')).toBeInTheDocument();
    expect(screen.getByText('people.detail.none')).toBeInTheDocument();
  });

  it('lists the direct reports, each opening their own drawer', async () => {
    const user_ = userEvent.setup();
    setTrpc({ reports: [report(1), report(2)] });
    show();
    expect(screen.getByText('people.detail.directReports:2')).toBeInTheDocument();
    await user_.click(screen.getByRole('button', { name: /Rep2 Person/ }));
    expect(onOpenUser).toHaveBeenCalledWith('u-r2');
  });

  it('caps a long list and says how many more there are', () => {
    /**
     * A manager with forty reports would otherwise push every other section off the
     * drawer — and the count is the useful part anyway.
     */
    setTrpc({ reports: Array.from({ length: 11 }, (_, i) => report(i)) });
    show();
    expect(screen.getByText('people.detail.directReports:11')).toBeInTheDocument();
    expect(screen.getByText('people.detail.andMore:3')).toBeInTheDocument();
    expect(screen.queryByText('Rep9 Person')).not.toBeInTheDocument();
  });

  it('names a report by email when they have no name', () => {
    setTrpc({ reports: [{ id: 'u-x', firstName: null, lastName: null, email: 'x@e.inc' }] });
    show();
    expect(screen.getByText('x@e.inc')).toBeInTheDocument();
  });
});

// ── Organization ──────────────────────────────────────────────────────────────

describe('the org assignments', () => {
  it('resolves each assignment to its label', () => {
    setTrpc();
    show();
    expect(fieldValue('people.columns.entity')).toBe('Carmigo Canada');
    expect(fieldValue('people.columns.businessUnit')).toBe('Retail');
    expect(fieldValue('people.columns.department')).toBe('Finance');
    expect(fieldValue('people.columns.jobLevel')).toBe('Senior');
  });

  it('dashes every assignment a person does not have', () => {
    /**
     * All four are nullable — a contractor may have none of them. Rendering blanks makes
     * the drawer look broken instead of showing a person with gaps.
     */
    setTrpc({
      user: user({
        entity: null,
        businessUnit: null,
        department: null,
        jobLevel: null,
        country: null,
        homeCurrency: null,
      }),
    });
    show();
    for (const label of [
      'people.columns.entity',
      'people.columns.businessUnit',
      'people.columns.department',
      'people.columns.jobLevel',
      'people.detail.country',
      'people.detail.homeCurrency',
    ]) {
      expect(fieldValue(label)).toBe('—');
    }
  });

  it('shows the NetSuite business unit straight after the business unit', () => {
    setTrpc();
    show();
    const admin = screen.getAllByText('people.columns.businessUnit')[0].parentElement;
    const ns = screen.getByText('people.columns.nsBusinessUnit').parentElement;
    expect(admin?.nextElementSibling).toBe(ns);
    // The mirror row's own NetSuite name — not localized, NetSuite owns it.
    expect(fieldValue('people.columns.nsBusinessUnit')).toBe('US Operations : EB Digital US');
  });

  it('dashes the NetSuite business unit when the sync has set none', () => {
    setTrpc({ user: user({ nsBusinessUnit: null }) });
    show();
    expect(fieldValue('people.columns.nsBusinessUnit')).toBe('—');
    // The admin one is independent of it.
    expect(fieldValue('people.columns.businessUnit')).toBe('Retail');
  });

  it('labels the NetSuite business unit in both catalogs', () => {
    // The translator above is an identity mock, so the label itself is read off the catalogs.
    expect(enPeople.columns.nsBusinessUnit).toBe('NetSuite Business Unit');
    expect(frPeople.columns.nsBusinessUnit).toBe("Unité d'affaires NetSuite");
  });

  it('shows the external systems only when there are some', () => {
    // An empty "External systems" heading implies a sync that failed.
    setTrpc();
    show();
    expect(screen.queryByText('people.detail.externalSystems')).not.toBeInTheDocument();

    setTrpc({ user: user({ externalIds: { netsuite: '1042' } }) });
    show();
    expect(screen.getByText('people.detail.externalSystems')).toBeInTheDocument();
  });
});

// ── Virtual cards ─────────────────────────────────────────────────────────────

// VeloExpense: ExpenseOS's "virtual cards section" block is not ported — virtual cards are
// out of scope (7 Oct 2026), so the drawer has no such section.

// ── The placeholders ──────────────────────────────────────────────────────────

describe('the activity section', () => {
  /**
   * Both halves of this section read "coming soon" for months after the features had
   * shipped, so an admin looking into an account was told to wait for something that
   * already existed and had to go searching two other screens for the same person.
   */
  const activity = () =>
    screen.getByText('people.detail.activity').closest('section') as HTMLElement;

  it("lists the person's expense reports", () => {
    setTrpc({ expenseReports: [expenseReport()] });
    show();
    const section = activity();
    expect(within(section).getByText('Toronto client visit')).toBeInTheDocument();
    // Money with its CODE, not just the glyph: this list can hold more than one
    // currency and CAD and USD both print `$`.
    expect(within(section).getByText(/1,245\.00/)).toBeInTheDocument();
    expect(within(section).getByText(/CAD/)).toBeInTheDocument();
  });

  it('links each report to the report itself', () => {
    setTrpc({ expenseReports: [expenseReport({ id: 'er-42' })] });
    show();
    const link = within(activity()).getByText('Toronto client visit').closest('a');
    expect(link).toHaveAttribute('href', '/en/expenses/er-42');
  });

  it('translates the report status rather than printing the enum', () => {
    // The pill goes through `statusBadgeProps`, which is what keeps an English
    // "Approved" off a French screen (GA readiness report F43).
    setTrpc({ expenseReports: [expenseReport({ status: 'REIMBURSED' })] });
    show();
    const section = activity();
    expect(within(section).queryByText('REIMBURSED')).not.toBeInTheDocument();
    expect(within(section).getByText('expenses.status.reimbursed')).toBeInTheDocument();
  });

  it('says which way a delegation runs, and names the other person', () => {
    // "Wei Chen" alone leaves the reader guessing whether Dana delegates to Wei or
    // approves on Wei's behalf.
    setTrpc({ delegations: [delegation()] });
    show();
    const section = activity();
    expect(within(section).getByText('people.detail.delegatesTo')).toBeInTheDocument();
    expect(within(section).getByText('Wei Chen')).toBeInTheDocument();
    expect(within(section).getByText('delegations.scope.ALL')).toBeInTheDocument();
  });

  it('reads an incoming delegation from the other side', () => {
    setTrpc({ delegations: [delegation({ direction: 'INCOMING' })] });
    show();
    expect(within(activity()).getByText('people.detail.actsFor')).toBeInTheDocument();
  });

  it('distinguishes "none" from "you may not look"', () => {
    /**
     * This is the whole reason the server returns `null` rather than `[]`. An empty
     * list shown to a reader who simply lacks the permission asserts that this person
     * has filed nothing — the same false conclusion the placeholder existed to prevent,
     * except now it looks like fact rather than a pending feature.
     */
    setTrpc({ expenseReports: null, delegations: null });
    show();
    expect(within(activity()).getAllByText('people.detail.restricted')).toHaveLength(2);
    expect(within(activity()).queryByText('people.detail.noReports')).not.toBeInTheDocument();
  });

  it('says so plainly when there genuinely are none', () => {
    setTrpc({ expenseReports: [], delegations: [] });
    show();
    const section = activity();
    expect(within(section).getByText('people.detail.noReports')).toBeInTheDocument();
    expect(within(section).getByText('people.detail.noDelegations')).toBeInTheDocument();
    expect(within(section).queryByText('people.detail.restricted')).not.toBeInTheDocument();
  });

  it('no longer promises either of them as a future feature', () => {
    setTrpc({ expenseReports: [expenseReport()], delegations: [delegation()] });
    show();
    expect(screen.queryByText('people.detail.comingSoon')).not.toBeInTheDocument();
  });
});

describe('People ↔ NetSuite section', () => {
  const disagreeing = () =>
    user({
      syncDiscrepancies: [
        { field: 'LEGAL_ENTITY', divergesFromDirectory: true },
        { field: 'CLASS', divergesFromDirectory: false },
      ],
    });

  it('names the fields NetSuite disagrees on, and marks the ones waiting on HR / IT', () => {
    setTrpc({ user: disagreeing() });
    show();
    const section = screen.getByTestId('people-sync-section');
    expect(section).toHaveTextContent('people.sync.field.LEGAL_ENTITY');
    expect(section).toHaveTextContent('people.sync.field.CLASS');
    expect(screen.getAllByText('people.sync.hrIt')).toHaveLength(1);
  });

  it('offers the review link only to somebody who may rule', () => {
    setTrpc({ user: disagreeing() });
    show({ canReviewSync: true });
    expect(screen.getByText('people.sync.review').closest('a')?.getAttribute('href')).toBe(
      '/netsuite/people?q=dana%40e.inc',
    );
  });

  it('shows no link, and no section at all, when there is nothing to review', () => {
    setTrpc({ user: disagreeing() });
    show({ canReviewSync: false });
    expect(screen.queryByText('people.sync.review')).not.toBeInTheDocument();
    cleanup();
    setTrpc({ user: user() });
    show({ canReviewSync: true });
    expect(screen.queryByTestId('people-sync-section')).not.toBeInTheDocument();
  });
});
