// @vitest-environment node
/**
 * w5-02a — the Slack half of ExpenseOS's notification dispatch, as VeloExpense sends it.
 *
 * Ported from ExpenseOS `apps/worker/src/handlers/notification-dispatch.test.ts` (1e682dd6):
 * "resolving the recipient's Slack id", "detailSections" and the Slack block shape. Their
 * comments come with them. VeloExpense: `resolveSlackId` RETURNS the cache write instead of
 * making it (it is written after the send, in the outbox's second transaction), so where
 * ExpenseOS asserts on `db.user.update`, these assert on `write`; and the stale-id repair is
 * `clearCache` on the outcome. The end-to-end path is `test/slack-delivery.db.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lookupSlackUser: vi.fn(),
  sendSlack: vi.fn(),
}));
vi.mock('@/lib/notifications/slack', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications/slack')>()),
  lookupSlackUser: h.lookupSlackUser,
  sendSlack: h.sendSlack,
}));

import { SlackApiError } from '@/lib/notifications/slack';
import {
  detailSections,
  resetSlackWarnings,
  resolveSlackId,
  sendPreparedSlack,
  slackBlocks,
  slackText,
  type PreparedSlack,
} from '@/lib/notifications/slackDispatch';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12);
const ago = (ms: number | null) => (ms === null ? null : new Date(NOW - ms));

beforeEach(() => {
  h.lookupSlackUser.mockReset();
  h.sendSlack.mockReset();
  resetSlackWarnings();
});
afterEach(() => vi.restoreAllMocks());

/**
 * The cached Slack id, and every way it is allowed to be corrected.
 *
 * `if (cached) return cached` meant a resolved id was never re-examined, so somebody who
 * moved to a different Slack account was unreachable forever; a negative was pinned for
 * seven days, so correcting an address left them silent for a week. The cache still
 * exists — `users.lookupByEmail` is rate-limited and a fan-out asks about a dozen people
 * at once — but it now has three repair paths instead of none.
 */
