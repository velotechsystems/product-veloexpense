/**
 * VX5-2 — the door VX5-1 deliberately shipped without.
 *
 * ── THE ORDER OF EVENTS, AND WHY IT IS THIS ORDER ───────────────────────────
 *
 *   start   → a `signup` row, a token, an email. NO organization yet.
 *   verify  → the token is consumed and `createOrganization` runs, in ONE
 *             transaction. The organization exists only now.
 *
 * The tenant is created at VERIFICATION, not at request. That is the whole
 * point: a tenant created at request time is a tenant created from an address
 * nobody has proven they hold, and cleaning those up afterwards means deciding
 * which half-used organizations are real.
 *
 * It also means an unverified request CANNOT SQUAT A NAME. The slug on a signup
 * row is what was asked for, not what was reserved; `organization`'s UNIQUE
 * constraint decides, at verification, and the loser of a race is told the name
 * is taken rather than finding a stranger's tenant sitting on it.
 *
 * ── WHY THIS DOES NOT USE THE NOTIFICATION OUTBOX ───────────────────────────
 *
 * `lib/notifications/outbox.ts` is the reliable path — a row written in the same
 * transaction as the thing it announces, retried by a poller — and every tenant
 * notification uses it. It cannot carry this one: `notification_delivery` is
 * tenant-scoped, and at the moment a verification email is sent there is no
 * tenant to scope it to.
 *
 * So this calls `sendEmail` directly and accepts what that costs: no automatic
 * retry. The compensation is that the person is standing right there, and RESEND
 * is a button rather than a background job. Stated plainly because "why is this
 * one not on the outbox" is the first question a reader should have.
 *
 * ── ONE LIVE SIGNUP PER ADDRESS ─────────────────────────────────────────────
 *
 * `0035` has a partial UNIQUE index rather than this file having a counter, so
 * asking twice is a RESEND — a new token and a new expiry on the existing row —
 * instead of a second row. That is better product behaviour and a stronger
 * guarantee, and it means the rate limit cannot be got round by racing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withSignupContext, withSignupConsume } from '@/lib/tenant/context';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { sendEmail, appOrigin } from '@/lib/notifications/email';
import { checkSlug } from '@/lib/onboarding/slug';
import { createOrganization, type ProvisionedOrganization } from '@/lib/onboarding/provision';
import type { QueryRunner } from '@/lib/db/client';

/** How long a verification link lives. Long enough to survive a lunch break. */
export const SIGNUP_TTL_MINUTES = 60;

export type SignupErrorCode =
  | 'EMAIL_REQUIRED'
  | 'EMAIL_SHAPE'
  | 'NAME_REQUIRED'
  | 'SLUG_UNUSABLE'
  | 'TOKEN_UNKNOWN';

export class SignupError extends DomainError {
  constructor(
    message: string,
    readonly code: SignupErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'SignupError';
  }
}

const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

/**
 * Deliberately permissive. An address is verified by SENDING TO IT, which is the
 * only check that means anything; a regex here exists to catch a typo before the
 * mail bounces, not to adjudicate RFC 5322 — every strict e-mail regex ever
 * written rejects somebody's real address.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export interface StartedSignup {
  signupId: string;
  /** The value that goes in the link. Never stored; returned once. */
  token: string;
  expiresAt: Date;
  /** True when this replaced the token on an existing live signup. */
  resent: boolean;
}

/**
 * Record a signup and mint its token. Does not send anything — `startSignup`
 * below is the one that also mails, and this is separated so a test can assert
 * the row without a transport.
 */
