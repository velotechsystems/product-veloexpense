/**
 * VX2-7 — the notification service: record an event, fan it out, read an inbox,
 * and resolve the sentence a tenant sees.
 *
 * Ported from ExpenseOS `packages/notifications/src/{activity,templates}.ts`.
 * The pure half — taxonomy, template keys, placeholder rules, channel defaults —
 * is in `lib/notifications/catalog.ts`; this file is the part that touches the
 * database. Findings: GAP-AUDIT NT-1 through NT-16.
 *
 * ── Three properties this file is responsible for ───────────────────────────
 *
 * 1. THE ROW IS WRITTEN WHENEVER ANY CHANNEL WANTS IT; the BELL filters on the
 *    IN_APP preference at READ time. That ordering matters and it is not how it
 *    first looks like it should work. Suppressing the row would make IN_APP a
 *    master switch — mute the bell and you silently mute the email VX2-8 will
 *    send from the same row, which is a trap laid for a later ticket. So:
 *    `notifyRecipients` writes a row if IN_APP or EMAIL or SLACK is on, and
 *    `listInbox` excludes the events the recipient has muted in-app.
 *    Consequence, and it is the right one: re-enabling a muted event brings its
 *    history back, because nothing was ever thrown away.
 * 2. RECORDING AND NOTIFYING ARE TWO CALLS. `recordActivity` then
 *    `notifyRecipients`, as in ExpenseOS. A caller can record an event without
 *    telling anybody, which is what makes the stream usable as a subject
 *    timeline as well as a mailbox. `notify()` is the convenience that does both.
 * 3. THE FAN-OUT NEVER THROWS ON A RECIPIENT IT CANNOT REACH. Ids are de-duped
 *    and empties dropped; a notification is a side effect of a decision, and a
 *    decision must not fail because somebody's inbox row could not be written.
 *    The one exception is the tenant predicate — an insert that RLS refuses is
 *    a bug, not a delivery problem, and it propagates.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import { formatMinor } from '@/lib/money';
import { enqueueDelivery } from '@/lib/notifications/outbox';
import {
  applyPlaceholders,
  CHANNELS,
  DEFAULT_LOCALE,
  isChannel,
  isDigestType,
  isEventType,
  localized,
  placeholderValuesFrom,
  preferenceKey,
  renderContent,
  resolveChannels,
  shippedBody,
  templateKeyFor,
  TEMPLATE_KEYS,
  TEMPLATE_KEY_BY_KEY,
  isTemplateKey,
  type Channel,
  type EventType,
  type PlaceholderValues,
  type PreferenceMap,
  type SubjectType,
} from '@/lib/notifications/catalog';
import { ORG } from '@/lib/tenant/sql';


export class NotificationError extends DomainError {
  constructor(
    message: string,
    readonly code:
      | 'UNKNOWN_EVENT_TYPE'
      | 'UNKNOWN_CHANNEL'
      | 'UNKNOWN_TEMPLATE_KEY'
      | 'EMPTY_BODY'
      | 'NOT_FOUND'
      | 'FORBIDDEN',
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'NotificationError';
  }
}

/* ── recording ────────────────────────────────────────────────────────────── */

export interface NewActivity {
  subjectType: SubjectType;
  subjectId: string;
  eventType: EventType;
  /** null = the system did it (a future reminder sweep). */
  actorId?: string | null;
  /**
   * Render parameters. SCALARS ONLY are usable as placeholders — see
   * `placeholderValuesFrom`. Amounts go in as STRINGS, never bigint: the same
   * rule the audit payload follows, and for the same reason (JSON.stringify
   * throws on a BigInt, inside the transaction that was doing real work).
   */
  payload?: Record<string, unknown>;
}

