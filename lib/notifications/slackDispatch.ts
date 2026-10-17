/**
 * w5-02a — one notification as a Slack DM, through the delivery outbox.
 *
 * Ported from the Slack half of ExpenseOS's `handleNotificationDispatch`
 * (`apps/worker/src/handlers/notification-dispatch.ts`, 1e682dd6): `slackText`,
 * `detailSections`, `slackBlocks`, `subjectContext`, `approverCtaFor` (its `channels.ts`),
 * `resolveSlackId` with its two TTLs, the stale-recipient repair, the per-subject thread root,
 * and the once-per-process warnings. Their comments come with them.
 *
 * VeloExpense, each marked below:
 *   · a Slack DM is a `notification_delivery` row with channel SLACK, drained by
 *     `drainOutbox` like an email (GAP-AUDIT NT-19), where ExpenseOS sends it from a BullMQ
 *     job and swallows a failure. So a failure is RECORDED and retried with backoff, and a
 *     delivery Slack cannot make is CANCELLED with the reason, on the delivery screen;
 *   · the work is split around the send, as an email's is: `prepareSlack` reads everything
 *     inside the tenant transaction, `sendPreparedSlack` makes the Slack calls (the lookup and
 *     the post) with no transaction open, and `commitSlack` records what happened in a second
 *     one — the cached id, the thread root, SENT or FAILED. ExpenseOS's `resolveSlackId`
 *     writes its cache in the middle; here its decision is returned and written after;
 *   · the message has no facts table yet: ExpenseOS fills `section.fields` from
 *     `subjectPresentation`, which VeloExpense has not ported (its emails do not carry the
 *     table either), so `slackBlocks` is called with no details and the header is the
 *     rendered template;
 *   · the template body is escaped for mrkdwn (`slackText`) — see the note above `subjectContext`.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { Catalog } from '@expenseos/i18n/load';
import { loadCatalog } from '@expenseos/i18n/load';
import { resolveReaderPrefs } from '@/lib/i18n/resolve';
import { renderMessage } from '@/lib/notifications/service';
import { originForTenant } from '@/lib/notifications/email';
import { ctaFor } from '@/lib/notifications/digest';
import { tenantDbOf } from '@/lib/db/prisma-pg-bridge';
import { withTenantDb, type TenantDb } from '@/lib/db/prisma';
import { ORG } from '@/lib/tenant/sql';
import { resolveDecidableTask } from '@/server/lib/reportApproval';
import { hasCommentThread } from '@/server/lib/threadParticipants';
import { ensureReplyThread, setSlackThread } from '@/lib/notifications/replyThreads';
import {
  getSlackConfigStatus,
  isStaleSlackRecipient,
  lookupSlackUser,
  sendSlack,
  slackConfigAdvice,
  slackConfigProblem,
  type SlackConfigState,
  type SlackPostRef,
} from '@/lib/notifications/slack';

/* ── preparing (tx1) ──────────────────────────────────────────────────────── */

/** Everything the send needs, read inside the tenant. Holds the decrypted bot token: never
 *  logged, never stored. */
export interface PreparedSlack {
  kind: 'SLACK';
  botToken: string;
  recipientId: string;
  email: string;
  cachedId: string | null;
  lookupAt: Date | null;
  text: string;
  blocks: unknown[];
  /** The subject's reply thread for this recipient, when the subject has one. */
  threadId: string | null;
  threadTs: string | null;
}

export type SlackPreparation = PreparedSlack | { kind: 'CANCEL'; reason: string };

interface SlackRow {
  event_type: string;
  subject_type: string;
  subject_id: string;
  payload: unknown;
  recipient_id: string;
  recipient_email: string;
  recipient_locale: string | null;
  recipient_timezone: string | null;
  org_locale: string;
  org_timezone: string;
  slack_user_id: string | null;
  slack_lookup_at: Date | null;
  actor_name: string | null;
  report_title: string | null;
  report_number: string | null;
  report_total_minor: string | null;
  report_currency: string | null;
}

