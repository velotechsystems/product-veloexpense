/**
 * VX5-1 — creating an organization, which is the one write that cannot start
 * inside a tenant.
 *
 * ── THE PROBLEM, STATED PRECISELY ───────────────────────────────────────────
 *
 * Every write in this codebase runs inside `withOrg`, which sets
 * `app.current_org` and lets FORCE RLS scope the statement. Creating an
 * organization has no such id to set — the row being written is what the id will
 * come from. And the first `app_user` cannot be written before the org exists,
 * because `app_user` is tenant-scoped and its WITH CHECK compares against a GUC
 * that is still unset.
 *
 * ── WHY THIS IS ONE TRANSACTION AND NOT TWO ─────────────────────────────────
 *
 * The obvious shape is `withoutOrg` to insert the organization, then `withOrg`
 * to insert the administrator. It works, and it is wrong: they are two
 * transactions, so anything that fails between them — a crash, a lost
 * connection, a constraint on the second insert — leaves an ORGANIZATION WITH NO
 * USERS. Nobody can sign into it (`resolveSsoUser` finds no row), nobody can be
 * invited into it (that needs an administrator), and its slug is taken forever.
 * A tenant that cannot be entered or deleted is worse than a failed signup.
 *
 * So: ONE transaction, which sets `app.current_org` on itself partway through,
 * after the INSERT that produces the id. `set_config(…, true)` is transaction-
 * local, so the setting dies with the transaction whether it commits or rolls
 * back — the same property `withOrg` relies on, used in the one place the id is
 * not known in advance.
 *
 * ── WHY THIS IS NOT A NEW ESCAPE HATCH ──────────────────────────────────────
 *
 * It is worth being explicit, because "a function that writes before RLS applies"
 * is exactly what a back door looks like:
 *
 *   · `organization` is not a tenant table. It has no `organization_id` and no
 *     RLS policy — `0001` says so — because it is the table the tenant id comes
 *     FROM. Inserting into it is not a bypass; there is nothing to bypass.
 *   · The connection is still `veloapp`, still subject to FORCE RLS on every
 *     other table. The `app_user` insert below is a normal tenant-scoped write
 *     that succeeds only because the GUC was set to the org it belongs to.
 *   · No `app.platform_task`, no ADMIN connection, no `SET ROLE`. The only new
 *     capability is choosing WHEN in the transaction the tenant becomes known.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * IT DOES NOT VERIFY THE EMAIL, and it has no route in front of it. That is
 * VX5-2's job and this ships without a caller on purpose: a provisioning
 * endpoint that anybody can POST to, creating tenants from addresses nobody has
 * proven they hold, is the abuse surface the phase's second ticket exists to
 * close. Shipping the mechanism first and the door second means there is never a
 * commit where the door is open.
 *
 * IT DOES NOT SEED CATEGORIES, POLICIES OR A CHART OF ACCOUNTS. What a brand-new
 * tenant should arrive holding is VX5-4, and it is a product question rather than
 * a mechanical one — `DEFAULT_POLICIES` exists and `scripts/seed.mjs`
 * deliberately does not apply it, precisely so that "a fresh tenant has no rules"
 * is a decision somebody makes rather than a thing that happened.
 */
import { transaction } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { append as auditAppend } from '@/lib/audit/service';
import { checkSlug, type SlugRefusal } from '@/lib/onboarding/slug';

export type ProvisionErrorCode = SlugRefusal | 'SLUG_TAKEN' | 'NAME_REQUIRED' | 'EMAIL_REQUIRED';

export class ProvisionError extends DomainError {
  constructor(
    message: string,
    readonly code: ProvisionErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'ProvisionError';
  }
}

export interface NewOrganization {
  /** What the company calls itself. Shown; not used as an identifier. */
  name: string;
  /** The hostname-safe identifier. `lib/onboarding/slug.ts` proposes it. */
  slug: string;
  /** The first administrator. VX5-2 is what proves they hold this address. */
  adminEmail: string;
  adminName?: string | null;
}

export interface ProvisionedOrganization {
  organizationId: string;
  slug: string;
  adminUserId: string;
}

/**
 * Create an organization and its first administrator, atomically.
 *
 * The administrator is ADMIN by construction and not by argument: an
 * organization whose first user is an EMPLOYEE is one nobody can administer,
 * invite into, or configure — a dead tenant created by a typo in a parameter.
 * The role is a fact about being first, so it is not something a caller passes.
 */
export async function createOrganization(
  input: NewOrganization,
): Promise<ProvisionedOrganization> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const adminEmail = input.adminEmail.trim();

  if (name === '') {
    throw new ProvisionError('organization name is required', 'NAME_REQUIRED', 'ORG_NAME_REQUIRED');
  }
  if (adminEmail === '') {
    throw new ProvisionError('an administrator email is required', 'EMAIL_REQUIRED');
  }
  const refusal = checkSlug(slug);
  if (refusal !== null) {
    throw new ProvisionError(
      `slug ${JSON.stringify(slug)} is not usable: ${refusal}`,
      refusal,
      refusal === 'RESERVED' ? 'ORG_SLUG_RESERVED' : 'ORG_SLUG_SHAPE',
    );
  }

  return transaction(async (tx) => {
    // ── 1. the organization ───────────────────────────────────────────────
    //
    // `ON CONFLICT DO NOTHING` and then checking, rather than catching 23505:
    // the UNIQUE constraint is what actually decides who gets a slug, and two
    // signups racing for the same one is a real case the moment signup is
    // public. The loser gets a sentence naming the problem instead of a
    // Postgres error class.
    const org = await tx.query(
      `INSERT INTO organization (slug, name, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, name],
    );
    if (org.rows.length === 0) {
      throw new ProvisionError(
        `slug ${JSON.stringify(slug)} is already taken`,
        'SLUG_TAKEN',
        'ORG_SLUG_TAKEN',
      );
    }
    const organizationId = org.rows[0].id as string;

    // ── 2. the tenant now exists, so become it ────────────────────────────
    //
    // Transaction-local, exactly as `withOrg` does it. Every statement after
    // this line is an ordinary tenant-scoped write under FORCE RLS; a rollback
    // takes the setting with it.
    await tx.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);

    // ── 3. the first administrator ────────────────────────────────────────
    const user = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1, $2, $3, 'ADMIN')
       RETURNING id`,
      [organizationId, adminEmail, input.adminName?.trim() || null],
    );
    const adminUserId = user.rows[0].id as string;

    // ── 4. the chain starts with its own creation ─────────────────────────
    //
    // A pleasing property rather than a contrived one: this tenant's audit chain
    // has a genesis row, and the genesis row is the tenant coming into being,
    // written by the person it made an administrator. There is no earlier state
    // for an auditor to wonder about.
    await auditAppend(
      tx,
      { id: adminUserId, name: input.adminName?.trim() || adminEmail, role: 'ADMIN' },
      {
        action: 'ORGANIZATION_CREATED',
        entityType: 'organization',
        entityId: organizationId,
        details: { slug, name, admin_email: adminEmail },
      },
    );

    return { organizationId, slug, adminUserId };
  });
}

/** Slugs already in use, for `nextFreeSlug` to propose around. */
export async function takenSlugs(prefix: string): Promise<Set<string>> {
  return transaction(async (tx) => {
    const r = await tx.query('SELECT slug FROM organization WHERE slug LIKE $1', [`${prefix}%`]);
    return new Set((r.rows as { slug: string }[]).map((row) => row.slug));
  });
}