/** Append one event to the stream. Notifies nobody — see property 2. */
export async function recordActivity(tx: QueryRunner, input: NewActivity): Promise<string> {
  if (!isEventType(input.eventType)) {
    throw new NotificationError(`unknown event type: ${input.eventType}`, 'UNKNOWN_EVENT_TYPE',
      'EVENT_TYPE_UNKNOWN',
    );
  }
  const r = await tx.query(
    `INSERT INTO activity
       (organization_id, subject_type, subject_id, event_type, actor_id, payload)
     VALUES (${ORG}, $1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      input.subjectType,
      input.subjectId,
      input.eventType,
      input.actorId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return r.rows[0].id as string;
}

/**
 * One user's channel overrides, as the catalog's map.
 *
 * A row exists only where the user disagreed with the default, so an empty map
 * is the normal state and means "all defaults" (GAP-AUDIT NT-3).
 */
export async function preferencesFor(tx: QueryRunner, userId: string): Promise<PreferenceMap> {
  return (await preferencesForMany(tx, [userId])).get(userId) ?? new Map();
}

/**
 * The same, for several people in ONE query.
 *
 * The fan-out asks about every recipient at once, and asking per recipient is
 * how a three-approver ladder turns one decision into four round trips. Same
 * reasoning as VX2-4's note on `canDecide` — except there the batching was left
 * as a "if that ever matters", and here it is free.
 */
export async function preferencesForMany(
  tx: QueryRunner,
  userIds: readonly string[],
): Promise<Map<string, PreferenceMap>> {
  const out = new Map<string, Map<string, boolean>>();
  if (userIds.length === 0) return out;
  const r = await tx.query(
    `SELECT user_id, event_type, channel, enabled
       FROM notification_preference WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );
  for (const id of userIds) out.set(id, new Map());
  for (const row of r.rows) {
    out
      .get(row.user_id as string)
      ?.set(
        preferenceKey(row.event_type as string, row.channel as Channel),
        row.enabled as boolean,
      );
  }
  return out;
}

/**
 * Fan an activity out to recipients' inboxes — one row each, at most.
 *
 * Ported semantics, all three with their reasons:
 *
 * · DE-DUPE the recipient ids and no-op on an empty set. The submitter is
 *   frequently also somebody's delegate or the actor; a fan-out that
 *   double-writes puts two identical rows in one bell. `ON CONFLICT DO NOTHING`
 *   makes it structural as well, since `0011` carries the UNIQUE that ExpenseOS
 *   documents but does not enforce.
 * · SKIP A RECIPIENT WHO HAS MUTED EVERY CHANNEL for this event. Not the IN_APP
 *   channel alone — see property 1 in the file header.
 * · NEVER NOTIFY THE ACTOR ABOUT THEIR OWN ACTION. An approver who approves does
 *   not need a bell saying they approved. This is not in ExpenseOS, which relies
 *   on each caller assembling a recipient list that happens to exclude them; one
 *   place is better than five, and the caller can still pass the actor
 *   explicitly by leaving `actorId` out of the activity.
 *
 * Returns the recipient ids that actually got a row, so a caller can assert on
 * the fan-out rather than on a count.
 */
