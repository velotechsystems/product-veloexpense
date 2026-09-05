/**
 * VX4-3 — reading and writing a tenant's branding. GAP-AUDIT BR-2/BR-3/BR-4.
 *
 * ExpenseOS has the storage and the form for all of this and nothing reads them
 * (BR-2), so the port is the easy half; what is net-new is that the values
 * actually render. This file is the boundary between the two.
 *
 * ── THE `NULLIF`, DELIBERATELY ──────────────────────────────────────────────
 *
 * `organization` carries no `organization_id` and so is not RLS-scoped — the
 * session variable is what names the row, and the WHERE is what keeps a write
 * from hitting every tenant. Every predicate here is written
 * `NULLIF(current_setting('app.current_org', true), '')::uuid`, which is PE-8's
 * whole lesson: `set_config(k, v, is_local => true)` leaves the setting as the
 * EMPTY STRING once the transaction ends, not undefined, so a pooled connection
 * that has served one `withOrg` makes a bare `''::uuid` raise `22P02` instead of
 * evaluating to NULL. Refusing consistently requires the guard. (PE-9 tracks the
 * seventeen older modules that still omit it.)
 */
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import { append, type AuditActor } from '@/lib/audit/service';
import type { AuditAction } from '@/lib/audit/actions';
import {
  CONTRAST_FLOOR,
  contrastRatio,
  FOREGROUND_INK,
  FOREGROUND_WHITE,
  normaliseHex,
  readableForeground,
} from '@/lib/branding/color';

const ORG = "NULLIF(current_setting('app.current_org', true), '')::uuid";

export type BrandingErrorCode =
  | 'NO_TENANT'
  | 'INVALID_COLOR'
  | 'UNREADABLE_COLOR'
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'INVALID_TAGLINE';

export class BrandingError extends DomainError {
  constructor(
    message: string,
    readonly code: BrandingErrorCode,
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'BrandingError';
  }
}

/** Mirrors `organization_logo_mime_raster`. Raster only — see 0023's header. */
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMime = (typeof LOGO_MIME_TYPES)[number];

/** Mirrors `organization_logo_size`. 512 KiB. */
export const LOGO_MAX_BYTES = 524288;

export const TAGLINE_MAX_LENGTH = 200;

export interface Branding {
  /** The tenant's own name — this is what the tab title says (BR-5). */
  name: string;
  brandColor: string | null;
  loginTagline: string | null;
  /**
   * Metadata only. The BYTES are never loaded here: this is read on every page
   * render and a 512 KiB buffer per request, through the pool, to be discarded
   * is exactly the kind of cost that never shows up in a test and never leaves.
   * `/api/branding/logo` reads them, once, for the request that serves them.
   */
  logo: { mime: LogoMime; updatedAt: Date } | null;
}

async function readRow(tx: QueryRunner) {
  const r = await tx.query(
    `SELECT name, brand_color, login_tagline, logo_mime, logo_updated_at
       FROM organization WHERE id = ${ORG}`,
  );
  if (r.rows.length === 0) {
    throw new BrandingError('no tenant context, so there is no branding to read', 'NO_TENANT');
  }
  return r.rows[0];
}

export async function getBranding(tx: QueryRunner): Promise<Branding> {
  const row = await readRow(tx);
  return {
    name: row.name as string,
    brandColor: (row.brand_color as string | null) ?? null,
    loginTagline: (row.login_tagline as string | null) ?? null,
    logo:
      row.logo_mime === null
        ? null
        : { mime: row.logo_mime as LogoMime, updatedAt: row.logo_updated_at as Date },
  };
}

/** One statement, and it refuses rather than reporting success on nought rows. */
async function updateOrganization(
  tx: QueryRunner,
  setClause: string,
  params: unknown[],
): Promise<void> {
  const done = await tx.query(
    `UPDATE organization SET ${setClause}, updated_at = now() WHERE id = ${ORG}`,
    params,
  );
  // `organization` always has the row when there IS a tenant, so nought rows
  // means the WHERE named nobody. PE-8's write half, same reasoning.
  if (done.rowCount === 0) {
    throw new BrandingError('no tenant context, so there is no branding to change', 'NO_TENANT');
  }
}

/**
 * Set or clear the brand colour.
 *
 * THE REFUSAL IS HERE, not on the form. John's call of 1 Sep was to pick the
 * readable foreground per tenant and refuse only a colour where NEITHER white nor
 * ink reaches AA — which over the whole 24-bit space is 6.3% of colours, so the
 * rule costs an admin almost nothing and catches the ones that would have shipped
 * an unreadable button. Refusing at the SERVICE rather than in the screen is
 * MT-3's lesson for the fourth time this phase: a gate at the edge is a gate the
 * next caller forgets, and a colour can also arrive from a seed, an import, or
 * whatever provisions a tenant in Phase 5.
 */
