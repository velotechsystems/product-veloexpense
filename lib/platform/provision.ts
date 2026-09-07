/**
 * VX5-20 part 2 — the platform stands a VeloExpense tenant up.
 *
 * Ported from `product-veloledger/lib/platform/provision.ts`, and the port is
 * mostly a DELETION: VeloLedger's version writes the organization, the entity,
 * the journal sequence, the fiscal periods, the Administrator role, the admin
 * user and the audit row itself, because it had no other caller that creates a
 * tenant. VeloExpense does — `lib/onboarding/provision.ts`'s
 * `createOrganization`, built for VX5-1 and used by self-serve signup since
 * VX5-2b — so this file is the platform-facing WRAPPER around it and nothing
 * more.
 *
 * That is the whole design decision, and it is worth being explicit about
 * because the alternative was one file copied over and left to drift:
 *
 *   · A second tenant-creation path would be a second place that decides what a
 *     new tenant arrives holding. VX5-4 settled that question (starter
 *     categories, no policies, no trial), and `createOrganization`'s header
 *     argues each of those. A platform-provisioned tenant that arrives with no
 *     categories, because the second path forgot to seed them, is a tenant
 *     nobody can record an expense in.
 *   · It would also be a second place that has to get the transaction shape
 *     right — the `set_config('app.current_org', …, true)` mid-transaction
 *     trick that makes the first `app_user` insert legal under FORCE RLS. That
 *     is subtle enough to be worth having exactly once.
 *
 * So: everything this file adds is what the PLATFORM needs and signup does not
 * — the Account link, idempotency on it, and a slug that resolves rather than
 * refuses.
 *
 * ── IDEMPOTENCY IS A CONSTRAINT, NOT A CHECK ────────────────────────────────
 *
 * The fast path is the same SELECT VeloLedger does. What `0040` adds is a UNIQUE
 * index behind it, because the caller is an orchestrator with a retry and the
 * most likely reason it calls twice is a first call that TIMED OUT — which means
 * the first call may still be running. A read-then-write check does not survive
 * that; two provisions for one Account would each pass the SELECT and the
 * Account would end up owning two tenants, one of which is invisible forever
 * because every later lookup takes `LIMIT 1`.
 *
 * The SELECT stays as an optimisation (the common retry is not concurrent, and
 * answering it without a write is cheaper and quieter). The constraint is the
 * guarantee. `0040`'s header carries the rest of the argument.
 *
 * ── THE SLUG RESOLVES INSTEAD OF REFUSING, AND THAT IS A CHANGE ────────────
 *
 * VeloLedger requires the platform to supply a usable slug and returns 400 when
 * it is taken. That puts the orchestrator in an impossible position: it has to
 * invent a different one and retry, with no way to know what is free — the list
 * lives in this database and nowhere else.
 *
 * VeloExpense already has the machinery signup uses for exactly this
 * (`nextFreeSlug`), so a taken slug becomes `acme-2` and **the response says
 * which slug was actually used.** The platform records the truth rather than its
 * request. A slug is a hostname, not an identity — `account_id` is the identity,
 * and it is the thing this refuses to duplicate.
 *
 * A slug that is not merely taken but UNUSABLE — reserved, or the wrong shape —
 * is still a refusal (422 at the route), because that is a bug in the caller
 * rather than a collision, and quietly renaming `admin` to `admin-2` would hide
 * it.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * IT DOES NOT ADOPT AN EXISTING TENANT. If a company signed up through
 * VeloExpense's front door and later buys through the platform, this creates a
 * SECOND tenant rather than stamping `account_id` onto the first. Matching on
 * the admin's email address would be the obvious way to "helpfully" link them,
 * and it is an account-takeover primitive: anybody who can make the platform
 * provision with a chosen `adminEmail` would acquire that tenant's data. Linking
 * an existing tenant to an Account is an operator action with a human deciding,
 * and it is not this endpoint. `already_exists` means the ACCOUNT was seen
 * before, never that the company was.
 *
 * IT ALSO DOES NOT SEND THE WELCOME MAIL. Same boarded follow-up as
 * VeloLedger's, and for the same reason: the admin is reachable through SSO the
 * moment their row exists, so mail is a convenience rather than the mechanism.
 */
import { transaction } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import {
  createOrganization,
  ProvisionError,
  takenSlugs,
  type ProvisionedOrganization,
} from '@/lib/onboarding/provision';
import { checkSlug, nextFreeSlug, slugify } from '@/lib/onboarding/slug';

/** The frozen v1 provision contract, minus what the route's schema validates. */
export interface PlatformProvisionInput {
  /** The platform Account UUID. The idempotency key and the tenant's link. */
  accountId: string;
  /** The platform's plan slug. Recorded on the genesis audit row; not stored. */
  plan: string;
  adminEmail: string;
  adminName: string;
  companyName: string;
  /** Requested, not guaranteed — see the header. */
  slug: string;
}

export interface PlatformProvisionResult {
  /** The VeloExpense organization id. `tenantId` in the platform's vocabulary. */
  tenantId: string;
  /** The slug ACTUALLY in use, which may not be the one requested. */
  slug: string;
  status: 'provisioned' | 'already_exists';
}

export type PlatformProvisionErrorCode = 'SLUG_UNUSABLE' | 'NO_FREE_SLUG';

