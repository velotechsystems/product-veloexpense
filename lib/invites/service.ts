/**
 * VX5-3 — the invite. How anybody but the founder gets into a tenant.
 *
 * ── WHAT CHANGED, AND WHY IT IS NOT ADDITIVE ────────────────────────────────
 *
 * "Invite-only" used to describe the login page and nothing else. `resolveSsoUser`
 * signs somebody in when an `app_user` row exists for (org, verified email) and
 * refuses otherwise — so the actual grant of access was `INSERT INTO app_user`,
 * and `createEmployee` did that from an admin form with no email to the person
 * and no record that they had never arrived.
 *
 * Two doors, one of them invisible. This module is the one door, and the
 * `app_user` row is now created at ACCEPTANCE. `0036`'s header has the full
 * argument; the part that governs this file is the consequence: the directory
 * only ever contains people who have actually arrived, because `app_user` is
 * what the manager picker, the reporting line and every approval ladder read.
 *
 * ── THE TOKEN IS NOT WHAT GRANTS ACCESS ─────────────────────────────────────
 *
 * Read `acceptForVerifiedEmail` before believing otherwise. The mailed link
 * carries the tenant and is revocable and expiring; the GRANT is bound to the
 * OAuth-verified email, so a forwarded link is useless to whoever it was
 * forwarded to. That is stronger than `0035`'s signup token and it can be,
 * because an invite has both a tenant and an identity provider in the picture
 * and a signup has neither.
 *
 * ── THE EMAIL IS BRANDED, WHICH SIGNUP'S DELIBERATELY IS NOT ────────────────
 *
 * `lib/onboarding/signup.ts` sends plain, unbranded mail because there is no
 * tenant yet and using the shell would put Velotech's defaults on a message
 * about somebody else's company. An invite HAS a tenant: it is minted by an
 * admin inside `withOrg`, so `getBranding(tx)` is right there, and a message
 * asking somebody to join Acme should look like it came from Acme.
 *
 * It still cannot use the notification OUTBOX, and for a reason worth stating
 * because it looks like it should: `notification_delivery` requires a
 * `notification`, which requires a `recipient_id` in `app_user`. The whole point
 * of this design is that no such row exists yet. So `sendEmail` directly, with
 * signup's cost accepted for signup's reason — no automatic retry, compensated
 * by resend being a button rather than a background job.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withInviteLookup, withOrg } from '@/lib/tenant/context';
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { getBranding } from '@/lib/branding/service';
import { sendEmail, appOrigin } from '@/lib/notifications/email';
import { emailShell } from '@/lib/notifications/email-shell';
import {
  EMPLOYEE_ROLES,
  EmployeeError,
  createEmployee,
  type EmployeeRole,
} from '@/lib/employees/service';

/** How long an invitation lives. Days, not minutes: unlike a signup confirmation,
 *  the person was not standing at a form when it was sent. */
export const INVITE_TTL_DAYS = 14;

export type InviteErrorCode =
  | 'EMAIL_REQUIRED'
  | 'EMAIL_SHAPE'
  | 'ROLE_UNKNOWN'
  | 'ALREADY_A_MEMBER'
  | 'ALREADY_INVITED'
  | 'NOT_FOUND'
  | 'TOKEN_UNKNOWN';

export class InviteError extends DomainError {
  constructor(
    message: string,
    readonly code: InviteErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'InviteError';
  }
}

/**
 * PE-9, and this copy has the guard the other seventeen do not.
 *
 * Every other service in this codebase writes
 * `current_setting('app.current_org', true)::uuid` without `NULLIF`. That is on
 * the board as a known defect: once the GUC has been set on a pooled connection
 * Postgres returns `''` afterwards rather than NULL, and `''::uuid` is a type
 * ERROR rather than a row that does not match. Every one of them is reached
 * through a path that has a tenant, so none of them is a leak — but this module
 * is reached from `resolveSsoUser`, which is the closest thing this product has
 * to a caller with no tenant. Adding an eighteenth copy of the defect here would
 * have been careless in the one place it is likeliest to matter.
 */
const ORG = "NULLIF(current_setting('app.current_org', true), '')::uuid";

const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

/** As `lib/onboarding/signup.ts`: an address is verified by SENDING TO IT. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/** What an admin fills in. Everything but the address and the role is optional,
 *  and all of it is what the `app_user` row will be made from at acceptance. */
export interface NewInvite {
  email: string;
  role: EmployeeRole;
  displayName?: string | null;
  title?: string | null;
  managerId?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  legalEntityId?: string | null;
}

