/**
 * VX3-9a — a real HTTP ledger for the e2e run.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The third instance of the same argument, and the reasoning is worth repeating
 * because it keeps being right. `scripts/e2e-storage.mjs` exists because
 * "MemoryStorage signs `memory://` URLs no browser can fetch, which is why the
 * vitest suites can be green while a real upload is broken". `scripts/e2e-mail.mjs`
 * exists because an in-memory transport "proves a message was COMPOSED and nothing
 * whatever about whether mail works".
 *
 * The stub ledger has the same hole, plus a mechanical one. VX3-9's acceptance
 * criterion is that the e2e "posts a real report through a stub ledger and asserts
 * THE PAYLOAD" — and the payload is the one thing nothing can currently see:
 *
 *   · the in-process stub records it in module state, which Playwright cannot
 *     read, because the app under test is a SEPARATE STANDALONE SERVER; and
 *   · `integration_post` stores `external_id`, `installation_id` and `status` but
 *     NOT what was sent, so the database cannot answer either.
 *
 * So the payload has to leave the process. This is a ledger that accepts a bill
 * over HTTP and serves back what it was given, in one Node process with no
 * dependencies — no Docker, nothing for CI or a laptop to install.
 *
 * ── What it proves that the in-process stub cannot ──────────────────────────
 *
 * 1. THE PAYLOAD. What actually went over the wire, per tenant.
 * 2. THE AUTHORISATION. The `Authorization` header is recorded, so a test can
 *    assert the OAuth access token arrived — which is the regression assertion for
 *    the defect VX3-9a fixed, where core handed OAUTH2 adapters an empty config and
 *    the token never left the database.
 * 3. THE REAL TRANSPORT. `fetch`, a status code, a JSON body, a timeout — the code
 *    path that ships, rather than a function call that cannot fail in the ways a
 *    network does.
 *
 * ── Two ports, deliberately ─────────────────────────────────────────────────
 *
 * The LEDGER port is what the app posts to. The CONTROL port is what the test
 * reads. Same split as the mail sink, and the reason is the same: Playwright's
 * `webServer.port` probe has to watch a port the app does not also depend on, and
 * a test that could POST bills to the control port would be able to fake its own
 * evidence.
 */
import { createServer } from 'node:http';

const LEDGER_PORT = Number(process.env.E2E_LEDGER_PORT ?? 9411);
const CONTROL_PORT = Number(process.env.E2E_LEDGER_CONTROL_PORT ?? 9412);

/**
 * The entity id this sink answers for. The seed configures the VeloLedger
 * installation with the same value, so `testConnection`'s "is this entity one this
 * key can see" check passes.
 */
const ENTITY_ID = process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';

/** Everything received, newest last. Bounded so a runaway drain cannot eat RAM. */
const bills = [];
const MAX_BILLS = 500;

/**
 * Set by the control port to make the next N posts fail. The e2e needs this to
 * exercise the retry and NEEDS_REVIEW paths against a REAL far end rather than a
 * thrown JavaScript error — a 502 and an exception are not the same thing to the
 * code that classifies them.
 */
/** The authorisation requests this sink has served, for the control port. */
const authorizeRequests = [];

let failNext = 0;
let failStatus = 502;
/**
 * Which call to fail, or null for "the next one, whatever it is".
 *
 * A post is THREE tool calls — `resolve_period`, `list_accounts`, `draft_bill` —
 * so an unaimed failure always lands on the first, where a 502 is a read that
 * failed and nothing was ever sent. The interesting case is a 5xx on the WRITE,
 * which may have applied at the far end; that is the whole of AC-8, and without a
 * way to aim, no test can reach it. `bills` names the plain `POST /bills` route.
 */
let failTool = null;

