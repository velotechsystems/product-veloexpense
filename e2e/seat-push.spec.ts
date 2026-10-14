/**
 * VX5-20 — the seat count reaches the platform.
 *
 * ── WHAT ONLY THIS FILE CAN PROVE ──────────────────────────────────────────
 *
 * `test/seats.db.test.ts` covers the decisions — what is skipped, what is an
 * error, what the payload holds. It calls `pushSeatCount` directly, so what it
 * cannot show is that anything CALLS it. Between a server action and a POST there
 * are three things a unit test does not cross:
 *
 *   1. a transaction boundary. The push must happen after the commit, or the
 *      platform gets a number that has not been written and might roll back.
 *   2. a floating promise. `pushSeatCountInBackground` is deliberately not
 *      awaited, so the action returns before the POST lands.
 *   3. a process boundary. The app under test is a separate standalone server;
 *      nothing in a vitest run can see inside it.
 *
 * So this drives the real UI against the real server and asks a real HTTP sink
 * what arrived.
 *
 * ── IT ARRANGES ITS OWN `account_id`, AND THAT IS DELIBERATE ───────────────
 *
 * `scripts/seed.mjs` sets no `organization.account_id` — correctly, because a
 * fixture tenant signed up locally and the platform has never heard of it.
 * Stamping every fixture with a platform account would be a fixture asserting
 * something untrue, and would also make the SKIP path untestable.
 *
 * So the demo tenant gets an account here, and `second`/`blank` deliberately do
 * not — which is what lets the sweep's `skipped` count be an assertion rather
 * than a number nobody reads.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import {
  ADMIN_STATE,
  reconcileSeats,
  resetPlatformSink,
  seatReportsAtSink,
  platformFailsNextSeatPush,
  waitForSeatReports,
} from './helpers';

// A fixed, obviously-fake account. Valid hex, which the first draft was not —
// `...00000000d3m0` spells "demo" and Postgres refused it, because `m` is not a
// hex digit. A cute identifier that does not parse is worth less than a dull one.
const DEMO_ACCOUNT = '9a7c1d20-0000-4000-8000-0000000000de';

async function withAdminPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

test.use({ storageState: ADMIN_STATE });

test.beforeAll(async () => {
  await withAdminPool(async (pool) => {
    // Only `demo`. The other fixtures stay accountless on purpose — see the header.
    await pool.query('UPDATE organization SET account_id = $1 WHERE slug = $2', [
      DEMO_ACCOUNT,
      'demo',
    ]);
    await pool.query("UPDATE organization SET account_id = NULL WHERE slug <> 'demo'");
  });
});

/**
 * Put the seed's plain employee back to ACTIVE.
 *
 * Both UI tests below deactivate this person, and each arranges its own starting
 * point rather than inheriting the other's. The first draft did inherit it and
 * failed: `listEmployees` defaults `includeDeactivated` to false, so a
 * deactivated employee is simply absent from the directory and the second test
 * timed out looking for a link that could not be there.
 *
 * `wipeIntegrations` makes the same argument in `helpers.ts` — "a spec that
 * depends on another spec's cleanup is a spec that fails when somebody adds a
 * file whose name sorts between them". It applies within a file too, and one
 * `beforeEach` costs less than the ordering coupling.
 */
/**
 * The demo tenant's real seat count, straight from the database.
 *
 * Asserted against instead of a fixture number, and the reason is a failure: the
 * first draft said `>= 4` because the seed makes four users. It passed once and
 * then failed on the next run, because this spec deactivates somebody and the
 * seed is not re-run between Playwright invocations — so the second run started
 * at three.
 *
 * A count compared against a constant tests the fixture. A count compared against
 * the database tests the FEATURE: whatever the number is, the number that arrived
 * at the platform has to be the same one. That is the actual claim.
 */
