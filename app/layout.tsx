/**
 * Root layout.
 *
 * ── VX4-3 part 2: the tab said "Create Next App" until today (BR-5/BR-9) ────
 *
 * `export const metadata = { title: 'Create Next App', description: 'Generated
 * by create next app' }` — the `create-next-app` scaffold defaults from VX0-1 —
 * was live in every tab of the product. ExpenseOS's version of this is a static
 * `title: 'ExpenseOS'` export, which is BR-5: a static export cannot vary per
 * tenant, so the fix is `generateMetadata` either way and the scaffold text was
 * only a worse starting point, not a different problem.
 *
 * THE TITLE IS THE TENANT'S NAME, not ours, and that is the point of a white-label
 * product: `Acme Inc · VeloExpense`. The order matters — a browser truncates the
 * END of a tab title, so the half that identifies which window this is goes first.
 *
 * ── The palette injection ───────────────────────────────────────────────────
 *
 * One `<style>` of custom properties, and `lib/branding/css.ts` explains why it is
 * so few lines: the 2026 kit binds every shadcn variable to `--brand-*` through
 * `data-app`, so re-binding the eleven ramp steps and six roles moves `--primary`,
 * `--ring`, `--accent`, the buttons, the charts and the sidebar without naming any
 * of them.
 *
 * IT GOES IN `<head>`. Its selectors out-rank the kit's `[data-app]` binding, so
 * stylesheet order no longer decides it (it used to: same specificity, last one
 * won). In `<head>`, because a `<style>` discovered in `<body>` repaints what has
 * already been painted — the tenant's product would flash VeloExpense teal on every cold
 * load, which is the kind of defect that gets called "just a flicker" and never
 * fixed.
 *
 * `dangerouslySetInnerHTML` is the only way to emit a stylesheet, and it is safe
 * here for a reason that is checked rather than assumed: every value in that
 * string went through `token()`, which throws on anything that is not
 * `#rrggbb`. `test/branding-color.test.ts` asserts the whole emitted string
 * against a strict shape, so a future edit that interpolates a tenant NAME here
 * fails the suite instead of shipping a `</style>` escape.
 */
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { brandingForRender } from "@/lib/branding/request";
import { readerPrefs } from "@/lib/i18n/request";
import { hostTenantMismatch } from "@/lib/tenant/request";
import { WrongTenantHost } from "@/app/wrong-tenant-host";
import { ShellGate } from "@/app/(app)/ShellGate";
import { shellState } from "@/server/shell";
import { AccountUnavailable } from "@/app/account-unavailable";
import { Providers } from "@/app/providers";
import { NextIntlClientProvider } from "next-intl";

/*
 * 2026 brand edition: Plus Jakarta Sans for the UI, Josefin Sans Light for
 * taglines and eyebrows, SELF-HOSTED from app/fonts (lib-ui-kit/fonts).
 * `next/font/google` downloads at build time, which broke VeloCRM's production
 * image and VeloLedger's CI build (design-system rollout notes), and would put
 * fonts.googleapis.com on our build's critical path. The kit's tokens read
 * --font-jakarta / --font-josefin and fall back to the system stack.
 */