/**
 * Compose one Slack DM, inside the tenant, having claimed the row. CANCEL for anything a
 * retry cannot fix, as `prepareEmail` does.
 *
 * `values` is the placeholder set the email renders with (`messageValues` in dispatch.ts),
 * passed in so the two channels say the same thing.
 */
export async function prepareSlack(
  tx: QueryRunner,
  notificationId: string,
  messageValues: (row: SlackRow, locale: string) => Record<string, unknown>,
): Promise<SlackPreparation> {
  const r = await tx.query(
    `SELECT a.event_type, a.subject_type, a.subject_id, a.payload,
            n.recipient_id,
            u.email AS recipient_email,
            u.locale AS recipient_locale, u.timezone AS recipient_timezone,
            o.default_locale AS org_locale, o.default_timezone AS org_timezone,
            u.slack_user_id, u.slack_lookup_at,
            COALESCE(act.display_name, act.email) AS actor_name,
            rep.title AS report_title, rep.number AS report_number,
            rep.total_minor AS report_total_minor, rep.currency_code AS report_currency
       FROM notification n
       JOIN activity a     ON a.id = n.activity_id
       JOIN app_user u     ON u.id = n.recipient_id
       JOIN organization o ON o.id = u.organization_id
       LEFT JOIN app_user act ON act.id = a.actor_id
       LEFT JOIN expense_report rep
              ON rep.id = a.subject_id AND a.subject_type = 'EXPENSE_REPORT'
      WHERE n.id = $1`,
    [notificationId],
  );
  const row = r.rows[0] as SlackRow | undefined;
  if (!row) return { kind: 'CANCEL', reason: 'the notification no longer exists' };

  const cfg = await getSlackConfigStatus(tx);
  if (cfg.state !== 'ok') {
    // The recipient wants Slack and the activity qualifies, but the integration
    // cannot be used — so nothing sends.
    //
    // The identical hole as the email gate three lines up (in ExpenseOS's handler), whose own comment
    // records what it cost: "un-diagnosable across several UAT rounds: no
    // error, no log, no delivery." What the warning has to carry is WHICH of the
    // failures it is: "nobody installed Slack", "somebody installed it and left the
    // bot token blank", and "this process cannot decrypt the config because
    // PG_CRYPTO_KEY is missing from the worker" all used to arrive as the same
    // absence of a message.
    //
    // VeloExpense: and the delivery is CANCELLED with that same sentence, so the delivery
    // screen says it too.
    const detail = cfg.state === 'unreadable' ? cfg.detail : undefined;
    warnSlackGateOnce(cfg.state, detail);
    return { kind: 'CANCEL', reason: slackConfigProblem(cfg.state, detail) };
  }
  if (row.subject_type !== 'EXPENSE_REPORT' || row.report_title === null) {
    return { kind: 'CANCEL', reason: `nothing to link to for ${row.subject_type} ${row.subject_id}` };
  }

  const prefs = resolveReaderPrefs({
    userLocale: row.recipient_locale,
    orgLocale: row.org_locale,
    userTimeZone: row.recipient_timezone,
    orgTimeZone: row.org_timezone,
  });
  // VeloExpense: English only for now (7 Oct 2026), as the digest and the receipts summary
  // read it.
  const cat = await loadCatalog('en');

  const rendered = await renderMessage(tx, {
    channel: 'SLACK',
    eventType: row.event_type,
    subjectType: row.subject_type,
    values: messageValues(row, prefs.locale) as never,
    locale: prefs.locale,
  });

  const slugRow = await tx.query(`SELECT slug FROM organization WHERE id = ${ORG}`);
  const origin = originForTenant((slugRow.rows[0]?.slug as string | undefined) ?? '');
  const link = origin ? `${origin}/expenses/${row.subject_id}` : null;

  // Whether the recipient can decide the report right now — which only changes the LABEL of
  // the one button, never where it goes. VeloExpense: `resolveDecidableTask`, the question
  // the report page and the email ask (AP-15), where ExpenseOS asks `hasDecidableTask`.
  let canActNow = false;
  if (link && ACTIONABLE_TYPES.has(row.event_type)) {
    canActNow = (await onTenantDb(tx, (db) =>
      resolveDecidableTask(db, row.subject_id, row.recipient_id, false),
    )) !== null;
  }
  // Named after what it opens ("View expense report"), not "View": the link is the one thing
  // in the message the recipient acts on. An approver who can decide now is told what they
  // are there to do instead.
  const cta = canActNow ? approverCtaFor(cat, row.subject_type) : ctaFor(cat, row.subject_type);

  // Only a subject that HAS a thread gets a per-subject Slack thread root.
  const thread = hasCommentThread(row.subject_type)
    ? await onTenantDb(tx, (db) =>
        ensureReplyThread(db, {
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          recipientId: row.recipient_id,
        }),
      )
    : null;

  const body = slackText(rendered.body);
  /**
   * `text` stays the SUMMARY, not the whole message.
   *
   * It is what a push notification and a notification-list preview show, so the
   * templated sentence is right there and the fifteen-row table is not — the blocks
   * carry that. It is also the fallback if blocks ever fail to render, which is why
   * it keeps the link.
   */
  const text = link ? `${body}\n<${link}|${cta}>` : body;
  return {
    kind: 'SLACK',
    botToken: cfg.botToken,
    recipientId: row.recipient_id,
    email: row.recipient_email,
    cachedId: row.slack_user_id,
    lookupAt: row.slack_lookup_at,
    text,
    blocks: slackBlocks(
      body,
      link,
      cta,
      canActNow,
      // What this is about. A bot DM has no subject line, so without it the
      // message alone can read as being about nothing in particular.
      subjectContext(cat, row.subject_type),
    ),
    threadId: thread?.id ?? null,
    threadTs: thread?.slackThreadTs ?? null,
  };
}