describe('resolving the recipient’s Slack id', () => {
  const resolve = (cached: string | null, agoMs: number | null) =>
    resolveSlackId('ada@example.test', cached, ago(agoMs), 'xoxb', NOW);

  it('uses a fresh cached id without asking Slack again', async () => {
    // The reason the cache exists at all. `users.lookupByEmail` is rate-limited and a
    // submit fans out to every approver at once.
    await expect(resolve('U-cached', 3 * DAY)).resolves.toEqual({
      slackId: 'U-cached',
      write: null,
      inconclusive: null,
    });
    expect(h.lookupSlackUser).not.toHaveBeenCalled();
  });

  it('re-checks a cached id that has gone a month without confirmation', async () => {
    /**
     * The defect: `if (cached) return cached` never asked again, so a person whose Slack
     * account changed was unreachable for good — no expiry, no lookup, nothing.
     */
    h.lookupSlackUser.mockResolvedValue({ outcome: 'found', userId: 'U-new' });
    const out = await resolve('U-old', 40 * DAY);
    expect(h.lookupSlackUser).toHaveBeenCalledWith('xoxb', 'ada@example.test');
    expect(out.slackId).toBe('U-new');
    expect(out.write).toEqual({ slackUserId: 'U-new', slackLookupAt: new Date(NOW) });
  });

  it('does not re-ask about somebody Slack said it has never heard of, for a week', async () => {
    // The throttle that justifies caching a negative at all.
    await expect(resolve(null, 3 * DAY)).resolves.toMatchObject({ slackId: null, write: null });
    expect(h.lookupSlackUser).not.toHaveBeenCalled();
  });

  it('asks again once that week is up', async () => {
    /**
     * The other half of the defect: somebody who fixed the email on their Slack account
     * had to wait out the TTL. Seven days, not never — and /profile can cut it short.
     */
    h.lookupSlackUser.mockResolvedValue({ outcome: 'found', userId: 'U-now' });
    await expect(resolve(null, 8 * DAY)).resolves.toMatchObject({ slackId: 'U-now' });
  });

  it('never caches a rate limit as "this person has no Slack account"', async () => {
    /**
     * The expensive one. `lookupSlackUserId` returned `null` for a rate limit exactly as
     * it did for a genuine miss, and the caller wrote that down and stopped asking for a
     * week — so one busy fan-out silenced somebody for seven days.
     *
     * VeloExpense: and it says so, so the outbox retries it rather than dropping it.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.lookupSlackUser.mockResolvedValue({ outcome: 'inconclusive', detail: 'ratelimited' });
    await expect(resolve(null, null)).resolves.toEqual({
      slackId: null,
      write: null,
      inconclusive: 'ratelimited',
    });
  });

  it('keeps delivering to a known id through an inconclusive lookup', async () => {
    // A Slack outage during the monthly re-check must not stop a working DM.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.lookupSlackUser.mockResolvedValue({ outcome: 'inconclusive', detail: 'HTTP 502' });
    await expect(resolve('U-cached', 40 * DAY)).resolves.toEqual({
      slackId: 'U-cached',
      write: null,
      inconclusive: null,
    });
  });

  it('keeps a cached id Slack’s directory no longer corroborates, and says so', async () => {
    /**
     * The ordinary cause of a re-check coming back empty is that the person changed the
     * email on their Slack account — the account is fine and the DM still arrives. Blanking
     * the id on that evidence would break a channel that works. It is kept, the timestamp
     * moves so we stop re-asking, and the operator is told once.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.lookupSlackUser.mockResolvedValue({ outcome: 'not_found' });
    const out = await resolve('U-cached', 40 * DAY);
    expect(out.slackId).toBe('U-cached');
    expect(out.write).toEqual({ slackUserId: 'U-cached', slackLookupAt: new Date(NOW) });
    expect(warn.mock.calls.flat().join(' ')).toContain('ada@example.test');
  });

  it('caches a genuine "no account" as a negative', async () => {
    h.lookupSlackUser.mockResolvedValue({ outcome: 'not_found' });
    await expect(resolve(null, null)).resolves.toEqual({
      slackId: null,
      write: { slackUserId: null, slackLookupAt: new Date(NOW) },
      inconclusive: null,
    });
  });
});

describe('sending one prepared DM', () => {
  const prepared = (cachedId: string | null, lookupAt: Date | null): PreparedSlack => ({
    kind: 'SLACK',
    botToken: 'xoxb',
    recipientId: 'u-recipient',
    email: 'ada@example.test',
    cachedId,
    lookupAt,
    text: 'hello',
    blocks: [],
    threadId: 't1',
    threadTs: null,
  });
  const fresh = () => new Date(Date.now() - DAY);

  it('posts to the resolved id, under the thread root when there is one', async () => {
    h.sendSlack.mockResolvedValue({ channel: 'D1', ts: '1.1' });
    const out = await sendPreparedSlack({ ...prepared('U1', fresh()), threadTs: '9.9' });
    expect(h.sendSlack).toHaveBeenCalledWith('xoxb', {
      channel: 'U1',
      text: 'hello',
      blocks: [],
      threadTs: '9.9',
    });
    expect(out).toMatchObject({ kind: 'SENT', slackId: 'U1', ref: { channel: 'D1', ts: '1.1' } });
  });

  it('forgets the cached id when Slack itself rejects it', async () => {
    /**
     * The repair path that needs no timer and no human: `channel_not_found` is Slack
     * saying the id is dead, which is the one piece of evidence that a lookup cannot
     * produce — the email may still resolve to a different account entirely. Both columns
     * are cleared, `slackLookupAt` included, so the NEXT notification resolves immediately
     * rather than waiting out a throttle.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.sendSlack.mockRejectedValue(new SlackApiError('chat.postMessage', 'channel_not_found'));
    const out = await sendPreparedSlack(prepared('U-dead', fresh()));
    expect(out).toMatchObject({ kind: 'FAILED', clearCache: true });
  });

  it('does NOT forget the id for a failure that is about the bot, not the person', async () => {
    /**
     * `invalid_auth` is the integration's token. Clearing the recipient's id on it would
     * blank every user in the org one notification at a time while the actual problem sat
     * in the config — and then a week of negative caching on top.
     */
    h.sendSlack.mockRejectedValue(new SlackApiError('chat.postMessage', 'invalid_auth'));
    const out = await sendPreparedSlack(prepared('U-fine', fresh()));
    expect(out).toMatchObject({ kind: 'FAILED', clearCache: false });
  });

  it('sends nothing to somebody Slack has no account for', async () => {
    h.lookupSlackUser.mockResolvedValue({ outcome: 'not_found' });
    const out = await sendPreparedSlack(prepared(null, null));
    expect(out.kind).toBe('NO_ACCOUNT');
    expect(h.sendSlack).not.toHaveBeenCalled();
  });

  it('fails, to be retried, when Slack could not be asked and nothing is cached', async () => {
    // VeloExpense: ExpenseOS drops this notification; the outbox retries it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.lookupSlackUser.mockResolvedValue({ outcome: 'inconclusive', detail: 'ratelimited' });
    const out = await sendPreparedSlack(prepared(null, null));
    expect(out).toMatchObject({ kind: 'FAILED', write: null, clearCache: false });
    if (out.kind === 'FAILED') expect(out.error.message).toContain('ratelimited');
    expect(h.sendSlack).not.toHaveBeenCalled();
  });
});