export async function notifyRecipients(
  tx: QueryRunner,
  activityId: string,
  recipientIds: readonly (string | null | undefined)[],
  options: { includeActor?: boolean } = {},
): Promise<string[]> {
  const unique = [...new Set(recipientIds)].filter((id): id is string => Boolean(id));
  if (unique.length === 0) return [];

  const act = await tx.query(
    `SELECT event_type, actor_id FROM activity WHERE id = $1`,
    [activityId],
  );
  if (act.rows.length === 0) {
    throw new NotificationError('activity not found', 'NOT_FOUND');
  }
  const eventType = act.rows[0].event_type as string;
  const actorId = act.rows[0].actor_id as string | null;

  // `includeActor` is VX4-5 part 3a's one exception, and it is a real case rather
  // than a convenience. The rule above — never tell somebody about their own
  // action — is right for every event whose subject IS the action. A budget
  // threshold alert is about a RUNNING TOTAL: a budget owner who files the claim
  // that breaks their own budget is exactly the person who needs telling, and
  // ExpenseOS's version says so ("somebody who owns a budget and files a claim
  // against it should still be told their own claim broke it").
  //
  // An option rather than recording the activity with a null actor, which was the
  // alternative and is worse: it would buy the fan-out at the cost of the activity
  // stream no longer knowing who moved the number.
  const candidates = options.includeActor ? unique : unique.filter((id) => id !== actorId);
  const prefs = await preferencesForMany(tx, candidates);

  const written: string[] = [];
  for (const recipientId of candidates) {
    const channels = resolveChannels(eventType, prefs.get(recipientId) ?? new Map());
    if (!CHANNELS.some((c) => channels[c])) continue;
    const ins = await tx.query(
      `INSERT INTO notification (organization_id, activity_id, recipient_id)
       VALUES (${ORG}, $1, $2)
       ON CONFLICT (activity_id, recipient_id) DO NOTHING
       RETURNING id`,
      [activityId, recipientId],
    );
    if (ins.rowCount !== 1) continue;
    written.push(recipientId);

    // VX2-8. IN_APP needs no job — the row above IS the delivery, which is what
    // "the always-on channel" means and why `0012` refuses an IN_APP delivery row
    // with a CHECK constraint. The external channels get one each, in the SAME
    // transaction as the notification: an outbox row written separately could be
    // lost if the transaction that caused it rolled back, and one written first
    // could describe a notification that never existed.
    //
    // The poller re-reads nothing about preferences. This is the decision point,
    // and it is here rather than in the worker because the preference the user
    // held when the thing happened is the one that should govern — not whichever
    // one they hold four hours later when a retry finally succeeds.
    // w5-02a: SLACK too, now that it has a transport (`lib/notifications/slackDispatch.ts`).
    // A Slack delivery is never held for the digest — ExpenseOS's digest is email only — and
    // whether the tenant has Slack connected is decided at the send, not here: a delivery
    // for a tenant that has disconnected is CANCELLED with the reason, on the delivery
    // screen, rather than never existing.
    //
    // w5-00: a digest-type event's email is held for the digest (`isDigestType`), so a
    // burst of comments reaches somebody as one message rather than one each.
    if (channels.EMAIL) {
      await enqueueDelivery(tx, ins.rows[0].id as string, 'EMAIL', {
        digest: isDigestType(eventType),
      });
    }
    if (channels.SLACK) {
      await enqueueDelivery(tx, ins.rows[0].id as string, 'SLACK');
    }
  }
  return written;
}

/** Record and fan out in one call — the shape every caller in VX2-7 uses. */
export async function notify(
  tx: QueryRunner,
  input: NewActivity,
  recipientIds: readonly (string | null | undefined)[],
  options: { includeActor?: boolean } = {},
): Promise<{ activityId: string; notified: string[] }> {
  const activityId = await recordActivity(tx, input);
  const notified = await notifyRecipients(tx, activityId, recipientIds, options);
  return { activityId, notified };
}

/* ── rendering ────────────────────────────────────────────────────────────── */

export interface RenderedMessage {
  subject: string | null;
  body: string;
  /**
   * True when a STORED template supplied the text, false when the shipped copy
   * did.
   *
   * This field is the whole reason VX2-7's acceptance criterion is testable, and
   * it exists because ExpenseOS's version of that test did not work. Their own
   * comment (GAP-AUDIT NT-5): a test named "falls back to default copy when the
   * catalog has no digest strings" "asserted on the fallback copy while never
   * once reaching it … the assertion passed only because those strings happen to
   * be character-identical to the code's fallbacks. Rewriting the fallback in
   * source left all 20 tests green. The test named a behaviour it could not
   * observe."
   *
   * When the shipped string and the stored template are equal, asserting on the
   * OUTPUT cannot tell you which path produced it. Assert the path.
   */
  fromTemplate: boolean;
}

/**
 * Resolve and render one message. Can never render nothing: every miss — no key
 * for this event, no stored row, no text for the locale — ends at the shipped
 * string.
 */