function shouldFail(tool) {
  if (failNext <= 0) return false;
  if (failTool !== null && failTool !== tool) return false;
  failNext -= 1;
  return true;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * VeloLedger's tool surface, enough of it to accept a bill.
 *
 * ── Why the REAL adapter, not a third stub ──────────────────────────────────
 *
 * VX3-9's criterion is two tenants on two different ledgers. Two stubs would
 * satisfy the letter of it and prove nothing extra. Pointing
 * `lib/integrations/veloledger.ts` at this sink instead means the second ledger is
 * the adapter that actually ships — its `resolve_period` call, its pre-flight
 * against `list_accounts`, its `draft_bill` payload shape, its idempotency key, its
 * status-code classification — over real HTTP.
 *
 * That also moves a tracker item that has been open since VX3-4: "the VeloLedger
 * adapter has never met a real VeloLedger". It still hasn't met a real one, and
 * this does not pretend otherwise. But it now meets a real HTTP far end that
 * answers on the documented tool names, which is strictly more than the zero
 * coverage it had.
 *
 * The routes mirror their REST shape: `POST /api/v1/<tool>`.
 */
const LEDGER_ACCOUNTS = [
  // Enough of VX3-1's starter chart for the pre-flight to pass. Numbers match,
  // which is the whole reason VX3-1 took VeloLedger's numbering verbatim.
  { id: 'acc-68100', number: '68100', name: 'Travel', type: 'expense', isActive: true },
  { id: 'acc-68200', number: '68200', name: 'Meals & Entertainment', type: 'expense', isActive: true },
  { id: 'acc-68300', number: '68300', name: 'Office Supplies', type: 'expense', isActive: true },
  { id: 'acc-20100', number: '20100', name: 'Trade Payables', type: 'liability', isActive: true },
];

async function veloLedgerTool(tool, req, res) {
  if (shouldFail(tool)) {
    return json(res, failStatus, {
      error: { code: 'SINK_REFUSED', message: `the ledger refused ${tool} (${failStatus})` },
    });
  }

  if (tool === 'list_entities') {
    return json(res, 200, { entities: [{ id: ENTITY_ID, name: 'Sink Entity' }] });
  }
  if (tool === 'resolve_period') {
    return json(res, 200, { periodId: '00000000-0000-4000-8000-000000000009', state: 'open' });
  }
  if (tool === 'list_accounts') {
    return json(res, 200, { accounts: LEDGER_ACCOUNTS });
  }
  if (tool === 'draft_bill') {
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 422, { error: { code: 'BAD_JSON', message: 'not JSON' } });
    }

    // IDEMPOTENCY, honoured rather than faked. VX3-4's whole double-post argument
    // rests on the far end refusing a repeated key, so a sink that cheerfully
    // created a second bill would make that test vacuous.
    const key = payload.idempotencyKey;
    if (key) {
      const existing = bills.find((b) => b.payload?.idempotencyKey === key);
      if (existing) {
        return json(res, 200, {
          billId: existing.billId,
          humanReviewUrl: `http://localhost:${LEDGER_PORT}/bills/${existing.billId}`,
          created: false,
        });
      }
    }

    const billId = `sink-bill-${bills.length + 1}`;
    bills.push({
      billId,
      receivedAt: new Date().toISOString(),
      via: 'veloledger',
      authorization: req.headers.authorization ?? null,
      externalAccount: payload.entityId ?? null,
      payload,
    });
    if (bills.length > MAX_BILLS) bills.shift();
    return json(res, 200, {
      billId,
      humanReviewUrl: `http://localhost:${LEDGER_PORT}/bills/${billId}`,
      created: true,
    });
  }
  return json(res, 404, { error: { code: 'UNKNOWN_TOOL', message: tool } });
}

