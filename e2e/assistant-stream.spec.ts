import { expect, test } from '@playwright/test';
import { closeTestDb, testDb } from './support/test-db';

/**
 * f63 — the assistant's answer STREAMS through the real server.
 *
 * Runs only under `playwright.assistant.config.ts` (`npm run e2e:assistant`): a standalone
 * server with a placeholder key, pointed at `scripts/e2e-anthropic.mjs`, a fake Messages API on
 * loopback that sends its answer in four pieces 300 ms apart. Not ported — ExpenseOS has no
 * streaming e2e; its real-model specs assert on the finished answer, which a buffered stream
 * passes too.
 *
 * What it pins:
 *   · the browser receives the text in several reads, spread over time — a server, proxy or
 *     compression layer that buffered the response would deliver it in one read at the end;
 *   · the frames arrive in order and join to the model's answer, then `done`;
 *   · every Messages API call the turn made is metered: an `ai_usage` row per call, feature
 *     `assistant`, `metered`, the request id the model returned, against the person who asked.
 */

const ANSWER = 'Streaming answer from the fake model.';

test.afterAll(async () => {
  await closeTestDb();
});

test('the answer arrives in pieces as the model sends them, and every call is metered', async ({ page }) => {
  // The admin's stored session (the chromium project's storageState).
  await page.goto('/dashboard');

  const result = await page.evaluate(async () => {
    const t0 = performance.now();
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'How do I submit a report?', locale: 'en' }),
    });
    const reads: { at: number; text: string }[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        reads.push({ at: performance.now() - t0, text: decoder.decode(value, { stream: true }) });
      }
    }
    return { status: res.status, contentType: res.headers.get('content-type'), reads };
  });

  expect(result.status).toBe(200);
  expect(result.contentType).toContain('text/event-stream');

  // Parse the frames, remembering which read each arrived in.
  const frames: { read: number; at: number; event: { type: string; text?: string } }[] = [];
  let buffer = '';
  result.reads.forEach((r, read) => {
    buffer += r.text;
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line) frames.push({ read, at: r.at, event: JSON.parse(line.slice(6)) });
      cut = buffer.indexOf('\n\n');
    }
  });

  const types = frames.map((f) => f.event.type);
  expect(types[0]).toBe('open');
  expect(types).toContain('done');
  expect(types).not.toContain('error');

  const texts = frames.filter((f) => f.event.type === 'text');
  expect(texts.map((f) => f.event.text).join('')).toBe(ANSWER);

  // Incremental: the text came in more than one read, and the first piece was in the browser
  // well before the last — the fake waits 300 ms between pieces, so a buffered response would
  // put every piece in one read at one instant.
  expect(new Set(texts.map((f) => f.read)).size).toBeGreaterThanOrEqual(3);
  expect(texts.at(-1)!.at - texts[0].at).toBeGreaterThan(500);

  // Metered: one row per Messages API call the turn made (the streamed answer, then the fast
  // model's title and reviews), each the model's own message id.
  const calls = (await (await fetch(`http://127.0.0.1:${process.env.E2E_ANTHROPIC_PORT ?? 9631}/_e2e/calls`)).json()) as {
    id: string;
    streamed: boolean;
    hasKey: boolean;
  }[];
  const streamed = calls.filter((c) => c.streamed);
  expect(streamed.length).toBeGreaterThanOrEqual(1);
  expect(calls.every((c) => c.hasKey)).toBe(true);

  const db = await testDb('assistant-stream.spec.ts');
  const ids = calls.map((c) => c.id);
  const rowsFor = async () =>
    (
      await db.query(
        `SELECT request_id, feature, metered, actor_user_id FROM ai_usage WHERE request_id = ANY($1::text[])`,
        [ids],
      )
    ).rows as { request_id: string; feature: string; metered: boolean; actor_user_id: string | null }[];
  await expect.poll(async () => (await rowsFor()).length, { timeout: 15_000 }).toBe(ids.length);
  const rows = await rowsFor();
  for (const r of rows) expect(r).toMatchObject({ feature: 'assistant', metered: true });
  expect(rows.map((r) => r.request_id).sort()).toEqual([...ids].sort());
  for (const c of streamed) expect(rows.map((r) => r.request_id)).toContain(c.id);
  // Against the person who asked — one person, and a real one.
  expect(new Set(rows.map((r) => r.actor_user_id)).size).toBe(1);
  expect(rows[0].actor_user_id).not.toBeNull();
});
