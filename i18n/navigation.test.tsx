import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: ExpenseOS's navigation helpers, on Next's own (no locale in the URL).
 * Ported code passes a `locale` and expects it to be harmless.
 */
const nav = vi.hoisted(() => ({ redirected: '' }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    nav.redirected = to;
    throw new Error('NEXT_REDIRECT');
  },
  usePathname: () => '/',
  useRouter: () => ({}),
}));

import { getPathname, Link, redirect } from './navigation';

describe('Link', () => {
  it('renders a plain link and drops the locale prop', () => {
    render(
      <Link href="/admin/expense-categories" locale="en">
        Categories
      </Link>,
    );
    const a = screen.getByRole('link', { name: 'Categories' });
    expect(a.getAttribute('href')).toBe('/admin/expense-categories');
    expect(a.hasAttribute('locale')).toBe(false);
  });
});

describe('redirect and getPathname', () => {
  it("take next-intl's { href, locale } and ignore the locale", () => {
    expect(() => redirect({ href: '/login', locale: 'fr-CA' })).toThrow('NEXT_REDIRECT');
    expect(nav.redirected).toBe('/login');
    expect(getPathname({ href: { pathname: '/expenses', query: { page: '2' } }, locale: 'en' })).toBe(
      '/expenses?page=2',
    );
  });
});
