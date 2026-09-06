/**
 * VX5-6 — the chrome every screen somebody reaches WITHOUT a session shares.
 *
 * ── WHY THIS MOVED OUT OF `app/signup/ui.tsx` ───────────────────────────────
 *
 * Three pages were using it and one of them imported it as `@/app/signup/ui`
 * while not being a signup page at all. More to the point, they did not look
 * like each other or like `/login`: the sign-in screen has a branded
 * split-screen from the vendored kit, and signup and invitation acceptance were
 * plain cards with no product identity on them whatsoever. The first three
 * screens a customer ever sees looked like three different products.
 *
 * ── PRODUCT IDENTITY HERE; TENANT IDENTITY ONLY WHERE A TOKEN EARNS IT ──────
 *
 * `Shell` carries VeloExpense's own wordmark — the same monogram the sign-in
 * screen uses — and nothing about any customer. That is all `/signup` and
 * `/signup/verify` can honestly carry: there is no tenant yet, and inventing one
 * would be worse than a plain page.
 *
 * `/invite/accept` passes a `tenant` and gets that organization's colours and
 * mark instead. It may, because getting to that page requires a live invitation
 * token — see `PendingInvite.brandColor` for the argument, and
 * `app/login/page.tsx` for why the SIGN-IN page deliberately does not.
 */
import type { ReactNode } from 'react';
import { brandCss } from '@/lib/branding/css';

/** The product's own mark. Two letters and a name, matching the sign-in screen. */
function ProductMark() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground"
      >
        VX
      </span>
      <span className="text-sm font-semibold tracking-tight text-foreground">VeloExpense</span>
    </div>
  );
}

/**
 * The organization's own mark, for the one pre-auth page entitled to show it.
 *
 * The logo is an `<img>` and the name is the ALT TEXT rather than a caption
 * beside it — a mark and its own name repeated next to each other reads as a
 * placeholder, and the alt is what a screen reader and a broken image both need
 * anyway. With no logo the name is the mark, which is `email-shell.ts`'s answer
 * to the same problem and for the same reason.
 */
function TenantMark({ name, logoSrc }: { name: string; logoSrc: string | null }) {
  return (
    <div className="flex items-center gap-2.5">
      {logoSrc === null ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- the bytes come from
        // a token-gated route with a `no-store` header; `next/image` would proxy
        // and cache a credential-bearing URL, which is the one thing it must not do.
        <img alt={name} className="h-7 w-auto max-w-[10rem] object-contain" src={logoSrc} />
      )}
      <span className="text-sm font-semibold tracking-tight text-foreground">{name}</span>
    </div>
  );
}

export interface PreAuthTenant {
  name: string;
  brandColor: string | null;
  logoSrc: string | null;
}

export function Shell({
  children,
  tenant = null,
}: {
  children: ReactNode;
  tenant?: PreAuthTenant | null;
}) {
  /* The tenant's palette, emitted as a `<style>` on the page itself.
   *
   * `app/layout.tsx` normally does this, and it CANNOT here: `brandingForRender`
   * reads the session, and the whole point of these pages is that there is not
   * one. So the style is scoped to this subtree instead of the document, which
   * is also the more honest place for it — the colour belongs to this page's
   * subject, not to the reader.
   *
   * `brandCss` throws on a colour it cannot make readable text on, and that is
   * left alone: the column already refuses one (`0023`), so reaching the throw
   * means the data is wrong, and rendering an unreadable page would hide it. */
  const css = tenant === null ? null : (brandCss(tenant.brandColor)?.css ?? null);
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-5 p-6">
      {css === null ? null : <style dangerouslySetInnerHTML={{ __html: css }} />}
      {tenant === null ? (
        <ProductMark />
      ) : (
        <TenantMark logoSrc={tenant.logoSrc} name={tenant.name} />
      )}
      {children}
      {tenant === null ? null : (
        // The product still says who it is, quietly, under a customer's mark.
        // Somebody deciding whether an email was genuine needs to see BOTH names.
        <p className="text-xs text-muted-foreground">Expense management by VeloExpense</p>
      )}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-6">
      {children}
    </section>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <h1 className="text-lg font-semibold text-foreground">{children}</h1>;
}

export function Lede({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * The text input. `Input` from `components/ui` would do, but every field here
 * wants the same label pairing and the same hint slot, and three copies of that
 * markup is where a `htmlFor` stops matching an `id` — invisible until an e2e's
 * `getByLabel` fails or somebody using a screen reader cannot tell which box is
 * which.
 */
export function Field({
  name,
  label,
  hint,
  type = 'text',
  required = false,
  autoComplete,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  type?: 'text' | 'email';
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={name}>
        {label}
      </label>
      <input
        className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
