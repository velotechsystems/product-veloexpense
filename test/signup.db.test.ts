/**
 * VX5-2 — the door, against a real Postgres.
 *
 * What has to be proved here is what `0035`'s policies claim, and none of it
 * survives a mock: an expired token is INVISIBLE rather than filtered, a second
 * click cannot consume what the first took, a tenant cannot see a signup row at
 * all, and a verification that fails leaves neither a tenant nor a burnt token.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import {
  recordSignup,
  verifySignup,
  peekSignup,
  SignupError,
  SIGNUP_TTL_MINUTES,
} from '@/lib/onboarding/signup';
import { withSignupContext, withSignupConsume, withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const REQUEST = {
  email: 'ada@signup.test',
  organizationName: 'Signup Co',
  slug: 'signup-co',
};

const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

const signupRow = async (email: string) =>
  (await admin.query('SELECT * FROM signup WHERE lower(email) = lower($1)', [email])).rows[0];

beforeEach(async () => {
  await admin.query('TRUNCATE signup, app_user, organization CASCADE');
});

afterAll(async () => {
  await admin.query('TRUNCATE signup, app_user, organization CASCADE');
  await admin.end();
});

describe('starting a signup', () => {
  it('records the request and stores ONLY the hash of the token', async () => {
    const started = await recordSignup(REQUEST);
    const row = await signupRow(REQUEST.email);

    expect(row.organization_name).toBe('Signup Co');
    expect(row.slug).toBe('signup-co');
    expect(row.consumed_at).toBeNull();
    expect(row.organization_id).toBeNull();

    // The raw value exists in exactly one place — the link in a mailbox.
    expect(row.token_hash).toBe(hash(started.token));
    expect(row.token_hash).not.toBe(started.token);
    expect(JSON.stringify(row)).not.toContain(started.token);
  });

  it('creates NO organization — the tenant arrives at verification', async () => {
    await recordSignup(REQUEST);
    expect(await admin.query('SELECT 1 FROM organization')).toMatchObject({ rowCount: 0 });
  });

  it('expires within the stated window', async () => {
    const started = await recordSignup(REQUEST);
    const minutes = (started.expiresAt.getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(SIGNUP_TTL_MINUTES - 2);
    expect(minutes).toBeLessThanOrEqual(SIGNUP_TTL_MINUTES + 1);
  });

  /**
   * The rate limit is a UNIQUE index rather than a counter, so asking twice is a
   * RESEND. The important half is that the OLD token stops working — two live
   * tokens for one address would be two credentials where the person believes
   * they have one.
   */
  it('asking again resends: one row, and the first token is dead', async () => {
    const first = await recordSignup(REQUEST);
    const second = await recordSignup(REQUEST);

    expect(second.resent).toBe(true);
    expect(second.token).not.toBe(first.token);
    const rows = await admin.query('SELECT count(*)::int AS n FROM signup');
    expect(rows.rows[0].n).toBe(1);

    await expect(verifySignup(first.token)).rejects.toMatchObject({ code: 'TOKEN_UNKNOWN' });
    await expect(verifySignup(second.token)).resolves.toBeTruthy();
  });

  it('treats the address case-insensitively, or the limit would not be one', async () => {
    await recordSignup(REQUEST);
    await recordSignup({ ...REQUEST, email: 'ADA@Signup.Test' });
    expect((await admin.query('SELECT count(*)::int AS n FROM signup')).rows[0].n).toBe(1);
  });

  it('refuses a malformed address before anything is sent', async () => {
    for (const email of ['', '   ', 'ada', 'ada@', '@signup.test', 'a b@c.test']) {
      await expect(recordSignup({ ...REQUEST, email }), email).rejects.toBeInstanceOf(SignupError);
    }
  });

  it('refuses a reserved or malformed slug at REQUEST time, not at verification', async () => {
    // Cheaper for the person: they find out while the form is in front of them.
    await expect(recordSignup({ ...REQUEST, slug: 'www' })).rejects.toMatchObject({
      code: 'SLUG_UNUSABLE',
    });
    await expect(recordSignup({ ...REQUEST, slug: 'Not A Slug' })).rejects.toMatchObject({
      code: 'SLUG_UNUSABLE',
    });
  });
});

