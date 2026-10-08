import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The sidebar's profile menu — identity, language, and the way out.
 *
 * VeloExpense: the language switcher and the install item are not in VeloExpense's menu
 * (English only for now; not a PWA — see ProfilePopover.tsx). Their ExpenseOS suites are
 * replaced by tests that pin their absence, and the "switching language" notes below are
 * kept for when French is switched on. Links carry no locale segment, and the menu reads no
 * locale, so the stubs below no longer provide one.
 *
 * The language switch is the interesting part, because it is two writes at once: the
 * URL (which is what actually changes the rendered locale) and the user's stored
 * preference (which is what makes it stick on the next sign-in). They are deliberately
 * NOT sequenced: the preference is fired and forgotten, and navigation happens
 * immediately, so a slow or failing write costs the user nothing but the memory of it.
 *
 * The path rewrite is the part that can go subtly wrong — `fr-CA` contains a character
 * that means something in a regular expression, and only the FIRST segment is the
 * locale. `/en/expenses/en-route` must not become `/fr-CA/expenses/fr-CA-route`.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  push: vi.fn(),
  pathname: '/expenses',
  signOut: vi.fn(),
}));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push }),
  usePathname: () => h.pathname,
}));
vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => h.signOut(...args),
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const t = (key: string) => (ns ? `${ns}.${key}` : key);
    t.has = () => false;
    return t;
  },
}));

import { ProfilePopover } from './ProfilePopover';

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock(over);
}

const show = (props: Partial<Parameters<typeof ProfilePopover>[0]> = {}) =>
  render(
    <ProfilePopover name="Ada Lovelace" roleLabel="Controller" email="ada@e.inc" {...props} />,
  );

const openMenu = async (user: ReturnType<typeof userEvent.setup>, name = 'Ada Lovelace') =>
  user.click(screen.getByRole('button', { name }));

beforeEach(() => {
  h.push = vi.fn();
  h.signOut = vi.fn();
  h.pathname = '/expenses';
  setTrpc();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('the pill', () => {
  it('shows the name and the role', () => {
    show();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Controller')).toBeInTheDocument();
  });

  it('falls back to the email when there is no name', () => {
    show({ name: '' });
    expect(screen.getAllByText('ada@e.inc').length).toBeGreaterThan(0);
  });

  it('falls back again when there is neither, rather than rendering a blank pill', () => {
    // A nameless, email-less session is broken, but an unlabelled control is worse.
    show({ name: '', email: '' });
    expect(screen.getByRole('button', { name: 'User' })).toBeInTheDocument();
  });

  it('takes initials from the first and last name', () => {
    show();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('takes two letters from a single name', () => {
    show({ name: 'Prince' });
    expect(screen.getByText('PR')).toBeInTheDocument();
  });

  it('skips the middle names', () => {
    show({ name: 'Ada Byron King Lovelace' });
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('marks an unnameable avatar rather than leaving it empty', () => {
    show({ name: '   ', email: '' });
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});

describe('the menu', () => {
  it('repeats the identity, including the email the pill has no room for', async () => {
    const user = userEvent.setup();
    show();
    await openMenu(user);
    expect(await screen.findByText('ada@e.inc')).toBeInTheDocument();
  });

  it('goes to the profile page', async () => {
    // VeloExpense: the profile page is /preferences, with no locale segment.
    const user = userEvent.setup();
    show();
    await openMenu(user);
    await user.click(await screen.findByRole('button', { name: /nav.items.myProfile/ }));
    expect(h.push).toHaveBeenCalledWith('/preferences');
  });

  it('signs out back to the login page', async () => {
    // VeloExpense: one language, one login page.
    const user = userEvent.setup();
    show();
    await openMenu(user);
    await user.click(await screen.findByRole('button', { name: /nav.profile.signOut/ }));
    expect(h.signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});

describe('VeloExpense: what the menu leaves out', () => {
  it('offers no language switch while French is switched off', async () => {
    const user = userEvent.setup();
    show();
    await openMenu(user);
    await screen.findByRole('button', { name: /nav.items.myProfile/ });
    expect(screen.queryByText('common.language')).not.toBeInTheDocument();
    expect(screen.queryByText('common.languageFrCA')).not.toBeInTheDocument();
  });

  it('offers no install item', async () => {
    const user = userEvent.setup();
    show();
    await openMenu(user);
    await screen.findByRole('button', { name: /nav.items.myProfile/ });
    expect(screen.queryByRole('button', { name: /nav.profile.installApp/ })).not.toBeInTheDocument();
  });

  it('has exactly two actions: the profile and the way out', async () => {
    const user = userEvent.setup();
    show();
    await openMenu(user);
    const profileItem = await screen.findByRole('button', { name: /nav.items.myProfile/ });
    const menu = profileItem.parentElement as HTMLElement;
    expect(menu.querySelectorAll('button')).toHaveLength(2);
  });
});

describe('VeloExpense: tenant data is not language', () => {
  it('marks the name, initials and email translate="no", and not the role', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByText('Ada Lovelace').closest('[translate="no"]')).not.toBeNull();
    expect(screen.getByText('AL').closest('[translate="no"]')).not.toBeNull();
    expect(screen.getByText('Controller').closest('[translate="no"]')).toBeNull();
    await openMenu(user);
    expect((await screen.findByText('ada@e.inc')).closest('[translate="no"]')).not.toBeNull();
  });
});