export async function recordSignup(input: {
  email: string;
  organizationName: string;
  slug: string;
}): Promise<StartedSignup> {
  const email = input.email.trim();
  const organizationName = input.organizationName.trim();
  const slug = input.slug.trim().toLowerCase();

  if (email === '') throw new SignupError('email is required', 'EMAIL_REQUIRED', 'SIGNUP_EMAIL');
  if (!EMAIL_SHAPE.test(email)) {
    throw new SignupError(`${email} is not an email address`, 'EMAIL_SHAPE', 'SIGNUP_EMAIL');
  }
  if (organizationName === '') {
    throw new SignupError('organization name is required', 'NAME_REQUIRED', 'ORG_NAME_REQUIRED');
  }
  const refusal = checkSlug(slug);
  if (refusal !== null) {
    throw new SignupError(
      `slug ${JSON.stringify(slug)} is not usable: ${refusal}`,
      'SLUG_UNUSABLE',
      refusal === 'RESERVED' ? 'ORG_SLUG_RESERVED' : 'ORG_SLUG_SHAPE',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  return withSignupContext(async (tx) => {
    // `ON CONFLICT … DO UPDATE` on the partial unique index: asking again is a
    // RESEND. The old token stops working the moment the new one is written,
    // which is the behaviour somebody who clicked "resend" expects and the
    // opposite of what two rows would give them.
    const r = await tx.query(
      `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 || ' minutes')::interval)
       ON CONFLICT (lower(email)) WHERE consumed_at IS NULL
       DO UPDATE SET token_hash        = EXCLUDED.token_hash,
                     expires_at        = EXCLUDED.expires_at,
                     organization_name = EXCLUDED.organization_name,
                     slug              = EXCLUDED.slug,
                     updated_at        = clock_timestamp()
       RETURNING id, expires_at, (xmax <> 0) AS resent`,
      [email, organizationName, slug, tokenHash, String(SIGNUP_TTL_MINUTES)],
    );
    const row = r.rows[0] as { id: string; expires_at: Date; resent: boolean };
    return { signupId: row.id, token, expiresAt: row.expires_at, resent: row.resent };
  });
}

/** Record the signup and mail the link. */
export async function startSignup(input: {
  email: string;
  organizationName: string;
  slug: string;
}): Promise<StartedSignup> {
  const started = await recordSignup(input);
  const origin = appOrigin();
  const link = `${origin ?? ''}/signup/verify?token=${encodeURIComponent(started.token)}`;
  await sendEmail({
    to: input.email.trim(),
    subject: `Confirm your email to finish setting up ${input.organizationName.trim()}`,
    text:
      `Confirm this address to create ${input.organizationName.trim()} on VeloExpense:\n\n${link}\n\n` +
      `The link expires in ${SIGNUP_TTL_MINUTES} minutes. If you did not ask for this, ignore ` +
      `this message — nothing has been created.`,
    // Plain and unbranded ON PURPOSE: there is no tenant yet, so there is no
    // brand to apply. `lib/notifications/email-shell.ts` renders a TENANT's
    // colours and logo, and using it here would put Velotech's defaults on a
    // message about somebody else's company.
    html:
      `<p>Confirm this address to create <strong>${escapeHtml(input.organizationName.trim())}</strong> on VeloExpense:</p>` +
      `<p><a href="${escapeHtml(link)}">Confirm my email</a></p>` +
      `<p>The link expires in ${SIGNUP_TTL_MINUTES} minutes. If you did not ask for this, ignore this message — nothing has been created.</p>`,
  });
  return started;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface VerifiedSignup extends ProvisionedOrganization {
  email: string;
}

/**
 * Consume a token and create the organization.
 *
 * THE CONSUMPTION AND THE CREATION ARE ONE TRANSACTION, for the reason VX5-1's
 * header gives about its own two inserts: consume-then-create in two
 * transactions burns a token whose organization was never made, leaving somebody
 * holding a dead link and no tenant. Consume LAST, after the organization
 * exists, and roll the consumption back with it if it does not.
 *
 * `0035`'s `signup_consume` policy only matches a live row, so a second click
 * cannot consume what the first one took — and the `rowCount !== 1` below is the
 * second of the two guards a credential deserves.
 */
export async function verifySignup(rawToken: string): Promise<VerifiedSignup> {
  const tokenHash = hashToken(rawToken.trim());

  const found = await withSignupContext(async (tx) => {
    // Unknown, consumed and expired are ONE case here — the row is not visible,
    // because `signup_read_live` says so. There is no `if` to forget.
    const r = await tx.query(
      'SELECT id, email, organization_name, slug FROM signup WHERE token_hash = $1',
      [tokenHash],
    );
    return r.rows[0] as
      | { id: string; email: string; organization_name: string; slug: string }
      | undefined;
  });
  if (!found) {
    throw new SignupError(
      'signup token is unknown, already used, or expired',
      'TOKEN_UNKNOWN',
      'SIGNUP_LINK_DEAD',
    );
  }

  const org = await createOrganization({
    name: found.organization_name,
    slug: found.slug,
    adminEmail: found.email,
  });

  const consumed = await withSignupConsume((tx) => markConsumed(tx, found.id, org.organizationId));
  if (!consumed) {
    // The policy matched a live row a moment ago and does not now, which means
    // somebody else consumed it in between. The organization they created is
    // theirs; this one is a duplicate and must not be handed over.
    throw new SignupError(
      'signup token was consumed by another request',
      'TOKEN_UNKNOWN',
      'SIGNUP_LINK_DEAD',
    );
  }
  return { ...org, email: found.email };
}

/**
 * The conditional write. `rowCount !== 1` is what says somebody got there first.
 *
 * Runs under `app.signup_consume` rather than `app.signup_task`, and that is not
 * tidiness: under the narrow gate this UPDATE is IMPOSSIBLE, because setting
 * `consumed_at` takes the row out of the live view and Postgres will not let an
 * UPDATE move a row out of view. See `0035`'s header.
 *
 * ── `AND consumed_at IS NULL` IS UNREACHABLE TODAY, AND IS KEPT ANYWAY ──────
 *
 * Said plainly because a sabotage proved it: deleting that clause fails NO test,
 * and it cannot be made to. `signup_consume`'s USING already refuses a consumed
 * row, so the policy answers first; and the clause cannot be reached through the
 * public surface either, because `verifySignup` looks the token up under the
 * NARROW gate, where a consumed row is invisible — it throws before it gets
 * here.
 *
 * Two attempts to test it in isolation were written and both were worse than
 * nothing. The first asserted that a WHERE clause written IN THE TEST filtered
 * rows, which is the "assertion whose subject swallows the failure" family this
 * codebase has a name for. The second would have meant exporting a private
 * function so a test could reach it.
 *
 * It stays because 0012's rule — two independent guards on a credential — is
 * about the day somebody simplifies the first one, and on that day this is what
 * is left. It is defence in depth with the depth honestly labelled, rather than a
 * line pretending to be load-bearing.
 */
async function markConsumed(
  tx: QueryRunner,
  signupId: string,
  organizationId: string,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE signup SET consumed_at = clock_timestamp(), organization_id = $2,
                       updated_at = clock_timestamp()
      WHERE id = $1 AND consumed_at IS NULL`,
    [signupId, organizationId],
  );
  return (r.rowCount ?? 0) === 1;
}
