# Slack — setup runbook

How a tenant creates its Slack app, grants it the right scopes, connects it to VeloExpense,
and proves each piece works — so notifications arrive as DMs, each with one link into the
app.

> **Ported from ExpenseOS** `docs/runbooks/slack-setup.md` (1e682dd6), and adapted. Where
> VeloExpense differs, this says so. The two differences that change most of the text:
>
> - **Each tenant connects its own Slack app** (decided 17 Oct 2026, w5-02). ExpenseOS has
>   one org-wide app installed by a platform admin. In VeloExpense an organization's
>   administrator pastes their app's bot token and signing secret at **/admin/slack**, and
>   they are stored per tenant in `slack_connection` (migration 0074).
> - **A Slack DM goes through the delivery outbox**, like an email. ExpenseOS sends it from a
>   BullMQ job and swallows a failure. Here every DM is a `notification_delivery` row with
>   channel `SLACK`: a failure is recorded and retried, and a DM that cannot be sent is
>   CANCELLED with the reason. Both show on **/admin/notification-delivery**.
>
> **Not built yet: replies in Slack (w5-02b).** The events route
> (`/api/slack/events`), and a reply in a DM thread becoming a comment, come next. Until
> then nothing inbound exists: do not set an Event Subscriptions Request URL (§3), and §7
> describes the design rather than running code.

Everything below is derived from the code that actually runs:

| What | Where |
|---|---|
| Slack API calls, signature verification, the config states | `lib/notifications/slack.ts` |
| Outbound DM: message, link button, cached id, thread root | `lib/notifications/slackDispatch.ts` |
| The drain that sends it (three transactions) | `drainOutbox` in `lib/notifications/dispatch.ts` |
| Who gets a Slack delivery at all (preferences) | `notifyRecipients` in `lib/notifications/service.ts` |
| Thread ↔ subject mapping | `lib/notifications/replyThreads.ts` |
| Which subjects have a discussion | `hasCommentThread` in `server/lib/threadParticipants.ts` |
| The admin screen (fields, steps, test, disconnect) | `app/admin/slack/`, `lib/notifications/slackConnection.ts` |
| A person's "Slack account" check | `app/notifications/preferences/page.tsx` (`SlackLink`) |

Where a statement below could **not** be established from this repository, it says so.

---

## 0. What the integration actually does

```
notifyRecipients (when something happens)
  │  recipient opted into Slack for this event type?      ← Notification preferences, opt-IN
  ▼
notification_delivery (channel SLACK, PENDING)
  │
drainOutbox, every two minutes
  │  tenant's Slack connected and readable?               ← getSlackConfigStatus()
  ▼                                                          (no → CANCELLED, with the reason)
users.lookupByEmail(recipient.email)                      ← cached on app_user.slack_user_id
  │                                                          (no account → CANCELLED;
  ▼                                                           Slack did not answer → FAILED, retried)
chat.postMessage(channel = U…, blocks)                    ← a DM
  ├─ message text
  ├─ ONE link button to the report ─────────────────────► the browser, signed-in app,
  │    on the tenant's own address; "Review and approve in VeloExpense" when the
  │    recipient can decide now, "View expense report" otherwise; nothing is posted back
  └─ first message for the report becomes the THREAD ROOT (reply_thread.slack_thread_ts)
       │
       └─ a human replies in that thread ─────────────────► (w5-02b) POST /api/slack/events
                                                              → COMMENT on the report
```

Three independent switches must all be on before anybody receives anything:

