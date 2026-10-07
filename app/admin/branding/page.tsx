/**
 * VX4-3 part 2 — the Branding screen.
 *
 * ── What it has to SAY, not just do ────────────────────────────────────────
 *
 * It shows the CHOSEN FOREGROUND and its ratio next to the colour. An admin who
 * picks lime green should be able to see that we put dark text on it, from the
 * screen, before a user reports it — the alternative is a product decision taken
 * on their behalf and never mentioned, which is what PE-8 was.
 *
 * The colour preview is a real primary button, not a swatch. A swatch answers
 * "what colour is this"; the question an admin actually has is "is my label
 * readable on my button", and only the button answers that.
 *
 * It says the logo must be PNG, JPEG or WebP **and why SVG is refused**, because
 * "unsupported format" for the one vector format every brand guide ships in reads
 * as an oversight rather than a decision.
 *
 * ── The one thing this screen cannot show ──────────────────────────────────
 *
 * `/login` is NOT branded, and the tagline field says so rather than implying a
 * change nobody will see. It has no tenant to brand — the user types their org
 * slug into it — so per-tenant sign-in waits for host-based tenancy in Phase 5.
 * Storing the tagline now costs nothing and means the rebrand is one field, not a
 * migration, when that lands.
 */
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import {
  clearLogoFromForm,
  getBrandingPage,
  saveColorFromForm,
  saveLogoFromForm,
  saveTaglineFromForm,
} from './actions';
// UD-9. The accept list used to be typed out here as
// `accept="image/png,image/jpeg,image/webp"` — a third copy of a list that the
// database CHECKs (`organization_logo_mime_raster`) and the service mirrors. A
// file picker that offers a type the database refuses is a rejected upload with
// no explanation on the screen that offered it.
import { LOGO_MIME_TYPES } from '@/lib/branding/service';

import { pageTitle } from '@/lib/i18n/page-title';
import { PageHeader, Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.branding');
}

export const dynamic = 'force-dynamic';

export default async function BrandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  const { error, changed } = await searchParams;
  const b = await getBrandingPage();

  return (
    <Screen width="narrow">
      <PageHeader title="Branding" description={`How VeloExpense looks for ${b.name}`} />

      <ErrorBanner message={error} />
      {changed ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Saved. The {changed} applies on the next page load, for everyone in {b.name}.
        </p>
      ) : null}

      {/* ── colour ─────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Brand colour</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One colour. Buttons, links, focus rings, the sidebar and chart series are all
          derived from it — you do not pick them separately.
        </p>

        <form action={saveColorFromForm} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Colour</span>
            <Input
              name="brandColor"
              defaultValue={b.brandColor ?? ''}
              placeholder="#0f766e"
              className="w-40 font-mono"
            />
          </label>
          <Button type="submit" size="sm">
            Save colour
          </Button>
          {/*
            A DISTINCT field name, not `brandColor=""`. A submit button shares the
            form's namespace, so `<button name="brandColor" value="">` beside an
            input of the same name puts BOTH into the FormData and `.get()` returns
            the first — the input's. The reset silently did nothing. Caught by
            reading the action rather than by running it, and worth the extra field.
          */}
          {b.brandColor === null ? null : (
            <Button type="submit" size="sm" variant="outline" name="reset" value="1">
              Reset to default
            </Button>
          )}
        </form>

        {b.brandColor === null ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Using the VeloExpense palette. Nothing is overridden.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {/* A real button, because "is my label readable" is the question. */}
            <span
              className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium"
              style={{
                backgroundColor: b.brandColor,
                color: b.contrast?.foreground ?? '#ffffff',
              }}
            >
              Submit report
            </span>
            {b.contrast ? (
              /* A testid, because a regex over this sentence spans a <b> and
                 `getByText` then resolves to the <p> AND its wrapper — the strict-mode
                 violation VX4-1's spec already paid for once. */
              <p data-testid="contrast-note" className="text-sm text-muted-foreground">
                Labels on this colour are{' '}
                <b>{b.contrast.foreground === '#ffffff' ? 'white' : 'dark'}</b>, chosen for
                you at <b>{b.contrast.ratio}:1</b> contrast. WCAG AA needs 4.5:1.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* ── logo ───────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Logo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          PNG, JPEG or WebP, up to {b.maxLogoKiB} KiB. SVG is not accepted — it can carry
          script, and this image is rendered inside your team&rsquo;s pages.
        </p>

        {b.logo ? (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.logo.src} alt={`${b.name} logo`} className="h-10 w-auto" />
            <span className="font-mono text-xs text-muted-foreground">{b.logo.mime}</span>
            <form action={clearLogoFromForm}>
              <Button type="submit" size="sm" variant="outline">
                Remove
              </Button>
            </form>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No logo uploaded.</p>
        )}

        <form action={saveLogoFromForm} className="mt-4 flex flex-wrap items-end gap-3">
          <Input
            type="file"
            name="logo"
            accept={LOGO_MIME_TYPES.join(',')}
            className="text-sm"
          />
          <Button type="submit" size="sm">
            Upload
          </Button>
        </form>
      </section>

      {/* ── tagline ────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Sign-in tagline</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Saved now, shown later. The sign-in page is shared across organizations today, so
          it cannot tell whose tagline to show until each organization has its own address —
          that is planned, and this field is ready for it.
        </p>
        <form action={saveTaglineFromForm} className="mt-4 flex flex-wrap items-end gap-3">
          <Input
            name="loginTagline"
            defaultValue={b.loginTagline ?? ''}
            maxLength={200}
            placeholder="Expenses, sorted."
            className="max-w-md"
          />
          <Button type="submit" size="sm">
            Save tagline
          </Button>
        </form>
      </section>
    </Screen>
  );
}
