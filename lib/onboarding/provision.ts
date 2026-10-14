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
import { seedStarterCategories } from '@/lib/onboarding/starter';
import { checkSlug, type SlugRefusal } from '@/lib/onboarding/slug';
import { seedDefaultExpenseWorkflow } from '@/lib/approvals/defaultWorkflow';

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
  /**
   * VX5-20 part 2 — the platform's Account UUID, when the platform is the caller.
   *
   * OMITTED for VeloExpense's own signup, and that absence is meaningful rather
   * than incidental: a tenant with no `account_id` is one the platform has never
   * heard of, which `lib/billing/entitlements.ts` and `lib/billing/seats.ts` both
   * treat as a legitimate state (the entitlement client falls back to resolving
   * by email domain; the seat push skips). So this stays optional — making it
   * required would force the signup path to invent a value, and an invented
   * account id is worse than a null one because it looks answered.
   */
  accountId?: string | null;
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
    // `account_id` is stamped HERE rather than UPDATEd afterwards. An UPDATE
    // would be a second statement that can fail on its own, and the state it
    // leaves — a tenant the platform provisioned but cannot find again — is the
    // exact half-existing shape this function's header refuses for the admin
    // row. `organization_by_account_idx` is UNIQUE as of `0040`, so a second
    // provision for the same Account raises 23505 here and the whole transaction
    // rolls back; `lib/platform/provision.ts` absorbs that as `already_exists`.
    const org = await tx.query(
      `INSERT INTO organization (slug, name, status, account_id)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, name, input.accountId ?? null],
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
      // w4-10b: System Administrator (SYSTEM_ROLE_IDS.admin) — the tenant's own row, which
      // the trigger on organization created with it (0068).
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, $3, '019e3000-0000-7000-8000-000000000001'::uuid)
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
    /* VX5-4 — the tenant can RUN when it is handed over.
     *
     * Inside this transaction on purpose. A tenant whose categories failed to
     * write is a tenant where nobody can record an expense, which is the same
     * class of half-existing this function's header refuses for the admin row.
     *
     * Categories and nothing else: everything else a new tenant lacks is a
     * POLICY, and `lib/onboarding/starter.ts` argues the line. */
    const seededCategories = await seedStarterCategories(tx);

    /* w4-00c-1 (d54, d56, d59) — and the approval flow every tenant starts on: the
     * submitter's manager approves, any administrator when there is no manager. Authored by
     * this administrator. In this transaction
     * for the same reason as the categories: ExpenseOS's engine approves a report that no
     * workflow governs, so a tenant without one would approve everything on submit. Not a
     * policy in starter.ts's sense — the absence is not benign. */
    await seedDefaultExpenseWorkflow(tx, adminUserId);

    /* VX5-19 — NO TRIAL IS STARTED HERE, and its absence is the decision.
     *
     * VX5-8 called `startTrial` in this transaction, on the reasoning that a
     * tenant which exists and is unbillable is a half-existing state. That
     * reasoning was right and the conclusion was wrong: this product does not
     * decide what anybody pays. The VeloTech platform owns billing across the
     * suite, starts the trial, and this tenant's entitlement is MIRRORED here
     * when the platform is asked (`lib/billing/entitlements.ts`).
     *
     * A tenant created through VeloExpense's own signup may therefore have no
     * platform Account at all — the platform answers `not_found` — and that is a
     * legitimate state meaning nobody is billing it. It writes normally; see
     * `canWriteWithoutSubscription`. */

    await auditAppend(
      tx,
      // w4-10b (d74): the role's label.
      { id: adminUserId, name: input.adminName?.trim() || adminEmail, role: 'System Administrator' },
      {
        action: 'ORGANIZATION_CREATED',
        entityType: 'organization',
        entityId: organizationId,
        // The seeded count rides on the genesis row rather than getting an
        // action of its own: it is part of the tenant coming into being, not a
        // separate event, and an auditor asking "where did these six categories
        // come from" finds the answer on the row that says where everything
        // came from.
        details: {
          slug,
          name,
          admin_email: adminEmail,
          seeded_categories: seededCategories,
          // Present only when the platform provisioned this tenant, so the
          // genesis row answers "where did this tenant come from" without a
          // second action or a join. Absent means VeloExpense's own front door.
          ...(input.accountId ? { account_id: input.accountId } : {}),
        },
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