export async function renderMessage(
  tx: QueryRunner,
  params: {
    channel: Channel;
    eventType: string;
    subjectType: string | null;
    locale?: string;
    values?: PlaceholderValues;
  },
): Promise<RenderedMessage> {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const values = params.values ?? {};
  const fallback = (): RenderedMessage => ({
    subject: null,
    body: applyShipped(params.eventType, params.subjectType, locale, values),
    fromTemplate: false,
  });

  const key = templateKeyFor(params.eventType, params.subjectType);
  // No key means nobody has written copy for this event. Pre-template
  // behaviour, unchanged.
  if (!key) return fallback();

  const hit = await tx.query(
    `SELECT subject, body FROM notification_template
      WHERE template_key = $1 AND channel = $2`,
    [key, params.channel],
  );
  if (hit.rows.length === 0) return fallback();

  const rendered = renderContent(
    { subject: hit.rows[0].subject, body: hit.rows[0].body },
    locale,
    values,
  );
  // A stored row whose body carries no text for this locale or its fallback is
  // a MISS, not an empty message.
  if (!rendered) return fallback();
  return { ...rendered, fromTemplate: true };
}

/** The shipped sentence with its placeholders filled. `applyPlaceholders` and
 *  not a second copy of the regex — one substitution rule, one implementation,
 *  or a template behaves differently depending on which path rendered it. */
function applyShipped(
  eventType: string,
  subjectType: string | null,
  locale: string,
  values: PlaceholderValues,
): string {
  return applyPlaceholders(shippedBody(eventType, subjectType, locale), values);
}

/* ── the inbox ────────────────────────────────────────────────────────────── */

export interface InboxRow {
  notificationId: string;
  activityId: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  actorName: string | null;
  body: string;
  /** See RenderedMessage.fromTemplate. Surfaced so the admin can see whether
   *  their override is actually the thing being read. */
  fromTemplate: boolean;
  readAt: Date | null;
  occurredAt: Date;
}

/**
 * The IN_APP predicate, as SQL.
 *
 * A muted event is filtered at READ time rather than suppressed at write time —
 * property 1 in the file header. `NOT EXISTS` rather than a join because the
 * absence of a row is the common case and the UNIQUE
 * `(user_id, event_type, channel)` answers it as a point lookup.
 *
 * Note it tests `enabled = false` explicitly, not `NOT enabled`: a row that
 * enables an event must not filter it out, and only an explicit false does.
 */
const NOT_MUTED_IN_APP = `
  NOT EXISTS (
    SELECT 1 FROM notification_preference p
     WHERE p.user_id = $1
       AND p.event_type = a.event_type
       AND p.channel = 'IN_APP'
       AND p.enabled = false
  )`;

export async function listInbox(
  tx: QueryRunner,
  recipientId: string,
  opts: { unreadOnly?: boolean; limit?: number; locale?: string } = {},
): Promise<InboxRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const r = await tx.query(
    `SELECT n.id AS notification_id, n.read_at, n.created_at,
            a.id AS activity_id, a.event_type, a.subject_type, a.subject_id,
            a.payload, a.occurred_at, a.actor_id,
            COALESCE(u.display_name, u.email) AS actor_name
       FROM notification n
       JOIN activity a ON a.id = n.activity_id
       LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE n.recipient_id = $1
        AND ($2::boolean IS FALSE OR n.read_at IS NULL)
        AND ${NOT_MUTED_IN_APP}
      ORDER BY a.occurred_at DESC
      LIMIT $3`,
    [recipientId, opts.unreadOnly ?? false, limit],
  );

  // One template read per DISTINCT (key, channel), not per row. An inbox of 50
  // decisions on five event types is five reads, and the loop below is why
  // `renderMessage` is not called per row.
  const cache = new Map<string, { subject: unknown; body: unknown } | null>();
  const out: InboxRow[] = [];
  for (const row of r.rows) {
    const key = templateKeyFor(row.event_type as string, row.subject_type as string);
    let stored = key === null ? null : cache.get(key);
    if (key !== null && stored === undefined) {
      const hit = await tx.query(
        `SELECT subject, body FROM notification_template
          WHERE template_key = $1 AND channel = 'IN_APP'`,
        [key],
      );
      stored = hit.rows[0] ? { subject: hit.rows[0].subject, body: hit.rows[0].body } : null;
      cache.set(key, stored);
    }
    const values = {
      ...placeholderValuesFrom(row.payload),
      // Reserved names LAST, so a payload key cannot shadow them (NT-6 rule 4).
      actor: (row.actor_name as string | null) ?? 'Somebody',
    };
    const rendered = stored ? renderContent(stored, opts.locale ?? DEFAULT_LOCALE, values) : null;
    out.push({
      notificationId: row.notification_id as string,
      activityId: row.activity_id as string,
      eventType: row.event_type as string,
      subjectType: row.subject_type as string,
      subjectId: row.subject_id as string,
      actorId: row.actor_id as string | null,
      actorName: row.actor_name as string | null,
      body:
        rendered?.body ??
        applyShipped(
          row.event_type as string,
          row.subject_type as string,
          opts.locale ?? DEFAULT_LOCALE,
          values,
        ),
      fromTemplate: rendered !== null,
      readAt: row.read_at as Date | null,
      occurredAt: row.occurred_at as Date,
    });
  }
  return out;
}

