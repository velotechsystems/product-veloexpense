/**
 * f63 — a fake Anthropic Messages API for the assistant's streaming e2e.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The chat route streams the model's answer to the browser as server-sent events. Every unit
 * and route test of it reads a stream assembled in memory, which proves the frames are
 * COMPOSED and nothing about whether a running server delivers them as they happen — a proxy,
 * a compression layer or a buffered Response turns a stream into one late blob, which looks
 * exactly like a slow model. Only a real standalone server, a real browser `fetch`, and a model
 * that answers slowly can show the difference. A real model cannot run in CI (no key, and it
 * would be nondeterministic), so this is the model: deterministic text, sent in pieces, with a
 * pause between each.
 *
 * ── WHAT IT ANSWERS ────────────────────────────────────────────────────────
 *
 *   POST /v1/messages, stream:true  → the SDK's event sequence (message_start, one text block
 *                                     delivered as FAKE_DELTAS.length deltas FAKE_GAP_MS apart,
 *                                     message_delta with usage, message_stop).
 *   POST /v1/messages, stream:false → one short text message (the title and the two reviews,
 *                                     which tolerate any answer and return null on a bad one).
 *   GET  /_e2e/calls                → every call received, for the spec to read: the model,
 *                                     whether it streamed, and whether an x-api-key arrived
 *                                     (never the key itself).
 *
 * The app reaches it only because `ASSISTANT_FAKE_ANTHROPIC_URL` names it, and the app honours
 * that variable only for a loopback http address (server/lib/assistantClient.ts).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.E2E_ANTHROPIC_PORT ?? 9631);
const HOST = '127.0.0.1';

/** The answer, in the pieces the stream sends. e2e/assistant-stream.spec.ts asserts on the joined text. */
const FAKE_DELTAS = ['Streaming ', 'answer ', 'from the ', 'fake model.'];
const FAKE_GAP_MS = 300;

const calls = [];
let seq = 0;
/** Unique per run, so a row left by an earlier run on the same database can never match. */
const RUN = Date.now().toString(36);

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamMessage(res, model, id) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 1 },
    },
  });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const text of FAKE_DELTAS) {
    await sleep(FAKE_GAP_MS);
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 24 } });
  send('message_stop', {});
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/_e2e/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
    const body = await readBody(req);
    const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
    seq += 1;
    const streamed = body.stream === true;
    const id = `msg_fake_${RUN}_${streamed ? 'stream' : 'once'}_${seq}`;
    calls.push({ id, model, streamed, hasKey: Boolean(req.headers['x-api-key']) });
    if (streamed) {
      await streamMessage(res, model, id);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'Fake title' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 5 },
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake: no such route' } }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`e2e anthropic: port ${PORT} is in use — stop what holds it or set E2E_ANTHROPIC_PORT`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => console.log(`e2e anthropic listening on http://${HOST}:${PORT}`));