/** Event types that can reach an approver. ExpenseOS's `ACTIONABLE_TYPES` is `SUBMITTED |
 *  TASK_ASSIGNED | DEADLINE_NEAR`; VeloExpense emits only TASK_ASSIGNED of those (dispatch.ts). */
const ACTIONABLE_TYPES = new Set(['TASK_ASSIGNED']);

/** A Prisma read or write on this delivery's tenant transaction when it is bridged, and in
 *  the same tenant otherwise — as dispatch.ts does for the email. */
async function onTenantDb<T>(tx: QueryRunner, fn: (db: TenantDb) => Promise<T>): Promise<T> {
  const bridged = tenantDbOf(tx);
  if (bridged) return fn(bridged);
  const org = await tx.query(`SELECT ${ORG}::text AS id`);
  return withTenantDb(org.rows[0].id as string, fn);
}

/*
 * VeloExpense: the rendered template body is ESCAPED for mrkdwn (`slackText`, above).
 * ExpenseOS escapes the composed lead and the facts but posts a template body as it is — and
 * a template interpolates text people type (a report title, a comment, a name), so a title
 * written as `<https://example.test|Approve>` would render as a disguised link in an
 * approver's DM. Every body here is a template body (there is no composed lead yet).
 */

/* ── ported: the message's shape ──────────────────────────────────────────── */

/**
 * The subject a Slack message is about, as a short context line.
 *
 * Reuses the same per-subject wording the CTA does — "Expense report", "Card request" —
 * so Slack, email and the bell name the same thing the same way rather than each
 * inventing a phrase.
 */
function subjectContext(cat: Catalog, subjectType: string | null): string | null {
  const subjects = (cat.notifications as { subject?: Record<string, string> } | undefined)?.subject;
  const name = subjectType ? subjects?.[subjectType] : null;
  return name ? `*${name}*` : null;
}

/** ExpenseOS's `approverCtaFor` (`channels.ts`): the approver's label, else the subject's. */
export function approverCtaFor(cat: Catalog, subjectType: string): string {
  const label = (cat.notifications as { ctaApprover?: unknown } | undefined)?.ctaApprover;
  return typeof label === 'string' && label.trim() ? label : ctaFor(cat, subjectType);
}

