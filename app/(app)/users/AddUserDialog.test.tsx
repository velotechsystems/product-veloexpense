import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adding one person from an email address alone.
 *
 * The audit found "Add user" a permanently disabled button whose menu footer read "Coming in
 * Phase 4" (GA readiness report F40). The interesting part of the build is not the create —
 * it is that FOUR different things can happen and each needs a different sentence. "Added"
 * on its own is true and useless when Google has no account for the address yet: the row
 * exists, the profile does not, and the person reading the screen needs to know which.
 *
 * Every profile field ExpenseOS holds — name, department, business unit, legal entity, title,
 * country, manager — is owned by Google Workspace and reconciled from it, which is why the
 * form asks for the one thing Google keys on and nothing else.
 */

const h: {
  data: unknown;
  error: { message: string } | null;
  isPending: boolean;
  calls: unknown[];
} = { data: undefined, error: null, isPending: false, calls: [] };

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, vals?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    return vals ? `${full}:${Object.values(vals).join(',')}` : full;
  },
  useLocale: () => 'en',
}));

// `EmployeeDirectory` imports `@/i18n/navigation`, which pulls next-intl's navigation
// factory and, through it, `next/navigation`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/en/users',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => children,
  usePathname: () => '/users',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ users: { listDirectory: { invalidate: vi.fn() } } }),
    users: {
      create: {
        useMutation: (opts?: { onSuccess?: () => void }) => ({
          data: h.data,
          error: h.error,
          isPending: h.isPending,
          mutate: (vars: unknown) => {
            h.calls.push(vars);
            opts?.onSuccess?.();
          },
        }),
      },
    },
  },
}));

const { AddUserDialog } = await import('./EmployeeDirectory');

const onClose = vi.fn();
const onAdded = vi.fn();

beforeEach(() => {
  h.data = undefined;
  h.error = null;
  h.isPending = false;
  h.calls = [];
  onClose.mockReset();
  onAdded.mockReset();
});
afterEach(cleanup);

function show() {
  render(<AddUserDialog onClose={onClose} onAdded={onAdded} />);
}

describe('the form', () => {
  it('asks for one thing, and says where the rest comes from', () => {
    show();
    expect(screen.getByText('people.add.description')).toBeInTheDocument();
    expect(screen.getByText('people.add.emailLabel')).toBeInTheDocument();
  });

  it('will not submit until the value looks like an address', async () => {
    const user = userEvent.setup();
    show();
    const submit = screen.getByRole('button', { name: 'people.add.submit' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('people.add.emailLabel'), 'not-an-email');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('people.add.emailLabel'), '@e.inc');
    expect(submit).toBeEnabled();
  });

  it('sends the address trimmed', async () => {
    // `User.email` is @unique, so "  Ada@e.inc " would create a second row for somebody who
    // is already here. The server lowercases too; this is the client half.
    const user = userEvent.setup();
    show();
    await user.type(screen.getByLabelText('people.add.emailLabel'), '  ada@e.inc  ');
    await user.click(screen.getByRole('button', { name: 'people.add.submit' }));
    expect(h.calls).toEqual([{ email: 'ada@e.inc' }]);
  });

  it('says it is working, so the button is not pressed twice', () => {
    h.isPending = true;
    show();
    expect(screen.getByRole('button', { name: 'people.add.adding' })).toBeDisabled();
  });
});

describe('what it says afterwards', () => {
  /*
   * VeloExpense (decided 16 Oct 2026): adding sends an invitation, so ExpenseOS's three
   * Google-directory outcomes (synced, alias of somebody here, not in the directory, directory
   * off) are one: invited — or invited again, which replaces the earlier link.
   */
  it('says the invitation went, and to whom', () => {
    h.data = { status: 'invited', email: 'ada@example.test', resent: false };
    show();
    expect(screen.getByText('people.add.invited:ada@example.test')).toBeInTheDocument();
  });

  it('says so when it replaced an invitation that was still waiting', () => {
    // The earlier link stops working, which the admin needs to know before forwarding it.
    h.data = { status: 'invited', email: 'ada@example.test', resent: true };
    show();
    expect(screen.getByText('people.add.reinvited:ada@example.test')).toBeInTheDocument();
    expect(screen.queryByText(/people\.add\.invited/)).not.toBeInTheDocument();
  });

  it('names the person when the address is already here', () => {
    h.data = { status: 'exists', userId: 'u1', deactivated: false, name: 'Ada Lovelace' };
    show();
    expect(screen.getByText('people.add.exists:Ada Lovelace')).toBeInTheDocument();
  });

  it('tells you to REACTIVATE a deactivated person rather than add them again', () => {
    // Without this the admin retries and meets a raw unique-constraint error, because the
    // row still exists behind a soft delete.
    h.data = { status: 'exists', userId: 'u1', deactivated: true, name: 'Ada Lovelace' };
    show();
    expect(screen.getByText('people.add.existsDeactivated:Ada Lovelace')).toBeInTheDocument();
  });

  it('surfaces a server refusal verbatim, rather than swallowing it', () => {
    h.error = { message: 'That person is already in the directory.' };
    show();
    expect(screen.getByText('That person is already in the directory.')).toBeInTheDocument();
  });

  it('offers Close instead of Add once there is an outcome', () => {
    // Re-submitting the same address after a result can only produce a duplicate refusal.
    h.data = { status: 'invited', email: 'ada@example.test', resent: false };
    show();
    expect(screen.queryByRole('button', { name: 'people.add.submit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
  });
});
