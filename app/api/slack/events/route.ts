/**
 * Slack Events API endpoint. Turns a reply in a notification's DM thread into a
 * COMMENT on the subject. Each subject has one DM thread per recipient (the
 * dispatch worker posts the first message as the root and threads the rest); a
 * reply in that thread carries `thread_ts` = the root, which maps back to the
 * subject via ReplyThread.
 *
 * Every request is verified against the Slack signing secret (over the RAW
 * body). The thread mapping + the replier's cached Slack id authenticate the
 * actor; the comment is always attributed to the thread's recipient.
 *
 * w5-02b — ExpenseOS's `apps/web/src/app/api/slack/events/route.ts` (1e682dd6). VeloExpense,
 * each marked below:
 *   · the TENANT comes from the address (`slackTenantFor`): each tenant connects its own Slack
 *     app (decided 17 Oct 2026) whose Request URL is the tenant's own host, so the signing
 *     secret, the thread lookup and the comment are all that tenant's. A host that names no
 *     active tenant is answered 404 before anything is read;
 *   · the dedup key is scoped to the tenant as well as the Slack `event_id`;
 *   · the lookup, the sender check and the comment run in ONE tenant transaction, so a reply
 *     is posted with its fan-out or not at all (`ingestReplyComment` explains why), as the
 *     email reply job does (`worker/src/handlers/ingest-reply-email.ts`).
 */
import { withOrg } from '@/lib/tenant/context';
import { withTenantDb } from '@/lib/db/prisma';
import { slackInboundGate, verifySlackSignature } from '@/lib/notifications/slack';
import { findThreadBySlack } from '@/lib/notifications/replyThreads';
import { ingestReplyComment } from '@/server/lib/inboundComment';
import { claimOnce, releaseClaim } from '@/server/lib/inboundDedup';
import { warnSlackGateOnce } from '@/server/lib/slackGateWarn';
import { slackTenantFor } from '@/server/lib/slackTenant';

export async function POST(req: Request): Promise<Response> {
  // VeloExpense: whose Slack app this is, from the address — before anything else, because
  // every later step (the handshake's diagnosis included) reads that tenant's connection.
  const orgId = await slackTenantFor(req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
  if (!orgId) return new Response('not a tenant address', { status: 404 });

  const raw = await req.text();
  let payload: SlackEvent;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  /**
   * Setup handshake — echo the challenge, before the config is loaded and before any
   * signature check.
   *
   * That order is not a bug to fix. Slack sends `url_verification` while the app is being
   * created, so there is nothing installed here yet and no signing secret to verify it
   * with; refusing it would make the endpoint impossible to register at all.
   *
   * What was wrong is what it left behind: Slack's console goes green, the operator reads
   * the tick as "events work", and every real event afterwards 503s — with nothing in the
   * product ever contradicting the tick. So the handshake now loads the config for the
   * sole purpose of SAYING SO, naming the specific thing that is missing, at the moment
   * the tick appears.
   */
  if (payload.type === 'url_verification') {
    const setup = await withOrg(orgId, (tx) => slackInboundGate(tx));
    if (!setup.ok) {
      console.warn(
        `[slack:events] Slack has verified this URL, but ${setup.message} Until then every ` +
          'real event is refused with 503 — the green tick proves the URL is reachable and ' +
          'nothing more.',
      );
    }
    return Response.json({ challenge: payload.challenge ?? '' });
  }

  const gate = await withOrg(orgId, (tx) => slackInboundGate(tx));
  if (!gate.ok) {
    // The body carries the diagnosis rather than a label. Slack shows the response text
    // back in the Event Subscriptions console when a delivery fails, so this is the one
    // place an operator sees WHY without holding the server log — and a flat "not
    // configured" reads as a lie to somebody looking at a filled-in signing-secret field
    // whose bot token happens to be blank.
    warnSlackGateOnce('slack:events', gate.state, gate.message);
    return new Response(`Slack events refused — ${gate.message}`, { status: 503 });
  }
  if (
    !verifySlackSignature(
      gate.signingSecret,
      req.headers.get('x-slack-request-timestamp'),
      raw,
      req.headers.get('x-slack-signature'),
    )
  ) {
    return new Response('unauthorized', { status: 401 });
  }

  if (payload.type === 'event_callback') {
    // Idempotent + durable: claim the Slack event_id so a retry can't double-post
    // a comment the first delivery already ingested. Process synchronously (Slack
    // allows ~3s) so a transient failure surfaces as a non-200 and Slack RETRIES
    // — the old fire-and-forget + unconditional retry-drop turned any first-attempt
    // blip into permanent comment loss. Release the claim on failure so the retry
    // can reprocess.
    //
    // VeloExpense: the key names the tenant too — each tenant's app is its own Slack app.
    const claimId = `slack:${orgId}:${payload.event_id ?? ''}`;
    if (!(await claimOnce(claimId))) return new Response(null, { status: 200 });
    try {
      await handleMessage(orgId, payload.event);
    } catch (e) {
      console.warn('[slack:events] failed', e);
      await releaseClaim(claimId);
      return new Response(null, { status: 500 });
    }
  }
  return new Response(null, { status: 200 });
}

async function handleMessage(orgId: string, event: SlackInnerEvent | undefined): Promise<void> {
  if (!event || event.type !== 'message') return;
  // Only genuine user replies in a thread: ignore bot posts (incl. our own),
  // edits/joins (subtype), and top-level messages (no thread_ts).
  if (event.bot_id || event.subtype || !event.thread_ts || !event.user || !event.channel) return;
  const { channel, thread_ts: threadTs, user } = event;

  // VeloExpense: one tenant transaction for the lookup, the check and the comment.
  await withTenantDb(orgId, async (db) => {
    const thread = await findThreadBySlack(db, channel, threadTs);
    if (!thread) return;

    // The thread is the recipient's DM; confirm the replier is that recipient.
    const recipient = await db.user.findUnique({
      where: { id: thread.recipientId },
      select: { slackUserId: true },
    });
    if (!recipient || recipient.slackUserId !== user) return;

    await ingestReplyComment({
      subjectType: thread.subjectType,
      subjectId: thread.subjectId,
      actorId: thread.recipientId,
      body: unescapeSlack(event.text ?? ''),
      via: 'slack',
      db,
    });
  });
}

/** Minimal Slack mrkdwn unescaping for the comment body. */
function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

interface SlackInnerEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  thread_ts?: string;
  text?: string;
}
interface SlackEvent {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackInnerEvent;
}