export async function setBrandColor(
  tx: QueryRunner,
  actor: AuditActor,
  input: string | null,
): Promise<{ brandColor: string | null; foreground: string | null; ratio: number | null }> {
  if (input === null || input.trim() === '') {
    const before = await readRow(tx);
    await updateOrganization(tx, 'brand_color = NULL', []);
    await auditBranding(tx, actor, 'branding.color.clear', {
      previousColor: (before.brand_color as string | null) ?? null,
    });
    return { brandColor: null, foreground: null, ratio: null };
  }

  const hex = normaliseHex(input);
  if (hex === null) {
    throw new BrandingError(
      `not a colour: ${JSON.stringify(input)} — expected a hex value such as #0f766e`,
      'INVALID_COLOR',
      { code: 'COLOUR_MALFORMED', params: { given: typeof input === 'string' ? input : String(input) } },
    );
  }

  const fg = readableForeground(hex);
  if (fg === null) {
    // The message names both numbers on purpose. "Contrast too low" tells an
    // admin nothing they can act on; "white 1.07, dark 16.62, we need 4.5" tells
    // them the colour is too light and by roughly how much.
    const white = contrastRatio(hex, FOREGROUND_WHITE);
    const ink = contrastRatio(hex, FOREGROUND_INK);
    throw new BrandingError(
      `${hex} cannot carry readable text: ${white.toFixed(2)}:1 against white and ` +
        `${ink.toFixed(2)}:1 against dark ink, and ${CONTRAST_FLOOR}:1 is needed for ` +
        `button and badge labels. Try a deeper or lighter shade of the same hue.`,
      'UNREADABLE_COLOR',
      {
        code: 'COLOUR_UNREADABLE',
        params: { hex, white: white.toFixed(2), ink: ink.toFixed(2), floor: CONTRAST_FLOOR },
      },
    );
  }

  const before = await readRow(tx);
  await updateOrganization(tx, 'brand_color = $1', [hex]);
  await auditBranding(tx, actor, 'branding.color.set', {
    previousColor: (before.brand_color as string | null) ?? null,
    color: hex,
    foreground: fg.hex,
    // Strings: `canonical()` throws on BigInt and a float in an audit detail is a
    // value that reads differently on two platforms. AU-5.
    contrastRatio: fg.ratio.toFixed(2),
  });
  return { brandColor: hex, foreground: fg.hex, ratio: fg.ratio };
}

/**
 * Store the tenant's wordmark.
 *
 * The mime is checked against the SAME list the column's CHECK carries, and the
 * size against the same number, so a caller gets a sentence rather than a
 * constraint violation — but the column keeps both, because an importer, a
 * support script and a restored backup all reach the column without reaching
 * this function.
 *
 * AND IT VERIFIES THE BYTES ARE THE IMAGE THE MIME CLAIMS (part 2). The declared
 * mime arrives from a multipart form, which is to say from whoever is posting, so
 * on its own it is a claim and not a fact. Checking it HERE and not in the route
 * is MT-3 again: the route is one caller, and the next one will be an importer.
 *
 * The check is a magic-number sniff, and its job is narrow and worth stating so
 * nobody mistakes it for validation: it makes the stored `logo_mime` TRUE, so the
 * `Content-Type` the route sends matches the bytes it sends. That is what makes
 * `nosniff` meaningful — `nosniff` tells the browser to trust our Content-Type,
 * which is only a safety property if our Content-Type is right. It is NOT a
 * decode, so a truncated or corrupt PNG with a good signature still stores; that
 * renders as a broken image and harms nobody, and a full decode means an image
 * library in the request path for a wordmark.
 */
export async function setLogo(
  tx: QueryRunner,
  actor: AuditActor,
  bytes: Buffer,
  mime: string,
): Promise<void> {
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new BrandingError(
      `${mime} is not an accepted logo format — use PNG, JPEG or WebP. ` +
        `SVG is refused because it can carry script into our own pages.`,
      'INVALID_IMAGE',
      { code: 'LOGO_FORMAT_UNSUPPORTED', params: { mime } },
    );
  }
  if (bytes.length === 0) {
    throw new BrandingError('the uploaded logo is empty', 'INVALID_IMAGE', 'LOGO_EMPTY');
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new BrandingError(
      `the logo is ${Math.round(bytes.length / 1024)} KiB and the limit is ` +
        `${LOGO_MAX_BYTES / 1024} KiB`,
      'IMAGE_TOO_LARGE',
      {
        code: 'LOGO_TOO_LARGE',
        params: { size: Math.round(bytes.length / 1024), limit: LOGO_MAX_BYTES / 1024 },
      },
    );
  }
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== mime) {
    throw new BrandingError(
      sniffed === null
        ? `the uploaded file is not a PNG, JPEG or WebP image, whatever it is named`
        : `the file was sent as ${mime} but its contents are ${sniffed} — ` +
          `re-export it, or upload it with the right type`,
      'INVALID_IMAGE',
      sniffed === null
        ? 'LOGO_NOT_AN_IMAGE'
        : { code: 'LOGO_TYPE_MISMATCH', params: { mime, sniffed } },
    );
  }
  await updateOrganization(
    tx,
    'logo_bytes = $1, logo_mime = $2, logo_updated_at = now()',
    [bytes, mime],
  );
  await auditBranding(tx, actor, 'branding.logo.set', {
    mime,
    // A string, and in bytes rather than KiB: the audit row is the record, and
    // rounding at write time throws away the only copy of the real number.
    bytes: String(bytes.length),
  });
}

