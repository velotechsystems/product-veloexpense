/**
 * Invite-only SSO resolver. Given the org slug (from the pre-redirect cookie)
 * and the provider's identity, return the user or a denial.
 *
 * AUTHKITSYNC-VE-1 (auth-kit v0.3): the kit now hands over an SsoIdentity, not
 * a bare email, and refuses a Google address Google has not verified before
 * this file is reached. Everything below acts on a VERIFIED email — invitation
 * acceptance is bound to it — so this resolver also refuses any identity whose
 * email is not verified. That is every Microsoft identity: an Entra `email`
 * claim is chosen by whoever runs the signing-in user's directory, so accepting
 * an invitation on it would let anyone with their own directory join a tenant
 * as the invited person. The kit does not offer Microsoft to this product
 * (auth.ts does not declare `microsoftDirectoryBinding`); the check here is the
 * second lock, so that turning Microsoft on later means building the directory
 * binding (see lib-auth-kit's README), not flipping a flag.
 *
 * Phase 0 returns role='member'/subjectId=null; authorization reads
 * the person's role from the DATABASE (`lib/auth/actor.ts`), never from the session
 * token, so the placeholder is not load-bearing.
 *
 * ── A BUG THIS TICKET FOUND, WHICH PREDATES IT: SSO COULD NOT SIGN ANYBODY IN ─
 *
 * The previous version read `app_user` inside `withoutOrg`, described in its own
 * header as "the service-role path — a sanctioned cross-tenant read". It is not
 * one, and `lib/tenant/context.ts` says so in as many words: `withoutOrg` still
 * connects as `veloapp`, which is subject to FORCE RLS, so with
 * `app.current_org` unset every policy body compares against NULL and the table
 * returns ZERO ROWS. The lookup could never match anybody. **Every SSO sign-in
 * was denied**, whoever they were.
 *
 * Nothing caught it because nothing exercises this path: `e2e/auth.setup.ts`
 * mints session cookies directly with `next-auth/jwt` (SSO is unrunnable in CI),
 * so the browser suite has never been through `signIn`, and there was no unit
 * test on this file at all. The first test written against it — VX5-3's "signs
 * in a member who already exists" — failed on the second call and that is how
 * this surfaced.
 *
 * The fix needs no new hatch. `organization` carries no tenant column and no
 * tenant policy, so the SLUG can be resolved with no context; after that there is
 * a tenant, and `app_user` is read inside it under `tenant_isolation` like
 * everything else. Two steps instead of one join, and the second one is ordinary.
 *
 * ── VX5-3: THIS IS WHERE MEMBERSHIP IS GRANTED ──────────────────────────────
 *
 * The auth-kit's contract says "the kit never provisions accounts from SSO", and
 * that is still true — the KIT does not. This resolver does, from a live
 * invitation, and this is the right place for it rather than a page or a link
 * handler, for one reason:
 *
 *   **the email here has been verified by Google or Microsoft moments ago.**
 *
 * That is what an invitation is bound to. An invite link carries the tenant and
 * is revocable and expiring, but it is not what makes somebody a member; if it
 * were, a link forwarded to a colleague or pasted into a chat would let whoever
 * read it join under somebody else's address. Provisioning here instead means
 * the holder of a stray link gains nothing they did not already have, because
 * they would need to control the invited mailbox as an SSO identity — which is
 * the same thing as being the invited person.
 *
 * It also means the link is optional. Somebody who was invited and lost the
 * email can sign in at `/login` with their organization's web address and it
 * works. "I can't find the invitation" stops being a support ticket, and it is
 * only safe because of the paragraph above.
 *
 * ── TWO GAPS CLOSED HERE, BOTH OUTSIDE THE INVITE ITSELF ────────────────────
 *
 * 1. `deleted_at` was NOT checked. A deactivated person completed OAuth, got a
 *    real session, and was refused a moment later at `requireActor`. Defence in
 *    depth held, so this was never a way in — but a valid session existed for a
 *    deactivated account, and a refusal belongs at the door rather than one room
 *    further in. Checked here now, and `requireActor` still checks it too.
 *
 * 2. A denied sign-in left no trace but a `console.warn`. With joining
 *    invite-only, a refused attempt is the shape somebody probing a tenant
 *    takes — the wrong address, the wrong organization, an account that used to
 *    work. `onSsoDenied` now writes `SIGN_IN_DENIED` to the tenant's audit log.
 */
