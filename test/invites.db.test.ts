/**
 * VX5-3 — the invite, against a real Postgres.
 *
 * What has to be proved here is the claim the whole design rests on: **the
 * token is not what grants access.** Everything else — the TTL, the resend, the
 * revoke — is ordinary, and none of it matters if a stray link turns out to be a
 * way into somebody's tenant.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { withOrg, withoutOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import {
  issueInvite,
  sendInvite,
  listLiveInvites,
  revokeInvite,
  resolveInviteTenant,
  readPendingInvite,
  readInviteLogo,
  acceptForVerifiedEmail,
  maskEmail,
  InviteError,
  INVITE_TTL_DAYS,
} from '@/lib/invites/service';
import { resolveSsoUser, onSsoDenied } from '@/lib/auth/resolve-sso-user';
import type { AuditActor } from '@/lib/audit/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let orgSlug: string;
let adminUserId: string;
let ACTOR: AuditActor;

const INVITEE = 'newcomer@acme.test';

beforeEach(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  const org = await createOrganization({
    name: 'Acme',
    slug: 'acme',
    adminEmail: 'founder@acme.test',
    adminName: 'Founder',
  });
  orgId = org.organizationId;
  orgSlug = org.slug;
  adminUserId = org.adminUserId;
  ACTOR = { id: adminUserId, name: 'Founder', role: 'System Administrator' };
});

afterAll(async () => {
  await admin.end();
});

const issue = (overrides: Partial<Parameters<typeof issueInvite>[2]> = {}) =>
  withOrg(orgId, (tx) =>
    issueInvite(tx, ACTOR, { email: INVITEE, roleId: EMPLOYEE, ...overrides }),
  );

/** w4-10b: the tenant's system roles the cases hand out (0068). */
const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';
const EXECUTIVE = '019e3000-0000-7000-8000-000000000007';

const inviteRow = async () =>
  (await admin.query('SELECT * FROM invite ORDER BY created_at DESC LIMIT 1')).rows[0];

describe('issuing an invitation', () => {
  it('stores ONLY the hash of the token, and creates no member', async () => {
    const issued = await issue();
    const row = await inviteRow();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(issued.token);
    expect(JSON.stringify(row)).not.toContain(issued.token);

    const members = await admin.query('SELECT email FROM app_user');
    expect(members.rows.map((r) => r.email)).toEqual(['founder@acme.test']);
  });

  it('expires within the stated window', async () => {
    const issued = await issue();
    const ms = issued.expiresAt.getTime() - Date.now();
    expect(ms).toBeGreaterThan((INVITE_TTL_DAYS - 1) * 86_400_000);
    expect(ms).toBeLessThanOrEqual(INVITE_TTL_DAYS * 86_400_000 + 60_000);
  });

  it('asking again resends: one row, and the first token is dead', async () => {
    const first = await issue();
    const second = await issue({ roleId: EXECUTIVE });
    expect(second.resent).toBe(true);

    const rows = await admin.query('SELECT count(*)::int AS n FROM invite');
    expect(rows.rows[0].n).toBe(1);
    expect(await resolveInviteTenant(first.token)).toBeNull();
    expect(await resolveInviteTenant(second.token)).not.toBeNull();
    // And the resend carries the NEW terms, not the old ones.
    expect((await inviteRow()).role_id).toBe(EXECUTIVE);
  });

  it('treats the address case-insensitively, or the limit would not be one', async () => {
    await issue();
    await issue({ email: INVITEE.toUpperCase() });
    const rows = await admin.query('SELECT count(*)::int AS n FROM invite');
    expect(rows.rows[0].n).toBe(1);
  });

  it('refuses somebody who is already a member', async () => {
    await expect(issue({ email: 'founder@acme.test' })).rejects.toMatchObject({
      code: 'ALREADY_A_MEMBER',
    });
    // Case-insensitively, because `app_user`'s own UNIQUE is not.
    await expect(issue({ email: 'FOUNDER@acme.test' })).rejects.toMatchObject({
      code: 'ALREADY_A_MEMBER',
    });
  });

  it('refuses a malformed address and an unknown role before writing anything', async () => {
    await expect(issue({ email: 'not-an-address' })).rejects.toBeInstanceOf(InviteError);
    await expect(
      issue({ roleId: 'SUPERUSER' }),
    ).rejects.toMatchObject({ code: 'ROLE_UNKNOWN' });
    // w4-10b: a well-formed id that is no role here, and a role that is deactivated.
    await expect(issue({ roleId: '019e3000-0000-7000-8000-0000000000ff' })).rejects.toMatchObject({
      code: 'ROLE_UNKNOWN',
    });
    await withOrg(orgId, (tx) => tx.query(`UPDATE role SET active = false WHERE id = $1`, [EXECUTIVE]));
    try {
      await expect(issue({ roleId: EXECUTIVE })).rejects.toMatchObject({ code: 'ROLE_UNKNOWN' });
    } finally {
      await withOrg(orgId, (tx) => tx.query(`UPDATE role SET active = true WHERE id = $1`, [EXECUTIVE]));
    }
    const rows = await admin.query('SELECT count(*)::int AS n FROM invite');
    expect(rows.rows[0].n).toBe(0);
  });

  it('records both ends in the audit log, and tells them apart', async () => {
    await issue();
    await issue();
    const entries = await admin.query(
      "SELECT action FROM audit_entry WHERE action LIKE 'INVITE%' ORDER BY sequence",
    );
    expect(entries.rows.map((r) => r.action)).toEqual(['INVITE_SENT', 'INVITE_RESENT']);
  });
});

