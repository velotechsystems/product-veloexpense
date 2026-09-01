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
 * so few lines: the token sheet is indirected, so overriding eight `--vl-*`
 * primitives moves `--primary`, `--ring`, `--accent`, the five `--chart-*` and the
 * whole sidebar without naming any of them.
 *
 * IT GOES IN `<head>`, AFTER the imported sheet, and both halves of that matter.
 * After, because these are overrides at the same specificity and the later one
 * wins. In `<head>`, because a `<style>` discovered in `<body>` repaints what has
 * already been painted — the tenant's product would flash sky blue on every cold
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
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { brandingForRender } from "@/lib/branding/request";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const PRODUCT = "VeloExpense";

export async function generateMetadata(): Promise<Metadata> {
  const { branding } = await brandingForRender();
  return {
    title: branding === null ? PRODUCT : `${branding.name} · ${PRODUCT}`,
    description: "Submit, approve, and reconcile expenses across your organization.",
    // The tenant's own wordmark as the tab icon when there is one. Next serves
    // this as a <link rel="icon"> pointing at our route, so the `?v=` stamp and
    // the immutable cache apply to the favicon too — and a tenant with no logo
    // gets no icon rather than somebody else's.
    icons:
      branding?.logo == null
        ? undefined
        : [{ url: `/api/branding/logo?v=${branding.logo.updatedAt.getTime()}`, type: branding.logo.mime }],
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { css } = await brandingForRender();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
