/**
 * VX5-5 — you are at one organization's address, signed in to another.
 *
 * Its own file rather than inline in `app/layout.tsx` because the layout is
 * already doing three things (branding CSS, locale, chrome) and this is a whole
 * page's worth of content that replaces the children.
 *
 * NAMES NEITHER ORGANIZATION. The reader is signed in to one of them, so telling
 * them that one would be safe — but this renders on a host somebody else typed,
 * and confirming "yes, `acme` is a customer of ours" to whoever typed it is an
 * oracle the page has no reason to be. `WRONG_TENANT_HOST` in the catalogue
 * carries the same reasoning.
 *
 * The action is SIGN OUT, not a link to the other tenant: a link would be a
 * guess about which of the two they meant, and signing out is the one move that
 * works whichever it was.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';

export function WrongTenantHost({ locale }: { locale: string }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-4 p-6">
      <section
        className="flex flex-col gap-4 rounded-xl border border-border bg-background p-6"
        data-testid="wrong-tenant-host"
      >
        <h1 className="text-lg font-semibold text-foreground">This is not your organization</h1>
        <p className="text-sm text-muted-foreground">
          {renderUserMessage('WRONG_TENANT_HOST', locale)}
        </p>
        <Button asChild>
          <Link href="/api/auth/signout">Sign out</Link>
        </Button>
      </section>
    </main>
  );
}