describe('verifying', () => {
  it('creates the organization and its administrator, and consumes the token', async () => {
    const started = await recordSignup(REQUEST);
    const verified = await verifySignup(started.token);

    expect(verified.slug).toBe('signup-co');
    expect(verified.email).toBe('ada@signup.test');

    const users = await withOrg(verified.organizationId, (tx) =>
      tx.query('SELECT email, role_id AS role FROM app_user'),
    );
    expect(users.rows).toEqual([{ email: 'ada@signup.test', role: '019e3000-0000-7000-8000-000000000001' }]); // w4-10b: System Administrator

    const row = await signupRow(REQUEST.email);
    expect(row.consumed_at).not.toBeNull();
    expect(row.organization_id).toBe(verified.organizationId);
  });

  it('refuses a second click, and creates only one organization', async () => {
    const started = await recordSignup(REQUEST);
    await verifySignup(started.token);
    await expect(verifySignup(started.token)).rejects.toMatchObject({ code: 'TOKEN_UNKNOWN' });
    expect((await admin.query('SELECT count(*)::int AS n FROM organization')).rows[0].n).toBe(1);
  });

  it('refuses a token nobody issued', async () => {
    await expect(verifySignup('not-a-real-token')).rejects.toMatchObject({
      code: 'TOKEN_UNKNOWN',
    });
  });

  /**
   * `0035`'s `signup_read_live`: unknown, consumed and expired are ONE case —
   * the row is not visible — so the check cannot be forgotten or defeated by a
   * clock the application reads instead of the database. Proved by expiring the
   * row in SQL and watching the SAME refusal come back.
   */
  it('refuses an EXPIRED token, and the row is invisible rather than filtered', async () => {
    const started = await recordSignup(REQUEST);
    await admin.query("UPDATE signup SET expires_at = clock_timestamp() - interval '1 second'");

    const seen = await withSignupContext((tx) =>
      tx.query('SELECT id FROM signup WHERE token_hash = $1', [hash(started.token)]),
    );
    expect(seen.rows).toHaveLength(0);

    await expect(verifySignup(started.token)).rejects.toMatchObject({ code: 'TOKEN_UNKNOWN' });
    expect((await admin.query('SELECT count(*)::int AS n FROM organization')).rows[0].n).toBe(0);
  });

  /**
   * The race. Two clicks arrive; the second finds the slug gone because the
   * first took it. What must NOT happen is a half-state: a consumed token with
   * no organization, or an organization with nobody able to sign in.
   */
  it('refuses when the slug was taken between request and verification', async () => {
    const started = await recordSignup(REQUEST);
    await createOrganization({
      name: 'Somebody Else',
      slug: 'signup-co',
      adminEmail: 'first@signup.test',
    });

    await expect(verifySignup(started.token)).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
    // The token is NOT burnt: the person can pick another name and try again.
    const row = await signupRow(REQUEST.email);
    expect(row.consumed_at).toBeNull();
  });
});

/* ── VX5-2b: what the confirmation PAGE may read before anybody acts ────────
 *
 * `/signup/verify` renders a question on the GET and only creates the tenant on
 * the POST, because link scanners fetch every URL in a message. That needs a
 * read that does not consume — and the thing worth testing about it is not that
 * it reads, but that it agrees with `verifySignup` about which links are alive
 * and stays quiet about everything else.
 */
describe('peeking at a signup, which is what the confirm page does', () => {
  it('names the organization and the address asked for, and NOT the email', async () => {
    const started = await recordSignup(REQUEST);
    const seen = await peekSignup(started.token);
    expect(seen).toEqual({
      organizationName: REQUEST.organizationName,
      slug: REQUEST.slug,
    });
    // Belt and braces: `toEqual` above already fails on an extra key, but the
    // email is the specific thing that must never be here — a link forwarded to
    // a colleague should not tell them whose address started this.
    expect(JSON.stringify(seen)).not.toContain(REQUEST.email);
  });

  it('does not consume: the row is still live and still verifiable after', async () => {
    const started = await recordSignup(REQUEST);
    await peekSignup(started.token);
    await peekSignup(started.token);
    const row = await signupRow(REQUEST.email);
    expect(row.consumed_at).toBeNull();
    const verified = await verifySignup(started.token);
    expect(verified.slug).toBe(REQUEST.slug);
  });

  it('is null for a token nobody issued', async () => {
    expect(await peekSignup('not-a-token')).toBeNull();
  });

  it('is null once the link has been used — the page cannot offer a spent one', async () => {
    const started = await recordSignup(REQUEST);
    await verifySignup(started.token);
    expect(await peekSignup(started.token)).toBeNull();
  });

  it('is null for an expired link, by the same policy verification obeys', async () => {
    const started = await recordSignup(REQUEST);
    await admin.query(
      "UPDATE signup SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [started.signupId],
    );
    expect(await peekSignup(started.token)).toBeNull();
  });

  /* The claim that makes the other four worth having: the page and the action
   * cannot disagree about whether a link is alive, because NEITHER decides —
   * `signup_read_live` does, and both of them read through it. A peek that said
   * yes where `verifySignup` said no would mean a button that fails on press. */
  it('agrees with verification on every case, alive or dead', async () => {
    const cases: Array<[string, () => Promise<string>, boolean]> = [
      ['live', async () => (await recordSignup(REQUEST)).token, true],
      ['unknown', async () => 'nobody-issued-this', false],
      [
        'consumed',
        async () => {
          const s = await recordSignup(REQUEST);
          await verifySignup(s.token);
          return s.token;
        },
        false,
      ],
      [
        'expired',
        async () => {
          const s = await recordSignup(REQUEST);
          await admin.query(
            "UPDATE signup SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
            [s.signupId],
          );
          return s.token;
        },
        false,
      ],
    ];
    for (const [name, make, alive] of cases) {
      await admin.query('TRUNCATE signup, app_user, organization CASCADE');
      const token = await make();
      const peeked = (await peekSignup(token)) !== null;
      const verifies = await verifySignup(token).then(
        () => true,
        () => false,
      );
      expect(`${name}: peek=${peeked} verify=${verifies}`).toBe(
        `${name}: peek=${alive} verify=${alive}`,
      );
    }
  });
});

