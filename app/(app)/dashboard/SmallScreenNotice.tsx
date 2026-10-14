'use client';

import { Card } from '@expenseos/design-system';
import type { RbacUser } from '@expenseos/rbac';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { hasPhoneHiddenDestinations } from '../Sidebar';

/**
 * The dashboard's small-screen notice — one sentence, at the top of `/dashboard`, telling a
 * phone reader that the product has more of itself on a larger screen.
 *
 * ─── WHY THIS IS A CLIENT COMPONENT WHEN THE PAGE THAT MOUNTS IT IS A SERVER ONE ─────────
 *
 * Not for state — it has none, and it never re-renders. It is a client component because the
 * predicate it is conditional on lives in `Sidebar.tsx`, which is `'use client'`. Under RSC
 * every export of a `'use client'` module is a CLIENT REFERENCE in the server graph, so a
 * server component that imports `hasPhoneHiddenDestinations` and CALLS it does not get the
 * function: it gets React's proxy, which throws "Attempted to call
 * hasPhoneHiddenDestinations() from the server but ... it's on the client" on every request
 * (`react-server-dom-webpack-server.node.*.js`, the `get` trap that wraps each named export).
 *
 * And nothing in this repo's test run would have caught that: Vitest applies no RSC
 * transform, so `'use client'` is an inert string literal there, the server-side call resolves
 * to the real function, and the whole suite goes green on a page that 500s in production.
 *
 * The shape here — server page resolves the audience, client component decides — is already
 * how the shell works: `(app)/layout.tsx` hands `rbac`, `canSeeOthers` and `activeModules`
 * across the same boundary to `AppShell`, `ReadonlySet` included. So the serialization is
 * proven rather than assumed. The component is still server-RENDERED (Next SSRs client
 * components), so the notice is in the first HTML and never flashes in on hydration.
 *
 * ─── THE CONDITION IS THE POINT ──────────────────────────────────────────────────────────
 *
 * ADR-0005 D7: a signpost "must not announce a loss to a reader whose RBAC never entitled
 * them to the destination in the first place". So this renders only when the reader ACTUALLY
 * has phone-hidden destinations, derived from `SECTIONS` ∩ RBAC ∩ module ∩ registry — the same
 * pipeline the sidebar renders from — and never from `MOBILE_READINESS`'s `desktop` keys,
 * which carry no permission and no module slug and would fire this at every employee in the
 * company.
 *
 * Measured on this branch: for a reader with no admin, audit, config, NetSuite or AP
 * permission, the ONLY `desktop`-ruled nav destination is `/users`, whose sole gate is
 * `canSeeOthers`. That makes `canSeeOthers` the whole predicate for the entire ordinary
 * population, which is why the page resolves it properly instead of passing `false`.
 *
 * ─── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────
 *
 * No route list and no link to an enumeration of the hidden pages — naming the destinations is
 * what `security-specialist` ruled out, and the sidebar's own per-section disclosure controls
 * are where a reader goes to find them. Not dismissible: there is no state to persist and a
 * dismissal would have to be remembered per device to be anything but an irritation.
 *
 * No `data-testid`: `e2e/crawl-mobile.spec.ts` counts the nodes carrying the desktop-only
 * notice's id per route and requires exactly one visible, and `SectionNotice` already had to
 * take a different string to stay out of that count. A third id in that family is a trap for
 * whoever writes the next crawl assertion, and nothing in `e2e/` addresses this notice.
 *
 * No heading and no `role="status"`. It is static page content present at first paint, not a
 * live update, so a live region would announce nothing a reader does not already meet in
 * reading order; and a heading would add an entry to the document outline that says nothing
 * the sentence does not.
 *
 * `lg:hidden` is a LITERAL string in the JSX below and must stay literal. Tailwind v4 has no
 * JS config and no safelist — it scans source TEXT — so a runtime-assembled class emits no CSS
 * while the element still carries the attribute: `toHaveClass` passes, `lint` is silent,
 * `build` succeeds, and the notice is visible on the desktop dashboard forever.
 */
export function SmallScreenNotice({
  rbac,
  canSeeOthers,
  activeModules,
}: {
  rbac: RbacUser;
  /** Hide /users from the nav when false (employee with no reports). */
  canSeeOthers: boolean;
  /** Slugs of modules that are installed + active. */
  activeModules: ReadonlySet<string>;
}) {
  const tNav = useTranslations('nav');
  if (!hasPhoneHiddenDestinations({ rbac, canSeeOthers, activeModules })) return null;
  return (
    <Card className="flex items-start gap-3 p-4 lg:hidden">
      <IconDeviceDesktop size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-foreground text-sm leading-snug">{tNav('smallScreenNotice')}</p>
    </Card>
  );
}