describe('the Slack message', () => {
  const buttonsOf = (blocks: unknown[]) =>
    (blocks as Array<{ type: string; elements?: unknown[] }>)
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements ?? []);

  it('gives an approver one primary URL button, which decides nothing in Slack', () => {
    const blocks = slackBlocks('msg', 'https://acme.example.test/expenses/r1', 'Review', true);
    expect(buttonsOf(blocks)).toEqual([
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Review' },
        url: 'https://acme.example.test/expenses/r1',
        style: 'primary',
      },
    ]);
    expect(buttonsOf(blocks)[0]).not.toHaveProperty('action_id');
    expect(buttonsOf(blocks)[0]).not.toHaveProperty('value');
  });

  it('styles the button primary only for an approver', () => {
    expect(buttonsOf(slackBlocks('msg', 'https://x.example.test', 'View', false))).toEqual([
      { type: 'button', text: { type: 'plain_text', text: 'View' }, url: 'https://x.example.test' },
    ]);
  });

  it('renders no actions block when there is no deep link', () => {
    expect(slackBlocks('msg', null, 'View', true).some((b) => (b as { type: string }).type === 'actions')).toBe(false);
  });

  it('opens with the context line naming the subject', () => {
    expect(slackBlocks('msg', null, 'View', false, '*Expense report*')[0]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '*Expense report*' }],
    });
  });

  it("quotes the approver's note under the message, escaped, a line at a time", () => {
    // ExpenseOS 67db2e33 (#578).
    const blocks = slackBlocks('msg', null, 'View', false, null, [], {
      label: 'Note from the approver:',
      text: 'Attach the <folio>.\nAnd the stub.',
    });
    expect(blocks[1]).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Note from the approver:*\n>Attach the &lt;folio&gt;.\n>And the stub.',
      },
    });
  });

  it('escapes what Slack would read as markup, and nothing else', () => {
    // VeloExpense: applied to the template body, which interpolates text people type.
    expect(slackText('<https://example.test|Approve> & "quotes"')).toBe(
      '&lt;https://example.test|Approve&gt; &amp; "quotes"',
    );
  });
});

describe('detailSections', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
  const fieldsOf = (out: unknown[]) => out.flatMap((s) => (s as { fields: unknown[] }).fields);

  it('keeps every section within the Slack hard cap of ten', () => {
    // One over-long `fields` array is refused by `chat.postMessage` wholesale — the message
    // does not degrade, it fails to send.
    const out = detailSections(rows(23));
    expect(out).toHaveLength(3);
    expect(out.map((s) => (s as { fields: unknown[] }).fields.length)).toEqual([10, 10, 3]);
  });

  it('loses no row to the split, and keeps them in order', () => {
    const out = fieldsOf(detailSections(rows(23))) as Array<{ text: string }>;
    expect(out).toHaveLength(23);
    expect(out[0].text).toBe('*L0*\nV0');
    expect(out[22].text).toBe('*L22*\nV22');
  });

  it('renders nothing for no rows, rather than an empty section', () => {
    // An empty `fields` array is itself invalid to Slack.
    expect(detailSections([])).toEqual([]);
    expect(detailSections([{ label: '  ', value: '  ' }])).toEqual([]);
  });
});