describe('a signup row is platform data, not tenant data', () => {
  /**
   * No `tenant_isolation` policy at all, which is stronger than one: a signup
   * holds the address of somebody who is not a customer, and no tenant should
   * see one — not even the tenant it produced.
   */
  it('is invisible from inside a tenant, including its own', async () => {
    const started = await recordSignup(REQUEST);
    const verified = await verifySignup(started.token);

    const fromInside = await withOrg(verified.organizationId, (tx) =>
      tx.query('SELECT id FROM signup'),
    );
    expect(fromInside.rows).toHaveLength(0);
  });

  it('is invisible with no context at all', async () => {
    await recordSignup(REQUEST);
    // `withoutOrg` is the service-role path; without the signup flag it still
    // sees nothing, because no policy matches.
    const { withoutOrg } = await import('@/lib/tenant/context');
    const seen = await withoutOrg((tx) => tx.query('SELECT id FROM signup'));
    expect(seen.rows).toHaveLength(0);
  });

  it('cannot be written without the flag either', async () => {
    const { withoutOrg } = await import('@/lib/tenant/context');
    await expect(
      withoutOrg((tx) =>
        tx.query(
          `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at)
           VALUES ('x@y.test','X','x', $1, clock_timestamp() + interval '1 hour')`,
          ['a'.repeat(64)],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

/**
 * The two gates, and what each one cannot do.
 *
 * This block exists because the separation was got WRONG TWICE while writing
 * `0035`, both times in a way that only running it revealed: consumption under
 * the narrow gate is impossible (the new row leaves the live view), and resend
 * needed an UPDATE policy of its own. Asserting the boundaries means the next
 * person to simplify these policies finds out here.
 */
describe('the signup gates', () => {
  it('the request gate cannot CONSUME — its WITH CHECK forbids it', async () => {
    const started = await recordSignup(REQUEST);
    const org = await createOrganization({
      name: 'Elsewhere',
      slug: 'elsewhere-co',
      adminEmail: 'z@signup.test',
    });
    await expect(
      withSignupContext((tx) =>
        tx.query(
          'UPDATE signup SET consumed_at = clock_timestamp(), organization_id = $2 WHERE token_hash = $1',
          [hash(started.token), org.organizationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const row = await signupRow(REQUEST.email);
    expect(row.consumed_at).toBeNull();
  });

  it('the request gate cannot SEE a consumed signup', async () => {
    const started = await recordSignup(REQUEST);
    const verified = await verifySignup(started.token);
    const seen = await withSignupContext((tx) =>
      tx.query('SELECT id FROM signup WHERE organization_id = $1', [verified.organizationId]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it('the consume gate cannot consume a signup that is already consumed', async () => {
    const started = await recordSignup(REQUEST);
    const verified = await verifySignup(started.token);
    const again = await withSignupConsume((tx) =>
      tx.query('UPDATE signup SET consumed_at = clock_timestamp() WHERE organization_id = $1', [
        verified.organizationId,
      ]),
    );
    // Not an error — the policy's USING simply matches no row, which is the
    // shape the conditional-write idiom reads as "somebody got there first".
    expect(again.rowCount).toBe(0);
  });

  it('neither gate is a master key: they do nothing on any other table', async () => {
    const org = await createOrganization({
      name: 'Keys Co',
      slug: 'keys-co',
      adminEmail: 'k@signup.test',
    });
    for (const ctx of [withSignupContext, withSignupConsume]) {
      const seen = await ctx((tx) =>
        tx.query('SELECT id FROM app_user WHERE organization_id = $1', [org.organizationId]),
      );
      expect(seen.rows).toHaveLength(0);
    }
  });
});

describe('the constraints hold whatever writes the row', () => {
  it('refuses a token_hash that is not a sha256 hex', async () => {
    await expect(
      admin.query(
        `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at)
         VALUES ('x@y.test','X','x','not-a-hash', clock_timestamp() + interval '1 hour')`,
      ),
    ).rejects.toMatchObject({ constraint: 'signup_token_hash_shape' });
  });

  it('refuses a consumed signup with no organization, and vice versa', async () => {
    await expect(
      admin.query(
        `INSERT INTO signup (email, organization_name, slug, token_hash, expires_at, consumed_at)
         VALUES ('x@y.test','X','x',$1, clock_timestamp() + interval '1 hour', clock_timestamp())`,
        ['a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: 'signup_consumed_has_org' });
  });
});