describe('the invitation email', () => {
  it('is branded with the TENANT, which the signup email deliberately is not', async () => {
    await withOrg(orgId, (tx) =>
      tx.query("UPDATE organization SET brand_color = '#663399' WHERE id = $1", [orgId]),
    );
    const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
    const email = await import('@/lib/notifications/email');
    const spy = vi.spyOn(email, 'sendEmail').mockImplementation(async (msg) => {
      sent.push(msg as (typeof sent)[number]);
    });
    try {
      await withOrg(orgId, (tx) => sendInvite(tx, ACTOR, { email: INVITEE, roleId: EMPLOYEE }));
    } finally {
      spy.mockRestore();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(INVITEE);
    expect(sent[0].subject).toContain('Acme');
    expect(sent[0].html).toContain('663399');
    // The link, and the token in it — the ONE place the raw value exists.
    expect(sent[0].text).toMatch(/\/invite\/accept\?token=[\w-]+/);
  });
});

describe('the hatch, and what the acceptance page may read', () => {
  it('resolves the tenant from a token and nothing else', async () => {
    const issued = await issue();
    const tenant = await resolveInviteTenant(issued.token);
    expect(tenant).toEqual({ organizationId: orgId, organizationSlug: orgSlug });
    // The contract is that a caller takes only the tenant. What can be asserted
    // is that nothing else comes back to take.
    expect(Object.keys(tenant!)).toEqual(['organizationId', 'organizationSlug']);
  });

  it('shows the organization and a MASKED address, never the full one', async () => {
    const issued = await issue();
    const pending = await readPendingInvite(issued.token);
    expect(pending).toEqual({
      organizationName: 'Acme',
      organizationSlug: 'acme',
      emailHint: 'n••••@acme.test',
      roleName: 'Employee',
      // VX5-6 — branding, for a page a live token is required to reach.
      brandColor: null,
      logoSrc: null,
    });
    expect(JSON.stringify(pending)).not.toContain(INVITEE);
  });

  /* ── VX5-6: the tenant's colours, and the one thing that gates them ────────
   *
   * `/login` is deliberately NOT branded (BR-4: an unauthenticated oracle for
   * who our customers are). This page is, because a live invitation token is a
   * credential rather than a guess — so the tests that matter are the ones where
   * the token STOPS being live. */
  it('carries the tenant’s colour and a logo URL that names the token', async () => {
    await admin.query(
      `UPDATE organization
          SET brand_color = '#663399', logo_bytes = $1, logo_mime = 'image/png',
              logo_updated_at = clock_timestamp()
        WHERE id = $2`,
      [Buffer.from('89504e470d0a1a0a', 'hex'), orgId],
    );
    const issued = await issue();
    const pending = await readPendingInvite(issued.token);
    expect(pending!.brandColor).toBe('#663399');
    expect(pending!.logoSrc).toContain('/api/invite/logo?token=');
    expect(pending!.logoSrc).toContain(encodeURIComponent(issued.token));
    // A `?v=` stamp, so a new logo is a new URL rather than a staleness window.
    expect(pending!.logoSrc).toMatch(/&v=\d+$/);
  });

  it('serves the logo bytes to a live invitation and to nothing else', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await admin.query(
      `UPDATE organization
          SET logo_bytes = $1, logo_mime = 'image/png', logo_updated_at = clock_timestamp()
        WHERE id = $2`,
      [png, orgId],
    );
    const live = await issue();
    const served = await readInviteLogo(live.token);
    expect(served).not.toBeNull();
    expect(served!.mime).toBe('image/png');
    expect(Buffer.from(served!.bytes).equals(png)).toBe(true);

    // A token nobody issued.
    expect(await readInviteLogo('not-a-token')).toBeNull();

    // WITHDRAWN — the bytes stop at the same moment the invitation does, because
    // both read through the same live-only policy rather than through two checks
    // that could disagree.
    await withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, live.inviteId));
    expect(await readInviteLogo(live.token)).toBeNull();

    // EXPIRED.
    await admin.query('DELETE FROM invite');
    const expiring = await issue();
    await admin.query(
      "UPDATE invite SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [expiring.inviteId],
    );
    expect(await readInviteLogo(expiring.token)).toBeNull();

    // ACCEPTED — a spent token is not a way to keep reading a customer's mark.
    await admin.query('DELETE FROM invite');
    const spent = await issue();
    await acceptForVerifiedEmail(orgId, INVITEE);
    expect(await readInviteLogo(spent.token)).toBeNull();
  });

  it('has no logo URL when the tenant has uploaded nothing', async () => {
    const issued = await issue();
    expect((await readPendingInvite(issued.token))!.logoSrc).toBeNull();
    expect(await readInviteLogo(issued.token)).toBeNull();
  });

  it('masks a one-character local part without revealing it is one character', () => {
    expect(maskEmail('a@acme.test')).toBe('a••••@acme.test');
    expect(maskEmail('alexandra@acme.test')).toBe('a••••@acme.test');
    // Same visible shape for two very different addresses — the point.
    expect(maskEmail('bob@acme.test').length).toBe(maskEmail('barbara@acme.test').length);
  });

  it('is null for unknown, revoked, expired and accepted alike', async () => {
    expect(await readPendingInvite('nobody-issued-this')).toBeNull();

    const revoked = await issue();
    await withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, (await1(revoked)).inviteId));
    expect(await readPendingInvite(revoked.token)).toBeNull();

    await admin.query('DELETE FROM invite');
    const expired = await issue();
    await admin.query(
      "UPDATE invite SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [expired.inviteId],
    );
    expect(await readPendingInvite(expired.token)).toBeNull();

    await admin.query('DELETE FROM invite');
    const accepted = await issue();
    await acceptForVerifiedEmail(orgId, INVITEE);
    expect(await readPendingInvite(accepted.token)).toBeNull();
  });
});

