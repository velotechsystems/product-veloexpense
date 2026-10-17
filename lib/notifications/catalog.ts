/**
 * VX2-7 — the notification catalog: what can be notified about, what the
 * sentence says, and which stored template (if any) overrides it.
 *
 * PURE. No `pg`, no imports from `lib/db` — the same rule `lib/policy/rules.ts`
 * and `lib/approvals/approver-token.ts` follow, so the truth table can be
 * unit-tested without a database and so a server component can import the
 * taxonomy without dragging a connection pool into the bundle.
 *
 * Ported from ExpenseOS `packages/notifications/src/{activity,templates,
 * templateKeys}.ts` and `apps/worker/src/channels.ts`. Findings: GAP-AUDIT
 * NT-3 through NT-10.
 *
 * ── The one design decision to understand ───────────────────────────────────
 *
 * A template is identified by a stable KEY, not by the coordinates the
 * dispatcher happens to arrive with. The Phase-2 board asked for
 * "exact -> any-subject -> shipped catalog string"; that middle rung is not a
 * feature, it is what a nullable `subject_type` KEY COLUMN looks like from the
 * outside, and ExpenseOS deleted it after writing down why:
 *
 *   "Templates used to be keyed on (channel, eventType, subjectType, locale).
 *    That was not an identity, it was a set of coordinates … A flat catalog
 *    entry produced a row whose subject was NULL and therefore rendered as
 *    'Any'; a nested block produced one whose subject was its block name.
 *    Nothing chose that mix — it fell out of the JSON."
 *
 * So `(event_type, subject_type) -> key` is a LOOKUP TABLE here, deliberately
 * not a naming rule. ExpenseOS's reason, which is the good one: one key
 * legitimately serves several coordinate pairs, and "a rule producing
 * `virtual_credit_cards.request_issued` for one of them would be a rule quietly
 * inventing a second template."
 */
import { DEFAULT_LOCALE, localizedFrom, type Locale } from '@/lib/i18n/locales';
// A VALUE import from `enums.ts`, which imports `EventType` back from here — but
// only as a `type`, so that edge is erased and there is no runtime cycle.
import { missingCopyMarker } from '@/lib/i18n/catalog/enums';

/**
 * Re-exported, not redeclared. `lib/i18n/locales.ts` owns the value; this line
 * exists so that the dozen call sites in `service.ts` that already import
 * `DEFAULT_LOCALE` from the catalogue keep working, and so there is exactly one
 * place it can be changed. See `LocaleMap` below for what having two was doing.
 */
export { DEFAULT_LOCALE };

/* ── the taxonomy ──────────────────────────────────────────────────────────── */

/**
 * What a notification can be ABOUT. Polymorphic, because VX2-8's approve-links
 * and any later travel or card subject route through the same machinery.
 * 'BUDGET' arrives with VX4-5 part 3a — a threshold alert is about the BUDGET, not
 * about the report whose spend crossed it, and addressing it to the report would
 * put it in the submitter's bell instead of the owner's. VCC/Travel are off for MVP.
 */