/** How many unread, for the badge. Honours the same mute filter as the list. */
export async function unreadCount(tx: QueryRunner, recipientId: string): Promise<number> {
  const r = await tx.query(
    `SELECT count(*)::int AS n
       FROM notification n
       JOIN activity a ON a.id = n.activity_id
      WHERE n.recipient_id = $1 AND n.read_at IS NULL AND ${NOT_MUTED_IN_APP}`,
    [recipientId],
  );
  return r.rows[0].n as number;
}

/**
 * Mark one notification read. Idempotent, and scoped to the recipient.
 *
 * `WHERE recipient_id = $2` is the authorization, not a filter: RLS scopes the
 * row to the tenant and this scopes it to the person. Without it a colleague's
 * notification id would be enough to mark their mail read.
 */
export async function markRead(
  tx: QueryRunner,
  notificationId: string,
  recipientId: string,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE notification SET read_at = clock_timestamp()
      WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [notificationId, recipientId],
  );
  return r.rowCount === 1;
}

/** Mark everything currently visible to this recipient read. */
export async function markAllRead(tx: QueryRunner, recipientId: string): Promise<number> {
  const r = await tx.query(
    `UPDATE notification n SET read_at = clock_timestamp()
      WHERE n.recipient_id = $1 AND n.read_at IS NULL
        AND EXISTS (SELECT 1 FROM activity a WHERE a.id = n.activity_id AND ${NOT_MUTED_IN_APP})`,
    [recipientId],
  );
  return r.rowCount ?? 0;
}

/* ── preferences ──────────────────────────────────────────────────────────── */

/**
 * Set or clear one override.
 *
 * `enabled === null` DELETES the row, returning the user to the code default
 * rather than pinning them to today's value of it. That distinction is the point
 * of storing overrides only (NT-3): if the product later decides Slack should
 * default on, somebody who never expressed an opinion should move with it, and
 * somebody who explicitly turned it off should not.
 */