import { withoutOrg, withOrg } from '@/lib/tenant/context';
import type { ResolvedUser, SsoDenied, SsoDeniedEvent, SsoIdentity } from '@/src/auth-kit';
import { acceptForVerifiedEmail } from '@/lib/invites/service';
import { pushSeatCountInBackground } from '@/lib/billing/seats';
import { append as auditAppend } from '@/lib/audit/service';
import { CapReachedError } from '@/lib/billing/caps';

/**
 * Slug to tenant. `organization` has no tenant column and no `tenant_isolation`
 * policy — it is where tenancy comes FROM — so this is the one read that
 * genuinely works with no context, and the only one this file makes that way.
 */
async function activeOrgIdForSlug(orgSlug: string): Promise<string | null> {
  return withoutOrg(async (tx) => {
    const r = await tx.query(
      "SELECT id FROM organization WHERE slug = $1 AND status = 'active'",
      [orgSlug],
    );
    return r.rows.length === 0 ? null : (r.rows[0].id as string);
  });
}

export async function resolveSsoUser(orgSlug: string, identity: SsoIdentity): Promise<ResolvedUser | SsoDenied> {
  // See the header: everything below trusts the address. Microsoft's is not verified.
  if (identity.emailVerified !== true) return { denied: 'email_unverified' };
  const email = identity.email;
  const orgId = await activeOrgIdForSlug(orgSlug);
  if (orgId === null) return { denied: 'unknown_org' };

  const existing = await withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `SELECT id, email, has_access FROM app_user
        WHERE lower(email) = lower($1)
          -- VX5-3: a deactivated account is refused HERE, not two steps later.
          AND deleted_at IS NULL
        LIMIT 1`,
      [email],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as { id: string; email: string; has_access: boolean };
    // People 1 (0072): ExpenseOS's `hasExpenseOSAccess` — its `signIn` callback refuses
    // without it, for every provider, and so does this. A member, not a stranger, so the
    // denial says the account is disabled rather than unknown.
    if (!row.has_access) return { denied: 'account_disabled' } as SsoDenied;
    // People 1: ExpenseOS's `lastLoginAt`, which the People directory shows.
    await tx.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [row.id]);
    return { userId: row.id, orgId, email: row.email, role: 'member', subjectId: null } as ResolvedUser;
  });
  if (existing !== null) return existing;

  // No member. Is there an invitation for this verified address?
  //
  // The tenant is the one they NAMED, via the cookie — never the one an
  // invitation happens to be in. Somebody invited to Acme who signs in at Globex
  // is refused rather than quietly signed into Acme.
  let accepted: Awaited<ReturnType<typeof acceptForVerifiedEmail>>;
  try {
    accepted = await acceptForVerifiedEmail(orgId, email);
  } catch (err) {
    // THE SEAT CAP (`lib/billing/caps.ts`), refusing inside NextAuth's `signIn`
    // callback, where a throw is an opaque failure page. So it becomes a denial
    // like any other — the invitation was not consumed (its transaction rolled
    // back), so the same person signs in the moment a seat is free — and the
    // REASON is written to the tenant's audit log first, because the
    // `SIGN_IN_DENIED` row the auth kit writes next cannot say why, and "my
    // invitee can't get in" is the call an admin will otherwise take blind.
    if (!(err instanceof CapReachedError)) throw err;
    console.warn('[auth] invitation not accepted: seat limit reached', { orgSlug, email });
    try {
      await withOrg(orgId, (tx) =>
        auditAppend(
          tx,
          { id: null, email, name: email, role: 'anonymous' },
          { action: 'INVITE_REFUSED', details: { reason: err.code, limit: err.limit } },
        ),
      );
    } catch (auditErr) {
      console.error('[auth] could not audit a refused invitation:', auditErr);
    }
    return { denied: 'unknown_user' };
  }
  // No member and no live invitation (or a deactivated member, whose row the
  // lookup above skips): not somebody this tenant knows.
  if (accepted === null) return { denied: 'unknown_user' };

  /*
   * VX5-20. A NEW MEMBER IS A NEW SEAT, and this is the only place in the product
   * where one appears: `app_user` is inserted at invitation ACCEPTANCE, not from
   * an admin form (VX5-2 removed that path), so a seat is created here and
   * nowhere else.
   *
   * `ACCEPTED` only. `ALREADY_A_MEMBER` means nothing was consumed and nothing
   * happened — pushing there would send an unchanged count on every sign-in of
   * every existing employee, which is a lot of requests to say nothing.
   *
   * Fire-and-forget, in a path where that is not a shortcut but the rule: this
   * runs inside NextAuth's `signIn` callback, and the note under
   * `recordDeniedSignIn` below says why anything here must not throw — "a throw
   * becomes an opaque failure page". Nobody should fail to sign in because the
   * platform is slow, and nobody should wait on it either.
   */
  if (accepted.kind === 'ACCEPTED') pushSeatCountInBackground(accepted.organizationId);

  // People 1: the new member's first sign-in is a sign-in (`last_login_at`, 0072). Best
  // effort, for the reason `recordDeniedSignIn` gives: nothing here may throw.
  try {
    await withOrg(accepted.organizationId, (tx) =>
      tx.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [accepted.userId]),
    );
  } catch (err) {
    console.error('[auth] could not record a first sign-in:', err);
  }

  return {
    userId: accepted.userId,
    orgId: accepted.organizationId,
    email: accepted.email,
    role: 'member',
    subjectId: null,
  };
}

