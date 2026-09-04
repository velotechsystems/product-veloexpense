'use server';

/**
 * VX4-3 part 2 — /admin/branding.
 *
 * Not gated on a module: branding is not something a tenant buys, it is what the
 * product looks like. Admin-only through the same `asAdmin` gate every other admin
 * surface uses.
 *
 * EVERY REFUSAL HERE COMES FROM THE SERVICE. This file validates nothing about a
 * colour, a mime or a size — it catches `BrandingError` and puts its sentence on
 * the screen. That is MT-3's rule kept rather than restated: the moment this file
 * grows its own hex check, there are two answers to "is this colour allowed" and
 * the seed, the importer and Phase 5's provisioning use the other one.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { type EmployeeRow } from '@/lib/employees/service';
import { brandCss } from '@/lib/branding/css';
import {
  clearLogo,
  getBranding,
  LOGO_MAX_BYTES,
  setBrandColor,
  setLoginTagline,
  setLogo,
} from '@/lib/branding/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/branding';

const auditActor = (a: EmployeeRow) => ({
  id: a.id,
  name: a.display_name ?? a.email,
  role: a.role,
});

/**
 * NOT exported, and `check:actions` is why — it caught this on CI rather than in
 * review. Next registers every export of a `'use server'` module as a server
 * action; it cannot wrap a type, and rather than failing the build it registers
 * NONE of the module's actions, so every form on the page would post an id the
 * server has never heard of. A silent, total failure from an `export` keyword on
 * an interface. `getBrandingPage`'s return type is structural, so no caller needs
 * the name — and `getModulesPage` returns an inline literal for the same reason.
 */
interface BrandingView {
  name: string;
  brandColor: string | null;
  loginTagline: string | null;
  logo: { mime: string; src: string } | null;
  /**
   * What the chosen colour actually resolves to, shown on the screen. An admin who
   * picks a colour should be able to see that we put DARK text on their lime green
   * before a user reports it — the alternative is a product decision taken on their
   * behalf and never mentioned, which is the class of bug PE-8 was.
   */
  contrast: { foreground: string; ratio: string } | null;
  maxLogoKiB: number;
}

export async function getBrandingPage(): Promise<BrandingView> {
  return asAdminPage(async (tx) => {
    const b = await getBranding(tx);
    const rendered = brandCss(b.brandColor);
    return {
      name: b.name,
      brandColor: b.brandColor,
      loginTagline: b.loginTagline,
      logo:
        b.logo === null
          ? null
          : {
              mime: b.logo.mime,
              src: `/api/branding/logo?v=${b.logo.updatedAt.getTime()}`,
            },
      contrast:
        rendered === null
          ? null
          : {
              foreground: rendered.foreground.hex,
              ratio: rendered.foreground.ratio.toFixed(2),
            },
      maxLogoKiB: LOGO_MAX_BYTES / 1024,
    };
  });
}

/** Next's redirect() throws a control-flow error that must not be swallowed. */
function rethrowRedirect(err: unknown): void {
  if (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  ) {
    throw err;
  }
}

async function run(work: () => Promise<void>, changed: string): Promise<never> {
  try {
    await work();
  } catch (err) {
    rethrowRedirect(err);
    redirect(
      `${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/branding'))}`,
    );
  }
  redirect(`${PAGE}?changed=${encodeURIComponent(changed)}`);
}

export async function saveColorFromForm(form: FormData): Promise<never> {
  // `reset` is its own field for a reason — see the note on the button. Reusing
  // `brandColor=""` on the submit button put two entries under one name and
  // `.get()` returned the input's, so the reset did nothing at all.
  const reset = form.get('reset') !== null;
  const raw = reset ? null : String(form.get('brandColor') ?? '');
  return run(
    () => asAdmin((tx, actor) => setBrandColor(tx, auditActor(actor), raw)).then(() => undefined),
    reset ? 'reset' : 'colour',
  );
}

export async function saveTaglineFromForm(form: FormData): Promise<never> {
  const raw = String(form.get('loginTagline') ?? '');
  return run(
    () => asAdmin((tx, actor) => setLoginTagline(tx, auditActor(actor), raw)).then(() => undefined),
    'tagline',
  );
}

export async function saveLogoFromForm(form: FormData): Promise<never> {
  const file = form.get('logo');
  return run(async () => {
    if (!(file instanceof File) || file.size === 0) {
      throw new Error('choose an image file first');
    }
    // Read it here rather than streaming: the column caps this at 512 KiB, so the
    // buffer is bounded by a CHECK and not by hope. The size is re-checked in the
    // service against the same constant.
    const bytes = Buffer.from(await file.arrayBuffer());
    await asAdmin((tx, actor) => setLogo(tx, auditActor(actor), bytes, file.type));
  }, 'logo');
}

export async function clearLogoFromForm(): Promise<never> {
  return run(() => asAdmin((tx, actor) => clearLogo(tx, auditActor(actor))), 'logo');
}
