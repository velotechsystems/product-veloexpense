/**
 * VX2-10 — a real SMTP server for the e2e run.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every VX2-8 test runs on the in-memory transport, which proves a message was
 * COMPOSED and nothing whatever about whether mail works. That is not a
 * theoretical gap — it is the exact trap VX1-9 wrote down for MemoryStorage:
 *
 *   "MemoryStorage signs `memory://` URLs no browser can fetch, which is why the
 *    vitest suites can be green while a real upload is broken."
 *
 * Same shape here. A memory transport cannot catch a message nodemailer refuses
 * to build, a header it drops, or — the one that actually bites — a URL the
 * quoted-printable encoder breaks across two lines, which would make every
 * approve link in production dead while 24 tests stayed green.
 *
 * `smtp-server` (a devDependency, same author as nodemailer) gives us a real
 * server in one Node process: no Docker, no Mailpit, nothing for CI or a laptop
 * to install. Exactly the argument scripts/e2e-storage.mjs makes for s3rver.
 *
 * ── Two ports, and why ──────────────────────────────────────────────────────
 *
 *   SMTP (E2E_SMTP_PORT, 2525)      what the app talks to.
 *   HTTP (E2E_MAIL_HTTP_PORT, 2526) what the SPEC talks to, because a Playwright
 *                                   test cannot open an SMTP session and should
 *                                   not try. GET /messages returns what arrived;
 *                                   DELETE /messages clears it.
 *
 * Playwright waits on the HTTP port for readiness, since it cannot probe SMTP.
 *
 *   node scripts/e2e-mail.mjs        # foreground, Ctrl-C to stop
 */
import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 2525);
const HTTP_PORT = Number(process.env.E2E_MAIL_HTTP_PORT ?? 2526);

/** Everything that has arrived this run. Cleared by DELETE /messages. */
const received = [];

/**
 * Undo quoted-printable, which is the whole reason this sink parses at all.
 *
 * nodemailer encodes a text part as quoted-printable when it has long lines, and
 * an approve link is a long line — so `…/approve?token=abc` arrives as
 * `…/approve?token=3Dabc` with a soft `=\r\n` break somewhere in the middle of
 * the token. A spec that regexed the raw stream would extract a truncated token,
 * fail with "this link no longer works", and send somebody hunting through the
 * token code for a bug that is in the mail encoding.
 *
 * Two transformations, in this order:
 *   1. remove soft line breaks (`=` at end of line)
 *   2. decode `=XX` hex escapes — `?token=` itself becomes `=3D`
 */
function decodeQuotedPrintable(text) {
  return text
    .replace(/=(?:\r\n|\n|\r)/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Split an RFC 822 blob into headers and a decoded body. */
function parse(raw) {
  const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const headerBlock = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).trimStart() : '';

  const headers = {};
  // Unfold continuation lines (a leading space or tab continues the previous
  // header) before splitting, or a long References value arrives truncated.
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }

  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  let text = body;
  if (encoding.includes('quoted-printable')) text = decodeQuotedPrintable(body);
  else if (encoding.includes('base64')) {
    text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  // A multipart message keeps every part in `text`; the sink does not split them,
  // because everything a spec looks for (a URL, a subject line, a header) is
  // findable in the whole blob and splitting invites its own bugs. The soft-break
  // decode is applied to the lot, which is why it runs on the raw body too.
  if (!encoding && /quoted-printable/i.test(raw)) text = decodeQuotedPrintable(body);

  return { headers, text, raw };
}

const smtp = new SMTPServer({
  // No TLS, no auth: it listens on 127.0.0.1 and exists for the length of one
  // test run. Disabling them explicitly rather than leaving them optional means
  // the app's transport cannot silently negotiate something this cannot answer.
  secure: false,
  authOptional: true,
  disabledCommands: ['STARTTLS', 'AUTH'],
  hideSTARTTLS: true,
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = parse(raw);
      received.push({
        to: session.envelope.rcptTo.map((r) => r.address),
        from: session.envelope.mailFrom?.address ?? null,
        subject: parsed.headers.subject ?? '',
        headers: parsed.headers,
        text: parsed.text,
        raw,
        receivedAt: new Date().toISOString(),
      });
      callback();
    });
    stream.on('error', callback);
  },
});

smtp.on('error', (err) => {
  // Logged rather than thrown: an SMTP-level error must not take the sink down
  // mid-run, because a dead sink turns one informative failure into every
  // subsequent test timing out on a port that stopped answering.
  //
  // ONE EXCEPTION, handled below: a port that was never acquired. There is no run
  // to protect yet, and staying alive without a listener is the silent failure
  // this whole file exists to avoid.
  console.error('[e2e-mail] smtp error', err.message);
});

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${HTTP_PORT}`);
  if (url.pathname === '/messages' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (url.pathname === '/messages' && req.method === 'DELETE') {
    received.length = 0;
    res.writeHead(204).end();
    return;
  }
  // Playwright probes the root for readiness.
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`e2e-mail: smtp on ${SMTP_PORT}, ${received.length} message(s) held\n`);
    return;
  }
  res.writeHead(404).end();
});

// Same treatment as the storage sink: Playwright no longer reuses whatever is on
// these ports, so a busy port stops the run, and a named port with a command to
// run beats a bare EADDRINUSE in a webServer log.
for (const [server, label] of [
  [smtp, 'SMTP'],
  [http, 'inbox HTTP'],
]) {
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const port = label === 'SMTP' ? SMTP_PORT : HTTP_PORT;
      console.error(
        `[e2e-mail] the ${label} port ${port} is already in use, so the mail sink cannot start.\n` +
          `  Find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          `  Then stop it, or set E2E_SMTP_PORT / E2E_MAIL_HTTP_PORT.`,
      );
      process.exit(1);
    }
  });
}

smtp.listen(SMTP_PORT, '127.0.0.1', () => {
  http.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(
      `e2e mail: SMTP on 127.0.0.1:${SMTP_PORT}, inbox on http://127.0.0.1:${HTTP_PORT}/messages`,
    );
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    smtp.close(() => http.close(() => process.exit(0)));
  });
}