const jakarta = localFont({
  src: [
    { path: "./fonts/PlusJakartaSans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/PlusJakartaSans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/PlusJakartaSans-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/PlusJakartaSans-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/PlusJakartaSans-800.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-jakarta",
  display: "swap",
});

const josefin = localFont({
  src: [
    { path: "./fonts/JosefinSans-300.woff2", weight: "300", style: "normal" },
    { path: "./fonts/JosefinSans-400.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-josefin",
  display: "swap",
});

/*
 * The product's own icons (2026 brand: the V from the wordmark on its glow dot).
 * SVG first, which switches itself in dark mode; then the 16/32/48 .ico; then the
 * 180px apple-touch icon. All under public/ and outside the sign-in redirect
 * (proxy.ts). A tenant with a logo still gets its logo in the tab (VX4-3).
 */
const PRODUCT_ICONS: Metadata["icons"] = {
  icon: [
    { url: "/brand/veloexpense-favicon.svg", type: "image/svg+xml" },
    { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
  ],
  apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
};

const PRODUCT = "VeloExpense";

export async function generateMetadata(): Promise<Metadata> {
  const { branding } = await brandingForRender();
  return {
    // UD-16. A TEMPLATE, not a string, which is what lets each page contribute
    // its own half. `%s` is the page's title; `default` is what a route with no
    // title of its own gets, and `scripts/check-page-titles.mjs` exists so that
    // "no title of its own" is a deliberate choice rather than an oversight.
    //
    // The page's name comes FIRST for a mechanical reason: a browser truncates
    // the END of a tab title. `Acme Inc · VeloExpense · Appro…` is thirty-one
    // titles that still look identical in a narrow tab, which is the defect this
    // was supposed to fix.
    title: {
      template: branding === null ? `%s · ${PRODUCT}` : `%s · ${branding.name} · ${PRODUCT}`,
      default: branding === null ? PRODUCT : `${branding.name} · ${PRODUCT}`,
    },
    description: "Submit, approve, and reconcile expenses across your organization.",
    // The tenant's own wordmark as the tab icon when there is one. Next serves
    // this as a <link rel="icon"> pointing at our route, so the `?v=` stamp and
    // the immutable cache apply to the favicon too. A tenant with no logo gets
    // VeloExpense's own icon set (2026 brand), never another tenant's.
    icons:
      branding?.logo == null
        ? PRODUCT_ICONS
        : [{ url: `/api/branding/logo?v=${branding.logo.updatedAt.getTime()}`, type: branding.logo.mime }],
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { css } = await brandingForRender();
  // VX4-7: `lang="en"` was hardcoded here from the `create-next-app` scaffold,
  // alongside the `title: 'Create Next App'` that VX4-3 part 2 removed — the same
  // line of provenance, found by `scripts/check-i18n.mjs` on its first run.
  //
  // This attribute is not decoration. A screen reader picks its voice and
  // pronunciation rules from it, so a French page announced as English is read
  // aloud in an English accent, word by word; `lang` is also what a browser's
  // translate prompt and hyphenation use. `en` specifically was doubly wrong —
  // not merely the wrong language for a French reader but, per IL-1, not even
  // the right English.
  //
  // `readerPrefs()` is `cache()`d and `brandingForRender()` above already reads
  // the session, so this adds no query to the request: see lib/i18n/request.ts.
  const { locale } = await readerPrefs();
  const mismatch = await hostTenantMismatch();
  // ExpenseOS's app shell (app/(app)/AppShell.tsx), ported in Wave 0. `null` with no
  // session, for a non-member, or if it could not be read — see server/shell.ts for why
  // the menu never takes a page down with it. Not asked for on a wrong-tenant host.
  // f04: with no shell, `refusal` says whether that is because this person's account here is
  // deactivated or their access is off — then they get app/account-unavailable.tsx, not a page
  // that cannot work for them.
  const { shell, refusal } = mismatch === null ? await shellState() : { shell: null, refusal: null };

  return (
    <html
      lang={locale}
      // 2026 brand: the shell names the product and the kit binds its colours
      // (app/velotech-tokens.css). Components never name a hue.
      data-app="expense"
      className={`${jakarta.variable} ${josefin.variable} h-full antialiased`}
    >
      <head>
        {css === null ? null : (
          <style
            id="tenant-branding"
            // Every value is a `#rrggbb` that passed `token()`; see the header.
            dangerouslySetInnerHTML={{ __html: css }}
          />
        )}
      </head>
      <body className="min-h-full flex flex-col">
        {/* VX5-5. The GUARD is in `withCurrentOrg`, on the path to the data, and
            it throws — route handlers never see a layout, so a check that lived
            only here would be a check the next caller forgets (MT-3). This is
            for the READER: a person who followed a colleague's link gets a
            sentence and a way out instead of a thrown error. */}
        {/* Wave 0: ExpenseOS's client providers (session + tRPC), so ported screens
            can call `trpc.*.useQuery` unchanged. app/providers.tsx. */}
        <Providers>
          {mismatch !== null ? (
            <WrongTenantHost locale={locale} />
          ) : shell === null && refusal !== null ? (
            <AccountUnavailable reason={refusal} locale={locale} />
          ) : shell === null ? (
            children
          ) : (
            /* ExpenseOS's message catalogues (i18n/request.ts), for ported screens. Inside
               the signed-in shell only: next-intl sends the whole catalogue (~150 KB, ~45 KB
               gzipped) with every page it wraps, and the sign-in, sign-up and approval pages
               render nothing ported. */
            <NextIntlClientProvider>
              <ShellGate shell={shell}>{children}</ShellGate>
            </NextIntlClientProvider>
          )}
        </Providers>
      </body>
    </html>
  );
}