/**
 * ── VX3-9b: a consent screen, because the redirect has to be WALKED ──────────
 *
 * `stub-oauth` sent the browser to `https://stub.invalid`, which is unreachable by
 * design — fine for a vitest suite that calls `completeAuthorisation` directly,
 * and useless for the one part of the OAuth flow a unit test cannot stand in for:
 * the round trip LEAVES the product and comes back. That is the flow VX2-10's
 * `/approve` form was dead on arrival in, and the reason 9b exists at all.
 *
 * So this serves a real page, over HTTP, with two buttons a browser can click:
 * Allow redirects to the callback with a code, Deny redirects with
 * `error=access_denied`. Both are GETs, because that is what every real provider
 * does and what the callback route has to survive.
 *
 * `redirect_uri` is echoed into HTML, so it is escaped — not because a test double
 * has an attacker, but because an unescaped `&` in a query string silently breaks
 * the form and the failure would look like an app bug.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function consentPage(state, redirectUri) {
  const target = escapeHtml(redirectUri);
  const s = escapeHtml(state);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stub Ledger — authorise</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto">
  <h1>Stub Ledger</h1>
  <p>VeloExpense would like to draft bills in <strong>E2E Company</strong>.</p>
  <form method="GET" action="${target}">
    <input type="hidden" name="code" value="e2e-consent-code">
    <input type="hidden" name="state" value="${s}">
    <input type="hidden" name="realmId" value="e2e-company">
    <button type="submit">Allow</button>
  </form>
  <form method="GET" action="${target}">
    <input type="hidden" name="error" value="access_denied">
    <input type="hidden" name="error_description" value="You declined at Stub Ledger. Nothing was changed.">
    <input type="hidden" name="state" value="${s}">
    <button type="submit">Deny</button>
  </form>
</body></html>`;
}

const ledger = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;

  // The consent screen. GET, and it changes nothing here — the far end's decision
  // is carried by the redirect the buttons perform.
  if (pathname === '/oauth/authorize') {
    const q = new URL(req.url, 'http://x').searchParams;
    const state = q.get('state') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    authorizeRequests.push({
      at: new Date().toISOString(),
      state,
      redirectUri,
      // Recorded so a test can assert the redirect_uri the APP built, which is the
      // one thing here that is the product's own doing (APP_URL + the slug).
      query: Object.fromEntries(q.entries()),
    });
    if (!state || !redirectUri) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('the stub authorize endpoint needs state and redirect_uri');
    }
    const body = consentPage(state, redirectUri);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  // The VeloLedger tool surface.
  const toolMatch = /^\/api\/v1\/([a-z_]+)$/.exec(pathname);
  if (toolMatch && req.method === 'POST') {
    if (!req.headers.authorization) {
      // A real far end gates the draft tools on a key; refusing an unauthenticated
      // call is what makes "the token arrived" an assertion rather than an
      // assumption.
      return json(res, 401, { error: { code: 'NO_KEY', message: 'missing bearer token' } });
    }
    return veloLedgerTool(toolMatch[1], req, res);
  }

  if (req.method !== 'POST' || !req.url.startsWith('/bills')) {
    return json(res, 404, { error: 'POST /bills, or POST /api/v1/<tool>' });
  }

  if (shouldFail('bills')) {
    // Deliberately a REAL status code. 5xx is ambiguous (the far end may have
    // applied it) and 4xx is a refusal — the distinction AC-8 and AC-17 are about,
    // and the app must classify it from the wire rather than from a stub flag.
    return json(res, failStatus, { error: `the ledger refused this bill (${failStatus})` });
  }

  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'not JSON' });
  }

  const billId = `sink-bill-${bills.length + 1}`;
  bills.push({
    billId,
    receivedAt: new Date().toISOString(),
    via: 'stub-oauth',
    // The headers a test needs to prove WHO posted and with WHAT credential.
    // Recorded verbatim: this is a test double, and redacting the thing under test
    // would defeat the point.
    authorization: req.headers.authorization ?? null,
    externalAccount: req.headers['x-external-account'] ?? null,
    payload,
  });
  if (bills.length > MAX_BILLS) bills.shift();

  return json(res, 200, { billId, humanReviewUrl: `http://localhost:${LEDGER_PORT}/bills/${billId}` });
});

const control = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);

  if (req.method === 'GET' && url.pathname === '/authorizations') {
    // What the consent screen was asked for, so the e2e can assert the redirect
    // the app built rather than the one it assumed.
    return json(res, 200, { count: authorizeRequests.length, requests: authorizeRequests });
  }

  if (req.method === 'GET' && url.pathname === '/bills') {
    // Optional filter, so a two-tenant test can ask "what did THIS tenant send"
    // without hand-filtering a shared list in every assertion.
    const account = url.searchParams.get('account');
    const matching = account
      ? bills.filter((b) => b.externalAccount === account)
      : bills;
    return json(res, 200, { count: matching.length, bills: matching });
  }

  if (req.method === 'POST' && url.pathname === '/fail-next') {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    failNext = Number(parsed.count ?? 1);
    failStatus = Number(parsed.status ?? 502);
    // A tool NAME, so a test can aim the failure at `draft_bill` rather than at
    // whichever call happens to come first.
    failTool = parsed.tool ? String(parsed.tool) : null;
    return json(res, 200, { failNext, failStatus, failTool });
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    bills.length = 0;
    authorizeRequests.length = 0;
    failNext = 0;
    failStatus = 502;
    failTool = null;
    return json(res, 200, { ok: true });
  }

  return json(res, 404, {
    error: 'GET /bills[?account=], GET /authorizations, POST /fail-next, POST /reset',
  });
});

ledger.listen(LEDGER_PORT, () => {
  control.listen(CONTROL_PORT, () => {
    // Playwright waits on the CONTROL port, and this line is what a human looks
    // for when a run fails: VX2-10's receipt failures were three specs blaming
    // uploads while the storage sink's startup line was simply absent from the log.
    console.log(
      `e2e ledger sink: POST http://localhost:${LEDGER_PORT}/{bills,api/v1/<tool>} · ` +
        `consent GET http://localhost:${LEDGER_PORT}/oauth/authorize · ` +
        `control http://localhost:${CONTROL_PORT} · entity ${ENTITY_ID}`,
    );
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    ledger.close();
    control.close();
    process.exit(0);
  });
}