async function activeSeatsInDemo(): Promise<number> {
  return withAdminPool(async (pool) => {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM app_user u
         JOIN organization o ON o.id = u.organization_id
        WHERE o.slug = 'demo' AND u.deleted_at IS NULL`,
    );
    return r.rows[0].n as number;
  });
}

/**
 * Wait until the Deactivate press has landed in the database.
 *
 * The press is a server action; the page re-renders when it returns, but a test that
 * navigates away first can leave before the action commits — and then reads the
 * directory, or the platform, before the change exists. Polling the row is the one signal
 * that cannot be early. (`seat-push` failed about one run in five without it.)
 */
async function employeeDeactivated() {
  await expect
    .poll(
      () =>
        withAdminPool(async (pool) => {
          const r = await pool.query(
            `SELECT deleted_at IS NOT NULL AS gone FROM app_user WHERE email = 'employee@demo.test'`,
          );
          return r.rows[0]?.gone as boolean;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function employeeIsActive() {
  await withAdminPool((pool) =>
    pool.query(
      `UPDATE app_user SET employee_status = 'ACTIVE', deleted_at = NULL
        WHERE email = 'employee@demo.test'`,
    ),
  );
}

test.describe('the seat count reaches the platform', () => {
  test('the reconcile sweep reports the demo tenant and skips the accountless ones', async ({
    request,
  }) => {
    await employeeIsActive();
    await resetPlatformSink(request);
    const result = await reconcileSeats(request);

    // `configured: false` would mean the harness never set PLATFORM_API_URL, and
    // every assertion below would then pass by the feature being switched off —
    // the same trap an unset SMTP_HOST sets for the mail specs.
    expect(result.configured, 'the harness did not configure the platform integration').toBe(
      true,
    );
    expect(result.failures).toEqual([]);
    expect(result.sent).toBe(1);
    // At least `second` and `blank`, plus whatever other specs created.
    expect(result.skipped).toBeGreaterThanOrEqual(2);

    const reports = await seatReportsAtSink(request);
    expect(reports).toHaveLength(1);
    const [sent] = reports;
    expect(sent.body.accountId).toBe(DEMO_ACCOUNT);
    expect(sent.body.product).toBe('veloexpense');
    // THE count, not a plausible one. See `activeSeatsInDemo`.
    expect(sent.body.seatCount).toBe(await activeSeatsInDemo());
    // The header the platform authenticates on. A push that works but is
    // unauthenticated gets a 401 this product swallows, so nothing else notices.
    expect(sent.key).toBe(process.env.PLATFORM_SERVICE_TOKEN ?? 'e2e-platform-token-not-a-real-secret');
  });

  test('deactivating an employee pushes the NEW count, after the commit', async ({
    page,
    request,
  }) => {
    await employeeIsActive();
    await resetPlatformSink(request);

    // The count as the platform last heard it.
    await reconcileSeats(request);
    const [baseline] = await waitForSeatReports(request, 1);
    const before = baseline.body.seatCount as number;

    await resetPlatformSink(request);

    // Deactivate somebody through the real screen. `employee@demo.test` is the
    // seed's plain employee and is nobody's manager, so no reassignment is needed.
    await page.goto('/admin/employees');
    await page.getByRole('link', { name: /Demo Employee/i }).click();
    await page.getByRole('button', { name: /Deactivate/i }).click();

    const reports = await waitForSeatReports(request, 1);
    const [pushed] = reports;

    // ONE FEWER, and this is the assertion the whole ticket is for: the push
    // carries the post-commit count, not the pre-commit one. A push from inside
    // the transaction would have reported `before`.
    expect(pushed.body.seatCount).toBe(before - 1);
    expect(pushed.body.accountId).toBe(DEMO_ACCOUNT);
  });

  test('a platform that REFUSES does not break the product', async ({ page, request }) => {
    await employeeIsActive();
    await resetPlatformSink(request);
    await platformFailsNextSeatPush(request);

    // Deactivate with the platform set to refuse. The screen must behave exactly
    // as it does when the platform is healthy — that is the claim
    // `lib/billing/seats.ts` makes at length, and it would be embarrassing to
    // have wrong.
    await page.goto('/admin/employees');
    await page.getByRole('link', { name: /Demo Employee/i }).click();
    await page.getByRole('button', { name: /Deactivate/i }).click();
    await employeeDeactivated();

    // The product succeeded. No error banner, and the person is gone from the
    // directory — which is what deactivation means here, since `listEmployees`
    // hides deactivated people by default.
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    await page.goto('/admin/employees');
    await expect(page.getByRole('link', { name: /Demo Employee/i })).toHaveCount(0);

    // And the refused push left nothing behind. The sink discards a refused
    // report, so an empty list here is the refusal having been swallowed exactly
    // as designed rather than retried or surfaced at a reader.
    expect(await seatReportsAtSink(request)).toEqual([]);

    // The sweep is what heals it — the reason it is not optional. The count it
    // sends is the post-deactivation one, so the platform ends up correct despite
    // the dropped push, which is the whole argument for the sweep existing.
    await resetPlatformSink(request);
    const healed = await reconcileSeats(request);
    expect(healed.sent).toBe(1);
    const [after] = await waitForSeatReports(request, 1);
    expect(after.body.seatCount).toBe(await activeSeatsInDemo());
  });

  test('the reconcile route refuses a wrong worker secret with a 404', async ({ request }) => {
    // 404 rather than 401, like every other internal route: an endpoint that says
    // "wrong password" confirms it exists.
    const r = await request.post('/api/internal/billing/seats', {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    expect(r.status()).toBe(404);
  });
});
