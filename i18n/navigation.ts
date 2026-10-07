/**
 * Locale-aware navigation helpers — ported from ExpenseOS `src/i18n/navigation.ts`.
 *
 * VeloExpense: ExpenseOS builds these with next-intl's `createNavigation(routing)` so every
 * link carries the `/en/` or `/fr-CA/` prefix. VeloExpense has no locale in its URLs, so
 * they are Next's own, behind ExpenseOS's names and signatures: ported code keeps
 * `import { Link, redirect, useRouter, usePathname } from '@/i18n/navigation'`, and a
 * `locale` argument is accepted and ignored.
 */
import NextLink from 'next/link';
import { redirect as nextRedirect, usePathname, useRouter } from 'next/navigation';
import { type ComponentProps, createElement } from 'react';

type Href = ComponentProps<typeof NextLink>['href'];

export function Link(props: ComponentProps<typeof NextLink> & { locale?: string }) {
  // `locale` is dropped so it never reaches the <a> as an unknown attribute.
  const rest = { ...props };
  delete rest.locale;
  return createElement(NextLink, rest);
}

function pathOf(href: Href): string {
  if (typeof href === 'string') return href;
  const query = href.query
    ? `?${new URLSearchParams(href.query as Record<string, string>).toString()}`
    : '';
  return `${href.pathname ?? ''}${query}${href.hash ? `#${href.hash}` : ''}`;
}

/** next-intl's form: `redirect({ href, locale })`. */
export function redirect(args: { href: Href; locale?: string }): never {
  return nextRedirect(pathOf(args.href));
}

export function getPathname(args: { href: Href; locale?: string }): string {
  return pathOf(args.href);
}

export { usePathname, useRouter };
