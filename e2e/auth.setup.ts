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

/** The seeded admin of the demo tenant (scripts/seed.mjs). */
const E2E_EMAIL = 'admin@demo.test';
const E2E_ORG_SLUG = 'demo';

// Auth.js v5 derives the JWE salt from the cookie name; on http it is the
// unprefixed one, which is also what proxy.ts checks for.
const COOKIE_NAME = 'authjs.session-token';

setup('mint a session cookie for the demo admin', async () => {
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
      [E2E_ORG_SLUG, E2E_EMAIL],
    );
    expect(
      result.rows.length,
      `${E2E_EMAIL} is missing from the '${E2E_ORG_SLUG}' tenant — run \`npm run seed\` first`,
    ).toBe(1);
    user = result.rows[0];
  } finally {
    await pool.end();
  }

  const maxAge = 60 * 60; // an hour is plenty for one CI run
  const token = await encode({
    token: {
      name: user.display_name ?? 'Demo Admin',
      email: E2E_EMAIL,
      sub: user.id,
      orgId: user.organization_id,
      role: 'ADMIN',
      subjectId: user.id,
    },
    secret: secret!,
    salt: COOKIE_NAME,
    maxAge,
  });

  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
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
});