export async function clearLogo(tx: QueryRunner, actor: AuditActor): Promise<void> {
  await updateOrganization(
    tx,
    'logo_bytes = NULL, logo_mime = NULL, logo_updated_at = NULL',
    [],
  );
  await auditBranding(tx, actor, 'branding.logo.clear', {});
}

export async function setLoginTagline(
  tx: QueryRunner,
  actor: AuditActor,
  input: string | null,
): Promise<string | null> {
  const trimmed = input === null ? null : input.trim();
  if (trimmed === null || trimmed === '') {
    await updateOrganization(tx, 'login_tagline = NULL', []);
    await auditBranding(tx, actor, 'branding.tagline.clear', {});
    return null;
  }
  if (trimmed.length > TAGLINE_MAX_LENGTH) {
    throw new BrandingError(
      `the tagline is ${trimmed.length} characters and the limit is ${TAGLINE_MAX_LENGTH}`,
      'INVALID_TAGLINE',
      {
        code: 'TAGLINE_TOO_LONG',
        params: { length: trimmed.length, limit: TAGLINE_MAX_LENGTH },
      },
    );
  }
  await updateOrganization(tx, 'login_tagline = $1', [trimmed]);
  await auditBranding(tx, actor, 'branding.tagline.set', { tagline: trimmed });
  return trimmed;
}

/**
 * Every branding change is audited against the ORGANISATION row, because that is
 * the entity that changed. `entityType` and `entityId` are both required or
 * neither — the contract refused a null id once already and it was right.
 */
async function auditBranding(
  tx: QueryRunner,
  actor: AuditActor,
  action: AuditAction,
  details: Record<string, unknown>,
): Promise<void> {
  const org = await tx.query(`SELECT ${ORG} AS id`);
  const id = org.rows[0]?.id as string | null;
  if (id === null || id === undefined) {
    throw new BrandingError('no tenant context, so there is nothing to audit against', 'NO_TENANT');
  }
  await append(tx, actor, { action, entityType: 'organization', entityId: id, details });
}

/**
 * The first bytes of the three accepted formats, and nothing else.
 *
 *   PNG   89 50 4E 47 0D 0A 1A 0A          — the full 8-byte signature. The
 *                                            CR/LF/EOF bytes are there to catch
 *                                            transfers that mangled line endings,
 *                                            which is exactly what we want.
 *   JPEG  FF D8 FF                          — SOI plus the first marker byte.
 *   WebP  'RIFF' xxxx 'WEBP'                — a RIFF container whose form type is
 *                                            WEBP; the four size bytes between
 *                                            them are skipped, not checked.
 *
 * Returns the mime the bytes ACTUALLY are, or null for anything else — including
 * an SVG, which is the case that matters: `<svg` is text, matches no signature
 * here, and so cannot be smuggled in under an `image/png` label.
 *
 * THE `bytes.length >=` GUARDS ARE REDUNDANT TODAY, and are kept deliberately —
 * with the reason written down, because PE-8 was a fallback that looked like dead
 * defence and was not, and the honest version of that lesson cuts both ways.
 * Indexing a Buffer past its end yields `undefined` rather than throwing, and
 * `Buffer.equals` on two different lengths is simply false, so every branch below
 * already answers null for a short buffer. Sabotaging the guards away fails NO
 * test, which is how this was established rather than assumed. They stay because
 * the guard is the invariant, not the mechanism: a future rewrite reaching for
 * `readUInt32BE` or a DataView to read the WebP chunk size WOULD throw on a short
 * buffer, and the guard is what makes that rewrite safe by default instead of a
 * crash on a one-byte upload.
 */
export function sniffImageMime(bytes: Buffer): LogoMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The bytes, for the one request that serves them. Separate from `getBranding`
 * on purpose — see the note on `Branding.logo`.
 */
export async function readLogoBytes(
  tx: QueryRunner,
): Promise<{ bytes: Buffer; mime: LogoMime; updatedAt: Date } | null> {
  const r = await tx.query(
    `SELECT logo_bytes, logo_mime, logo_updated_at FROM organization WHERE id = ${ORG}`,
  );
  if (r.rows.length === 0) {
    throw new BrandingError('no tenant context, so there is no logo to read', 'NO_TENANT');
  }
  const row = r.rows[0];
  if (row.logo_mime === null) return null;
  return {
    bytes: row.logo_bytes as Buffer,
    mime: row.logo_mime as LogoMime,
    updatedAt: row.logo_updated_at as Date,
  };
}