export class PlatformProvisionError extends DomainError {
  constructor(
    message: string,
    readonly code: PlatformProvisionErrorCode,
  ) {
    super(message, null);
    this.name = 'PlatformProvisionError';
  }
}

/** How many times a slug race is re-resolved before giving up. */
const SLUG_ATTEMPTS = 3;

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

function isAccountConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  // `0040`'s index. Named rather than assumed: this transaction can also violate
  // the slug UNIQUE, and the two mean opposite things — one is a duplicate
  // provision to absorb, the other is a race to re-resolve.
  return e.constraint === 'organization_by_account_idx';
}

/** The tenant already linked to this Account, if there is one. */
async function findByAccount(accountId: string): Promise<{ id: string; slug: string } | null> {
  return transaction(async (tx) => {
    // `organization` is not a tenant table — it has no `organization_id` and no
    // RLS policy, because it is the table the tenant id comes FROM (`0001`).
    // So this needs no GUC and no platform hatch, and is not one.
    const r = await tx.query(
      `SELECT id, slug FROM organization WHERE account_id = $1 LIMIT 1`,
      [accountId],
    );
    const row = r.rows[0] as { id: string; slug: string } | undefined;
    return row ? { id: row.id, slug: row.slug } : null;
  });
}

/**
 * Create — or find — the tenant for a platform Account.
 *
 * Never throws for a duplicate: a retried provision returns the existing tenant.
 * Throws `PlatformProvisionError` only when the caller asked for something this
 * cannot give it (an unusable slug), and `ProvisionError` for the input problems
 * `createOrganization` already names.
 */
export async function provisionTenant(
  input: PlatformProvisionInput,
): Promise<PlatformProvisionResult> {
  const existing = await findByAccount(input.accountId);
  if (existing) {
    return { tenantId: existing.id, slug: existing.slug, status: 'already_exists' };
  }

  // The requested slug is normalised the same way signup normalises a typed one,
  // so the platform does not have to know this product's slug rules. What it
  // cannot do is rescue a RESERVED or malformed request — see the header.
  const requested = slugify(input.slug.trim().toLowerCase());
  const refusal = checkSlug(requested);
  if (refusal !== null) {
    throw new PlatformProvisionError(
      `requested slug ${JSON.stringify(input.slug)} is not usable: ${refusal}`,
      'SLUG_UNUSABLE',
    );
  }

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const slug = nextFreeSlug(requested, await takenSlugs(requested));
    if (slug === '') {
      throw new PlatformProvisionError(
        `no free slug near ${JSON.stringify(requested)}`,
        'NO_FREE_SLUG',
      );
    }

    let created: ProvisionedOrganization;
    try {
      created = await createOrganization({
        name: input.companyName,
        slug,
        adminEmail: input.adminEmail,
        adminName: input.adminName,
        accountId: input.accountId,
      });
    } catch (err) {
      // A concurrent provision for the SAME Account won. Absorb it: the caller
      // asked for a tenant for this Account and there is one.
      if (isAccountConflict(err)) {
        const won = await findByAccount(input.accountId);
        if (won) return { tenantId: won.id, slug: won.slug, status: 'already_exists' };
        // Vanishingly unlikely (the conflicting transaction rolled back after
        // conflicting with us), and falling through to another attempt is the
        // honest response rather than inventing a result.
        continue;
      }

      /* A concurrent provision took the SLUG we had just picked. That is not
       * necessarily a different Account: two retries of the SAME provision both
       * read `takenSlugs` before either inserts, land on the same candidate, and
       * whichever loses arrives here.
       *
       * THIS RE-CHECK IS NOT LOAD-BEARING, AND THAT WAS MEASURED RATHER THAN
       * ASSUMED. The comment here first claimed that without it "a duplicate
       * provision would be reported as a slug error". That is false, and the
       * sabotage that removed it came back green: the loser simply loops, reads
       * a `takenSlugs` that now contains the winner, picks `-2`, and trips the
       * ACCOUNT index instead — absorbed by the branch above, one attempt later,
       * with the same answer.
       *
       * It stays for two reasons that are worth less than correctness but more
       * than nothing, and both are stated because no test can distinguish them:
       *
       *   · it answers a duplicate provision without a second doomed INSERT, and
       *   · it keeps the `SLUG_ATTEMPTS` budget for real slug contention rather
       *     than spending it on our own retries — which is the one case where
       *     removing this WOULD change the outcome, since exhausting the budget
       *     raises NO_FREE_SLUG for what was only ever a duplicate.
       */
      if (err instanceof ProvisionError && err.code === 'SLUG_TAKEN') {
        const won = await findByAccount(input.accountId);
        if (won) return { tenantId: won.id, slug: won.slug, status: 'already_exists' };
        continue; // genuinely somebody else's slug — take the next one
      }
      throw err;
    }

    return { tenantId: created.organizationId, slug: created.slug, status: 'provisioned' };
  }

  // Three consecutive losses on freshly-read candidates. Not a slug problem any
  // more — something is provisioning in a loop — so it is reported rather than
  // retried forever, and the route turns it into a 400 the orchestrator can
  // retry with its own backoff.
  throw new PlatformProvisionError(
    `could not claim a slug near ${JSON.stringify(requested)} in ${SLUG_ATTEMPTS} attempts`,
    'NO_FREE_SLUG',
  );
}
