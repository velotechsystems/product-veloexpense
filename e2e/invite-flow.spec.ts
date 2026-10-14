/**
 * VX5-3 — invitations, end to end through the mail sink.
 *
 * ── WHAT THIS SPEC CAN AND CANNOT REACH ─────────────────────────────────────
 *
 * It covers everything up to the identity provider: an admin invites somebody,
 * the mail arrives, the link names the right tenant and the right (masked)
 * mailbox, the pending list shows it, withdrawing kills the link.
 *
 * It stops there, and stops deliberately. **Acceptance happens inside the SSO
 * callback**, in `lib/auth/resolve-sso-user.ts`, because the thing an invitation
 * is bound to is an email Google or Microsoft has just verified. There is no
 * Google in CI — `e2e/auth.setup.ts` mints session cookies directly for exactly
 * that reason — so the grant itself is proved in `test/invites.db.test.ts`
 * against a real database, and this file proves the wiring around it.
 *
 * Saying so here rather than leaving the gap to be discovered: a browser test
 * that claimed to cover acceptance would have to fake the verified email, which
 * is the one input the whole design rests on not being fakeable.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_STATE } from './helpers';

test.use({ storageState: ADMIN_STATE });

/** Per-run id: the demo tenant is never reset and CI retries once. */
const RUN = Date.now().toString(36);
const INVITEE = `newcomer-${RUN}@invite.e2e`;

const MAIL_HTTP = `http://127.0.0.1:${process.env.E2E_MAIL_HTTP_PORT ?? 2526}`;

interface Captured {
  to: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
}

async function inbox(request: APIRequestContext): Promise<Captured[]> {
  const res = await request.get(`${MAIL_HTTP}/messages`);
  expect(res.ok(), 'the e2e mail sink should be reachable').toBeTruthy();
  return (await res.json()) as Captured[];
}

/**
 * Poll the sink for the invitation mailed to `to`.
 *
 * No drain call, unlike `approval-flow.spec.ts`. Invitation mail does not go
 * through the outbox: `notification_delivery` needs a `notification`, which needs
 * a `recipient_id` in `app_user` — and the whole point of this design is that no
 * such row exists until they accept. So `sendInvite` calls `sendEmail` directly
 * and the sink has it as soon as the POST returns.
 */
