// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSlackConfigStatus,
  isStaleSlackRecipient,
  lookupSlackUser,
  SlackApiError,
  sendSlack,
  slackConfigProblem,
  slackInboundGate,
  verifySlackSignature,
  verifySlackToken,
} from './slack';

/**
 * Slack delivery and — the part that actually matters — inbound request verification.
 * The module was 23% covered.
 *
 * `verifySlackSignature` is what stands between "an approver replied in Slack" and
 * "anybody who can POST to the endpoint commented as that approver". It gets the most
 * attention here: the signature, the replay window, and the constant-time compare are
 * each a way in if they are wrong.
 */

/** A `vi.fn` rather than a plain passthrough so one test can make decryption FAIL —
 *  which is what a missing `PG_CRYPTO_KEY` looks like from here.
 *  VeloExpense: `decryptSecret` (lib/crypto/secrets.ts) per field, and the key is
 *  `SECRET_ENCRYPTION_KEY`. */
const decryptSecret = vi.hoisted(() => vi.fn((value: string) => value));
vi.mock('@/lib/crypto/secrets', () => ({ decryptSecret }));

beforeEach(() => {
  // Re-established rather than set once: `mockReset` clears the implementation too, and a
  // suite that only clears call history leaks an override into every test after it.
  decryptSecret.mockReset();
  decryptSecret.mockImplementation((value: string) => value);
});

afterEach(() => vi.restoreAllMocks());