export async function setPreference(
  tx: QueryRunner,
  userId: string,
  eventType: string,
  channel: string,
  enabled: boolean | null,
): Promise<void> {
  if (!isEventType(eventType)) {
    throw new NotificationError(`unknown event type: ${eventType}`, 'UNKNOWN_EVENT_TYPE',
      'EVENT_TYPE_UNKNOWN',
    );
  }
  if (!isChannel(channel)) {
    throw new NotificationError(`unknown channel: ${channel}`, 'UNKNOWN_CHANNEL',
      'CHANNEL_UNKNOWN',
    );
  }
  if (enabled === null) {
    await tx.query(
      `DELETE FROM notification_preference
        WHERE user_id = $1 AND event_type = $2 AND channel = $3`,
      [userId, eventType, channel],
    );
    return;
  }
  await tx.query(
    `INSERT INTO notification_preference
       (organization_id, user_id, event_type, channel, enabled)
     VALUES (${ORG}, $1, $2, $3, $4)
     ON CONFLICT (user_id, event_type, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [userId, eventType, channel, enabled],
  );
}

/* ── templates ────────────────────────────────────────────────────────────── */

export interface TemplateRow {
  templateKey: string;
  channel: Channel;
  name: string;
  description: string;
  /** The tenant's override, or null where they have not written one. */
  body: string | null;
  subject: string | null;
  /** What the product ships, always present — the fallback and the reset target. */
  shipped: string;
  updatedByName: string | null;
  updatedAt: Date | null;
}

/**
 * Every shippable message, with the tenant's override where one exists.
 *
 * Driven by the CODE registry and left-joined to the table, not the other way
 * round. That ordering is what makes "a fresh tenant has zero rows" a working
 * configuration rather than an empty screen — the same shape
 * `/admin/expense-policies` uses for `DEFAULT_POLICIES`.
 */
export async function listTemplates(
  tx: QueryRunner,
  channel: Channel = 'IN_APP',
  locale: string = DEFAULT_LOCALE,
): Promise<TemplateRow[]> {
  const r = await tx.query(
    `SELECT t.template_key, t.subject, t.body, t.updated_at,
            COALESCE(u.display_name, u.email) AS updated_by_name
       FROM notification_template t
       LEFT JOIN app_user u ON u.id = t.updated_by_id
      WHERE t.channel = $1`,
    [channel],
  );
  const stored = new Map(r.rows.map((row) => [row.template_key as string, row]));
  return TEMPLATE_KEYS.map((def) => {
    const row = stored.get(def.key);
    return {
      templateKey: def.key,
      channel,
      name: def.name,
      description: def.description,
      body: row ? localized(row.body, locale) : null,
      subject: row ? localized(row.subject, locale) : null,
      shipped: localized(def.shipped, locale) ?? def.key,
      updatedByName: (row?.updated_by_name as string | null) ?? null,
      updatedAt: (row?.updated_at as Date | null) ?? null,
    };
  });
}

/**
 * Write a tenant's override, or clear it.
 *
 * `body === null` DELETES the row rather than storing an empty string, so
 * "reset to the shipped wording" and "the shipped wording" are the same state
 * and not two states that render the same. A stored empty body would also be a
 * MISS at render time (see `renderContent`), which means it would look like a
 * reset while occupying a row and a timestamp claiming somebody authored it.
 */
export async function setTemplate(
  tx: QueryRunner,
  actorId: string,
  input: { templateKey: string; channel: string; body: string | null; subject?: string | null },
): Promise<void> {
  if (!isChannel(input.channel)) {
    throw new NotificationError(`unknown channel: ${input.channel}`, 'UNKNOWN_CHANNEL',
      'CHANNEL_UNKNOWN',
    );
  }
  // Both halves of ExpenseOS's `isTemplateKey`, plus the registry: the shape is
  // also a CHECK in `0011`, the owner list is code-only, and a well-formed key
  // nothing renders from is still a row nobody will ever read.
  if (!isTemplateKey(input.templateKey) || !TEMPLATE_KEY_BY_KEY.has(input.templateKey)) {
    throw new NotificationError(
      `unknown template key: ${input.templateKey}`,
      'UNKNOWN_TEMPLATE_KEY',
      'TEMPLATE_KEY_UNKNOWN',
    );
  }
  // EMPTY AFTER TRIMMING IS A RESET, and `?? null` alone does not say that:
  // `'   '.trim()` is `''`, which is not null, so a whitespace-only body fell
  // through to the INSERT and stored `{"en": ""}`. That is the precise failure
  // this function's own doc comment warns about two paragraphs up — a body
  // `renderContent` treats as a MISS, so the message renders shipped copy while
  // occupying a row with a timestamp claiming somebody authored it, and
  // `listTemplates` shows "shipped wording" next to an editor's name. I wrote
  // the warning and then wrote the bug; the test caught it.
  const trimmedBody = input.body?.trim() ?? null;
  const body = trimmedBody === '' ? null : trimmedBody;
  if (body === null) {
    await tx.query(
      `DELETE FROM notification_template WHERE template_key = $1 AND channel = $2`,
      [input.templateKey, input.channel],
    );
    return;
  }
  const trimmedSubject = input.channel === 'EMAIL' ? (input.subject?.trim() ?? null) : null;
  const subject = trimmedSubject === '' ? null : trimmedSubject;
  await tx.query(
    `INSERT INTO notification_template
       (organization_id, template_key, channel, body, subject, updated_by_id)
     VALUES (${ORG}, $1, $2, $3::jsonb, $4::jsonb, $5)
     ON CONFLICT (organization_id, template_key, channel)
       DO UPDATE SET body = EXCLUDED.body,
                     subject = EXCLUDED.subject,
                     updated_by_id = EXCLUDED.updated_by_id,
                     updated_at = now()`,
    [
      input.templateKey,
      input.channel,
      JSON.stringify({ [DEFAULT_LOCALE]: body }),
      subject === null ? null : JSON.stringify({ [DEFAULT_LOCALE]: subject }),
      actorId,
    ],
  );
}

/* ── the subject's timeline ───────────────────────────────────────────────── */

/**
 * Every activity on one subject, newest first.
 *
 * Not used by VX2-7's screens — the report page already has
 * `expense_report_event` for its timeline (GAP-AUDIT NT-16 draws the boundary).
 * It exists because the index it reads (`activity_subject_idx`) is the reason
 * that index is there, and because a stream nothing can read back is a stream
 * nobody will trust.
 */
export async function listSubjectActivity(
  tx: QueryRunner,
  subjectType: string,
  subjectId: string,
  limit = 50,
): Promise<{ eventType: string; actorName: string | null; occurredAt: Date }[]> {
  const r = await tx.query(
    `SELECT a.event_type, a.occurred_at, COALESCE(u.display_name, u.email) AS actor_name
       FROM activity a
       LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE a.subject_type = $1 AND a.subject_id = $2
      ORDER BY a.occurred_at DESC
      LIMIT $3`,
    [subjectType, subjectId, Math.min(Math.max(limit, 1), 200)],
  );
  return r.rows.map((row) => ({
    eventType: row.event_type as string,
    actorName: row.actor_name as string | null,
    occurredAt: row.occurred_at as Date,
  }));
}

/* ── the values a travel event renders from ───────────────────────────────── */

/**
 * VeloExpense (w6-01): the placeholder values every TRAVEL_REQUEST event carries
 * (`TRAVEL_PLACEHOLDERS`), the counterpart of `reportPayload` below and for its reason — one
 * place, so `{request}` and `{total}` mean the same thing in every travel template.
 *
 * `totalMinor` is what the trip is for: the approved total once there is one, else the sum
 * of the estimate's lines. The caller passes whichever it has; nothing here reads the
 * database.
 */
export function travelPayload(request: {
  number: string | null;
  destinationLabel: string;
  totalMinor: string | number | bigint;
  currencyCode: string;
}): Record<string, string> {
  return {
    request: request.destinationLabel,
    destination: request.destinationLabel,
    number: request.number ?? '',
    total: formatMinor(request.totalMinor, request.currencyCode),
  };
}

/* ── the values a report event renders from ───────────────────────────────── */

/**
 * The placeholder values every EXPENSE_REPORT event carries.
 *
 * One place, so `{report}`, `{number}` and `{total}` mean the same thing in
 * every template and a new caller cannot invent a fourth spelling. Amounts are
 * formatted HERE rather than in the template, because a template is copy and
 * currency formatting is not something a copy editor should be able to get
 * wrong.
 */
export function reportPayload(report: {
  title: string;
  number: string | null;
  totalMinor: string | number | bigint;
  currencyCode: string;
}): Record<string, string> {
  return {
    report: report.title,
    // '' rather than 'null': a report always has a number after VX1-4, so this
    // is defensive, and an empty gap in a sentence reads better than the word.
    number: report.number ?? '',
    total: formatMinor(report.totalMinor, report.currencyCode),
  };
}