async function waitForInviteLink(request: APIRequestContext, to: string): Promise<string> {
  let last: Captured[] = [];
  await expect
    .poll(
      async () => {
        last = await inbox(request);
        return last.some((m) => m.to.includes(to) && m.text.includes('/invite/accept?token='));
      },
      { message: `no invitation mailed to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  const message = last.filter((m) => m.to.includes(to)).pop()!;
  const match = message.text.match(/(https?:\/\/\S*\/invite\/accept\?token=[\w-]+)/);
  expect(match, 'the invitation should carry an absolute URL').not.toBeNull();

  // ONE credential, in BOTH MIME parts — the sink keeps the parts in one blob.
  const tokens = [...message.text.matchAll(/\/invite\/accept\?token=([\w-]+)/g)].map((m) => m[1]);
  expect(new Set(tokens).size, 'an invitation has exactly one live token').toBe(1);
  expect(tokens.length, 'the link should be in both the text and the HTML part').toBeGreaterThan(1);

  // Branded with the TENANT, which the signup email deliberately is not: an
  // invitation has an organization, and a message asking somebody to join Demo Co
  // should look like it came from Demo Co.
  expect(message.subject).toContain('Demo Co');
  return match![1];
}

async function memberCount(email: string): Promise<number> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM app_user WHERE lower(email) = lower($1)',
      [email],
    );
    return Number(r.rows[0].n);
  } finally {
    await pool.end();
  }
}

/**
 * Give the demo tenant a colour and a logo.
 *
 * Written as bytes rather than through the admin screen: this spec is about who
 * may SEE branding, and the upload path has its own coverage in
 * `branding.db.test.ts`. An eight-byte PNG signature is enough — nothing here
 * decodes it, and `0023`'s CHECK wants a raster mime and the three columns
 * moving together, which this satisfies.
 */
async function setDemoBranding(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `UPDATE organization
          SET brand_color = '#663399', logo_bytes = $1, logo_mime = 'image/png',
              logo_updated_at = clock_timestamp()
        WHERE slug = 'demo'`,
      [Buffer.from('89504e470d0a1a0a', 'hex')],
    );
  } finally {
    await pool.end();
  }
}

test.beforeAll(async ({ request }) => {
  await request.delete(`${MAIL_HTTP}/messages`);
});

test.describe('inviting somebody', () => {
  test('an invitation is mailed, is pending, and creates nobody until it is accepted', async ({
    page,
    request,
  }) => {
    await page.goto('/admin/employees/invite');
    await expect(page.getByRole('heading', { name: 'Invite someone' })).toBeVisible();

    // Status is not asked for: an invited person has not arrived, so ON_LEAVE and
    // DEACTIVATED are not choices anybody should be offered.
    await expect(page.getByLabel('Status')).toBeHidden();

    await page.getByLabel('Email').fill(INVITEE);
    await page.getByLabel('Name').fill(`Newcomer ${RUN}`);
    // w4-10b: the tenant's roles, by name (0068); Executive is one of the system roles.
    await page.getByLabel('Role').selectOption({ label: 'Executive' });
    await page.getByRole('button', { name: 'Send the invitation' }).click();

    await expect(page.getByText('Invitation sent.')).toBeVisible();

    // NOBODY WAS CREATED. This is the assertion the whole ticket is for: before
    // it, filling in this form wrote an `app_user` row, which is what
    // `resolveSsoUser` matches on — so the form WAS the grant of access.
    expect(await memberCount(INVITEE), 'no member until they accept').toBe(0);

    // And they are visible as pending, so an admin's invitation has not vanished.
    const pending = page.getByRole('row', { name: new RegExp(INVITEE) });
    await expect(pending).toBeVisible();
    await expect(pending).toContainText('Executive');

    /* ── the link ───────────────────────────────────────────────────────────*/
    const link = await waitForInviteLink(request, INVITEE);
    await page.goto(link);

    await expect(page.getByRole('heading', { name: /invited to Demo Co/ })).toBeVisible();
    // The MASKED address: enough to say which mailbox, not enough to hand the
    // address to everybody who can see a link pasted in a group chat.
    await expect(page.getByText('n••••@invite.e2e')).toBeVisible();
    await expect(page.getByText(INVITEE)).toBeHidden();

    // Nothing happened by loading it, and there is no button here that would.
    expect(await memberCount(INVITEE), 'a GET on the link creates nothing').toBe(0);

    // It hands off to SSO carrying the tenant, so nobody retypes a web address.
    await page.getByRole('link', { name: 'Sign in to accept' }).click();
    await expect(page).toHaveURL(/\/login\?org=demo$/);
    await expect(page.getByLabel('Organization')).toHaveValue('demo');
  });

  test('withdrawing kills the link', async ({ page, request }) => {
    const email = `withdrawn-${RUN}@invite.e2e`;
    await page.goto('/admin/employees/invite');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible();

    const link = await waitForInviteLink(request, email);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: /invited to Demo Co/ })).toBeVisible();

    await page.goto('/admin/employees');
    await page
      .getByRole('row', { name: new RegExp(email) })
      .getByRole('button', { name: 'Withdraw' })
      .click();
    await expect(page.getByText('Invitation withdrawn.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(email) })).toBeHidden();

    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'That invitation is not usable' })).toBeVisible();
  });

  test('asking again resends rather than making a second invitation', async ({ page, request }) => {
    const email = `resend-${RUN}@invite.e2e`;
    for (let i = 0; i < 2; i += 1) {
      await page.goto('/admin/employees/invite');
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Send the invitation' }).click();
    }
    await expect(page.getByText(/already had an invitation open/)).toBeVisible();
    // ONE row in the pending list, not two.
    await expect(page.getByRole('row', { name: new RegExp(email) })).toHaveCount(1);

    // And the FIRST link is dead — which is what somebody who pressed resend
    // expects, and the opposite of what two rows would have given them.
    const messages = (await inbox(request)).filter((m) => m.to.includes(email));
    const links = messages
      .map((m) => m.text.match(/(https?:\/\/\S*\/invite\/accept\?token=[\w-]+)/)?.[1])
      .filter((l): l is string => Boolean(l));
    expect(links.length, 'two messages were sent').toBe(2);
    await page.goto(links[0]);
    await expect(page.getByRole('heading', { name: 'That invitation is not usable' })).toBeVisible();
    await page.goto(links[1]);
    await expect(page.getByRole('heading', { name: /invited to Demo Co/ })).toBeVisible();
  });

  test('somebody already in the directory cannot be invited again', async ({ page }) => {
    await page.goto('/admin/employees/invite');
    await page.getByLabel('Email').fill('employee@demo.test');
    await page.getByRole('button', { name: 'Send the invitation' }).click();
    await expect(page.getByTestId('error-banner')).toContainText('already in your organization');
  });

  /* ── VX5-6 ─────────────────────────────────────────────────────────────────
   *
   * The tenant's colours and mark appear on the acceptance page and NOWHERE ELSE
   * that a stranger can reach. Both halves are asserted, because the second is
   * the decision: `/login` could be branded — the host names the tenant — and
   * deliberately is not (BR-4's oracle). A test that only checked the branding
   * would let somebody "finish the job" later without noticing they had reversed
   * a decision. */
  test('a live invitation shows the organization’s own colours and mark', async ({
    page,
    request,
  }) => {
    const email = `branded-${RUN}@invite.e2e`;
    await setDemoBranding();

    await page.goto('/admin/employees/invite');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible();

    const link = await waitForInviteLink(request, email);
    await page.goto(link);

    // The mark: an <img> whose ALT is the organization's name, pointing at the
    // token-gated route rather than the session-gated one.
    const logo = page.getByRole('img', { name: 'Demo Co' });
    await expect(logo).toBeVisible();
    const src = await logo.getAttribute('src');
    expect(src).toContain('/api/invite/logo?token=');
    // And it actually serves bytes, through the page so cookies and the token
    // travel exactly as the browser would send them.
    const served = await page.evaluate(async (u: string) => {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    }, src!);
    expect(served.status).toBe(200);
    expect(served.type).toBe('image/png');
    expect(served.bytes).toBeGreaterThan(0);

    // The colour, as a scoped <style> rather than the document-level one the
    // layout emits for a signed-in reader.
    const styled = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    );
    expect(styled.length, 'the tenant colour should be applied').toBeGreaterThan(0);

    // The product still names itself under the customer's mark: somebody judging
    // whether the email was genuine needs to see both.
    await expect(page.getByText('Expense management by VeloExpense')).toBeVisible();
  });

  test('a dead invitation gets the plain product shell, not somebody’s brand', async ({
    page,
    request,
  }) => {
    const email = `dead-brand-${RUN}@invite.e2e`;
    await setDemoBranding();
    await page.goto('/admin/employees/invite');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the invitation' }).click();
    const link = await waitForInviteLink(request, email);

    await page.goto('/admin/employees');
    await page
      .getByRole('row', { name: new RegExp(email) })
      .getByRole('button', { name: 'Withdraw' })
      .click();
    /* WAIT FOR THE WITHDRAWAL, do not assume it. `click()` returns when the
     * event is dispatched, not when the server action's POST has finished — the
     * same flake `compliance-flow.spec.ts` was fixed for. Without this the next
     * line navigated to a link that was still live and failed on a page that was
     * entirely correct. It passed in isolation and failed in the file, which is
     * the timing signature. */
    await expect(page.getByText('Invitation withdrawn.')).toBeVisible();

    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'That invitation is not usable' })).toBeVisible();
    // No mark, because there is no longer an invitation to be entitled to one by.
    await expect(page.getByRole('img', { name: 'Demo Co' })).toBeHidden();
    // The bytes are gone too, at the same moment and for the same reason.
    const dead = await page.evaluate(async (u: string) => (await fetch(u)).status, `/api/invite/logo?token=${encodeURIComponent(new URL(link).searchParams.get('token')!)}`);
    expect(dead).toBe(404);
  });

  /* THE DECISION, NOT AN OMISSION. `/login` could show a tenant's colours since
   * VX5-5 — the host names them. It does not, because a branded sign-in page is
   * readable by anybody who can guess a company's name (BR-4). Pinned here so
   * reversing it is a deliberate act with a failing test attached. */
  test('the sign-in page is NOT branded per tenant', async ({ page }) => {
    await setDemoBranding();
    await page.goto('/login');
    await expect(page.getByRole('img', { name: 'Demo Co' })).toBeHidden();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Demo Co');
    // It is the product's own screen, and says so.
    expect(body).toContain('VeloExpense');
  });

  test('a made-up token and a missing one say the same thing', async ({ page }) => {
    for (const url of ['/invite/accept', '/invite/accept?token=nobody-issued-this']) {
      await page.goto(url);
      await expect(
        page.getByRole('heading', { name: 'That invitation is not usable' }),
      ).toBeVisible();
    }
  });

  test('the old create-an-employee page is gone, not merely unlinked', async ({ page }) => {
    // It was the second door: it wrote an `app_user` row, which IS the grant of
    // access. A route left in place and taken off the nav is still a route.
    //
    // This asserted 404 and got 500 on its first run, which turned out to be a
    // defect older than this ticket: with the static route gone the path falls
    // through to `/admin/employees/[employeeId]` with the id `new`, and Postgres
    // answered `invalid input syntax for type uuid`. Any hand-edited id in that
    // URL had done the same since VX1-2 — the static route was hiding it.
    // `getEmployee` now treats a non-uuid id as not found; see its comment.
    const res = await page.goto('/admin/employees/new');
    expect(res!.status(), '/admin/employees/new must not exist').toBe(404);
  });

  test('a hand-edited employee id is not found, rather than a 500', async ({ page }) => {
    for (const id of ['not-a-uuid', '../../etc', '1', '%20']) {
      const res = await page.goto(`/admin/employees/${id}`);
      expect(res!.status(), `/admin/employees/${id} should be a 404`).toBe(404);
    }
  });
});