/** Sign a body the way Slack does, so a valid request can be constructed. */
const sign = (secret: string, ts: string, body: string) =>
  `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

/** A stubbed fetch returning one JSON body. */
function stubFetch(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  // Parameters declared even though unused: an argument-less `vi.fn` infers an EMPTY
  // tuple for `mock.calls`, so `calls[0][1]` fails to typecheck — and the request body
  // is exactly what several of these assertions need to read.
  const fn = vi.fn(async (_url?: unknown, _init?: { body?: string }) => ({
    ok: init.ok ?? (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('verifySlackSignature', () => {
  const SECRET = 'shhh';
  const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
  const now = () => String(Math.floor(Date.now() / 1000));

  it('accepts a correctly signed, fresh request', () => {
    const ts = now();
    expect(verifySlackSignature(SECRET, ts, BODY, sign(SECRET, ts, BODY))).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const ts = now();
    expect(verifySlackSignature(SECRET, ts, BODY, sign('wrong', ts, BODY))).toBe(false);
  });

  it('rejects a tampered body', () => {
    // The signature covers the RAW body, so changing one character invalidates it —
    // this is what stops an approve payload being rewritten into a different task.
    const ts = now();
    const sig = sign(SECRET, ts, BODY);
    expect(verifySlackSignature(SECRET, ts, `${BODY}&extra=1`, sig)).toBe(false);
  });

  it('rejects a replayed timestamp outside the 5-minute window', () => {
    // Both directions: a captured request cannot be replayed later, and a clock far
    // ahead cannot pre-sign one.
    for (const offset of [-301, 301]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      expect(verifySlackSignature(SECRET, ts, BODY, sign(SECRET, ts, BODY))).toBe(false);
    }
  });

  it('accepts a request just inside the window', () => {
    /**
     * ±299, not ±300. The comparison is `Math.abs(Date.now() / 1000 - ts) > 300` and
     * `Date.now() / 1000` is NOT floored, so it carries a sub-second remainder while
     * `ts` is whole seconds. At exactly ±300 the boundary therefore lands on either
     * side depending on where in the current second the test runs — asserting it would
     * be asserting a precision the implementation does not promise. The window is
     * "about five minutes", and one second of fuzz at the edge is not a security
     * property worth pinning.
     */
    for (const offset of [-299, 299]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      expect(verifySlackSignature(SECRET, ts, BODY, sign(SECRET, ts, BODY))).toBe(true);
    }
  });

  it('rejects a missing timestamp or signature', () => {
    const ts = now();
    expect(verifySlackSignature(SECRET, null, BODY, sign(SECRET, ts, BODY))).toBe(false);
    expect(verifySlackSignature(SECRET, ts, BODY, null)).toBe(false);
  });

  it('rejects a non-numeric timestamp instead of comparing NaN', () => {
    // `Math.abs(now - NaN) > 300` is false, so without the finite check a garbage
    // timestamp would pass the freshness test.
    expect(
      verifySlackSignature(SECRET, 'not-a-number', BODY, sign(SECRET, 'not-a-number', BODY)),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, so the length is checked first.
    const ts = now();
    expect(verifySlackSignature(SECRET, ts, BODY, 'v0=short')).toBe(false);
  });
});

describe('sendSlack', () => {
  it('returns the posted channel and ts', async () => {
    stubFetch({ ok: true, ts: '1700000000.000100', channel: 'D123' });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).resolves.toEqual({
      channel: 'D123',
      ts: '1700000000.000100',
    });
  });

  it('falls back to the requested channel when Slack omits one', async () => {
    // The ts is what threading needs; the channel is echoed back for a DM, where the
    // posted channel id differs from the user id it was addressed to.
    stubFetch({ ok: true, ts: '1.1' });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).resolves.toMatchObject({
      channel: 'U1',
    });
  });

  it('passes blocks and thread_ts only when given', async () => {
    const fetchMock = stubFetch({ ok: true, ts: '1.1', channel: 'D1' });
    await sendSlack('xoxb-1', { channel: 'U1', text: 'hi' });
    const bare = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect('blocks' in bare).toBe(false);
    expect('thread_ts' in bare).toBe(false);

    await sendSlack('xoxb-1', { channel: 'U1', text: 'hi', blocks: [{ x: 1 }], threadTs: '9.9' });
    const full = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body);
    expect(full).toMatchObject({ blocks: [{ x: 1 }], thread_ts: '9.9' });
  });

  it('throws on a Slack ok:false, naming the error', async () => {
    // Callers treat Slack as best-effort but log the reason; `channel_not_found` and
    // `invalid_auth` need different fixes.
    stubFetch({ ok: false, error: 'channel_not_found' });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).rejects.toThrow(
      /channel_not_found/,
    );
  });

  it('throws when the response has no ts', async () => {
    // ok:true with no ts would otherwise be stored as a thread parent of `undefined`.
    stubFetch({ ok: true });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).rejects.toThrow(
      /chat.postMessage failed/,
    );
  });

  it('throws on an HTTP error, falling back to the status', async () => {
    stubFetch({}, { status: 500 });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).rejects.toThrow(/500/);
  });
});

describe('verifySlackToken', () => {
  it('names the workspace on success', async () => {
    stubFetch({ ok: true, user: 'veloexpense', team: 'Example Co' });
    await expect(verifySlackToken('xoxb-1')).resolves.toEqual({
      ok: true,
      message: 'Connected as veloexpense in Example Co.',
    });
  });

  it('reports Slack’s own rejection', async () => {
    stubFetch({ ok: false, error: 'invalid_auth' });
    await expect(verifySlackToken('xoxb-bad')).resolves.toMatchObject({ ok: false });
  });

  it('reports a transport failure rather than throwing', async () => {
    // It backs an admin "Test connection" button, so a DNS failure has to render as a
    // message rather than a 500.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    await expect(verifySlackToken('xoxb-1')).resolves.toEqual({
      ok: false,
      message: 'getaddrinfo ENOTFOUND',
    });
  });
});

describe('lookupSlackUser', () => {
  it('returns the id when Slack finds the email', async () => {
    stubFetch({ ok: true, user: { id: 'U999' } });
    await expect(lookupSlackUser('xoxb-1', 'a@example.test')).resolves.toEqual({
      outcome: 'found',
      userId: 'U999',
    });
  });

  it('reports `not_found` ONLY for Slack’s users_not_found', async () => {
    /**
     * The distinction the caller caches on. `users_not_found` is Slack answering the
     * question — this address has no account — and is worth remembering for a week.
     */
    stubFetch({ ok: false, error: 'users_not_found' });
    await expect(lookupSlackUser('xoxb-1', 'nobody@example.test')).resolves.toEqual({
      outcome: 'not_found',
    });
  });

  it('reports a rate limit, a bad token and a missing scope as INCONCLUSIVE', async () => {
    /**
     * The bug this type exists for. All three used to return `null`, identical to "no such
     * user", and the dispatcher wrote that down as a confirmed negative and stopped asking
     * for seven days — so a rate limit during one fan-out silenced a person for a week.
     *
     * Each is a fact about the CALL, not about the person.
     */
    for (const error of ['ratelimited', 'invalid_auth', 'missing_scope']) {
      stubFetch({ ok: false, error });
      await expect(lookupSlackUser('xoxb-1', 'a@example.test')).resolves.toEqual({
        outcome: 'inconclusive',
        detail: error,
      });
    }
  });

  it('reports an HTTP failure with no JSON body as inconclusive, naming the status', async () => {
    stubFetch(undefined, { status: 502 });
    await expect(lookupSlackUser('xoxb-1', 'a@example.test')).resolves.toEqual({
      outcome: 'inconclusive',
      detail: 'HTTP 502',
    });
  });

  it('reports a transport failure rather than throwing', async () => {
    // It runs inside the dispatch handler's try/catch, so a throw would be caught and
    // logged as "slack failed" — losing which of the two things went wrong.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    await expect(lookupSlackUser('xoxb-1', 'a@example.test')).resolves.toEqual({
      outcome: 'inconclusive',
      detail: 'getaddrinfo ENOTFOUND',
    });
  });

  it('treats ok:true with no user id as inconclusive, not as a resolved id', async () => {
    stubFetch({ ok: true, user: {} });
    await expect(lookupSlackUser('xoxb-1', 'a@example.test')).resolves.toMatchObject({
      outcome: 'inconclusive',
    });
  });

  it('URL-encodes the email', async () => {
    const fetchMock = stubFetch({ ok: true, user: { id: 'U1' } });
    await lookupSlackUser('xoxb-1', 'a+b@example.test');
    // A raw `+` in a query string decodes as a space, so it would look up the wrong
    // address and silently return "no such user".
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('a%2Bb%40example.test');
  });
});

describe('a failed post, and whether the cached id is to blame', () => {
  it('carries Slack’s error code as data, not only inside the message', async () => {
    /**
     * The dispatcher has to tell "this DM is addressed to an id that no longer exists"
     * from every other failure, and re-parsing the code out of a sentence is how a log
     * string becomes load-bearing by accident.
     */
    stubFetch({ ok: false, error: 'channel_not_found' });
    await expect(sendSlack('xoxb-1', { channel: 'U1', text: 'hi' })).rejects.toMatchObject({
      slackError: 'channel_not_found',
      method: 'chat.postMessage',
    });
  });

  it('says the cached id is stale for the errors that mean exactly that', async () => {
    for (const code of ['channel_not_found', 'user_not_found', 'users_not_found']) {
      expect(isStaleSlackRecipient(new SlackApiError('chat.postMessage', code))).toBe(true);
    }
  });

  it('does NOT blame the recipient for a failure that is about the bot', async () => {
    /**
     * `account_inactive` is the bot's own workspace, `invalid_auth` its token, `ratelimited`
     * the API. Treating any of them as a stale recipient id would blank every user's cached
     * id one dispatch at a time while the real problem sat in the integration config.
     */
    for (const code of ['account_inactive', 'invalid_auth', 'ratelimited', 'msg_too_long']) {
      expect(isStaleSlackRecipient(new SlackApiError('chat.postMessage', code))).toBe(false);
    }
  });

  it('does not mistake an ordinary Error for a Slack verdict', async () => {
    expect(isStaleSlackRecipient(new Error('channel_not_found'))).toBe(false);
    expect(isStaleSlackRecipient(null)).toBe(false);
  });
});

/**
 * VeloExpense: the tenant's `slack_connection` row through a stub `QueryRunner`, where
 * ExpenseOS stubs `db.integration.findUnique`. `undefined` and `null` are both "no row" —
 * VeloExpense has no inactive installation; disconnecting deletes the row.
 */
const configDb = (config: { botToken?: string; signingSecret?: string } | null | undefined) =>
  ({
    query: async () => ({
      rows: config
        ? [{ bot_token: config.botToken ?? '', signing_secret: config.signingSecret ?? null }]
        : [],
    }),
  }) as never;

describe('getSlackConfigStatus', () => {
  it('returns the token and signing secret', async () => {
    await expect(
      getSlackConfigStatus(configDb({ botToken: 'xoxb-1', signingSecret: 'sss' })),
    ).resolves.toEqual({ state: 'ok', botToken: 'xoxb-1', signingSecret: 'sss' });
  });

  it('returns a null signing secret when none is configured', async () => {
    // Without it inbound replies are refused, but outbound delivery still works — so
    // null is a supported state here, not a failure; `slackInboundGate` refuses it.
    await expect(getSlackConfigStatus(configDb({ botToken: 'xoxb-1' }))).resolves.toEqual({
      state: 'ok',
      botToken: 'xoxb-1',
      signingSecret: null,
    });
  });

  it('says `not-installed` when Slack is not connected', async () => {
    await expect(getSlackConfigStatus(configDb(undefined))).resolves.toEqual({
      state: 'not-installed',
    });
    await expect(getSlackConfigStatus(configDb(null))).resolves.toEqual({
      state: 'not-installed',
    });
  });

  it('distinguishes a blank BOT TOKEN from Slack never having been installed', async () => {
    /**
     * The defect. Both used to be `null`, so an installation carrying a signing secret and
     * an empty token 503'd with the words "not configured" — to an operator looking at a
     * filled-in form. The two need different fixes and now have different names.
     */
    await expect(getSlackConfigStatus(configDb({}))).resolves.toEqual({ state: 'no-bot-token' });
    await expect(getSlackConfigStatus(configDb({ botToken: '   ' }))).resolves.toEqual({
      state: 'no-bot-token',
    });
    await expect(
      getSlackConfigStatus(configDb({ botToken: '', signingSecret: 'sss' })),
    ).resolves.toEqual({ state: 'no-bot-token' });
  });

  it('trims a pasted token and secret', async () => {
    await expect(
      getSlackConfigStatus(configDb({ botToken: '  xoxb-1  ', signingSecret: '  sss  ' })),
    ).resolves.toEqual({ state: 'ok', botToken: 'xoxb-1', signingSecret: 'sss' });
  });
});

describe('a config this process cannot decrypt', () => {
  /**
   * `PG_CRYPTO_KEY` missing from the WORKER's environment — it needs it as well as the web
   * app — used to surface as `[notification.dispatch] slack failed` with a bare Error, and
   * as a 500 from either route. It is a state now, so both callers can name it.
   */
  it('names the failure instead of throwing', async () => {
    decryptSecret.mockImplementation(() => {
      throw new Error('SECRET_ENCRYPTION_KEY is not set');
    });
    await expect(getSlackConfigStatus(configDb({ botToken: 'enc:v1:zzz' }))).resolves.toMatchObject(
      { state: 'unreadable', detail: 'SECRET_ENCRYPTION_KEY is not set' },
    );
  });

  it('turns it into advice that names the variable and the process', async () => {
    // VeloExpense: `SECRET_ENCRYPTION_KEY`, and "this process" rather than "the worker" —
    // whichever process reads the connection (the drain, the events route) needs the key.
    decryptSecret.mockImplementation(() => {
      throw new Error('SECRET_ENCRYPTION_KEY is not set');
    });
    const gate = await slackInboundGate(configDb({ botToken: 'enc:v1:zzz' }));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.message).toContain('SECRET_ENCRYPTION_KEY');
    expect(gate.message).toContain('THIS process');
  });
});

describe('slackInboundGate — what an events/interactions route is told', () => {
  it('passes both secrets through when the install is complete', async () => {
    await expect(
      slackInboundGate(configDb({ botToken: 'xoxb-1', signingSecret: 'sss' })),
    ).resolves.toEqual({ ok: true, botToken: 'xoxb-1', signingSecret: 'sss' });
  });

  it('refuses a signing secret with no bot token, and says which is missing', async () => {
    const gate = await slackInboundGate(configDb({ signingSecret: 'sss' }));
    expect(gate).toMatchObject({ ok: false, state: 'no-bot-token' });
    if (gate.ok) return;
    // Asserted on the token being NAMED, not on the sentence: the wording will be
    // rewritten and the operator being told which field is blank must not be.
    expect(gate.message.toLowerCase()).toContain('bot token');
    expect(gate.message).not.toMatch(/signing secret is/i);
  });

  it('refuses a bot token with no signing secret, and says THAT instead', async () => {
    const gate = await slackInboundGate(configDb({ botToken: 'xoxb-1' }));
    expect(gate).toMatchObject({ ok: false, state: 'no-signing-secret' });
    if (gate.ok) return;
    expect(gate.message.toLowerCase()).toContain('signing secret');
  });

  it('gives the two half-configured installs DIFFERENT messages', async () => {
    /**
     * The whole defect in one assertion. Before, both produced `Slack events not
     * configured` — so the log could not tell an operator which of the two fields to go
     * and fill in, and neither could the response body Slack shows back in its console.
     */
    const noToken = await slackInboundGate(configDb({ signingSecret: 'sss' }));
    const noSecret = await slackInboundGate(configDb({ botToken: 'xoxb-1' }));
    expect(noToken.ok).toBe(false);
    expect(noSecret.ok).toBe(false);
    if (noToken.ok || noSecret.ok) return;
    expect(noToken.message).not.toBe(noSecret.message);
  });

  it('points every refusal at the runbook', async () => {
    for (const config of [undefined, {}, { botToken: 'xoxb-1' }]) {
      const gate = await slackInboundGate(configDb(config));
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.message).toContain('docs/runbooks/slack-setup.md');
    }
  });
});

describe('slackConfigProblem', () => {
  it('gives each failure its own sentence', () => {
    const states = ['not-installed', 'no-bot-token', 'no-signing-secret', 'unreadable'] as const;
    const sentences = states.map((s) => slackConfigProblem(s, 'SECRET_ENCRYPTION_KEY is not set'));
    expect(new Set(sentences).size).toBe(states.length);
  });
});
