/**
 * VX5-20 — a real HTTP platform for the e2e run.
 *
 * ── WHY THIS EXISTS, WHICH IS THE FOURTH TIME ──────────────────────────────
 *
 * `e2e-storage.mjs`, `e2e-mail.mjs` and `e2e-ledger.mjs` each exist because an
 * in-process stub proves the wrong thing: it records that something was COMPOSED
 * and nothing about whether it went anywhere. The seat push has the same hole and
 * a sharper version of it, because the whole ticket is about a number leaving this
 * product:
 *
 *   · a mocked `fetch` in a vitest suite proves the payload was built. It cannot
 *     prove the URL is the platform's, that the header the platform authenticates
 *     on was sent, or that `observedAt` survived JSON.
 *   · the app under test is a SEPARATE STANDALONE SERVER, so nothing Playwright
 *     can reach sees module state inside it.
 *   · VeloExpense stores no record of a push. There is no table to inspect
 *     afterwards, by design — a level does not need a log to be correct.
 *
 * So the push has to leave the process and be caught. This is a platform that
 * accepts a seat report over HTTP and serves back what it was given, in one Node
 * process with no dependencies.
 *
 * ── WHAT IT PROVES THAT A MOCK CANNOT ──────────────────────────────────────
 *
 * 1. THE PAYLOAD, per account: `{ accountId, product, seatCount, observedAt }`.
 * 2. THE AUTHORISATION. `x-platform-key` is recorded, so a test can assert the
 *    service token arrived and is the one from the environment — the regression
 *    assertion for "the push works but is unauthenticated", which returns a 401
 *    the product currently swallows.
 * 3. THE ABSENCE of a push. A tenant with no `account_id` must send NOTHING, and
 *    "nothing arrived" is only checkable against something that would have
 *    recorded it. This is the assertion an in-process mock is worst at, because a
 *    mock that was never called and a mock that was never wired up look identical.
 *
 * ── IT ALSO REFUSES, ON DEMAND ─────────────────────────────────────────────
 *
 * `POST /fail-next` makes the next seat report return 500, which is how the
 * "fail soft" claim gets tested rather than asserted: with the platform
 * refusing, adding or removing an employee must still work and the product must
 * not surface an error. That is the property the whole module is built around and
 * the one that would be embarrassing to have wrong.
 *
 * Ports come from `playwright.config.ts` so a stale server on a default port
 * cannot be adopted — the same reasoning as the other three sinks.
 */
import { createServer } from 'node:http';

const PLATFORM_PORT = Number(process.env.E2E_PLATFORM_PORT ?? 9521);
const CONTROL_PORT = Number(process.env.E2E_PLATFORM_CONTROL_PORT ?? 9522);

/** Every seat report received, in order. */
const seatReports = [];
/** Every entitlement read received, in order. Recorded, not served differently. */
const entitlementReads = [];
/** When true, the next seat report is refused with a 500 and NOT recorded. */
let failNext = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined; // distinguishable from "no body"
  }
}

const platform = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PLATFORM_PORT}`);

  /*
   * The level endpoint this ticket is about. NOTE: this route does not exist on
   * the real platform yet — John is adding it — so this sink is currently the
   * only thing that answers it. That is stated so nobody reads a green e2e as
   * evidence that the integration works end to end against VeloCRM. It proves
   * VeloExpense's half.
   */
  if (req.method === 'POST' && url.pathname === '/api/v1/platform/seats') {
    const body = await readBody(req);
    if (failNext) {
      failNext = false;
      json(res, 500, { error: 'refused on purpose' });
      return;
    }
    seatReports.push({
      at: new Date().toISOString(),
      key: req.headers['x-platform-key'] ?? null,
      contentType: req.headers['content-type'] ?? null,
      body,
    });
    json(res, 200, { data: { accepted: true } });
    return;
  }

  // The read direction, so a test can point the whole platform integration at
  // this one server rather than half of it. Answers `disabled`-shaped 404s by
  // default — a tenant the platform has never heard of — which is what the
  // fixture tenants are.
  if (req.method === 'GET' && url.pathname === '/api/v1/platform/entitlements') {
    entitlementReads.push({ at: new Date().toISOString(), query: url.search });
    json(res, 404, { error: 'Account not found for domain' });
    return;
  }

  json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);

  if (req.method === 'GET' && url.pathname === '/seats') {
    json(res, 200, { reports: seatReports });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/entitlements') {
    json(res, 200, { reads: entitlementReads });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/fail-next') {
    failNext = true;
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    seatReports.length = 0;
    entitlementReads.length = 0;
    failNext = false;
    json(res, 200, { ok: true });
    return;
  }
  json(res, 404, { error: `no control route for ${req.method} ${url.pathname}` });
});

function bail(what) {
  return (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `e2e platform: ${what} port is already in use. Another run is up, or a ` +
          'previous one did not exit. Stop it, or shift E2E_PLATFORM_PORT / ' +
          'E2E_PLATFORM_CONTROL_PORT.',
      );
      process.exit(1);
    }
    throw err;
  };
}

platform.on('error', bail('the platform'));
control.on('error', bail('the control'));

platform.listen(PLATFORM_PORT, () => {
  control.listen(CONTROL_PORT, () => {
    console.log(
      `e2e platform: seats POST http://127.0.0.1:${PLATFORM_PORT}/api/v1/platform/seats · ` +
        `control http://127.0.0.1:${CONTROL_PORT}`,
    );
  });
});