export interface IssuedInvite {
  inviteId: string;
  /** The value that goes in the link. Never stored; returned once. */
  token: string;
  expiresAt: Date;
  /** True when this replaced the token on an existing live invite. */
  resent: boolean;
}

export interface InviteRow {
  id: string;
  email: string;
  role: EmployeeRole;
  displayName: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/* ── issuing ───────────────────────────────────────────────────────────────── */

/**
 * Mint an invitation, or refresh the live one for that address.
 *
 * Runs inside a tenant, as an admin. `ON CONFLICT` on the partial unique index
 * makes asking twice a RESEND rather than a second invitation — `0035`'s rule,
 * for the same reason: the person expects the newest link to work and the older
 * one not to.
 *
 * Refuses an address that is ALREADY A MEMBER before it writes anything. The
 * check is `lower(email)`, because `app_user`'s own UNIQUE is case-sensitive and
 * every other membership check in this codebase already works around that.
 */
export async function issueInvite(
  tx: QueryRunner,
  actor: AuditActor,
  input: NewInvite,
): Promise<IssuedInvite> {
  const email = input.email.trim();
  if (email === '') {
    throw new InviteError('email is required', 'EMAIL_REQUIRED', 'INVITE_EMAIL');
  }
  if (!EMAIL_SHAPE.test(email)) {
    throw new InviteError(`${email} is not an email address`, 'EMAIL_SHAPE', 'INVITE_EMAIL');
  }
  if (!(EMPLOYEE_ROLES as readonly string[]).includes(input.role)) {
    throw new InviteError(`unknown role ${input.role}`, 'ROLE_UNKNOWN', 'ROLE_UNKNOWN');
  }

  const member = await tx.query(
    'SELECT id FROM app_user WHERE lower(email) = lower($1) AND deleted_at IS NULL',
    [email],
  );
  if (member.rows.length > 0) {
    throw new InviteError(
      `${email} is already a member of this organization`,
      'ALREADY_A_MEMBER',
      'INVITE_ALREADY_MEMBER',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const r = await tx.query(
    `INSERT INTO invite (organization_id, email, token_hash, role, display_name, title,
                         manager_id, department_id, business_unit_id, legal_entity_id,
                         invited_by_id, expires_at)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             clock_timestamp() + ($11 || ' days')::interval)
     ON CONFLICT (organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL
     DO UPDATE SET token_hash       = EXCLUDED.token_hash,
                   expires_at       = EXCLUDED.expires_at,
                   role             = EXCLUDED.role,
                   display_name     = EXCLUDED.display_name,
                   title            = EXCLUDED.title,
                   manager_id       = EXCLUDED.manager_id,
                   department_id    = EXCLUDED.department_id,
                   business_unit_id = EXCLUDED.business_unit_id,
                   legal_entity_id  = EXCLUDED.legal_entity_id,
                   invited_by_id    = EXCLUDED.invited_by_id,
                   updated_at       = clock_timestamp()
     RETURNING id, expires_at, (xmax <> 0) AS resent`,
    [
      email,
      hashToken(token),
      input.role,
      input.displayName?.trim() || null,
      input.title?.trim() || null,
      input.managerId ?? null,
      input.departmentId ?? null,
      input.businessUnitId ?? null,
      input.legalEntityId ?? null,
      actor.id,
      String(INVITE_TTL_DAYS),
    ],
  );
  const row = r.rows[0] as { id: string; expires_at: Date; resent: boolean };

  await auditAppend(tx, actor, {
    action: row.resent ? 'INVITE_RESENT' : 'INVITE_SENT',
    entityType: 'invite',
    entityId: row.id,
    details: { email, role: input.role },
  });

  return { inviteId: row.id, token, expiresAt: row.expires_at, resent: row.resent };
}

/** Mint and mail, in the tenant's own colours. */
export async function sendInvite(
  tx: QueryRunner,
  actor: AuditActor,
  input: NewInvite,
): Promise<IssuedInvite> {
  const issued = await issueInvite(tx, actor, input);
  const branding = await getBranding(tx);
  const origin = appOrigin();
  const link = `${origin ?? ''}/invite/accept?token=${encodeURIComponent(issued.token)}`;

  await sendEmail({
    to: input.email.trim(),
    subject: `${branding.name} has invited you to VeloExpense`,
    text:
      `${actor.name} has invited you to join ${branding.name} on VeloExpense.\n\n${link}\n\n` +
      `Sign in with the work account for this address — the invitation only works for it. ` +
      `The link expires in ${INVITE_TTL_DAYS} days.`,
    html: emailShell({
      organizationName: branding.name,
      brandColor: branding.brandColor,
      bodyHtml: `<p>${escapeHtml(actor.name)} has invited you to join <strong>${escapeHtml(
        branding.name,
      )}</strong> on VeloExpense.</p>`,
      cta: { label: 'Accept the invitation', url: link },
      footnote:
        `Sign in with the work account for this address — the invitation only works for it. ` +
        `The link expires in ${INVITE_TTL_DAYS} days.`,
    }),
  });
  return issued;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── administering ─────────────────────────────────────────────────────────── */

/** The pending list an admin sees. Live only — accepted invites are people now,
 *  and revoked ones are a decision already taken. */
export async function listLiveInvites(tx: QueryRunner): Promise<InviteRow[]> {
  const r = await tx.query(
    `SELECT i.id, i.email, i.role, i.display_name, i.expires_at, i.created_at,
            COALESCE(u.display_name, u.email) AS invited_by_name
       FROM invite i
       LEFT JOIN app_user u ON u.id = i.invited_by_id
      WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > clock_timestamp()
      ORDER BY i.created_at DESC`,
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    email: row.email as string,
    role: row.role as EmployeeRole,
    displayName: (row.display_name as string | null) ?? null,
    invitedByName: (row.invited_by_name as string | null) ?? null,
    expiresAt: row.expires_at as Date,
    createdAt: row.created_at as Date,
  }));
}

/**
 * Withdraw a live invitation.
 *
 * The conditional write, as everywhere else a race matters: `rowCount !== 1`
 * says somebody accepted it between the admin reading the list and pressing the
 * button, and the correct answer then is that revoking failed — not that it
 * succeeded and left a member behind.
 */
export async function revokeInvite(
  tx: QueryRunner,
  actor: AuditActor,
  inviteId: string,
): Promise<void> {
  const r = await tx.query(
    `UPDATE invite SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING email`,
    [inviteId],
  );
  if (r.rowCount !== 1) {
    throw new InviteError(
      `invite ${inviteId} is not live, so it cannot be revoked`,
      'NOT_FOUND',
      'INVITE_NOT_LIVE',
    );
  }
  await auditAppend(tx, actor, {
    action: 'INVITE_REVOKED',
    entityType: 'invite',
    entityId: inviteId,
    details: { email: r.rows[0].email as string },
  });
}

/* ── accepting ─────────────────────────────────────────────────────────────── */

/**
 * Which tenant is this token in?
 *
 * `action_token`'s `resolveTokenTenant` with its rule repeated verbatim, because
 * it is the rule: **THE CALLER MUST TAKE NOTHING FROM THIS BUT THE TENANT.** The
 * hatch it runs under can see live invites in every organization, so anything
 * else read here would be read across the tenant boundary. The organization id
 * is the one fact that is safe, because the caller's next move is to switch into
 * that tenant and ask again under `tenant_isolation`.
 *
 * `null` for unknown, expired, revoked and already-accepted alike — the policy
 * makes them one case, so there is no `if` to forget.
 */
export async function resolveInviteTenant(
  rawToken: string,
): Promise<{ organizationId: string; organizationSlug: string } | null> {
  const tokenHash = hashToken(rawToken.trim());
  return withInviteLookup(async (tx) => {
    const r = await tx.query(
      `SELECT i.organization_id, o.slug
         FROM invite i JOIN organization o ON o.id = i.organization_id
        WHERE i.token_hash = $1 AND o.status = 'active'`,
      [tokenHash],
    );
    if (r.rows.length === 0) return null;
    return {
      organizationId: r.rows[0].organization_id as string,
      organizationSlug: r.rows[0].slug as string,
    };
  });
}

/** What the acceptance page may show before anybody signs in. */
export interface PendingInvite {
  organizationName: string;
  organizationSlug: string;
  /** Masked — see `maskEmail`. */
  emailHint: string;
  role: EmployeeRole;
}

/**
 * Read an invitation for display, without accepting it.
 *
 * The address is MASKED. The page has to say which mailbox the invitation is
 * for — otherwise somebody with two work accounts cannot tell which one to sign
 * in with, which is the single most likely way this flow fails — but a link
 * pasted into a group chat should not hand a full address to everybody who can
 * see it. `a••@acme.com` answers the question without being a disclosure.
 */
export async function readPendingInvite(rawToken: string): Promise<PendingInvite | null> {
  const tenant = await resolveInviteTenant(rawToken);
  if (tenant === null) return null;
  const tokenHash = hashToken(rawToken.trim());
  return withOrg(tenant.organizationId, async (tx) => {
    const r = await tx.query(
      `SELECT i.email, i.role, o.name
         FROM invite i JOIN organization o ON o.id = i.organization_id
        WHERE i.token_hash = $1
          AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > clock_timestamp()`,
      [tokenHash],
    );
    if (r.rows.length === 0) return null;
    return {
      organizationName: r.rows[0].name as string,
      organizationSlug: tenant.organizationSlug,
      emailHint: maskEmail(r.rows[0].email as string),
      role: r.rows[0].role as EmployeeRole,
    };
  });
}

/**
 * `alice@acme.com` → `a••••@acme.com`. The domain stays: it is what tells
 * somebody which of their accounts this is, and it is not the secret half.
 *
 * A FIXED number of dots, never one per hidden character. The first version
 * scaled with the local part and the suite caught it: `bob@acme.test` masked to
 * thirteen characters and `barbara@acme.test` to fifteen, so the mask published
 * the length of what it was hiding. That is a small leak and an easy one to
 * write, because "one dot per character" reads as the more honest choice.
 */
export function maskEmail(email: string): string {
  const MASK = '••••';
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 0) return `${MASK}${domain}`;
  return `${local[0]}${MASK}${domain}`;
}

export interface AcceptedInvite {
  userId: string;
  organizationId: string;
  email: string;
  role: EmployeeRole;
}

/**
 * THE GRANT. Turn a live invitation into a member, for an email an identity
 * provider has just verified.
 *
 * ── WHAT THIS TAKES AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 * It takes an ORGANIZATION and a VERIFIED EMAIL. It does not take a token, and
 * that is the design rather than an omission.
 *
 * The mailed link is a convenience: it carries the tenant so nobody has to be
 * told to type a web address, and it is revocable and expiring. What makes
 * somebody a member is that Google or Microsoft has just asserted they hold the
 * address an admin invited. So a link forwarded to a colleague, pasted into a
 * chat, or read out of somebody else's mailbox grants nothing — the holder would
 * have to control the invited mailbox as an SSO identity, which is the same
 * thing as being the invited person.
 *
 * It also means the flow works without the link at all: somebody who was invited
 * can sign in at `/login` with their organization's web address and it will
 * work, because the invitation is to an ADDRESS and OAuth proves the address.
 * That is a feature — "I lost the email" stops being a support ticket — and it
 * is only safe because of the paragraph above.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 *
 * The member and the acceptance are written together, for VX5-1's reason about
 * its own two inserts: accept-then-create leaves a burnt invitation and no
 * member, and create-then-accept leaves a member who can be created again. The
 * conditional write on `accepted_at` is what makes a second concurrent sign-in
 * lose rather than make a second row.
 */
export async function acceptForVerifiedEmail(
  organizationId: string,
  verifiedEmail: string,
): Promise<AcceptedInvite | null> {
  const email = verifiedEmail.trim();
  try {
    return await acceptOnce(organizationId, email);
  } catch (err) {
    /* ── THE SAME PERSON, TWICE AT ONCE ─────────────────────────────────────
     *
     * A double-click on "Sign in to accept", or two tabs, is two concurrent
     * sign-ins for one address. Both find the invitation live, both insert, and
     * one loses on `app_user`'s UNIQUE — as `duplicate key … 23505`, a raw
     * `DatabaseError`, from inside NextAuth's `signIn` callback, where a throw
     * becomes an opaque failure page.
     *
     * Found by running the race rather than by reading the code, and worth
     * fixing rather than logging: the correct outcome for somebody signing in
     * twice is that they are signed in, not that one of the tabs shows an error
     * about a database constraint. The member exists now — the other
     * transaction just made it — so read it and hand it back.
     *
     * Deliberately narrow. Anything that is not a uniqueness conflict on the
     * address rethrows, because "retry once and see" is how a real failure
     * becomes a silent one.
     *
     * WHICH OF THE TWO GUARDS IS LOAD-BEARING, measured rather than assumed: a
     * sabotage that removed the `isDuplicateMember` narrowing entirely failed no
     * test, and it is right that it did — the retry can only RETURN something it
     * actually found, so a genuine failure still rethrows at the empty read
     * below. The narrowing is the belt; `member.rows.length === 0` is the
     * braces, and the braces are what the suite pins. Both stay: catching only
     * the error you mean is how the next reader knows what this is for.
     */
    if (!isDuplicateMember(err)) throw err;
    const member = await withOrg(organizationId, (tx) =>
      tx.query(
        `SELECT id, email, role FROM app_user
          WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
        [email],
      ),
    );
    if (member.rows.length === 0) throw err;
    const row = member.rows[0] as { id: string; email: string; role: string };
    return {
      userId: row.id,
      organizationId,
      email: row.email,
      role: row.role as EmployeeRole,
    };
  }
}

/** 23505 from Postgres, or `createEmployee`'s own pre-check losing the same race. */
function isDuplicateMember(err: unknown): boolean {
  if (err instanceof EmployeeError && err.code === 'EMAIL_TAKEN') return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

async function acceptOnce(
  organizationId: string,
  email: string,
): Promise<AcceptedInvite | null> {
  return withOrg(organizationId, async (tx) => {
    const found = await tx.query(
      `SELECT id, email, role, display_name, title, manager_id, department_id,
              business_unit_id, legal_entity_id
         FROM invite
        WHERE lower(email) = lower($1)
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [email],
    );
    if (found.rows.length === 0) return null;
    const invite = found.rows[0] as Record<string, unknown>;

    // `createEmployee`, not a second INSERT of my own. It is the one place that
    // knows how to make a member — the role and status CHECKs, the
    // manager-in-this-tenant check, and the case-insensitive EMAIL_TAKEN guard
    // that `app_user`'s case-SENSITIVE UNIQUE does not give us. Writing the
    // INSERT again here would have been a second definition of what a member is,
    // and the two would have drifted the first time one of those rules changed.
    const created = await createEmployee(tx, {
      // The INVITED spelling, not the one the provider handed back. They differ
      // only in case where they differ at all, and the admin's is the one that
      // appears in the directory they are looking at.
      email: invite.email as string,
      displayName: (invite.display_name as string | null) ?? null,
      title: (invite.title as string | null) ?? null,
      role: invite.role as EmployeeRole,
      managerId: (invite.manager_id as string | null) ?? null,
      departmentId: (invite.department_id as string | null) ?? null,
      businessUnitId: (invite.business_unit_id as string | null) ?? null,
      legalEntityId: (invite.legal_entity_id as string | null) ?? null,
    });
    const userId = created.id;

    const consumed = await tx.query(
      `UPDATE invite SET accepted_at = clock_timestamp(), accepted_user_id = $2,
                         updated_at = clock_timestamp()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [invite.id as string, userId],
    );
    if (consumed.rowCount !== 1) {
      /* ── UNREACHABLE TODAY, AND KEPT — with the depth honestly labelled ────
       *
       * A sabotage disabled this branch and failed NO test, which is the finding
       * rather than a gap in the suite. Two concurrent acceptances were run to
       * see why, and the loser never gets here: `createEmployee` above hits
       * `app_user`'s `UNIQUE (organization_id, email)` and raises 23505 first, so
       * the race is decided one statement earlier than this line assumes.
       *
       * `lib/onboarding/signup.ts` reached the same place with `markConsumed`'s
       * `AND consumed_at IS NULL`, and the answer is the same: this is what is
       * left on the day somebody relaxes the constraint above it, and a rollback
       * is still the correct response to losing. Two independent guards on a
       * credential is the right number; labelling which one is load-bearing is
       * how the next reader avoids trusting the wrong one.
       */
      throw new InviteError(
        'invitation was accepted by another request',
        'TOKEN_UNKNOWN',
        'INVITE_LINK_DEAD',
      );
    }

    await auditAppend(
      tx,
      // `id` ONLY, not id-and-email: `lib/audit/service.ts` requires exactly one
      // of them, because they mean two different kinds of actor (an internal
      // user, or an external approver identified by address alone). The person
      // accepting became an internal user one statement ago, so they are the
      // first kind. Caught by the suite on the first run of this file.
      {
        id: userId,
        name: (invite.display_name as string | null) ?? (invite.email as string),
        role: invite.role as string,
      },
      {
        action: 'INVITE_ACCEPTED',
        entityType: 'invite',
        entityId: invite.id as string,
        details: { email: invite.email as string, role: invite.role as string },
      },
    );

    return {
      userId,
      organizationId,
      email: invite.email as string,
      role: invite.role as EmployeeRole,
    };
  });
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Exported because `test/invites.db.test.ts` asserts it, and present at all for
 * `action_token`'s reason: the hash lookup is by index, but anywhere a hash is
 * compared in application code, a timing-variable comparison is a side channel.
 */
export function sameTokenHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