/**
 * Record a refused sign-in against the tenant it was aimed at.
 *
 * Best effort, and deliberately so: this runs inside NextAuth's `signIn`
 * callback, where a throw becomes an opaque failure page. A denial that cannot
 * be audited must still be a denial, so the write is wrapped and the console
 * line stays as the floor.
 *
 * The actor is the EXTERNAL shape — `{ id: null, email }` — which
 * `lib/audit/service.ts` already supports for approve-by-link. It is exactly
 * right here: somebody who is not a member of this tenant, identified only by an
 * address an identity provider verified.
 *
 * An unknown slug writes nothing, and cannot: there is no tenant to write it to.
 * That case is the console line alone, which is the honest floor rather than a
 * gap — an audit log belongs to an organization, and a probe against a name that
 * is not one has no organization to belong to. The same holds for a missing or
 * expired org cookie (auth-kit v0.3 reports it with `orgSlug: null`).
 *
 * AUTHKITSYNC-VE-1: the kit passes an address only when the provider verified
 * it (`verifiedEmail`, Google). `audit_entry` needs a user id or an email for
 * its actor, and this resolver never names a user in a denial, so a refusal
 * without a verified address — an unverified or missing one, which the kit or
 * the check above refuses before any tenant lookup — is the console line
 * alone, like an unknown slug. The kit's `reason` is now recorded too: "my invitee
 * can't get in" reads differently as `unknown_user` than as `email_unverified`.
 */
export async function onSsoDenied(event: SsoDeniedEvent): Promise<void> {
  const { orgSlug, provider, reason, verifiedEmail } = event;
  console.warn('[auth] SSO denied', { orgSlug, provider, reason, email: verifiedEmail ?? null });
  try {
    if (orgSlug === null) return;
    if (!verifiedEmail) return;
    const orgId = await activeOrgIdForSlug(orgSlug);
    if (orgId === null) return;
    await withOrg(orgId, (tx) =>
      auditAppend(
        tx,
        { id: null, email: verifiedEmail, name: verifiedEmail, role: 'anonymous' },
        { action: 'SIGN_IN_DENIED', details: { provider, reason } },
      ),
    );
  } catch (err) {
    console.error('[auth] could not audit a denied sign-in:', err);
  }
}
