/**
 * VX1-9 — mint a signed-in session for the e2e run.
 *
 * WHY NOT DRIVE THE LOGIN PAGE: sign-in is invite-only SSO through Google or
 * Microsoft Entra. A CI browser cannot complete either, and a test-only
 * credentials provider would mean shipping a login bypass whose safety rests on
 * an env flag never being set in production. Instead this encodes the very same
 * Auth.js JWT the app would issue, using AUTH_SECRET, and writes it as the
 * session cookie. The bypass exists only in this file; nothing in app/ or lib/
 * knows the e2e exists.
 *
 * The trade: the spec never exercises the login page itself, and if auth-kit
 * changes its claim or cookie shape this breaks. Both are visible failures, not
 * silent passes — the first request would land on /login and the spec fails.
 *
 * Claims must match src/auth-kit/create-auth-config.ts: the jwt callback stores
 * orgId / role / subjectId, and the session callback maps orgId ->
 * session.user.organizationId, which lib/tenant/request.ts turns into
 * app.current_org.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { Pool } from 'pg';
import { encode } from 'next-auth/jwt';

const STATE_PATH = path.join('e2e', '.auth', 'state.json');
/**
 * VX2-10: a SECOND session, for the approver.
 *
 * `approval-flow.spec.ts` needs two signed-in people, and not for convenience —
 * reimbursement refuses your own report (GAP-AUDIT RB-3), and the demo tenant has
 * the break-glass ON. So paying as the submitter would exercise the EXCEPTION and
 * quietly stop testing the control. `owner@demo.test` is the submitter's manager
 * and also an ADMIN, so they are both the approver and the person who can pay.
 */
const APPROVER_STATE_PATH = path.join('e2e', '.auth', 'approver.json');

/**
 * The seeded admin of the demo tenant (scripts/seed.mjs).
 *
 * `npm run e2e` SEEDS before it runs, added by VX2-10 after this exact trap
 * caught me: every DB suite in `npm test` does
 * `TRUNCATE app_user, organization CASCADE`, so running the e2e after the unit
 * tests without re-seeding leaves both of these users gone and BOTH setup
 * projects fail. CI has always known this — its workflow has a "Seed the demo
 * tenant" step with a comment saying why — and the failure is only ever a
 * hand-run command block that forgot it. The seed is idempotent
 * (`ON CONFLICT DO UPDATE` throughout), so seeding twice costs nothing and the
 * trap cannot recur.
 */
const E2E_EMAIL = 'admin@demo.test';
const E2E_APPROVER_EMAIL = 'owner@demo.test';
const E2E_ORG_SLUG = 'demo';

// Auth.js v5 derives the JWE salt from the cookie name; on http it is the
// unprefixed one, which is also what proxy.ts checks for.
const COOKIE_NAME = 'authjs.session-token';

async function mintSession(email: string, statePath: string) {
  const secret = process.env.AUTH_SECRET;
  expect(secret, 'AUTH_SECRET must be set for the e2e run').toBeTruthy();

  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  let user: { id: string; organization_id: string; display_name: string | null };
  try {
    const result = await pool.query(
      `SELECT u.id, u.organization_id, u.display_name
         FROM app_user u JOIN organization o ON o.id = u.organization_id
        WHERE o.slug = $1 AND lower(u.email) = lower($2)`,
      [E2E_ORG_SLUG, email],
    );
    expect(
      result.rows.length,
      `${email} is missing from the '${E2E_ORG_SLUG}' tenant — run \`npm run seed\` first`,
    ).toBe(1);
    user = result.rows[0];
  } finally {
    await pool.end();
  }

  const maxAge = 60 * 60; // an hour is plenty for one CI run
  const token = await encode({
    token: {
      name: user.display_name ?? email,
      email,
      sub: user.id,
      orgId: user.organization_id,
      role: 'ADMIN',
      subjectId: user.id,
    },
    secret: secret!,
    salt: COOKIE_NAME,
    maxAge,
  });

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        cookies: [
          {
            name: COOKIE_NAME,
            value: token,
            domain: 'localhost',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + maxAge,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );
}

setup('mint a session cookie for the demo admin', async () => {
  await mintSession(E2E_EMAIL, STATE_PATH);
});

setup('mint a session cookie for the approver', async () => {
  await mintSession(E2E_APPROVER_EMAIL, APPROVER_STATE_PATH);
});