/**
 * Slack's own escaping — `&`, `<` and `>` only.
 *
 * Not HTML escaping, and the difference matters: Slack's mrkdwn uses `<url|label>` for
 * links, so an unescaped `<` in a value can swallow the rest of the field, and escaping
 * quotes (as the email side does) would print a literal `&quot;` at the reader.
 */
export function slackText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ExpenseOS's `SubjectDetail`: one labelled fact. */
export interface SubjectDetail {
  label: string;
  value: string;
}

/**
 * The subject's facts as `section.fields` — Slack's two-column key/value layout.
 *
 * Chunked ten at a time because that is Slack's hard limit per section: a card request with
 * every coding field set produces fifteen rows, and one over-long `fields` array is
 * rejected by `chat.postMessage` wholesale — the message does not degrade, it fails to
 * send. Splitting is invisible to the reader (consecutive field sections read as one
 * table) and is the difference between a long notification and no notification.
 *
 * Bold label above the value, which is the shape Slack renders as a definition list;
 * `*Label*\nvalue` is the idiom, not a style choice.
 */
export function detailSections(details: SubjectDetail[]): unknown[] {
  const fields = details
    .filter((d) => d.label.trim() && d.value.trim())
    .map((d) => ({ type: 'mrkdwn', text: `*${slackText(d.label)}*\n${slackText(d.value)}` }));
  const sections: unknown[] = [];
  for (let i = 0; i < fields.length; i += 10) {
    sections.push({ type: 'section', fields: fields.slice(i, i + 10) });
  }
  return sections;
}

/**
 * Block Kit for a Slack DM.
 *
 *   · a CONTEXT line naming what this is about, because a DM from a bot arrives with no
 *     subject line and the message alone can read as being about nothing in particular;
 *   · the message;
 *   · the subject's facts as two-column fields, so the approver knows what is being
 *     decided before they open it;
 *   · one URL button to the record in the signed-in app, styled primary when the
 *     recipient can decide now — the same single button the email carries.
 *
 * Nothing is decided in Slack: the button carries no `action_id` and no value, so the
 * message looks the same whether or not a signing secret is configured. No link, no
 * actions block.
 */
export function slackBlocks(
  message: string,
  link: string | null,
  cta: string,
  approver: boolean,
  context?: string | null,
  details: SubjectDetail[] = [],
): unknown[] {
  const blocks: unknown[] = [];
  if (context) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context }] });
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: message } });
  blocks.push(...detailSections(details));
  if (link) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: cta },
          url: link,
          ...(approver ? { style: 'primary' } : {}),
        },
      ],
    });
  }
  return blocks;
}

/* ── ported: who to send it to ────────────────────────────────────────────── */

/**
 * How long an answer from `users.lookupByEmail` is trusted before it is asked again.
 *
 * The cache exists because the method is rate-limited and a fan-out asks about a dozen
 * people at once, not because the answer is permanent — and treating it as permanent is
 * what made the two failures below unfixable:
 *
 *   · a **negative** was cached for a week, so correcting somebody's Slack email left
 *     them unreachable until it lapsed;
 *   · a **positive** was never re-checked at all (`if (cached) return cached`), so a
 *     person who moved to a different Slack account was unreachable *forever*.
 *
 * Two TTLs, because the two answers cost different things to be wrong about. A stale
 * negative is a person hearing nothing, so it lapses in a week. A stale positive is
 * usually still correct — Slack ids do not change under a stable account — so it is
 * re-checked monthly, which is one extra API call per person per month.
 *
 * Neither TTL is the only repair path, and that is deliberate: a stale positive also
 * heals the moment Slack refuses the id (see `isStaleSlackRecipient` above), and either
 * can be cleared on demand from /profile — `notifications.forgetSlackLink`. A cache whose
 * only correction is waiting is the thing being fixed here.
 *
 * VeloExpense: "on demand" is /notifications/preferences → Slack account → Check again.
 */
export const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What to write to the person's cached Slack id after the lookup, if anything. */
export type SlackCacheWrite = { slackUserId: string | null; slackLookupAt: Date } | null;