/** Tiny helper so the line above reads as one expression. */
function await1<T>(v: T): T {
  return v;
}

describe('accepting — and what the token does NOT do', () => {
  it('creates the member with everything the admin filled in', async () => {
    await issue({ roleId: EXECUTIVE, displayName: 'New Comer', title: 'Controller' });
    const accepted = await acceptForVerifiedEmail(orgId, INVITEE);
    expect(accepted).toMatchObject({ email: INVITEE, roleId: EXECUTIVE });

    const row = (
      await admin.query('SELECT * FROM app_user WHERE lower(email) = lower($1)', [INVITEE])
    ).rows[0];
    expect(row.role_id).toBe(EXECUTIVE);
    expect(row.display_name).toBe('New Comer');
    expect(row.title).toBe('Controller');
    expect(row.employee_status).toBe('ACTIVE');
    expect(row.deleted_at).toBeNull();
  });

  it('is bound to the ADDRESS, not the token: a stray link grants nothing', async () => {
    const issued = await issue();
    // Somebody else holds the link and signs in with their own work account.
    expect(await acceptForVerifiedEmail(orgId, 'someone.else@acme.test')).toBeNull();
    const members = await admin.query('SELECT count(*)::int AS n FROM app_user');
    expect(members.rows[0].n).toBe(1); // the founder, alone

    // The invitation is untouched and still works for the person it was for.
    expect(await resolveInviteTenant(issued.token)).not.toBeNull();
    expect(await acceptForVerifiedEmail(orgId, INVITEE)).not.toBeNull();
  });

  it('works with NO token at all, which is the other half of the same claim', async () => {
    await issue();
    // No token is presented anywhere in this test. The invitation is to an
    // address, and the address is what an identity provider verifies.
    const accepted = await acceptForVerifiedEmail(orgId, INVITEE);
    expect(accepted).not.toBeNull();
  });

  it('matches the address case-insensitively but stores the INVITED spelling', async () => {
    await issue({ email: 'Newcomer@Acme.test' });
    const accepted = await acceptForVerifiedEmail(orgId, 'newcomer@acme.TEST');
    expect(accepted!.email).toBe('Newcomer@Acme.test');
  });

  it('a second acceptance creates nothing and no second member', async () => {
    await issue();
    expect((await acceptForVerifiedEmail(orgId, INVITEE))!.kind).toBe('ACCEPTED');
    // Not null any more, and not a second acceptance either: see the
    // ALREADY_A_MEMBER cases above.
    expect((await acceptForVerifiedEmail(orgId, INVITEE))!.kind).toBe('ALREADY_A_MEMBER');
    const members = await admin.query(
      'SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower($1)',
      [INVITEE],
    );
    expect(members.rows[0].n).toBe(1);
  });

  /* ── THE RACE, RUN RATHER THAN REASONED ABOUT ─────────────────────────────
   *
   * A double-click on "Sign in to accept", or two tabs, is two concurrent
   * sign-ins for one address. This was written because a sabotage disabling
   * `acceptOnce`'s `rowCount !== 1` guard failed NO test — and running the race
   * showed why: the loser never reaches that guard. It hits `app_user`'s
   * `UNIQUE (organization_id, email)` one statement earlier and got back a raw
   * `duplicate key … 23505`, which inside NextAuth's `signIn` callback is an
   * opaque failure page for somebody who did nothing wrong.
   *
   * What is asserted is the outcome, not the mechanism: both callers succeed,
   * they are the SAME person, and exactly one member exists.
   */
  it('two simultaneous acceptances both succeed, and exactly one of them accepts', async () => {
    /* THE FIRST VERSION OF THIS TEST WAS WRONG, AND CI SAID SO.
     *
     * It asserted both calls returned a member. That is true of ONE of the two
     * interleavings — the one where the inserts overlap and the loser is caught
     * on `app_user`'s UNIQUE. Eight consecutive local runs produced only that
     * one. CI produced the other on its first: the loser arrived strictly after
     * the winner had committed, found no live invitation, and got `null`.
     *
     * `null` was the wrong answer, so the CODE changed too — the loser now
     * reports `ALREADY_A_MEMBER`. What this test asserts is the invariant that
     * holds whichever way the race falls, which is what a concurrency test is
     * allowed to assert: both callers end up with the same member, there is one
     * member, and exactly ONE of them did the accepting. */
    await issue();
    const [a, b] = await Promise.all([
      acceptForVerifiedEmail(orgId, INVITEE),
      acceptForVerifiedEmail(orgId, INVITEE),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.userId).toBe(b!.userId);

    // One accepted; the other found itself already in. Which is which depends on
    // the schedule, and asserting that would be asserting the schedule.
    expect([a!.kind, b!.kind].sort()).toEqual(['ACCEPTED', 'ALREADY_A_MEMBER']);

    const members = await admin.query(
      'SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower($1)',
      [INVITEE],
    );
    expect(members.rows[0].n).toBe(1);
    const accepted = await admin.query(
      'SELECT count(*)::int AS n FROM invite WHERE accepted_at IS NOT NULL',
    );
    expect(accepted.rows[0].n).toBe(1);
    // And ONE audit row. The loser did nothing, so it recorded nothing — this is
    // what would fail if the recovery path ever started auditing an acceptance
    // it did not perform.
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'INVITE_ACCEPTED'",
    );
    expect(audited.rows[0].n).toBe(1);
  });

  /* The interleaving CI hit, forced rather than raced — this is the branch a
   * concurrent test can only reach by luck, and it is reachable on purpose when
   * the second call simply starts later. */
  it('a caller arriving after somebody else accepted is told they are already in', async () => {
    await issue();
    const first = await acceptForVerifiedEmail(orgId, INVITEE);
    expect(first!.kind).toBe('ACCEPTED');

    const second = await acceptForVerifiedEmail(orgId, INVITEE);
    expect(second, 'a member arriving late is not denied').not.toBeNull();
    expect(second!.kind).toBe('ALREADY_A_MEMBER');
    expect(second!.userId).toBe(first!.userId);

    // Nothing was accepted twice and nothing was audited twice.
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'INVITE_ACCEPTED'",
    );
    expect(audited.rows[0].n).toBe(1);
  });

  it('somebody who was never invited and is not a member gets nothing', async () => {
    // The recovery must not become "anybody who asks twice is let in".
    expect(await acceptForVerifiedEmail(orgId, 'stranger@acme.test')).toBeNull();
  });

  it('a DEACTIVATED member is not handed back by the recovery', async () => {
    await issue();
    const joined = await acceptForVerifiedEmail(orgId, INVITEE);
    await admin.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [
      joined!.userId,
    ]);
    expect(await acceptForVerifiedEmail(orgId, INVITEE)).toBeNull();
  });

  it('a genuine failure is not swallowed by the retry', async () => {
    // The retry is narrow on purpose: only a uniqueness conflict on the address
    // is treated as "somebody else just did this". A different error must still
    // be an error, or "retry once and see" is how a real failure goes quiet.
    //
    // The failure used here is a real one rather than a contrived fault: the
    // named manager LEFT between the invitation being sent and it being
    // accepted, which for a 14-day TTL is a thing that will happen. A bogus
    // manager id cannot be used — `invite_manager_id_fkey` refuses it at issue
    // time, which is the composite FK from `0019` doing its job and is worth
    // knowing: the invitation cannot be written pointing at a manager who is not
    // in this tenant.
    const manager = await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, role_id) VALUES ($1, 'boss@acme.test', '019e3000-0000-7000-8000-000000000004')
         RETURNING id`,
        [orgId],
      ),
    );
    await issue({ managerId: manager.rows[0].id as string });
    await admin.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [
      manager.rows[0].id,
    ]);

    await expect(acceptForVerifiedEmail(orgId, INVITEE)).rejects.toMatchObject({
      code: 'MANAGER_NOT_FOUND',
    });
    const members = await admin.query(
      'SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower($1)',
      [INVITEE],
    );
    expect(members.rows[0].n).toBe(0);
    // The invitation is untouched, so fixing the manager and trying again works.
    const still = await admin.query(
      'SELECT count(*)::int AS n FROM invite WHERE accepted_at IS NULL AND revoked_at IS NULL',
    );
    expect(still.rows[0].n).toBe(1);
  });

  it('a revoked invitation grants nothing', async () => {
    const issued = await issue();
    await withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, issued.inviteId));
    expect(await acceptForVerifiedEmail(orgId, INVITEE)).toBeNull();
  });

  it('an expired invitation grants nothing', async () => {
    const issued = await issue();
    await admin.query(
      "UPDATE invite SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [issued.inviteId],
    );
    expect(await acceptForVerifiedEmail(orgId, INVITEE)).toBeNull();
  });

  it('records the acceptance against the person who accepted', async () => {
    await issue();
    const accepted = await acceptForVerifiedEmail(orgId, INVITEE);
    const entry = (
      await admin.query(
        "SELECT actor_id, action FROM audit_entry WHERE action = 'INVITE_ACCEPTED'",
      )
    ).rows[0];
    expect(entry.actor_id).toBe(accepted!.userId);
  });
});

describe('withdrawing', () => {
  it('lists live invitations and stops listing a withdrawn one', async () => {
    await issue();
    const before = await withOrg(orgId, (tx) => listLiveInvites(tx));
    expect(before.map((i) => i.email)).toEqual([INVITEE]);
    expect(before[0].invitedByName).toBe('Founder');

    await withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, before[0].id));
    expect(await withOrg(orgId, (tx) => listLiveInvites(tx))).toEqual([]);
  });

  it('refuses to withdraw one that was accepted in the meantime', async () => {
    const issued = await issue();
    await acceptForVerifiedEmail(orgId, INVITEE);
    await expect(
      withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, issued.inviteId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // And the member it became is still there — the failure is the honest
    // outcome, not a rollback of somebody's membership.
    const members = await admin.query(
      'SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower($1)',
      [INVITEE],
    );
    expect(members.rows[0].n).toBe(1);
  });

  it('withdrawing frees the address for a fresh invitation', async () => {
    const first = await issue();
    await withOrg(orgId, (tx) => revokeInvite(tx, ACTOR, first.inviteId));
    const second = await issue();
    expect(second.resent).toBe(false);
    expect(await resolveInviteTenant(first.token)).toBeNull();
    expect(await resolveInviteTenant(second.token)).not.toBeNull();
  });
});

describe('accepting after the invited role was deactivated (w4-10b)', () => {
  it('joins as an Employee — never more than was promised — and the audit row says so', async () => {
    await issue({ roleId: EXECUTIVE });
    await withOrg(orgId, (tx) => tx.query(`UPDATE role SET active = false WHERE id = $1`, [EXECUTIVE]));
    try {
      const accepted = await acceptForVerifiedEmail(orgId, INVITEE);
      expect(accepted).toMatchObject({ email: INVITEE, roleId: EMPLOYEE });
      const audit = await admin.query(
        `SELECT details FROM audit_entry WHERE action = 'INVITE_ACCEPTED' ORDER BY sequence DESC LIMIT 1`,
      );
      expect(audit.rows[0].details).toMatchObject({
        roleId: EMPLOYEE,
        role: 'Employee',
        invitedRoleId: EXECUTIVE,
        roleUnavailable: true,
      });
    } finally {
      await withOrg(orgId, (tx) => tx.query(`UPDATE role SET active = true WHERE id = $1`, [EXECUTIVE]));
    }
  });
});

describe('signing in — the door itself', () => {
  it('provisions from a live invitation, once', async () => {
    await issue({ roleId: EXECUTIVE });
    const first = await resolveSsoUser(orgSlug, INVITEE);
    expect(first).not.toBeNull();
    const second = await resolveSsoUser(orgSlug, INVITEE);
    // Second sign-in finds the member, not the invitation.
    expect(second!.userId).toBe(first!.userId);
    const members = await admin.query('SELECT count(*)::int AS n FROM app_user');
    expect(members.rows[0].n).toBe(2);
  });

  /* THE ONE THAT FOUND A BUG OLDER THAN THIS TICKET.
   *
   * `resolveSsoUser` read `app_user` inside `withoutOrg`, which its own header
   * called "a sanctioned cross-tenant read". It is not one — `withoutOrg` still
   * connects as `veloapp` under FORCE RLS, so with no `app.current_org` the table
   * returns zero rows. Every SSO sign-in was denied, for everybody. Nothing
   * caught it because `e2e/auth.setup.ts` mints session cookies directly and the
   * browser suite has never been through `signIn`. */
  it('signs in a member who already exists — which it could not do before', async () => {
    const founder = await resolveSsoUser(orgSlug, 'founder@acme.test');
    expect(founder).not.toBeNull();
    expect(founder!.userId).toBe(adminUserId);
    expect(founder!.orgId).toBe(orgId);
    // And made nobody: an existing member is found, not provisioned again.
    const members = await admin.query('SELECT count(*)::int AS n FROM app_user');
    expect(members.rows[0].n).toBe(1);
  });

  it('refuses somebody with no invitation and no membership', async () => {
    expect(await resolveSsoUser(orgSlug, 'stranger@acme.test')).toBeNull();
    expect(await admin.query('SELECT count(*)::int AS n FROM app_user')).toMatchObject({
      rows: [{ n: 1 }],
    });
  });

  it('will not sign somebody into a DIFFERENT tenant than the one they named', async () => {
    await issue();
    const other = await createOrganization({
      name: 'Globex',
      slug: 'globex',
      adminEmail: 'founder@globex.test',
    });
    // Invited to Acme, signing in at Globex. Refused, and no member is made in
    // either tenant.
    expect(await resolveSsoUser(other.slug, INVITEE)).toBeNull();
    const acme = await withOrg(orgId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM app_user'),
    );
    const globex = await withOrg(other.organizationId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM app_user'),
    );
    expect([acme.rows[0].n, globex.rows[0].n]).toEqual([1, 1]);
  });

  /* VX5-3 folds in a gap that predates it: `resolveSsoUser` matched on email
   * alone, so a deactivated person completed OAuth and held a real session until
   * `requireActor` refused them one step later. Never a way in — but a refusal
   * belongs at the door. */
  it('refuses a DEACTIVATED member at the door, not one room further in', async () => {
    await issue();
    const joined = await resolveSsoUser(orgSlug, INVITEE);
    expect(joined).not.toBeNull();
    await admin.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [
      joined!.userId,
    ]);
    expect(await resolveSsoUser(orgSlug, INVITEE)).toBeNull();
  });

  it('does not resurrect a deactivated member through a new invitation', async () => {
    await issue();
    const joined = await resolveSsoUser(orgSlug, INVITEE);
    await admin.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [
      joined!.userId,
    ]);
    // An admin may invite the address again — `issueInvite`'s member check
    // ignores deactivated rows on purpose, because re-hiring is a real thing.
    const again = await issue();
    expect(again.resent).toBe(false);
    // But acceptance goes through `createEmployee`, whose EMAIL_TAKEN check is
    // case-insensitive and does NOT ignore deactivated rows — so this refuses
    // rather than making a second row for the same person. Asserted because the
    // two checks disagree, deliberately, and a reader should know which wins.
    await expect(acceptForVerifiedEmail(orgId, INVITEE)).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
    });
  });

  it('audits a denied sign-in against the tenant it was aimed at', async () => {
    await onSsoDenied(orgSlug, 'stranger@acme.test', 'google');
    const entries = await admin.query(
      "SELECT actor_id, actor_email, action, details FROM audit_entry WHERE action = 'SIGN_IN_DENIED'",
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0].actor_id).toBeNull();
    expect(entries.rows[0].actor_email).toBe('stranger@acme.test');
    expect(entries.rows[0].details).toMatchObject({ provider: 'google' });
  });

  it('writes nothing for a slug that is not an organization, and does not throw', async () => {
    await expect(onSsoDenied('no-such-tenant', 'x@y.test', 'google')).resolves.toBeUndefined();
    const entries = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'SIGN_IN_DENIED'",
    );
    expect(entries.rows[0].n).toBe(0);
  });
});

describe('an invitation is tenant data, and nobody else may read it', () => {
  it('is invisible with no context at all', async () => {
    await issue();
    const blind = await withoutOrg((tx) => tx.query('SELECT count(*)::int AS n FROM invite'));
    expect(blind.rows[0].n).toBe(0);
  });
});