export const SUBJECT_TYPES = ['EXPENSE_REPORT', 'BUDGET'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/**
 * What HAPPENED. Six events, and the list is exactly what the product emits — no
 * more. `REIMBURSED` arrived with VX2-9, which is when something started emitting
 * it; VX2-7 left it out deliberately, because an event type nothing emits is a
 * template nobody can test and a preference row nobody can explain.
 *
 * Notably NOT here, and this is a choice rather than an omission: `SUBMITTED`.
 * ExpenseOS has it, addressed to watchers of a card request. Here the person who
 * clicked Submit does not need telling that they clicked Submit, and the
 * approver learns about it through TASK_ASSIGNED, which is the event that
 * actually concerns them.
 */
export const EVENT_TYPES = [
  /** A task was routed to you (or to a role pool you hold). */
  'TASK_ASSIGNED',
  /** The report cleared its LAST step. Addressed to the submitter. */
  'APPROVED',
  'REJECTED',
  'RETURNED',
  /** The submitter withdrew a submitted report before a decision. Addressed to
   *  the approvers whose pending tasks were just cancelled — "you no longer
   *  need to look at this" is a notification, and its absence is why a recalled
   *  report sits in a queue looking live. */
  'RECALLED',
  /**
   * Finance marked an approved report paid. Addressed to the submitter, and it
   * is the one notification in the product that is about money having actually
   * moved rather than about somebody's opinion of whether it should.
   *
   * It is also the last thing that happens to a report, so it is the message a
   * submitter is most likely to go looking for and least likely to have been
   * told about any other way — nothing else in the product surfaces "you have
   * been paid".
   */
  'REIMBURSED',
  /**
   * A budget period crossed one of its configured thresholds (VX4-5 part 3a).
   * Addressed to the budget's owner and that threshold's own recipients — NOT to
   * whoever filed the claim that crossed it, who learns about it as a policy
   * warning on their own report instead.
   *
   * The one event in the product whose subject is not an expense report, and the
   * one that deliberately does NOT exclude the actor: see `notifyRecipients`.
   */
  'BUDGET_THRESHOLD',
  /**
   * Somebody asked the submitter for receipts their expenses are missing (w2-06). Addressed
   * to the submitter, attributed to whoever asked — ExpenseOS's on-demand chase from the
   * cross-report expense view (`expenseApprovals.chaseReceipts`), "so the submitter should
   * see who is waiting on them".
   *
   * VeloExpense: only the on-demand chase emits it. ExpenseOS's daily `expense.receiptChase`
   * job sends the same event with no actor; here it sends RECEIPT_CHASE (below, d46).
   */
  'RECEIPT_REMINDER',
  /**
   * The daily reminder that a draft still has expenses without a receipt (w3-05, d46).
   * ExpenseOS's `expense.receiptChase` job, which ExpenseOS sends as RECEIPT_REMINDER with
   * no actor. VeloExpense's RECEIPT_REMINDER sentence names who asked, which a job cannot
   * fill, so the automatic one is its own event: its own wording, and its own preference,
   * so a person can turn the daily nudge off and still hear when somebody asks.
   */
  'RECEIPT_CHASE',
  /**
   * Somebody posted to a report's discussion thread (w2-02a, d37). ExpenseOS's `COMMENT`,
   * addressed to everyone else on the thread — the submitter and anybody an approval task
   * touched — never to everybody who could read the report.
   *
   * In-app only by default, ExpenseOS's one per-type exception ("no email noise / storms"):
   * see `EVENT_CHANNEL_DEFAULTS`.
   */
  'COMMENT',
  /**
   * An approval task was handed to somebody else (w2-02a, d36/d37). VeloExpense's: ExpenseOS
   * tells only the new assignee, as TASK_ASSIGNED, and its thread shows nothing. Here the
   * reassignment carries the reason it was given, and is addressed to the SUBMITTER — "the
   * submitter and reviewer need to know reasons why rejected or reassigned" — while the new
   * assignee still gets TASK_ASSIGNED.
   */
  'REASSIGNED',
  /**
   * w4-00c (ExpenseOS's events, with its approval engine). A Notify node in a report's
   * approval workflow sent an FYI (`server/lib/workflowEffects.ts`), to whoever the node
   * names — never to the person whose action fired it.
   */
  'NOTIFY',
  /**
   * An approval task passed the deadline an admin set on its step, and the step's
   * `onExpire` ran — escalated, rejected or approved (`approval.sweepExpired`). Addressed to
   * the submitter, and to the new approver on an escalation. VeloExpense's default flow
   * sets no deadline (d56), so only a step an admin gave one can send it.
   */
  'TASK_EXPIRED',
  /** An approval task is within a business day of its deadline: a reminder to its approver,
   *  once per task (`approval.sweepExpired`). */
  'DEADLINE_NEAR',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Where a notification can go. IN_APP is the always-on core channel and the only
 * one VX2-7 delivers; EMAIL and SLACK arrive with VX2-8's worker and read the
 * same rows.
 */
export const CHANNELS = ['IN_APP', 'EMAIL', 'SLACK'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * w5-00 — the events whose email waits for the digest rather than going out on its own.
 *
 * ExpenseOS's `DIGEST_TYPES` (`apps/worker/src/handlers/channels.ts`, 1e682dd6), whose job is
 * to coalesce "comment / informational bursts" into one email per person: `COMMENT`,
 * `ADJUSTED` and `CARD_STATUS`. VeloExpense: `COMMENT` only — the other two are virtual-card
 * events, and virtual cards are out of scope (7 Oct 2026).
 *
 * The two rules compose as ExpenseOS's do: COMMENT is digest-eligible (it never emails on
 * its own) AND defaults to email off (`EVENT_CHANNEL_DEFAULTS`), so a comment reaches
 * somebody's inbox only when they asked for comment emails — and then in the digest.
 */
export const DIGEST_EVENT_TYPES: ReadonlySet<string> = new Set<string>(['COMMENT']);

/** True when `eventType`'s email waits for the digest rather than sending on its own. */
export function isDigestType(eventType: string): boolean {
  return DIGEST_EVENT_TYPES.has(eventType);
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/* ── channel defaults ─────────────────────────────────────────────────────── */

/**
 * What a channel does when the user has expressed no opinion.
 *
 * The asymmetry is ExpenseOS's and it is right: email is opt-OUT, Slack is
 * opt-IN. An unasked-for email is an annoyance; an unasked-for DM is an
 * intrusion. IN_APP defaults on for everything, because a bell that is silent
 * until configured is a product that appears not to work.
 *
 * ExpenseOS's one per-type exception is `COMMENT`, which defaults to in-app only
 * "(no email noise / storms)". VeloExpense has no COMMENT event yet, so the
 * table below is uniform — the exception is recorded here rather than in a
 * comment somewhere else, so that adding comments later has an obvious home.
 */
const CHANNEL_DEFAULTS: Record<Channel, boolean> = {
  IN_APP: true,
  EMAIL: true,
  SLACK: false,
};

/**
 * Per-event exceptions to `CHANNEL_DEFAULTS`. w2-02a: ExpenseOS's `COMMENT`, which "defaults
 * to in-app only (no email noise / storms)" — the home the note above promised it.
 */
const EVENT_CHANNEL_DEFAULTS: Partial<Record<string, Partial<Record<Channel, boolean>>>> = {
  COMMENT: { EMAIL: false },
};

/** One user's overrides, as `${eventType}:${channel}` -> enabled. */
export type PreferenceMap = ReadonlyMap<string, boolean>;

export function preferenceKey(eventType: string, channel: Channel): string {
  return `${eventType}:${channel}`;
}

/**
 * Whether `channel` is on for `eventType`: the user's override wins, else the
 * default.
 *
 * THE STORED MAP HOLDS ONLY OVERRIDES, and that property is load-bearing rather
 * than an optimisation (GAP-AUDIT NT-3). ExpenseOS reads
 * `prefs[type]?.email ?? def.email` for exactly this reason: adding an event
 * type then needs no backfill, no migration, and no rewrite of anybody's stored
 * preferences. A representation that stored every type x channel explicitly
 * would need a data migration per new event.
 */
export function channelEnabled(
  eventType: string,
  channel: Channel,
  overrides: PreferenceMap,
): boolean {
  const override = overrides.get(preferenceKey(eventType, channel));
  return override ?? EVENT_CHANNEL_DEFAULTS[eventType]?.[channel] ?? CHANNEL_DEFAULTS[channel];
}

/** All three answers at once, for the fan-out. */
export function resolveChannels(
  eventType: string,
  overrides: PreferenceMap,
): Record<Channel, boolean> {
  return {
    IN_APP: channelEnabled(eventType, 'IN_APP', overrides),
    EMAIL: channelEnabled(eventType, 'EMAIL', overrides),
    SLACK: channelEnabled(eventType, 'SLACK', overrides),
  };
}

/** The default, for a UI that wants to show what "no opinion" means. */
export function channelDefault(channel: Channel, eventType?: string): boolean {
  // w2-02a: per event where it has an exception (COMMENT's email), else the channel's.
  const perEvent = eventType === undefined ? undefined : EVENT_CHANNEL_DEFAULTS[eventType]?.[channel];
  return perEvent ?? CHANNEL_DEFAULTS[channel];
}

/* ── template keys ────────────────────────────────────────────────────────── */

/**
 * Shape of a template key: `<owner>.<name>`, both snake_case. Ported verbatim
 * from ExpenseOS, and `0011` carries the same expression as a CHECK constraint —
 * so the database refuses a malformed key and this file refuses an unowned one.
 *
 * REJECTS: kebab-case, more than one dot, uppercase, a leading digit or
 * underscore in either half, a trailing underscore or dot, doubled underscores,
 * spaces, and an empty half.
 */
export const TEMPLATE_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Owners a key may claim.
 *
 * One entry today, which makes the closed list look like ceremony. It is not:
 * ExpenseOS's reason is prospective and it is the reason to establish the
 * convention while there is one owner rather than after there are four — "so two
 * features cannot both invent `request_submitted` and collide, and so a key says
 * which part of the product is responsible for the sentence."
 *
 * The list lives here and NOT in `0011`'s CHECK constraint on purpose: adding a
 * module must not need a migration.
 */
export const TEMPLATE_KEY_OWNERS = ['expense_management', 'budgets'] as const;
export type TemplateKeyOwner = (typeof TEMPLATE_KEY_OWNERS)[number];

/** True when `key` is well-formed AND owned by a known part of the product. */
export function isTemplateKey(key: string): boolean {
  if (!TEMPLATE_KEY_PATTERN.test(key)) return false;
  const owner = key.slice(0, key.indexOf('.'));
  return (TEMPLATE_KEY_OWNERS as readonly string[]).includes(owner);
}

/**
 * Locale-keyed text.
 *
 * ── VX4-7: THE ARITY IS GONE, AND SO IS THE SECOND DEFAULT (IL-7/IL-1) ──────
 *
 * This was `Partial<Record<'en' | 'fr-CA', string>>` with its own
 * `DEFAULT_LOCALE = 'en'`, and both halves were wrong in the same way.
 *
 * The ARITY was hardcoded here, which is IL-7's finding in miniature: upstream
 * pins the identical shape in six Zod schemas and eleven `labelEn`/`labelFr`
 * form pairs across ~17 files, so their third locale is "a schema-and-form
 * change plus a data backfill". Ours was two files, which is the only reason
 * this ticket is three days and not three weeks. It now derives from
 * `SUPPORTED_LOCALES`, so a fourth locale is one line in one file.
 *
 * The DEFAULT was worse, because it was a second opinion rather than a
 * duplicate: this file said the product's language was `en` while
 * `lib/money.ts` had been formatting `en-CA` since VX1. One product, two tags,
 * and `Intl` treats them differently — `en` renders `3/4/2026` and
 * `CA$10,799.00`, `en-CA` renders `2026-03-04` and `$10,799.00`. So a
 * notification could name a date in one convention while the amount beside it
 * used another. `DEFAULT_LOCALE` now lives in `lib/i18n/locales.ts` and nothing
 * else declares one.
 */
export type LocaleMap = Partial<Record<Locale, string>>;

export interface TemplateKeyDef {
  key: string;
  /** Shown in the admin list. */
  name: string;
  /** One line: when does this fire, and who receives it. */
  description: string;
  /**
   * The runtime `(eventType, subjectType)` pairs that render with this key. Many
   * pairs may share one key; one pair never has two — enforced at module load
   * below.
   */
  events: readonly (readonly [EventType, SubjectType])[];
  /**
   * The copy the product ships, and the fallback whenever no stored template
   * answers. Locale-keyed for the same reason the column is (see `0011`).
   *
   * ExpenseOS reads this from an i18n catalog and keeps `legacyEvent` /
   * `legacySubject` on each entry to find the right path. VeloExpense has no
   * catalog and no legacy table, so the copy lives here — one place, no path to
   * derive, and nothing to drift.
   */
  shipped: LocaleMap;
}

/**
 * Every message the product ships.
 *
 * The placeholders available to a template are exactly `RESERVED_PLACEHOLDERS`
 * plus whatever scalars the emitting call puts in the activity payload. An
 * unknown placeholder renders VERBATIM rather than blank — see
 * `applyPlaceholders`.
 */
export const TEMPLATE_KEYS: readonly TemplateKeyDef[] = [
  {
    key: 'expense_management.report_awaiting_approval',
    name: 'Report awaiting your approval',
    description: 'An approval step on an expense report was routed to the recipient.',
    events: [['TASK_ASSIGNED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': '{actor} needs your approval on {report} ({total}).' },
  },
  {
    key: 'expense_management.report_approved',
    name: 'Report approved',
    description: 'An expense report cleared its last approval step. Sent to the submitter.',
    events: [['APPROVED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': '{actor} approved {report}. It is ready for reimbursement.' },
  },
  {
    key: 'expense_management.report_rejected',
    name: 'Report rejected',
    description: 'An approver rejected an expense report. Sent to the submitter.',
    events: [['REJECTED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': '{actor} rejected {report}.' },
  },
  {
    key: 'expense_management.report_returned',
    name: 'Report returned for changes',
    description: 'An approver sent an expense report back to the submitter to amend.',
    events: [['RETURNED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': '{actor} returned {report} for changes.' },
  },
  {
    key: 'expense_management.report_reimbursed',
    name: 'Report reimbursed',
    description:
      'Finance marked an approved report paid. Sent to the submitter, with the payment ' +
      'reference when one was recorded.',
    events: [['REIMBURSED', 'EXPENSE_REPORT']],
    // `{reference}` is NOT one of the report placeholders and is supplied by the
    // reimbursement payload, which means it can be absent — the reference is
    // optional at payment time (0013). An absent placeholder renders VERBATIM as
    // `{reference}`, which would be worse than saying nothing, so the shipped
    // copy does not use it and a tenant that always records one can add it.
    shipped: { 'en-CA': '{report} has been reimbursed. {total} is on its way to you.' },
  },
  {
    key: 'expense_management.report_recalled',
    name: 'Report withdrawn',
    description:
      'A submitter withdrew a report before it was decided. Sent to the approvers whose ' +
      'pending tasks were cancelled.',
    events: [['RECALLED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': '{actor} withdrew {report}. It no longer needs your approval.' },
  },
  {
    key: 'budgets.threshold_crossed',
    name: 'Budget threshold crossed',
    description:
      'A budget period reached one of its configured thresholds. Sent to the budget owner ' +
      'and that threshold\'s own recipients.',
    events: [['BUDGET_THRESHOLD', 'BUDGET']],
    // No `{actor}`, deliberately, and it is the one shipped body that leaves the
    // reserved placeholder out. The actor is whoever's claim happened to tip the
    // period over; naming them reads as an accusation about one report when the
    // sentence is about a running total that many reports built. A tenant that
    // wants it can add `{actor}` to their own template.
    shipped: {
      'en-CA':
        '{budget} has crossed {thresholdPercent}% of its {period} budget — ' +
        '{used} of {amount}.',
    },
  },
  {
    // VeloExpense: ExpenseOS renders `(COMMENT, EXPENSE_REPORT)` from its catalog with no
    // template key; every event here has one (see the test that maps them all).
    key: 'expense_management.report_comment',
    name: 'Comment on a report',
    description:
      "Somebody posted to a report's discussion. Sent to everyone else on it — the submitter " +
      'and the approvers its tasks touched.',
    events: [['COMMENT', 'EXPENSE_REPORT']],
    // `{body}` is the posted text, from the comment's payload (ExpenseOS's field).
    shipped: { 'en-CA': '{actor} commented on {report}: {body}' },
  },
  {
    key: 'expense_management.report_reassigned',
    name: 'Approval reassigned',
    description:
      "An approver handed a report's pending approval to somebody else, with a reason. Sent " +
      'to the submitter.',
    events: [['REASSIGNED', 'EXPENSE_REPORT']],
    // `{assignee}` and `{note}` from the reassignment's payload.
    shipped: { 'en-CA': '{actor} passed the approval of {report} to {assignee}: {note}' },
  },
  {
    // ExpenseOS's key, name and description (`packages/notifications/src/templateKeys.ts`).
    key: 'expense_management.report_receipt_reminder',
    name: 'Missing receipt reminder',
    description: 'A draft expense still has no receipt attached.',
    events: [['RECEIPT_REMINDER', 'EXPENSE_REPORT']],
    // VeloExpense: ExpenseOS's shipped line is the event label alone ("A draft expense is
    // still missing its receipt"). The on-demand chase is attributed and counted, and its
    // report is not always a draft, so the sentence says who asked, how many, and on which
    // report — `{missing}` from the chase's payload, `{report}` from `reportPayload`.
    shipped: { 'en-CA': '{actor} asked for {missing} missing receipt(s) on {report}.' },
  },
  {
    // VeloExpense (w3-05, d46): the daily job's own key. ExpenseOS sends its reminder under
    // the key above; here the automatic one is worded and switched separately.
    key: 'expense_management.report_receipt_chase',
    name: 'Daily missing-receipt reminder',
    description:
      'A draft report still has expenses without a receipt, a few days after they were ' +
      'added. Sent to the submitter at most once a week per report.',
    events: [['RECEIPT_CHASE', 'EXPENSE_REPORT']],
    // No `{actor}`: nobody sent it. `{missing}` from the job's payload, `{report}` from
    // `reportPayload`.
    shipped: { 'en-CA': '{report} still has {missing} expense(s) without a receipt.' },
  },
  {
    // ExpenseOS's key, name and description (`templateKeys.ts`), w4-00c.
    key: 'expense_management.report_update',
    name: 'Expense report update',
    description: 'A workflow Notify node sent an FYI about an expense report.',
    events: [['NOTIFY', 'EXPENSE_REPORT']],
    // VeloExpense: ExpenseOS ships the event label alone. `{report}` from `reportPayload`.
    shipped: { 'en-CA': 'An update on {report} from its approval workflow.' },
  },
  {
    // ExpenseOS's key, name and description (`templateKeys.ts`), w4-00c.
    key: 'expense_management.report_approval_expired',
    name: 'Expense report approval expired',
    description: 'An approval task on an expense report passed its deadline without a decision.',
    events: [['TASK_EXPIRED', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': 'The approval of {report} passed its deadline without a decision.' },
  },
  {
    // ExpenseOS's key, name and description (`templateKeys.ts`), w4-00c.
    key: 'expense_management.report_approval_due_soon',
    name: 'Expense report approval due soon',
    description: 'An approval task on an expense report is approaching its deadline.',
    events: [['DEADLINE_NEAR', 'EXPENSE_REPORT']],
    shipped: { 'en-CA': 'The approval of {report} is due soon.' },
  },
];

export const TEMPLATE_KEY_BY_KEY: ReadonlyMap<string, TemplateKeyDef> = new Map(
  TEMPLATE_KEYS.map((d) => [d.key, d]),
);

/**
 * `${eventType} ${subjectType}` -> key. Built once at module load.
 *
 * The throw is ExpenseOS's and it is worth keeping: "Two keys claiming one
 * activity is unresolvable at runtime — whichever won would depend on array
 * order, which is not a decision anybody made." It fires at import, so a bad
 * registry fails the build's first test rather than one delivery in production.
 */
const EVENT_KEY_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const def of TEMPLATE_KEYS) {
    if (!isTemplateKey(def.key)) {
      throw new Error(`[notifications] "${def.key}" is not a valid template key`);
    }
    for (const [eventType, subjectType] of def.events) {
      const pair = `${eventType} ${subjectType}`;
      const existing = map.get(pair);
      if (existing && existing !== def.key) {
        throw new Error(
          `[notifications] (${eventType}, ${subjectType}) is claimed by both ` +
            `"${existing}" and "${def.key}"`,
        );
      }
      map.set(pair, def.key);
    }
  }
  return map;
})();

/**
 * The template key for one activity, or null when nothing has copy for it.
 *
 * NULL IS NOT AN ERROR. It means "render the shipped string", and it is
 * deliberately possible: there is no compile-time exhaustiveness guard forcing
 * every event type into the registry, which is a considered non-divergence
 * rather than an oversight (GAP-AUDIT NT-8). AP-19 went the other way — a
 * `Record<EmployeeRole, true>` over approver roles — and the difference is what a
 * miss costs. An unmapped approver role is a rung that routes nowhere. An
 * unmapped event degrades to a working notification with shipped wording, so
 * requiring authored copy before an event can exist would make the taxonomy
 * expensive to grow for no safety gained.
 */
export function templateKeyFor(eventType: string, subjectType: string | null): string | null {
  if (!subjectType) return null;
  return EVENT_KEY_MAP.get(`${eventType} ${subjectType}`) ?? null;
}

/** Every mapped pair, for tests and for the admin list. */
export function mappedEventPairs(): { eventType: string; subjectType: string; key: string }[] {
  return [...EVENT_KEY_MAP.entries()].map(([pair, key]) => {
    const [eventType, subjectType] = pair.split(' ') as [string, string];
    return { eventType, subjectType, key };
  });
}

/* ── rendering ────────────────────────────────────────────────────────────── */

/**
 * Placeholder names the notification MACHINERY supplies, as opposed to the ones
 * an emitting call puts in the payload.
 *
 * The distinction is not pedantry — it is which names are safe. These are applied
 * AFTER the payload, so a payload key cannot shadow them (ExpenseOS's rule, and
 * there is a test for it). Without the ordering, an activity payload carrying
 * `actor` could make a template say whatever it liked about who did something.
 */
export const RESERVED_PLACEHOLDERS = ['actor'] as const;
export type ReservedPlaceholder = (typeof RESERVED_PLACEHOLDERS)[number];

/**
 * Names every EXPENSE_REPORT event's payload is expected to carry.
 *
 * A CONVENTION, not a guarantee: they come from the payload like any other
 * scalar, so they are shadowable and an emitter that forgets one leaves
 * `{total}` visible in the sentence. That is the intended failure — see
 * `applyPlaceholders` on why an unknown placeholder renders verbatim. One place
 * fills them (`reportPayload` in `service.ts`) so a new caller cannot invent a
 * fourth spelling of "the report's title".
 */
export const REPORT_PLACEHOLDERS = ['report', 'number', 'total'] as const;

export type PlaceholderValues = Readonly<Record<string, string | number>>;

/**
 * Replace `{name}` with `values[name]`; leave an unknown placeholder IN PLACE.
 *
 * Two rules, both ported verbatim with their reasons:
 *
 * 1. Substitution is deliberately dumb. Named `{placeholder}` replacement and
 *    nothing else — "No expressions, no property access, no conditionals. A
 *    template editor that evaluates expressions against the notification context
 *    is an injection surface and a support burden, and the need it serves is
 *    rewording sentences."
 * 2. An unknown placeholder is left verbatim rather than blanked — "`{amont}` in
 *    the output is a visible typo somebody fixes, whereas an empty gap reads as
 *    a product bug and hides the cause."
 */
export function applyPlaceholders(source: string, values: PlaceholderValues): string {
  return source.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/**
 * Only SCALAR payload entries become placeholder values.
 *
 * ExpenseOS's reason, and the failure it prevents: "Scalar payload entries
 * become placeholders, so a template can say 'report {number} is missing
 * {missing} receipt(s)' without this handler knowing anything about receipts.
 * Non-scalars (arrays like ADJUSTED's `fields`) are dropped rather than
 * stringified as '[object Object]'."
 *
 * `null`, `undefined` and booleans are dropped too. A booleaned sentence reads
 * as "your report was true", and a dropped placeholder renders as `{flag}`,
 * which is at least visibly wrong.
 */
export function placeholderValuesFrom(payload: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Read one locale out of a locale-keyed map, falling back to `en`. */
export function localized(map: unknown, locale: string = DEFAULT_LOCALE): string | null {
  // VX4-7: was `m[locale] ?? m[DEFAULT_LOCALE]` inline — ExpenseOS's exactly one
  // hop, always to the default. `localizedFrom` walks `fallbackChain(locale)`
  // instead, which is the same answer for `en-CA`, adds the `en-US -> en-CA` hop,
  // and — the part that matters — gives `fr-CA` NO English hop at all.
  //
  // That last change is visible here rather than buried: this function used to
  // guarantee a French reader an English sentence whenever French copy was
  // missing, and now returns null so the caller falls through to shipped copy or
  // shows the missing-copy marker. `locales.ts` argues why at length; the short
  // version is that a fluent English fallback is invisible to everyone reviewing
  // in English and therefore ships forever.
  return localizedFrom<string>(map, locale);
}

/** One version's locale-keyed columns, as stored. */
export interface TemplateContent {
  subject?: unknown;
  body: unknown;
}

/**
 * Render stored template content in one locale — PURE, and the only place the
 * locale maps are unwrapped.
 *
 * It takes CONTENT rather than a key, and that split is ported even though VX2-7
 * ships no draft/preview (GAP-AUDIT NT-7). ExpenseOS's reason: "preview has to
 * render a version that is not published, and delivery must never render one
 * that is. Keeping the rendering identical while the SELECTION differs is the
 * whole point of the split."
 *
 * Returns null when the content carries no text for the locale or its fallback,
 * so the caller drops to the shipped string instead of sending an empty message.
 * A half-authored template is a MISS, not an empty body.
 */
export function renderContent(
  content: TemplateContent,
  locale: string,
  values: PlaceholderValues = {},
): { subject: string | null; body: string } | null {
  const body = localized(content.body, locale);
  if (body === null) return null;
  const subject = localized(content.subject, locale);
  return {
    subject: subject === null ? null : applyPlaceholders(subject, values),
    body: applyPlaceholders(body, values),
  };
}

/**
 * The shipped sentence for an event, with no database involved.
 *
 * ── THE FALLBACK, AND WHY IT CHANGED ───────────────────────────────────────
 *
 * This used to end `|| eventType`, ported from ExpenseOS's `renderMessage`
 * (`?? type`), and the reasoning written here was sound as far as it went: an
 * event with no registry entry renders as `TASK_ASSIGNED`, which is "ugly and
 * unmistakably a missing-copy bug rather than a blank row". Loud beats blank, and
 * that half was right.
 *
 * What it got wrong is that the product had since acquired a STANDARD way to be
 * loud, and this was not it. `missingCopyMarker` renders `{TASK_ASSIGNED}` —
 * braces around the value it could not resolve — and it is what `enumLabel`
 * returns for an unknown member, what `uiText` returns for an unknown key, and
 * what `test/i18n-ui.test.ts` and `test/i18n-enum-catalog.test.ts` both assert
 * against. One shape for "copy is missing here", everywhere.
 *
 * The difference is not cosmetic. A bare `TASK_ASSIGNED` in a notification body
 * is ambiguous: it could be deliberate shorthand, and a reader has no way to tell.
 * `{TASK_ASSIGNED}` cannot be mistaken for content by anybody, and it is
 * greppable — an operator seeing it in a screenshot can find every other instance
 * of the same class of bug.
 *
 * VX4-7 part 3 already made this exact call on this exact screen: the row's
 * SUB-LABEL was a raw `{row.eventType}` and became
 * `enumLabel(EVENT_TYPE_COPY, …)`, which falls back to the marker. The body path
 * simply was not updated to match, so one screen had two conventions for the same
 * failure — and the body is the half a person actually reads.
 *
 * Found by VX5-20's crawl fixture inserting a lower-case `expense_report` subject
 * type, which `templateKeyFor` does not match. That was a fixture bug, and this
 * was the product behind it.
 */
export function shippedBody(
  eventType: string,
  subjectType: string | null,
  locale: string = DEFAULT_LOCALE,
): string {
  const key = templateKeyFor(eventType, subjectType);
  const def = key ? TEMPLATE_KEY_BY_KEY.get(key) : undefined;
  return (def && localized(def.shipped, locale)) || missingCopyMarker(eventType);
}