/**
 * Return the recipient's Slack user id, resolving it lazily by email.
 *
 * ExpenseOS's `resolveSlackId`. VeloExpense: it returns the cache write rather than making
 * it (`commitSlack` makes it, after the send), and it says why there is no id — `inconclusive`
 * is retried by the outbox rather than dropped.
 */
export async function resolveSlackId(
  email: string,
  cached: string | null,
  lookupAt: Date | null,
  token: string,
  now: number = Date.now(),
): Promise<{ slackId: string | null; write: SlackCacheWrite; inconclusive: string | null }> {
  const age = lookupAt ? now - lookupAt.getTime() : Number.POSITIVE_INFINITY;
  if (age < (cached ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) {
    return { slackId: cached, write: null, inconclusive: null };
  }

  const result = await lookupSlackUser(token, email);

  // Slack did not answer the question — rate limit, revoked token, missing scope, a 502.
  // Writing that down as "this person has no Slack account" is exactly the mistake the
  // old `string | null` return made, and it cost a week of silence per occurrence. Use
  // whatever we already had and ask again next time.
  if (result.outcome === 'inconclusive') {
    warnSlackLookupOnce(result.detail);
    return { slackId: cached, write: null, inconclusive: cached ? null : result.detail };
  }

  if (result.outcome === 'not_found') {
    // A cached id that Slack's directory no longer corroborates is NOT evidence the id is
    // dead — the ordinary cause is that the person changed their Slack email, so the
    // account still exists and the DM still arrives. Keep delivering, say so once, and
    // stop re-asking; if the id really is dead, the send fails and the catch above clears
    // it with proof.
    if (cached) warnSlackEmailDriftOnce(email);
    return {
      slackId: cached,
      write: { slackUserId: cached, slackLookupAt: new Date(now) },
      inconclusive: null,
    };
  }

  return {
    slackId: result.userId,
    write: { slackUserId: result.userId, slackLookupAt: new Date(now) },
    inconclusive: null,
  };
}

/* ── sending (no transaction) ─────────────────────────────────────────────── */

export type SlackOutcome =
  | { kind: 'SENT'; slackId: string; ref: SlackPostRef; write: SlackCacheWrite }
  /** Slack has no account for the address: nothing to send, and nothing a retry fixes
   *  before the negative lapses. */
  | { kind: 'NO_ACCOUNT'; write: SlackCacheWrite }
  /** Retry later. `clearCache` when Slack refused the cached id (`isStaleSlackRecipient`). */
  | { kind: 'FAILED'; error: Error; write: SlackCacheWrite; clearCache: boolean };

/** The Slack calls for one prepared DM: the lookup when the cache is stale, then the post. */
export async function sendPreparedSlack(p: PreparedSlack): Promise<SlackOutcome> {
  const resolved = await resolveSlackId(p.email, p.cachedId, p.lookupAt, p.botToken);
  if (!resolved.slackId) {
    if (resolved.inconclusive) {
      return {
        kind: 'FAILED',
        error: new Error(
          `Slack could not be asked whether ${p.email} has an account (${resolved.inconclusive})`,
        ),
        write: null,
        clearCache: false,
      };
    }
    return { kind: 'NO_ACCOUNT', write: resolved.write };
  }
  try {
    const ref = await sendSlack(p.botToken, {
      channel: resolved.slackId,
      text: p.text,
      blocks: p.blocks,
      // Thread later notifications under the subject's root message so a
      // reply in that thread maps back to the subject (see ReplyThread).
      threadTs: p.threadTs ?? undefined,
    });
    return { kind: 'SENT', slackId: resolved.slackId, ref, write: resolved.write };
  } catch (err) {
    const stale = isStaleSlackRecipient(err);
    if (stale) {
      // Slack says the id we addressed does not exist. That is the one failure that
      // proves the CACHE is wrong rather than the message, and it is the only way a
      // person who moved to a different Slack account ever becomes reachable again —
      // their email still resolves, so no lookup would have noticed. Forget the id and
      // clear the throttle so the very next notification re-resolves from the email.
      //
      // VeloExpense: "the very next" attempt is this delivery's own retry.
      console.warn(
        `[notifications] Slack rejected the cached user id for ${p.email} ` +
          `(${(err as { slackError: string }).slackError}) — cleared it; the next attempt ` +
          'will look the address up again.',
      );
    }
    return {
      kind: 'FAILED',
      error: err instanceof Error ? err : new Error(String(err)),
      write: resolved.write,
      clearCache: stale,
    };
  }
}

/* ── recording (tx2) ──────────────────────────────────────────────────────── */

/** Write what the send learned about the person, and the thread root on a first message. */
export async function commitSlackFacts(
  tx: QueryRunner,
  p: PreparedSlack,
  outcome: SlackOutcome,
): Promise<void> {
  if (outcome.kind === 'FAILED' && outcome.clearCache) {
    await tx.query(
      `UPDATE app_user SET slack_user_id = NULL, slack_lookup_at = NULL WHERE id = $1`,
      [p.recipientId],
    );
  } else if (outcome.write) {
    await tx.query(
      `UPDATE app_user SET slack_user_id = $2, slack_lookup_at = $3 WHERE id = $1`,
      [p.recipientId, outcome.write.slackUserId, outcome.write.slackLookupAt],
    );
  }
  // First message for this subject → remember it as the thread root.
  if (outcome.kind === 'SENT' && p.threadId && !p.threadTs) {
    const { channel, ts } = outcome.ref;
    const threadId = p.threadId;
    await onTenantDb(tx, (db) => setSlackThread(db, threadId, channel, ts));
  }
}

/* ── ported: the once-per-process warnings ────────────────────────────────── */

/**
 * Drop every once-per-process Slack warning latch.
 *
 * Exported for tests, and it earns its place for the same reason `resetCatalogCache` does:
 * the latches are module-level, so the FIRST test to trip one silences it for every later
 * test in the file. A suite written without this has one real assertion and a row of
 * companions that pass because nothing was logged AND because nothing could have been.
 */
export function resetSlackWarnings(): void {
  slackGateWarned.clear();
  slackLookupWarned = false;
  slackDriftWarned.clear();
}

/**
 * Log the Slack gate once per worker process PER REASON, for the same reason as the email
 * one below: a per-notification warning is a log flood, and no warning at all is an outage
 * nobody can see.
 *
 * Per reason, not once outright, because the reasons are fixed in sequence — an operator
 * pastes a bot token, restarts nothing, and the next thing they need to be told is that
 * the signing secret is still missing. One latch would have swallowed that.
 *
 * VeloExpense: per process, not per tenant — each tenant's own reason reaches its delivery
 * screen as the CANCELLED row's reason, so the log line is for whoever runs the deployment.
 */
const slackGateWarned = new Set<SlackConfigState>();
function warnSlackGateOnce(state: SlackConfigState, detail?: string): void {
  if (slackGateWarned.has(state)) return;
  slackGateWarned.add(state);
  console.warn(
    `[notifications] Slack was requested but ${slackConfigAdvice(state, detail)} ` +
      'No Slack messages will be sent.',
  );
}

/** Slack could not be asked whether an address has an account. Once per process: during a
 *  rate limit or an outage this is every dispatch, and the fact is the same each time. */
let slackLookupWarned = false;
function warnSlackLookupOnce(detail: string): void {
  if (slackLookupWarned) return;
  slackLookupWarned = true;
  console.warn(
    `[notifications] users.lookupByEmail did not answer (${detail}) — treating it as unknown ` +
      'rather than as "no such Slack user", so nothing is cached from it.',
  );
}

/** Slack's directory no longer maps a person's VeloExpense address to any account, but a
 *  previously resolved id is still being used. Once per address. */
const slackDriftWarned = new Set<string>();
function warnSlackEmailDriftOnce(email: string): void {
  if (slackDriftWarned.has(email)) return;
  slackDriftWarned.add(email);
  console.warn(
    `[notifications] Slack no longer has an account for ${email}, but a previously resolved ` +
      'user id is cached and still delivering. Their Slack email probably changed; if the DMs ' +
      'have stopped, clear the link from Notification preferences → Slack account.',
  );
}