1. the **organization has connected Slack** at /admin/slack, with a bot token
   (`getSlackConfigStatus` reads `slack_connection` on the tenant's transaction);
2. the **recipient opted in** — Slack defaults to off for every event type
   (`CHANNEL_DEFAULTS` in `lib/notifications/catalog.ts`), unlike email;
3. the recipient's email **resolves to a Slack user id** (§10).

VeloExpense: switches 1 and 3 announce themselves on the delivery screen, as the CANCELLED
row's reason. Switch 1 is also logged by the drain, `[notifications] Slack was requested but
…`, once per reason per process. Switch 2 stays quiet by design: with no opt-in there is no
delivery row at all, and nobody is messaged by connecting Slack alone.

---

## 1. Create the Slack app

**api.slack.com/apps → Create New App → From scratch**, pick the workspace.

One app per VeloExpense organization, with one bot token — not per-user OAuth. There is no
OAuth callback and no per-user consent: an administrator pastes the token.

---

## 2. Bot token scopes

Only three Slack Web API methods are ever called. Every scope below is traceable to one of
them:

| Scope | Required by | Call site |
|---|---|---|
| `chat:write` | `chat.postMessage` — every notification DM | `sendSlack`, `lib/notifications/slack.ts` |
| `users:read.email` | `users.lookupByEmail` — matches a VeloExpense person to a Slack account by email | `lookupSlackUser`, same file |
| `users:read` | Paired with `users:read.email`; Slack's app-config UI adds it alongside | listed in the setup steps on /admin/slack |
| `im:history` | Receiving the `message.im` events the inbound reply path will consume (w5-02b) | — |

`im:history` is in the list now although nothing inbound exists yet, so that nobody has to
reinstall the app — which changes the token — when replies arrive.

One call needs **no** scope: `auth.test`, the **Test connection** button on /admin/slack
(`verifySlackToken`).

**No user scopes are used.** Nothing reads or sends a `xoxp-` token.

> **Derivation note.** The *method → scope* mapping is Slack's API contract, not something
> this repository states. What the repository proves is **which methods are called**; the
> scope each one demands is read off Slack's own documentation. If Slack changes a
> requirement, this table is the thing that goes stale.

> **`im:write` is genuinely uncertain.** `sendSlack` passes a `U…` user id straight to
> `chat.postMessage` as `channel` and never calls `conversations.open`. Whether the
> workspace requires `im:write` for the bot to open that DM is not determinable from this
> code. If DMs fail with `channel_not_found` for a user who exists, add `im:write`,
> reinstall, and re-test — that is the one scope to try before investigating anything else.

**After adding or changing any scope you must reinstall the app to the workspace, and the
bot token changes.** Paste the new one at /admin/slack, or every call starts failing with
`missing_scope` against a token that looks correct.

---

## 3. Request URLs

| Slack setting | Value |
|---|---|
| **Interactivity & Shortcuts** | **Off**. Nothing is decided in Slack (§6). |
| **Event Subscriptions** | **Leave off until w5-02b ships.** The Request URL will be the organization's own address, `https://<tenant>.<app domain>/api/slack/events`, subscribed to `message.im`. |

VeloExpense never had in-Slack approvals, so there is no Interactivity URL to switch off.
(ExpenseOS removed its own on 2026-10-07; its runbook keeps the migration steps.)

The link button is opened by the person's own browser, like any other link to the app.

---

## 4. Signature verification

`verifySlackSignature(signingSecret, timestamp, rawBody, signature)` in
`lib/notifications/slack.ts` checks, in order:

1. both `X-Slack-Request-Timestamp` and `X-Slack-Signature` are present — missing either is
   an immediate `false`;
2. the timestamp parses as a finite number and is within **300 seconds** of now
   (`Math.abs(Date.now() / 1000 - ts) > 300`) — the replay window;
3. `v0=HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)` equals the header,
   compared with `timingSafeEqual` after a length check.

It is ported and tested, and nothing calls it yet: its caller is the events route (w5-02b).
`slackInboundGate` is ported with it and names four states, each with its own sentence:

| State | What it means |
|---|---|
| `not-installed` | The organization has not connected Slack. Connect it at /admin/slack. |
| `no-bot-token` | A connection whose token reads as blank. /admin/slack cannot produce this (the token is required to connect, and a blank field on an edit keeps the stored one); it is kept so such a row is named rather than sent to Slack. |
| `no-signing-secret` | Bot token present, no signing secret. Outbound DMs work; nothing inbound can be verified. |
| `unreadable` | The stored secrets could not be decrypted — `SECRET_ENCRYPTION_KEY` missing from this process, or not the key they were saved under (§5). |

---

## 5. Config fields

Two, and **both are secret**, entered at /admin/slack:

| Field | Required to save | What it is |
|---|---|---|
| Bot User OAuth Token | **yes**, to connect | `xoxb-…`. |
| Signing Secret | no | Basic Information → App Credentials → Signing Secret. |

The signing secret is optional to save so a connection can be made before the Slack app is
finished — but it will be required for anything inbound (w5-02b). Outbound DMs are unaffected
by it: the link button is the same with or without it (§6).

The same three rules as ExpenseOS's secret fields, in `lib/notifications/slackConnection.ts`:

- **never rendered** — the screen shows an empty box and "already set", not a mask;
- **blank means unchanged** on a save, so re-saving the form does not wipe a secret nobody
  retyped; a new token clears the last test result, which was about the old one;
- **encrypted at rest** — `enc:v1:` AES-256-GCM in Node under `SECRET_ENCRYPTION_KEY`
  (`lib/crypto/secrets.ts`), where ExpenseOS uses pgcrypto under `PG_CRYPTO_KEY`. The table
  refuses anything not marked `enc:v1:` with a CHECK constraint.

**`SECRET_ENCRYPTION_KEY` must be set in every process that sends or receives Slack** — the
web app runs the drain. Without it the delivery is CANCELLED with the `unreadable` sentence and
the drain logs it once:

```
[notifications] Slack was requested but the Slack connection could not be decrypted
(SECRET_ENCRYPTION_KEY is not set, …) — SECRET_ENCRYPTION_KEY must be set in THIS process,
and it must be the key the connection was saved under. See docs/runbooks/slack-setup.md.
No Slack messages will be sent.
```

**Disconnect deletes the row**, token and secret included. Connecting again starts fresh.

---

## 6. One link button, or no button at all

`slackBlocks(...)` in `lib/notifications/slackDispatch.ts` adds at most one `actions` block,
holding one `button` with a `url` and no `action_id` or `value`. A press opens the browser
and posts nothing to VeloExpense.

**One button** — the DM has a link. The label is "Review and approve in VeloExpense"
(`notifications.ctaApprover`), styled `primary`, when the event is `TASK_ASSIGNED` and
`resolveDecidableTask` finds a task on the report that the recipient can decide — the same
question the report page and the email ask. Otherwise it is "View expense report".

**No button** — there is no app origin. `appOrigin()` reads `APP_URL || AUTH_URL ||
NEXTAUTH_URL`, and the link is on the tenant's own address (`originForTenant`). With none set
the DM is a correct sentence with nothing to click. The one thing that says so is the log
line, once per process:

```
[notifications] no APP_URL / AUTH_URL / NEXTAUTH_URL is set — …
```

VeloExpense: only expense reports are linked. A notification about anything else is
CANCELLED ("nothing to link to"), as its email is.

The message has no facts table yet. ExpenseOS puts the subject's fields under the sentence
(`subjectPresentation`); VeloExpense has not ported that, and its emails do not carry it either.

The template body is escaped for Slack (`slackText`: `&`, `<`, `>`), because it interpolates
text people type — a report title written as `<https://…|Approve>` would otherwise render as a
disguised link. ExpenseOS posts a template body unescaped.

---

## 7. Inbound replies → comments (w5-02b — not built yet)

The outbound half is in place: the **first** DM about a report is remembered as the thread
root (`setSlackThread`, `reply_thread.slack_channel_id` / `slack_thread_ts`), and later DMs
about the same report post with `thread_ts` = that root. A reply in that thread will map back
to the report through `findThreadBySlack(channel, thread_ts)`.

Only expense reports have a discussion in VeloExpense (`hasCommentThread`).

---

## 8. Verify, in this order

1. **Token is valid.** /admin/slack → **Test connection**. This runs `auth.test` and reports
   `Connected as <bot> in <team>.` A failure quotes Slack's own error code verbatim
   (`invalid_auth`, `token_revoked`, …). *It does not check scopes* — `auth.test` passes with
   no scopes at all.
2. **Opt in.** Notification preferences → **Slack: On** for an event you can trigger (a
   comment on a report is the easiest). Slack is opt-in per person per event type.
3. **A DM arrives** within two minutes (the drain's interval), or press **Send waiting mail
   now** on /admin/notification-delivery. If nothing arrives, that screen has the row and its
   reason (§9).
4. **The message has a button.** Its absence means no app origin (§6).
5. **Press the button.** The browser opens the report, after the sign-in page if signed out.
6. **The next notification about the same report** arrives as a reply in the first one's
   thread.

---

## 9. When it doesn't work

/admin/notification-delivery lists Slack deliveries beside emails, marked **Slack ·** with the
Slack user id they went to.

| Symptom | Most likely cause |
|---|---|
| No row at all for the person | They have not opted in to Slack for that event (switch 2). |
| **Nothing to send**: "Slack is not connected for this organization" | Nobody has connected Slack at /admin/slack, or it was disconnected. |
| **Nothing to send**: "Slack has no account for …" | `users.lookupByEmail` found no account for their address — usually their Slack account uses a different email. The negative is cached for **7 days** (§10). They can press **Check again** under Notification preferences → Slack account, which clears it immediately. |
| **Failed**: "Slack could not be asked whether … has an account (ratelimited)" | A rate limit, a bad token, or a Slack outage during the lookup. Nothing is cached from it; the delivery is retried. If the detail is `missing_scope` or `invalid_auth`, fix the token (§2). |
| **Failed** / **Dead**: `slack: chat.postMessage failed (…)` | Slack's own error code: `missing_scope` (reinstall after adding a scope — the token changed), `invalid_auth`, `channel_not_found` (see the `im:write` note in §2). |
| **Nothing to send**: "the Slack connection could not be decrypted" | `SECRET_ENCRYPTION_KEY` is missing, or is not the key the connection was saved under. Fix the key, or disconnect and connect again. |
| Message arrives with **no button** | No app origin. §6. |
| An approver's button says "View expense report" | They could not decide a task on the report when the DM was sent. The button opens the same report either way. |
| Everything worked, then stopped after a scope change | Reinstalling issues a **new** bot token. Paste it at /admin/slack. |
| One person stopped receiving DMs after changing their Slack account | Their cached id is cleared the first time Slack refuses it, and the retry looks the address up again (§10). |

---

## 10. The cached Slack user id

A DM is addressed to a Slack **user id**, resolved from the person's VeloExpense email via
`users.lookupByEmail` and cached on `app_user.slack_user_id` / `slack_lookup_at`. The cache
exists because the method is rate-limited and a submit fans out to several people at once —
not because the answer is permanent.

Four things can correct it:

| Repair | When | Why it is not enough on its own |
|---|---|---|
| **Positive re-check, 30 days** | A resolved id has gone a month without confirmation | Slow, but it is the only thing that notices a *silent* move to another Slack account. |
| **Negative re-check, 7 days** | Slack said no account has this address | Somebody who fixes their address should not wait a week — see the button. |
| **Automatic clear on refusal** | `chat.postMessage` answers `channel_not_found` / `user_not_found` | Only fires when the id is genuinely dead. VeloExpense: the delivery is FAILED and its retry re-resolves. |
| **Notification preferences → Slack account → Check again** | The person knows the answer changed | Immediate; clears both columns so the very next DM re-resolves. |

Two behaviours worth knowing, because they look wrong from outside:

- **A lookup that did not complete is never cached.** `ratelimited`, `invalid_auth`,
  `missing_scope` and a 5xx are facts about the CALL, not about the person.
- **A re-check that comes back empty does not blank a working id.** The usual cause is that
  the person changed the email on their Slack account — the account is fine and the DM still
  arrives. The id is kept, the log says so once per address, and if the id really is dead the
  next send fails and clears it with proof.

`account_inactive` and `invalid_auth` deliberately do **not** clear anybody's cached id: both
are about the bot's own token.
