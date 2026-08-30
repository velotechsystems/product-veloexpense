# Gap audit — VeloExpense vs ExpenseOS source

Findings from reading ExpenseOS **source** against shipped VeloExpense code. Separate from
`SPEC-BASELINES.md`, which is the mechanism; this is the findings log.

Each entry is: what ExpenseOS does, what we do, whether it is a live defect / a latent gap / a
deliberate divergence, and what to do. **Nothing here is a bug report until the "status" says so** —
several checks came back with VeloExpense ahead, and those are recorded too so a later "faithful
port" does not regress us.

---

## Decisions taken (2026-08-28) — the three that were blocking VX2-2

Recorded here rather than only in the findings below, because each one closes a question that the
audit opened and a later reader will otherwise re-open. John decided all three.

| # | Question | Decision | Cost accepted |
|---|---|---|---|
| **AP-7** | Can an unassigned-but-claimable task exist? | **REVERSED, same day — yes.** First decided "no, keep the CHECK"; reopened on the discovery below and settled as **option (ii)**: `0009` relaxes the CHECK and adds `approval_task.claim_role`. | ~1 day on VX2-2, and the pending-task query stops being `assignee_id = $1`. |
| **AP-10** | `manager_level = 3` on a two-deep chain? | **Degrade to the most senior ancestor found**, as ExpenseOS does, and record the shortfall on the task. `CHAIN_EXHAUSTED` is reserved for no-manager-at-all, where AP-5's fallback takes over. | A policy can be satisfied non-literally. Visible in `escalation_level`, so it is auditable rather than silent. |
| **AP-14** | Break-glass for a sole-approver tenant? | **Yes — per-tenant, audited, and only when the resolver can prove no other eligible approver exists.** | A deliberate, narrow exception to the AP-13 hard block. Every use is a row in the VX2-6 audit chain under its own action, so it is trivially reportable. |

**Consequence: VX2-2 now carries a small migration `0009`.** One column, for AP-14:

```sql
ALTER TABLE organization
    ADD COLUMN allow_sole_approver_self_approval boolean NOT NULL DEFAULT false;
```

**Correction to AP-14 as first written:** it proposed this flag on `approval_policy`. That is wrong.
`approval_policy` is one row **per rung** — it carries `sequence` and `threshold_minor` — so a flag
there would be per-rung, and a tenant with four rungs could set it on three of them, which is
meaningless. It belongs on `organization`, which is the tenant row.

It should be a real column and **not** a key in `organization.settings jsonb`, even though that
column exists and would need no migration. The whole argument in AP-11 for VeloExpense's column
model over ExpenseOS's JSON graph is that a security-relevant setting in a blob cannot be
constrained, cannot be grepped, and cannot be found by someone auditing what turns a control off.
`DEFAULT false` means every existing tenant is unaffected, which is the correct direction for a flag
that relaxes a guard.

**VX2-6's two inputs, decided 2026-08-28:** per-tenant audit **export** is OUT of scope (exporting
a hash-chained log usefully means exporting the verification proof too, and what an auditor should
receive is a decision nobody has made — a CSV dump now becomes the de facto format by accident; it
belongs with the Phase 4 controls work). `audit_entry` lives in **`public`** like every other table,
diverging from VeloLedger's dedicated `audit` schema, because CI's RLS-coverage guard, the isolation
test and `veloapp`'s grants all assume `public` — and a table the guard cannot see is precisely the
table you do not want unprotected. The chain-key question turned out not to need asking: see AU-2.

Not decided, and not blocking VX2-2: the per-approver **authored** fallback of AP-5
(`fallback_kind` / `fallback_user_id` / `fallback_role` on `approval_policy_approver`, per AP-11's
column shape) — `ADMIN_FALLBACK` covers the unconfigured tenant, so an admin authoring their own
fallback is a later ticket. Also open: VX2-6's two inputs (UUIDv7 vs `bigserial` for the chain key;
whether per-tenant audit **export** is in scope).

Note AP-7's reversal does **not** revive AP-5's authored fallback. They are different features:
`claim_role` is how a ROLE approver the admin *already configured* routes, while AP-5's fallback is
what happens when a MANAGER approver resolves to nobody. Only the first is in VX2-2.

---

## Decisions taken (2026-08-29) — the three that were blocking VX2-7

| # | Question | Decision | Cost accepted |
|---|---|---|---|
| **NT-4** | Template identity: the board's coordinates, or the source's key? | **Key.** One row per (`key`, `channel`), locale-keyed JSON body/subject, and an explicit `(event_type, subject_type) → key` table in code with a module-load collision guard. **Diverges from the Phase-2 board note**, which describes the design ExpenseOS's own postmortem deletes. | The board's "any-subject" rung disappears — it only ever existed because `subjectType` was a nullable key column. A small registry file to write and keep honest. |
| **NT-2** | Can a preference suppress an IN-APP notification? | **Yes, fully.** The preference is consulted at FAN-OUT (`notifyRecipients`), which is a different place in the flow from ExpenseOS, where in-app is unconditional and prefs gate only email/Slack. Their schema already documents an `inApp` key that no code reads; this makes it real rather than shipping the dead toggle. | Somebody can mute their own inbox and miss a returned report. Mitigated by auditing preference CHANGES on the VX2-6 chain, so "I was never told" is answerable; the suppression itself writes nothing. |
| **NT-7** | How much of the draft/published version machinery ships now? | **None of it.** Body and subject live directly on the `(key, channel)` row. The pure `render(content, values)` split IS ported, so a version table is additive later. | No draft, no preview, no revert, no per-reword history. Unticketed follow-up, recorded in HANDOFF §7. |

**Decided without asking, on existing precedent:** a fresh tenant gets **zero** template rows.
VX1-7 already settled this shape — the starter policy set lives only in `DEFAULT_POLICIES` and
`scripts/seed.mjs` deliberately seeds none, "so there is no second copy to drift". Shipped copy
lives in code; a template row exists only where a tenant has overridden it. This is also what makes
VX2-7's acceptance criterion ("an empty template table still renders shipped copy") the *normal*
path rather than an edge case.

## Decisions taken (2026-08-29, later) — the three that were blocking VX2-8

| # | Question | Decision | Cost accepted |
|---|---|---|---|
| **NT-19** | What carries a delivery job? VeloExpense has no queue, no worker and no Redis. | **A Postgres outbox plus a poller.** `FOR UPDATE SKIP LOCKED`, `attempts` / `next_attempt_at` / `last_error`, and the admin queue is that table with a policy on it. NOT BullMQ/Redis. | We write the backoff, the claim, the visibility timeout and the dead-letter ourselves — the parts BullMQ gives away. Accepted on the precedent VX1-9 set choosing `s3rver` over MinIO: "one Node process — no Docker for CI or a laptop." |
| **NT-20/21** | The board says "email/Teams/Slack". | **EMAIL ONLY.** Slack and Teams become their own tickets. Email is a strict prerequisite for Slack anyway — ExpenseOS's Slack buttons fall back to the same confirm page the email links to — so nothing is stranded. | The board title is not delivered literally, and `/admin/approval-ladder` keeps hiding EMAIL approvers only until THIS ticket lands, not until Slack does. Teams has no source to port and would also need a migration to widen `notification_preference_channel_check`. |
| **NT-17** | How long does an approve-link live, with no task TTL to read? | **A fixed five business days**, the number ExpenseOS uses, with a comment recording that it becomes the task's own TTL if AP-8 ever ships. | A link outlives a short holiday and dies before a forwarded mailbox becomes a credential store. It is a constant rather than a policy, so a tenant cannot shorten it. |

**Consequence: VX2-8 carries migration `0012`** — `notification_delivery` (the outbox) and
`action_token`, both with `organization_id` and `FORCE ROW LEVEL SECURITY`, both in the isolation
test. And it introduces **the second and third `withoutOrg` reads in the product**: the poller
finding work across tenants, and the approve-link handler resolving a bare token to its tenant
before any session exists. Both must take NOTHING from the row they find except the organization id
— that constraint is the whole reason those two reads are safe, and it is easy to widen by accident.

## Decisions taken (2026-08-29, VX2-9) — the two that were blocking reimbursement

| # | Question | Decision | Cost accepted |
|---|---|---|---|
| **RB-3** | May somebody mark their OWN report reimbursed? ExpenseOS allows it — no self-payment check at all, in a codebase that treats self-APPROVAL as a SOX-grade control. | **No.** Refused, with AP-14's existing break-glass (`allow_sole_approver_self_approval`) as the audited exception — the forcing case is identical, a tenant where the admin who submits is the only person who can act. | That column's NAME now under-describes what it governs. `0013` widens its COMMENT rather than adding `allow_self_reimbursement`, because one flag with a stale name beats two flags where the second is never set. |
| **RB-1** | What does a reimbursement record? Theirs writes one column and passes `details: {}` to its own audit call. | **Date, actor and an optional reference.** `0013` adds `reimbursed_at`, `reimbursed_by_id`, `reimbursement_reference` to `expense_report`. | Three columns and a migration on a ticket the board sized at one day. Bought because `approved_at` already exists (the asymmetry would read as a bug) and because RB-6 establishes the status is bookkeeping-free — without a reference it asserts a payment and offers nothing to check it against. |

**Not a decision, but the thing that made this audit worth doing: RB-2 is a live double-payment race
in their code** — the status is read outside the transaction and the UPDATE re-asserts only the id,
so two concurrent calls both write, producing two audit rows and two notifications for one payment.
It is the FOURTH appearance of this shape in the port and VeloExpense already answers it three times
(VX2-3's decision claim, VX2-8's token consume, VX2-8's delivery claim), so the fix is the house
idiom rather than an invention.



**Consequence: VX2-7 carries migration `0011`.** Four tables — `activity`, `notification`,
`notification_preference`, `notification_template` — all with `organization_id`, all `FORCE ROW
LEVEL SECURITY`, all in the isolation test (NT-1 explains why RLS is the only guard `activity` gets:
`subject_id` is polymorphic and can carry no FK). **No `emailed_at`** — see NT-15.

---


## policy-engine (VX1-7, VX1-8) — PARTIAL, ~45% read

Source read: `packages/predicate/src/engine.ts` (11.4 KB), `validate.ts` (18.6 KB), `facts.ts`
(6.8 KB). **Not yet read:** `builtinKinds.ts` (28 KB), `kinds.ts` (20.8 KB), `paramsSpec.ts`,
`messageKeys.ts`, and `packages/money` (which `facts.ts` calls via `convertMoney`). The rule engine
lives in `packages/predicate` — there is no `packages/policy`.

### PE-1 · Policy thresholds have no currency — **LIVE**, not latent. Needs a ticket.

Source read: `packages/predicate/src/{engine,validate,facts}.ts`.

**What ExpenseOS does.** A policy currency (`SystemFlag policyCurrency`, **default `'CAD'`**) is the
one currency every amount threshold compares in. `validate.ts` loads `FxRate` rows and builds a
lookup, then `facts.ts` converts each line amount, the report total and `maxLineAmount` into that
currency before any numeric predicate runs — with the stated reason: *"otherwise a multi-currency
report compares incommensurable minor units."*

**What VeloExpense does.** Nothing. `expense_policy` has no currency column, `params.thresholdMinor`
is a bare bigint, and `rules.ts` compares it directly against `amount_minor`. The only currency
reference in the whole policy layer is `formatMinor(...)` — *message formatting*, not comparison.

**Why this is LIVE, not latent** (correcting an earlier version of this entry). `expense_report
.currency_code` is per REPORT, but a policy threshold is per TENANT. So a tenant with one USD report
and one CAD report compares both against the same number. `thresholdMinor = 500000` means $5,000 USD
on one report and $5,000 CAD — about $3,650 USD — on the other. VeloExpense ships CAD and USD, so a
tenant using both hits this today. The single-currency-per-report cascade from VX1-6 does not help:
it makes each report internally consistent and says nothing about the threshold.

**Do:** ticket a policy currency (tenant default + per-rule override) and convert before comparing.
Port ExpenseOS's *loud* degradation, not its silent one — see PE-7. Needs PE-3 to express it.

**CLOSED by VX3-2 (migration `0015`, PR pending).** Exactly as prescribed: `organization
.policy_currency_code` with a nullable `expense_policy.currency_code` override, and the LINE is
converted into the THRESHOLD's currency rather than the reverse — the threshold is what an admin
typed and is authoritative in the currency they typed it in. A missing rate emits INFO with an
`fxRateMissing` payload and does not block. The message now names both currencies whenever a
conversion happened, because the sentence that printed a CAD limit with the report's currency symbol
is how this survived as long as it did.

### PE-2 · Graduated thresholds are impossible to configure — DELIBERATE DIVERGENCE, with a cost

**ExpenseOS** allows several instances of one rule kind at one scope, and therefore needs a
`keepMostSevere` pass: *"a receipt threshold that WARNS over $25 and one that BLOCKS over $75 are
separate rules, and a $100 line breaches both. Reporting both is two problems where there is one —
and worse than cosmetic, because the submit gate counts unjustified WARNINGs, so the submitter is
asked to justify a warning about the very thing that is already blocking them. Justifying it
changes nothing; the block still stands."*

**VeloExpense** cannot hit that bug: `expense_policy_kind_scope_idx` is UNIQUE on
`(organization_id, kind, COALESCE(category_id, …))`, so only one instance of a kind exists per
category scope. Correspondingly `policy_violation.rule_code` stores the **kind**, not the instance
id — a coarser identity, consistent with the index.

**The cost:** a tenant cannot express "warn at $25, block at $75" **at all**. That is a real
capability ExpenseOS has and we do not.

**Do:** nothing now — but **if that unique index is ever relaxed to allow graduated rules, we
inherit ExpenseOS's exact bug and must port `keepMostSevere` in the same change.** Recorded here so
whoever relaxes it finds this first.

### PE-3 · A rule cannot downgrade its own severity — GAP, small

**ExpenseOS:** `stamp()` resolves severity as `f.severity ?? inst.severity`, so a kind may override
the configured severity for one finding. That is the mechanism behind PE-1's graceful degradation.

**VeloExpense:** severity comes only from the `expense_policy` row; `Finding` carries no severity.
A rule that cannot evaluate has no way to say "I could not check this" — it either fires at full
configured severity or stays silent.

**Do:** add an optional `severity` to `Finding`. Cheap, and PE-1 needs it.

**CLOSED by VX3-2.** `Finding.severity?` resolves as `finding.severity ?? policy.severity`, the same
shape as their `f.severity ?? inst.severity`. One caller so far: the missing-rate INFO. Worth knowing
that the first implementation passed the POLICY's severity on the INSERT path and the finding's only
on the UPDATE path, so the override worked on re-validation and not on first evaluation — which is
the run nobody looks at. A test caught it.

### PE-4 · No cap on findings per rule — GAP, small

**ExpenseOS** caps output at one violation per scope per rule so *"a 100-line report with every
limit blown would still produce ≤ ~600 rows, not thousands."*

**VeloExpense** has no cap. VX1-7's `finding_key` deliberately *allows* many findings per
(rule, line) — which fixed a real ExpenseOS bug (their Module 9 doc admits keying on
`(ruleCode, lineItemId)` loses all but the first) — but it removed the bound at the same time.

**Do:** consider a per-rule cap. Low priority; a report has to be pathological to matter.

### PE-7 · ExpenseOS has TWO disagreeing FX-failure behaviors — port one, refuse the other

This is the mechanism behind the GA audit's **CAD-exclusion-from-totals** P0/P1, and behind the
`fix/fx-reciprocal-rates` branch now on ExpenseOS `origin`.

**The reciprocal gap.** `validate.ts` builds the rate lookup forward-only:

```ts
const fxRates = new Map<string, string>();
for (const r of fxRows) {
  const key = `${r.base}->${r.quote}`;
  if (!fxRates.has(key)) fxRates.set(key, r.rate.toString());
}
```

No inverse is derived. ExpenseOS's FX sync is Bank-of-Canada, which publishes CAD-quoted pairs, so
`USD->CAD` exists and `CAD->USD` does not. An admin who correctly sets `policyCurrency = 'USD'` for
a US entity therefore has **every CAD line fail to convert** — which is why this reads as "CAD
mishandled in totals" and why it is a US-fit blocker rather than a cosmetic bug.

**Then the two paths disagree about what to do on failure.**

- The **built-in / AGGREGATE kinds** degrade LOUDLY. `engine.ts`'s header: limit rules *"degrade to
  `info` severity with a 'rate missing' payload — never silently skip, never crash."* Correct
  behavior, and the thing to port.
- The **v2 admin-authored PREDICATE facts** degrade SILENTLY. `facts.ts`:

  ```ts
  const converted = convertMoney({ amountMinor, currencyCode: fromCode }, to, src.fxRates);
  return converted ? converted.amountMinor : amountMinor;   // ← raw units, unchanged
  ```

  A failed conversion returns the amount **as if it were already in the policy currency**. So 10,000
  JPY minor units are compared as 10,000 CAD minor units. That is worse than exclusion: the
  threshold silently under- or over-triggers with no INFO, no payload, no signal — and it also
  corrupts `maxLineAmount` and `reportTotal`, which is how a total ends up wrong.

**And the library is not at fault — one caller chose the unsafe branch of a documented choice.**
`packages/money/src/convert.ts`'s own header spells out both options:

> `- missing rate → returns null (callers decide whether to emit a diagnostic, default to the
> source currency, etc.)`

`convertMoney` correctly returns `null`. `engine.ts` takes the diagnostic option; `facts.ts` takes
"default to the source currency". That is the whole defect: a documented fork where one branch
produces a signal and the other produces a wrong number, and the newer code path picked wrong.

**Do:**
1. **PORT** the loud degradation when PE-1 lands: a rule that cannot convert emits INFO with a
   `fxRateMissing` payload. Never guess.

**Item 1 DONE, and the reciprocal gap avoided rather than inherited, by VX3-2.** `fx_rate` stores
one direction and `lib/policy/rates.ts` DERIVES the inverse, so a CAD-quoted source cannot leave a
USD-policy tenant unable to convert anything. Storing both directions was considered and rejected:
two rows for one pair can disagree, a derivation cannot. There is a test that stores only `USD->CAD`,
sets the policy currency to USD, and asserts a CAD line is still checked — with `rateBasis:
'RECIPROCAL'` in the payload so the reader can tell which way it went. No triangulation: an unknown
pair returns null and degrades loudly.
2. **DO NOT PORT** `facts.ts`'s raw fallback. If VeloExpense ever adds a predicate fact layer, a
   missing rate must fail the check, not substitute a wrong number.
3. **Derive reciprocals** when building any rate lookup, or refuse the pair explicitly. A
   forward-only map plus a single-direction rate feed is the whole bug.

### PE-5 · Where VeloExpense is already correct

- **First-writer-wins dedupe per finding identity** — ExpenseOS's `dedupe()` pass. We have the
  equivalent in `validateReport` ("First writer wins for a given identity"). ✓
- **Re-validation reconciles** rather than replaces, and an acknowledgement survives unless severity
  becomes BLOCK. ✓
- **BLOCK cannot be acknowledged**; acknowledgement requires a note. ✓

### PE-6 · Versioning lesson worth keeping

ExpenseOS denormalises a rule's `scope` onto the instance row and comments: *"a kind re-scoped in
code after an instance was authored would otherwise be handed the wrong context. The kind's own
scope governs."* VeloExpense derives scope from the code registry only, so this cannot bite — but
the same hazard applies to any attribute we later denormalise onto `expense_policy`.

---

## money (VX1-6) — `packages/money/src` vs `lib/money.ts`

Source read: `convert.ts` (3.0 KB). **Not yet read:** `money.ts`, `currencies.ts`, `dinero.ts`,
`format.ts`, `convert.test.ts`.

ExpenseOS builds on **dinero.js** (`convert`, `transformScale`, `halfEven`, `allocate`) with FX
rates stored as `Decimal(18,8)`. VeloExpense hand-rolled `lib/money.ts` in 80 lines of string/bigint
math. That divergence is defensible — no dependency, exact by construction — but it is missing three
capabilities, and one trap is worth recording even though we do not use dinero.

### MO-1 · No conversion — see PE-1
Same gap, stated from the money side: ExpenseOS *has* a conversion primitive with a clear contract
(null on missing rate). We have none, so every threshold comparison is currency-blind.

### MO-2 · No proportional allocation, and nothing with banker's rounding — GAP
ExpenseOS re-exports dinero's `allocate` with the reason: *"so consumers that want to split a charge
across N line items don't have to import dinero directly."* Splitting is where cents get lost or
duplicated — apportioning tax across lines, distributing a tip, splitting one receipt across
several expenses. VeloExpense has no allocation helper at all, so any future split will be ad-hoc
and will almost certainly not sum back to the original.

**Do:** add an `allocate(totalMinor, weights[])` to `lib/money.ts` that provably sums to the input,
before anything needs to split money. Cheap now, and a correctness trap later.

### MO-3 · No rounding policy for computed values — GAP, small
ExpenseOS rounds half-even (banker's) consistently, matching `allocate`. VeloExpense's
`parseAmountToMinor` refuses to round *input* at all — which is the better choice and stays — but
there is no stated rounding mode for values we compute. There is nothing to round today; there will
be as soon as MO-1 or MO-2 lands.

### MO-4 · The scale trap, recorded for when we implement conversion
Even doing this in bigint rather than dinero, the same normalisation is required. ExpenseOS's
comment is the concrete test case:

> dinero's `convert` widens the working scale to `source.scale + rate.scale` to preserve precision,
> so the raw snapshot amount is `cents × 10^rateDecimals` — **NOT minor units**. Bring it back down
> to the destination currency's ISO exponent so `amountMinor` is real cents (e.g. 10000 USD × 1.37 →
> **13700 CAD, not 1370000**).

Any string/bigint conversion we write multiplies by an 8-decimal rate and must divide back by
`10^8`, rounding once, at the end. `10000 × 1.37 → 13700` is the assertion to write first.

### MO-5 · FX rate precision and an overflow guard
Rates are `Decimal(18,8)`. Before scaling a rate to an integer, ExpenseOS checks
`Number.isSafeInteger` and throws rather than silently drifting. Worth copying if we ever hold rates
as numbers; unnecessary if we keep them as strings and use bigint throughout, which is our house
style anyway.

### MO-6 · Where VeloExpense is already ahead
- **`parseAmountToMinor` REJECTS more decimals than the currency has** rather than rounding.
  ExpenseOS's `fix/bound-money-inputs` branch exists precisely because their amount input mangles
  typed values (`125.50` → `125.500.00`). Do not port their input handling.
- **No float path anywhere.** String/bigint end to end, so there is no drift to guard against and
  no dependency to pin.

---

## approvals (VX2-1 shipped; VX2-2 next) — `packages/approvals/src` — PARTIAL, ~70% read

Source read: `delegation.test.ts` (5.0 KB) — the `resolveAssignment` contract;
`noManagerFallback.db.test.ts` (27 KB) — the no-eligible-approver behaviour, which *is* VX2-2's
acceptance criteria; `expire.test.ts` (1.4 KB) — the expiry-outcome policy table.
`engine-core.ts` (14.8 KB) — the pure interpreter, read and ruled OUT as a port target (AP-9);
`schema.approverFallback.test.ts` (3.7 KB) — the fallback's shape rules (AP-11).
**Not yet read:** `engine.ts` (62.5 KB — the DB layer, and where `resolveApprover` /
`resolveManagerChain` / `isEligible` / `canDecide` actually live), `engine.db.test.ts` (51.7 KB),
`graph.ts` (5.9 KB, not a port target), `schema.ts` (11 KB),
`backfillApprovalFallback.db.test.ts` (21.2 KB — only matters if AP-7 goes to option (ii)).
The `fix/self-approval-guard` diff is read in full (`engine.ts` +100, `engine.db.test.ts` +108,
`reportApproval.ts` +13).

### AP-1 · `resolveAssignment` — the contract, which IS VX2-2's spec

Derived from the tests, in execution order:

1. Assignee is `null` → return `null`. ExpenseOS calls these **"filter" tasks** and permits them.
2. Look up an **active, in-scope, currently-dated** delegation for the assignee. If one exists,
   the assignee becomes the delegatee. **This happens even when the delegator is ACTIVE** — a
   delegation is an explicit redirect, not only an absence mechanism.
3. From whoever that produced, walk **up the manager chain while `employeeStatus !== 'ACTIVE'`**,
   stopping at the first active person. Leave-skipping therefore applies to the **delegatee** too.
4. **If the chain runs out and the last person is still not ACTIVE, KEEP THEM** — the test is named
   *"keeps an ON_LEAVE assignee at the top of the chain (TTL escalation covers)"*.

Scope is enforced in both directions: a `REPORTS` delegation applies to an expense report, and a
`VCC` delegation explicitly does **not**. That is the prototype gap ExpenseOS's own Module 8 doc
listed as unfixed — it is fixed in the real code, which is exactly the kind of thing the summary
does not tell you.

### AP-2 · **Step 4 cannot be ported, and VX2-2 must decide what to do instead** ⚠

ExpenseOS's answer to "the whole chain is on leave" is *assign it anyway and let the TTL escalation
deal with it*. **VeloExpense has no TTL.** Migration `0008` has no expiry column, and while
`approval_task.escalation_level` exists, nothing increments it. So porting step 4 verbatim produces
a task assigned to someone on leave that **never escalates and never expires** — a report stuck in
SUBMITTED indefinitely. That is precisely the "fails open in slow motion" outcome VX2-2's acceptance
criteria forbid.

**Options for VX2-2, pick one deliberately:**
- **(a) Fall back to an ADMIN.** `approval_task.resolved_via` already admits `'ADMIN_FALLBACK'` for
  exactly this, and it keeps a human in the path. Recommended.
- **(b) Fail the routing closed** — refuse the submit with "no eligible approver". Safest, worst UX:
  the employee cannot submit because their management chain is on holiday.
- **(c) Port ExpenseOS's behavior AND its TTL.** Correct but drags task expiry, an escalation job
  and a worker into VX2-2, which is a 2-day ticket.

> **Superseded in part — read AP-5 first.** The above was written from `delegation.test.ts` alone.
> `noManagerFallback.db.test.ts` shows ExpenseOS *already lived through* the "let the TTL deal with
> it" answer, measured the damage, and replaced it. Step 4 is still unportable as written, but the
> replacement is not something VX2-2 has to invent — it is written down, and AP-5 is it. Note also
> the distinction those two files draw and AP-2 blurred: **an assignee who is on leave** (step 4,
> the TTL's job) and **an assignee who does not exist at all** (AP-5, the fallback's job) are
> different failures with different remedies. VeloExpense needs an answer to both; only the second
> has a ported one.

### AP-3 · Two VX2-1 divergences confirmed as real (not oversights)

- **VeloExpense never produces an ownerless task.** The column `approval_task.assignee_id` is
  nullable (external EMAIL approvers need that), but `approval_task_assignee_present` requires
  `assignee_id OR assignee_email`, so the *effect* is that every task has a named owner. ExpenseOS
  permits a genuinely unassigned task ("filter" / pool). Recorded in `0008`'s comments as
  deliberate, and the divergence stands — **but see AP-7: that CHECK is what makes ExpenseOS's role
  fallback unportable, so "deliberate" now has a price tag attached.**
- **Delegation scope**: theirs is `ALL | VCC | REPORTS`, ours `ALL | REPORTS` (no VCC in MVP). Fine.

### AP-4 · A small inconsistency in my own VX2-1 worth fixing when convenient

`delegation_scope_check CHECK (scope IN ('ALL','REPORTS'))` will need a **migration** to add
`TRAVEL` or `VCC` later. Everywhere else in `0008` I deliberately pre-admitted future values to
avoid exactly that — `resolved_via` admits `DELEGATION`/`REASSIGNED`/`EMAIL`, and
`approval_task_status` admits `SKIPPED`, specifically so VX2-4/VX2-5 need no migration. The scope
CHECK is the one place that rule was not applied. Low priority (VCC and Travel are out of MVP
entirely), but it is an inconsistency, not a decision.

### AP-5 · The no-manager case is a **measured incident** in ExpenseOS, and its fix is VX2-2's spec

`noManagerFallback.db.test.ts` opens with the behaviour it replaces, stated as measurement rather
than theory. A `manager` node whose requester has no manager created a task with
`assigneeUserId = null`, and `isEligible` returns false for every non-`filter` approver kind, so:

```
canDecide(submitter)  = false
canDecide(admin)      = false   ← not even a system administrator
expireTask outcome    = REJECTED
FINAL report status   = REJECTED
```

> "The claim was invisible in every queue and auto-rejected five business days later, so the
> employee was told their expense was declined — by nobody, because of a gap in the HR feed.
> On dev this affects **80 of 703 active users (11%)**."

Two things follow, and both matter more than the code does.

**First, the blast radius is an HR-data problem, not an edge case.** 11% of an org having no
`manager_id` is normal — new hires mid-onboarding, contractors, executives, anyone whose feed row
is incomplete. VeloExpense's `app_user.manager_id` is nullable with no backfill and no import
validation, so assume the same or worse on day one of any tenant.

**Second, "let the expiry escalate it" is the answer ExpenseOS already tried and withdrew.** That
is the option AP-2 was reasoning toward. Do not spend the decision again.

The replacement is a per-approver **`fallback`**, authored on the node, with three kinds:

| fallback | task shape | who may decide |
|---|---|---|
| *(none)* | unassigned | the legacy **approver pool** — active holders of the approve permission, **minus the requester's own subordinates** |
| `{ kind: 'user', userId }` | **assigned** to that person | that person, **and nobody else** — the pool is shut |
| `{ kind: 'role', roleId }` | unassigned | active holders of **that** role, and nobody else |

Three design decisions inside that table are the valuable part:

- **A `user` fallback assigns; a `role` fallback does not.** Assignment is what puts a task in a
  queue, notifies, escalates and delegates — so a named person gets it. A role is deliberately
  *not* resolved to a person at task-creation time: "resolving a role to a person at task-creation
  time would make the same authored workflow behave differently the day somebody else is given the
  role — a flip that is invisible in the editor." That reasoning applies verbatim to VeloExpense's
  `approver_kind = 'ROLE'`, which VX2-2 must resolve at **decision** time, not at routing time.
- **A fallback never outranks a real manager.** Tested explicitly: "if it ever outranked a real
  manager, every ordinary approval in the org would be re-routed to one person."
- **The fallback covers `managerChain`, not only `manager`.** `resolveManagerChain` returns null
  under exactly the same condition, and the seeded workflow sends everything over $5k through
  `managerChain` — "a fallback that only worked on `manager` would have covered the CEO's lunch and
  stranded their offsite." VeloExpense's equivalent is `approver_kind = 'MANAGER'` with
  `manager_level > 1`: **the fallback must key off "MANAGER resolved to nobody", not off a
  particular `manager_level`.**

**Recommendation for VX2-2:** port the `user`-fallback and `role`-fallback semantics, and take
AP-2's option (a) `ADMIN_FALLBACK` as the *unconfigured-tenant* default instead of the open pool.
Rationale: `resolved_via` already admits both `'ROLE'` and `'ADMIN_FALLBACK'`, so the routing side
needs no migration; and the open pool is the one branch ExpenseOS itself had to narrow twice
(see AP-6). The `role` fallback is what needs a schema answer — AP-7.

### AP-6 · The pool's narrowing rules — one of which is a **live gap in VeloExpense**

Every positive in that file is paired with a negative, on purpose: *"'The named approver can decide
it' passes just as happily on a build where EVERYONE can decide it."* The negatives are the spec.

1. **Not the submitter.** Already in `routing.ts` as `SELF_APPROVAL` — declared, not implemented.
2. **Not the submitter's subordinates — transitively.** ⚠ **This is the one to act on.** A
   manager-less requester is by definition senior, so "anyone who may approve" included the people
   who report to them: *"someone whose job the submitter controls, signing off on the submitter's
   spend. That is the self-approval failure one hop removed, and `canDecide`'s self-block did not
   reach it."* The test asserts refusal for a direct report **and** for a grandchild.
   **VeloExpense has no guard for this at any depth**, and it is not only a pool problem — VX2-4
   (reassign) and VX2-5 (delegation) can both land a task on someone who reports to the submitter,
   with `SELF_APPROVAL` cheerfully passing. Needs a downward recursive CTE over
   `app_user.manager_id` (`app_user_manager_id_idx` exists; `app_user_manager_id_not_self_check`
   prevents the trivial cycle but **not** a longer one, so bound the recursion by depth).
   *Flagging this outside VX2-2's stated scope, as agreed — it should be its own ticket, not folded
   into the resolver PR silently.*

   **Implementation note — we already have most of this.** `lib/employees/service.ts` declares
   `MAX_CHAIN_DEPTH = 20` (the same value ExpenseOS uses) and around line 183 walks the manager
   chain **upward** in a recursive CTE that carries `ARRAY[u.id] AS path` and extends it with
   `c.path || m.id` — a path-based cycle guard, not just a depth bound. AP-6 rule 2 does not need a
   new downward walk: "does the actor report up to the submitter" is that same upward walk started
   from the actor, asking whether the submitter appears in it. Bounded and cycle-safe already.
   Note the existing direct-reports query near line 168 is `WHERE u.manager_id = $1` — one level
   only — so that is *not* the thing to reuse; the transitive answer is the CTE. ExpenseOS's
   `reportsUpTo` is the same idea written as a per-hop loop bounded by `MAX_CHAIN_DEPTH`; one CTE
   beats twenty round trips, so port the behaviour, not the implementation.

   **One more piece of their reasoning, worth recording because the tempting fix is worse.** They
   considered narrowing the pool org-relatively instead — same legal entity, at-or-above the
   requester's job level — and rejected it: *"every such rule is empty for exactly the person this
   exists for — nobody outranks the CEO — so it would restore the auto-reject under a more
   respectable name."* Any seniority-based narrowing is vacuous for the manager-less requester who
   is the whole reason the path exists. The real close is for the tenant to author a fallback; the
   pool is what an unconfigured tenant gets.
3. **Not a non-ACTIVE person**, in the pool or as a role holder. VeloExpense's equivalent is
   `employee_status IN ('ON_LEAVE','DEACTIVATED')` — note ExpenseOS tests `TERMINATED`, and our
   three-value CHECK has no terminal state at all, only `DEACTIVATED`. Same effect, worth knowing.
4. **Never widen an already-assigned task to the pool.** Called "the privilege-escalation guard":
   *"a task parked on a specific manager must stay theirs; if the fallback ignored the assignee, any
   approver in the company could decide anyone else's routed approval."*
5. **A named fallback stays exclusive even if the task somehow parks unassigned** — a graph edited
   after the instance started, a hand-fixed row. Eligibility is computed from the *node*, not
   inferred from the task's null assignee.
6. **Never apply the fallback to a `filter` (predicate-pool) approver.** A filter node is already
   unassigned by design and its authored predicate *is* the authorization; treating it as
   "unresolved" would let any approve-permission holder claim a task the predicate deliberately
   excludes them from, "silently overriding the workflow the admin wrote." N/A today — VeloExpense
   has no predicate approver kind — **but this rule must ship in the same PR as one if we ever add
   it.** Record it against `approver_kind`.

One more, as a lesson rather than a port: the same file fixes a bug where `isRelativeApprover`
enumerated node types and accepted only `'approval'`, missing `'acknowledge'` — so an acknowledge
node routed to a manager-less person "resolved to nobody and then admitted nobody," and was
*quieter* than the approval case because an acknowledgement that expires unacknowledged leaves
nothing looking wrong afterwards. VeloExpense's `approver_kind` CHECK is the same kind of
enumeration. Any eligibility predicate we write over it must be exhaustive by construction
(a switch with a `never` default), not a list of the kinds we happened to think of.

### AP-7 · `approval_task_assignee_present` forbids the shape the `role` fallback needs — **DECIDED: (i)**

Concrete, and it lands before VX2-2 rather than during it. `0008` has:

```sql
CONSTRAINT approval_task_assignee_present
    CHECK (assignee_id IS NOT NULL OR assignee_email IS NOT NULL)
```

ExpenseOS's `role` fallback and open pool both depend on an `assigneeUserId = null` task plus a
claim rule. **Our CHECK makes that row illegal**, so as the schema stands the `role` fallback cannot
be ported at all — only the `user` fallback and `ADMIN_FALLBACK` can, because both name a person.

That is not obviously wrong. The invariant "every task has an owner" is why VeloExpense's routing
`resolve()` is all-or-nothing and fails closed, and it is a real improvement over a task sitting in
nobody's queue. But it forces the choice, so make it deliberately:

- **(i) Keep the CHECK.** `role` fallback is out of MVP; a tenant configures a `USER` approver or
  gets `ADMIN_FALLBACK`. Zero migration, VX2-2 unblocked today. Cost: a tenant cannot say "any
  member of Finance approves this" — which is a *normal* AP configuration and a likely early
  request, so expect to revisit.
- **(ii) Relax it in a `0009` and add a claim-pool descriptor** (`claim_role text`, plus
  `CHECK (assignee_id IS NOT NULL OR assignee_email IS NOT NULL OR claim_role IS NOT NULL)`, and a
  claim/decide eligibility path). Full fidelity, and the pending-task query stops being a simple
  `assignee_id = $1`. Adds roughly a day to VX2-2, and a migration before it.
- **(iii) Fail closed at submit** — throw `CHAIN_EXHAUSTED` and refuse the submission. Cleanest
  invariant, and the failure is *immediately visible* to both the employee and an admin, which is
  strictly better than ExpenseOS's silent five-day auto-reject. But on ExpenseOS's own numbers it
  blocks ~11% of users from submitting an expense at all until an admin configures something. Do
  not pick this without an admin-facing "these N employees cannot submit" surface.

**My recommendation: (i) now, (ii) as its own ticket after VX2-2 ships**, with `role` fallback
tracked as a known missing capability the way PE-2 is. (iii) only with the admin surface attached.
This one is John's call — it changes migration order.

> **DECIDED 2026-08-28: (i)** — and then **REVERSED to (ii) the same day.** Recorded in both
> directions on purpose, because the reversal is the useful part.
>
> (i) won on two premises I supplied, and both turned out to be false:
>
> 1. *"The `role` fallback is out of MVP."* It is not. `DEFAULT_LADDER`'s third rung — "Finance
>    sign-off", every report at or above $5,000 — is `approverKind: 'ROLE'` with
>    `approverRole: 'ADMIN'`. A ROLE approver is not an optional thing a tenant might configure;
>    it is the **starter ladder every tenant gets**. Under (i) the router would have had to name one
>    person for that rung on every report over $5k, which is exactly the arbitrary pick
>    `resolveApprover`'s comment warns against — "a flip that is invisible in the editor".
> 2. *"(i) needs no migration."* By the time the decision was live, VX2-2 already carried `0009` for
>    AP-14's break-glass column. The marginal cost of (ii) was therefore one more column on a
>    migration being written anyway, not a new migration — which was the whole reason (i) looked
>    cheaper.
>
> Found by reading `DEFAULT_LADDER` before writing the resolver, not by reasoning about it. The
> lesson is the same one that cost VX2-1 a rewrite: check the shipped code, including our own.
>
> **Settled: (ii).** `0009` drops `approval_task_assignee_present`, adds `claim_role`, and replaces
> the old constraint with `num_nonnulls(assignee_id, assignee_email, claim_role) = 1` — three
> ownership shapes, exactly one per task. A claimed task is **not** rewritten to `assignee_id`; the
> pool stays the owner and the decision is recorded in `decided_by_id`, so "who could have decided
> this" stays answerable after the fact. `resolved_via = 'ROLE'` is tied to `claim_role IS NOT NULL`
> in both directions so the two cannot drift.

### AP-8 · `defaultOnExpire` — the expiry policy table, portable when TTL lands

`expire.test.ts` is small and worth keeping verbatim as the spec for whenever VeloExpense grows a
TTL. An explicit `onExpire` on the node always wins; absent one:

| approver kind | default outcome | why |
|---|---|---|
| `manager`, `managerChain` | `ESCALATE` | there is a single chain to climb |
| `filter` (pool) | `REJECT` | no single chain to climb |
| missing node, or a non-approval node | `REJECT` | fail closed |

`APPROVE` is authorable but is **never** a default — the test is named *"never auto-approves"*, and
the missing-node case returning `REJECT` is the deliberate fail-closed direction. That matches
`routing.ts`'s "routing fails CLOSED" comment exactly, so the two layers already agree on direction.

Two notes for the TTL ticket, both confirmed against `0008`:

- `escalation_level` is the right column and already documents itself as "what a future TTL
  escalation would increment"; ExpenseOS's escalate path asserts `escalationLevel: 1`. Good.
- The escalation target is **the requester's manager**, not the assignee's — because the case it
  exists for is an *unassigned* task, where there is no assignee to climb from. Their bug was that
  `expireTask`'s ESCALATE branch required a truthy assignee, so an unassigned lapsed task "fell
  straight through to REJECT — conflating 'your approver ignored this' with 'we never found you an
  approver', and punishing the claimant for the second." And when the requester has no manager
  either, `REJECT` is correct and must stay correct, "or a lapsed claim would hang forever."

### AP-9 · The workflow model diverges by design — `engine-core.ts` and `graph.ts` are **not** port targets

Worth stating plainly so a later "faithful port" pass does not try. `engine-core.ts` is a
BPMN-lite **token interpreter over a directed graph**: tokens flow from a `start` node toward a
terminal; `if` / `switch` nodes route on a predicate; `parallel` forks one token per branch and the
branches re-synchronize at their convergence node under a join policy; `notify` / `action` nodes
fire side effects and pass through; `callWorkflow` is a stub. Approval nodes "park" their token and
emit a `createTask` effect. It is pure (no DB, no I/O) and it is good code.

VeloExpense's VX2-1 model is a **linear cumulative rung ladder**: `planApproval` filters rungs by
threshold, sorts by `sequence`, flattens approvers by `position`, and produces numbered steps that
are decided one at a time. There is no graph, no token, no branch, no join. That is the Plan's
simplification and it is the right one for MVP — a graph editor is a product, not a ticket.

So: **do not port** `engine-core.ts`, `graph.ts`, the token model, or the join policies. What IS
portable out of `packages/approvals` is everything that keys off an *approver*, not off the graph
shape — the fallback (AP-5), the eligibility rules (AP-6), the expiry table (AP-8), and the
manager-chain resolution (AP-10). Those transfer cleanly because they never touch the topology.

**The capability we are giving up, recorded like PE-2:** ExpenseOS's `parallel` node supports three
join policies — `all`, `any`, and `quorum(k)` — so "any two of these three VPs" is expressible, and
a branch failure is *tolerated* until the policy becomes arithmetically impossible (`all` → one
reject; `any` → all reject; `quorum` → fewer than `k` branches can still approve). VeloExpense's
ladder cannot express any of that: every step is sequential and every step is mandatory. Two of
three signatories is a common finance control, so expect this as a request. It is not a defect and
not in MVP — it is a known missing capability, and the day it is wanted it is a new model, not a
patch to `planApproval`.

### AP-10 · `manager_level` counts hops; `managerChain` targets a job level — **DECIDED: degrade**

A quiet but real divergence, and the second decision VX2-2 cannot avoid.

- **ExpenseOS** `managerChain` carries `minJobLevelId`: climb until you reach somebody at or above
  a named **job level**. Crucially, `resolveManagerChain` "returns the most senior ancestor it
  found and null only when there is no manager at all" — so a chain that never reaches the target
  level **still resolves**, to the most senior person available. It degrades, it does not fail.
- **VeloExpense** `approval_policy_approver.manager_level` is a **hop count**, `BETWEEN 1 AND 5`:
  1 = direct manager, 2 = their manager, and so on.

Two consequences.

**A hop count does not mean the same thing in two orgs.** Level 2 in a three-deep company is nearly
the top; level 2 in an eight-deep company is middle management. The same authored policy therefore
encodes a different seniority per tenant, which for a multi-tenant product is a worse property than
it is for ExpenseOS's single org. Not worth changing now — job levels are their own reference table
and out of MVP — but it belongs in the Differences Chart as a deliberate simplification with a
known cost, not as an equivalent feature.

**And the decision: what does `manager_level = 3` do when the submitter's chain is two deep?**
`routing.ts` already declares `CHAIN_EXHAUSTED`, which implies we fail closed. That means a tenant
with a shallow org chart cannot submit anything over the level-3 threshold at all — the same shape
of outage as AP-5's, arriving through a different door. ExpenseOS's answer is to **take the most
senior person found** and record how far it got. We already have the column for the second half:
`approval_task.escalation_level` is documented as "how many extra links up the chain the resolver
had to walk past absent approvers", which generalizes to "how far the resolver fell short" without
a migration.

**Recommendation:** port their degrade-to-most-senior behaviour, reserve `CHAIN_EXHAUSTED` for the
genuine no-manager-at-all case (where AP-5's fallback takes over), and record the shortfall on the
task so an admin can see the policy was not literally satisfied. Failing a submit because the
company is flat is not a control, it is an outage.

> **DECIDED 2026-08-28: port the degrade.** `escalation_level` carries the shortfall, so no
> migration. The hop-count-vs-job-level divergence itself stays as written — a note for the
> Differences Chart, not a change to `0008`.

### AP-11 · Where the column model is already ahead — two structural wins, worth not losing

`schema.approverFallback.test.ts` exists to police states that **cannot be represented** in
VeloExpense's schema. That is the payoff of the Plan's choice to put approver config in columns
rather than ExpenseOS's JSON `graph` column, and it should be recorded before somebody "simplifies"
`0008` toward a JSONB blob.

- **The half-configured approver.** Their test: *"the editor writes `{ kind: 'user', userId: '' }`
  the moment somebody picks 'a specific person' and before they say who, and that half-state must
  fail validation — publishing it would produce a node that claims to route somewhere and assigns
  to a user id that cannot exist."* `0008`'s `approval_policy_approver_complete` already forbids
  this, and is *stricter* than their zod: it requires the companion column the kind needs **and**
  asserts every other companion column is NULL, so a `USER` approver cannot carry a stale
  `approver_role` left behind by someone changing the kind in a form. Their zod checks presence,
  not absence.
- **"A fallback belongs only on the relative kinds."** They enforce this by relying on zod objects
  being non-strict and asserting the fallback does not *survive* the parse — a strip, not a
  refusal, because their schema cannot say "this key is invalid on this variant". In a column model
  it is one line: `CHECK (fallback_kind IS NULL OR approver_kind = 'MANAGER')`. A refusal beats a
  silent strip, because a silent strip means an admin can save a fallback, see it accepted, and
  never learn it was discarded.

So when the fallback lands (AP-5), the shape is `fallback_kind text` + `fallback_user_id uuid
REFERENCES app_user(id) ON DELETE RESTRICT` + `fallback_role text`, plus a
`approval_policy_approver_fallback_complete` CHECK in the same style as the existing one, plus the
relative-kinds CHECK above. `NOT NULL` is wrong on all three — the fallback is optional, and their
test *"keeps the fallback OPTIONAL"* exists because every workflow authored before the feature had
to keep parsing. Same for us: every policy row in every tenant predates it.

One thing to copy exactly: their fallback kind vocabulary refuses `requester` and `manager`, which
exist in the sibling `notifyTargetSchema`. The reason is worth the comment — *"`manager` is what
just failed, `requester` is self-approval."* Both would be accepted by a careless
`fallback_kind IN (...)` list copied from somewhere else, and both are nonsense with teeth.

### AP-12 · Rejection semantics, for VX2-3 — and the duplicated-enumeration lesson

`applyRejection` is not portable as written (it routes tokens), but the *policy* inside it is the
question VX2-3 has to answer, so record it now:

- A node with a **wired `reject` exit** routes down it and the instance keeps RUNNING — the author
  chose an explicit rejection path (send it back for revision, route to a second reviewer).
- With **no wired exit**, the default applies: the instance is REJECTED — *unless* the token is
  inside a parallel, where it is a tolerated branch failure.

VeloExpense has no authored graph, so "wired exit" has no analogue; but `approval_task_status`
admits `RETURNED` alongside `REJECTED`, which is the same distinction expressed as an outcome
instead of an edge: **RETURNED sends it back to the submitter as a draft and the run ends;
REJECTED is terminal.** What `0008` does not settle is what happens to the *other* tasks of a
multi-step request when step 2 of 3 is rejected or returned. `approval_task_status` admits
`CANCELLED` with `decided_at NOT NULL` and no actor, described as "the tasks voided when a
submitter recalls" — which is exactly the mechanism needed here too. VX2-3 should cancel the
remaining PENDING tasks of the request, and the `approval_request_one_running_idx` unique index
means it must, or a returned report cannot be resubmitted.

**And the lesson, which is the most reusable thing in this file.** AP-6 closed a bug where
`isRelativeApprover` enumerated node types and accepted only `'approval'`, missing `'acknowledge'`.
`engine-core.ts` gets the same concept right, once, as a shared constant:

```ts
const APPROVAL_TYPES = new Set(['approval', 'acknowledge']);
```

The bug was not ignorance — it was the same set written down twice in two files and then drifting.
VeloExpense has exactly this hazard: `approver_kind` is enumerated in `0008`'s CHECK, in
`APPROVER_ROLES` in `lib/approvals/tiers.ts` (declared locally on purpose, to keep `pg` out of a
pure module), and it will be enumerated again in VX2-2's resolver and once more in whatever
eligibility predicate AP-6 produces. **Four copies.** Every predicate over it must be exhaustive by
construction — a `switch` with a `default: never` — so adding a kind breaks the build in all four
places instead of silently short-circuiting in one of them.

### AP-13 · The self-approval guard is a SOX-grade P0, and the fix is an **ordering** rule ⚠ changes VX2-2's spec

`fix/self-approval-guard` read. It is the most important thing this audit has surfaced, and it is
not the check itself — we already have `SELF_APPROVAL` declared — it is *where the check sits*.

`canDecide` opened with `if (isAdmin) return true`. The self-approval block sat about thirty lines
below it. So the rule was unreachable for precisely the people best able to break it:

> "a System Administrator submitted a report, opened it, and was offered Approve — which succeeded
> and was recorded as a real approval — while the workflow assigned the decision to their direct
> manager and their own approvals inbox showed nothing to do (GA readiness report F15 / F20,
> blocker B3). A privileged user approving their own expenses outside the assigned route is a
> standard SOX audit exception."

The fix moves the requester check **first**, ahead of every grant below it — admin, assignee,
delegatee and the pool fallthrough alike. Three parts of that are worth porting exactly:

- **Ahead of the *assignee* path, not only the pool.** Their reasoning: "a workflow that resolves
  the approver relative to the requester can legitimately land the task on the requester themselves
  (their own manager, a same-job-level pool), and 'the graph named me' is not a reason to let
  somebody sign off their own money." **This is the part that changes our design.** VeloExpense's
  `SELF_APPROVAL` is currently a `RoutingErrorCode` — a *routing-time* refusal. Routing-time alone
  is insufficient: VX2-4 (reassign) and VX2-5 (delegation) can both move a task onto the submitter
  *after* it was routed cleanly. So the guard has to exist twice, and the **decision-time** one is
  the authoritative copy. VX2-2 must ship a decision-time `assertCanDecide` with the requester
  check as its first statement, not merely refuse at routing.
- **The admin override survives for everyone else's subject.** "It is load-bearing: it is how a
  stuck queue gets unwedged. What is removed is the ability to use it on your own."
- **Order the queries accordingly.** The guard needs the requester before it can refuse, so the
  cheap `isAdmin` short-circuit cannot come first. Their `canDecide` now loads the task, then the
  requester, then decides. Two reads before any grant — fine, and worth the comment saying why.

And a testing lesson that generalizes past this ticket, from their own post-mortem: *"the
self-approval rule above was tested only with `isAdmin: false`, while `canDecide` opened with
`if (isAdmin) return true` — so the rule was never reachable for the people best able to break
it."* A guard exercised only on the unprivileged path is an untested guard. **Every VX2-2 guard test
must run twice, once with the caller's admin role set.** That is a cheap rule and it is exactly what
would have caught this.

Their seeded ladder, quoted in passing and useful as a sanity check on our `DEFAULT_LADDER`:
manager under $5k, Director under $25k, VP under $100k, C-level above.

### AP-14 · Their accepted cost is **not acceptable for VeloExpense** — the SMB collision — **DECIDED: (a)**

The fix records its own downside honestly, which is what makes it usable:

> "KNOWN CONSEQUENCE, recorded rather than discovered later: a subject whose only possible approver
> is also its requester — the person at the top of the chain, or a one-admin org — can no longer be
> decided by that person at all. It parks until somebody else decides it. That is the accepted cost
> of the hard block; a break-glass override with an audited reason was considered and deliberately
> not taken."

For ExpenseOS that reasoning holds: it is one large enterprise, so "somebody else" always exists.
**For VeloExpense it does not.** We are selling to SMBs. A two-person company where the owner
submits expenses and is the only admin is not an edge case, it is a plausible first customer. Under
the combination of

- AP-5's recommendation (`ADMIN_FALLBACK` when the chain resolves to nobody), and
- AP-13's hard self-approval block ahead of the admin grant,

that tenant's reports are **unapprovable**. Not stuck-and-escalating: structurally undecidable, by
anyone, forever. Two rules that are each correct compose into a dead end, and it only appears in
tenants small enough that the sole admin is also the sole submitter.

So VeloExpense has to take the option ExpenseOS declined, in one of these shapes — and this is a
product call, not a technical one:

- **(a) Break-glass self-approval, per tenant, audited.** An `approval_policy` flag
  (`allow_self_approval_when_sole_approver bool NOT NULL DEFAULT false`), permitted *only* when the
  resolver can prove no other eligible approver exists, and every use written to the VX2-6 audit
  chain with its own action so it is trivially reportable. Recommended: it is the honest version of
  what a one-person company is going to do anyway, and it makes the exception *visible* instead of
  making the product unusable.
- **(b) Require a second approver at onboarding.** Refuse to activate expense approvals until the
  tenant names someone other than the owner. Clean model, worst onboarding friction, and it fails
  at exactly the wrong moment — the tenant is trying to start using the product.
- **(c) Auto-approve when the submitter is the sole possible approver.** Simplest to build, and
  wrong: it silently converts "nobody can approve this" into "approved", which is the fail-open
  outcome every other rule in this codebase is written to avoid. Recorded to be rejected explicitly.

**Recommendation: (a).** Note it interacts with AP-7 — if the `role` fallback lands (option (ii)
there), a tenant can name "any Finance member", which reduces how often (a) fires but does not
remove the one-person case.

> **DECIDED 2026-08-28: (a).** See the decisions table at the top of this file for the exact column,
> and for the correction to where it lives — this section originally said `approval_policy`, which
> is per-**rung**, not per-tenant. The flag goes on `organization`, as a real column rather than a
> key in `settings jsonb`. This is the one migration VX2-2 carries.

### AP-15 · The read-side predicate and the write-side guard must be the **same function**

The same branch fixes a second, quieter bug worth generalizing. `callerCanDecideReport` — the
predicate the *page* uses to decide whether to render an Approve button — opened with
`if (isAdmin) return true`, while the mutation behind the button asked the engine. Once the engine
started refusing a requester their own subject, the two disagreed:

> "a role-based yes here would render an Approve button that fails when pressed. One question, one
> answer, both surfaces."

The original short-circuit had a justification that had quietly become false — "an admin viewing a
DRAFT report has no task to find, and a lookup-based answer would deny them" — except
`callerCanReadReport` already short-circuits on `isAdmin` on its own line, so admin *read* access
never depended on it. A stale rationale outliving the condition it described, which is its own
lesson about comments.

For VeloExpense this is a naming-and-structure rule for VX2-2 and VX2-4: the server action's guard
and whatever the page calls to decide what to render must be the **same exported function** from
`lib/approvals/`, not two predicates that happen to agree today. Our architecture makes this easy —
server actions and `lib/<domain>/` modules, no tRPC layer in between — so there is no excuse for
two copies. `assertCanDecide` (throws, for the action) wrapping `canDecide` (boolean, for the page)
is the shape.

### AP-16 · `resolveAssignment` in full — three rules the tests did not show

`engine.ts` read directly (from Drive, at the spec baseline — so `canDecide` there is the PRE-fix
ordering; compose it with the `fix/self-approval-guard` diff in AP-13 to get today's behaviour).
The function itself is ten lines, and AP-1's derived contract was right, but three rules only exist
in the code:

```ts
export async function resolveAssignment(db, baseAssigneeId, subjectType) {
  if (!baseAssigneeId) return null;
  const afterLeave = await skipOnLeave(db, baseAssigneeId);
  const delegatee  = await activeDelegateeFor(db, afterLeave, subjectType);
  return delegatee ? skipOnLeave(db, delegatee) : afterLeave;
}
```

- **One delegation hop, never a chain.** Their comment says so outright: "One delegation hop — no
  chains-of-delegations." A delegates to B, B delegates to C, and a task of A's goes to **B**, not
  C. Worth pinning in VX2-5, because the recursive reading is the intuitive one and it is a loop
  waiting to happen (A→B, B→A).
- **The overlapping-delegation tie-break is `ORDER BY created_at DESC`.** `activeDelegateeFor`
  documents it as "picks the most recently created when several overlap". **This answers the open
  question `HANDOFF` §7 records as VX2-2's to own** — 0008's comments leave the tie-break undecided,
  and ExpenseOS has already decided it. Most-recently-created wins: the newest instruction is the
  one the delegator meant.
- **On-leave skipping runs on BOTH sides of the delegation.** `skipOnLeave` is applied to the base
  assignee *and* again to the delegatee — so delegating to somebody who is themselves away still
  lands on a present person.

`skipOnLeave`'s own unavailability test is worth copying but not copying *literally*:

```ts
const unavailable =
  u.deletedAt != null || u.employeeStatus === 'ON_LEAVE' || u.employeeStatus === 'TERMINATED';
```

That is an **allow-list by omission** — a status added to the enum later is treated as available by
default. VeloExpense should invert it: `deleted_at IS NOT NULL OR employee_status <> 'ACTIVE'`, so a
new status is unavailable until somebody decides otherwise. Same fail-closed direction as everything
else in `routing.ts`. Our enum is `ACTIVE | ON_LEAVE | DEACTIVATED`, so the two forms agree *today*;
they stop agreeing the day a `TERMINATED` or `SUSPENDED` is added, which is exactly when nobody will
be looking at this function.

### AP-17 · The AP-10 degrade, confirmed in code — plus a lesson about nullable classifications

`resolveManagerChain` is the degrade AP-10 decided to port, and it is unambiguous: `mostSenior`
tracks the last manager found, the loop returns early only when a manager's job level clears the
bar, and the function returns `mostSenior` when it never does. `null` comes back only when the
requester has no manager at all — which is the case AP-5's fallback owns.

The header carries a *previous* bug and it generalizes past this ticket:

> "Because job levels are optional on `User`, one unclassified employee anywhere in a chain was
> enough to strand every tiered approval above the direct-manager tier."

The walk used to stop at an employee whose classification was missing. The fix is the shape of the
comparison — `if (mgr?.jobLevel && mgr.jobLevel.sortOrder >= minSort) return mgr.id;` — so an
unclassified manager simply fails to satisfy and the walk **continues past them** rather than
aborting. The rule: **a nullable column consulted inside a chain walk must never terminate the
walk.** VeloExpense's walk consults `employee_status`, which is `NOT NULL DEFAULT 'ACTIVE'`, so we
are safe today; the hazard arrives the moment VX2-2's resolver reads anything optional (a job level,
a department, a delegation row) inside the loop.

### AP-18 · **The three decisions did not close AP-2** ⚠ — a chain that is entirely on leave

Flagging this because it would otherwise be discovered while writing VX2-2, and it is the same
failure class the other decisions were made to prevent.

The decisions cover two of three ways a MANAGER approver fails to produce a usable person:

| the chain is… | decided answer |
|---|---|
| absent entirely (no `manager_id`) | `ADMIN_FALLBACK` — AP-5 |
| shorter than `manager_level` | degrade to the most senior found — AP-10 |
| present, long enough, and **every person in it is ON_LEAVE / DEACTIVATED** | **still undecided** |

ExpenseOS's answer to the third row is in `skipOnLeave`, and it is explicit about relying on
something we do not have:

```ts
if (!u.managerId) return cursor; // top of chain — leave it (TTL escalation covers)
```

It assigns the task to the on-leave person and lets expiry escalate. VeloExpense has no TTL
(AP-2, AP-8), so porting that line produces a task assigned to somebody on leave that never
escalates and never expires — a report stuck in SUBMITTED indefinitely, which is the outcome AP-13
and AP-14 were both decided to avoid.

**Proceeding on this assumption unless told otherwise:** treat "walked the whole chain, found
nobody ACTIVE" the same as "no chain at all" and route to `ADMIN_FALLBACK`, recording the hops
walked in `escalation_level`. It reuses a decision already taken, needs no migration, keeps a human
in the path, and is the only one of the three rows that would otherwise fail silently rather than
loudly. The alternative worth naming: assign to the on-leave person anyway *and* make the TTL a
Phase-2 ticket rather than a Phase-3 one — correct, but it puts task expiry, a sweep job and a
worker on VX2-2's critical path.

### AP-19 · A live gap in our own shipped VX2-1, and ExpenseOS's fix for it

`APPROVE_PERMISSION` in `engine.ts` is a literal-string copy of values owned by their `rbac`
package, for the same reason our `APPROVER_ROLES` is declared locally in `lib/approvals/tiers.ts` —
to keep a heavy dependency out of a module that must stay pure. Their comment names the risk and
then closes it:

> "Duplicated from `@expenseos/rbac`'s registry as literal strings because this package deliberately
> does not depend on rbac. A rename there would silently disable the fallback here — so
> `systemRoles.test.ts` asserts these exact strings still exist, and a rename breaks that test
> instead of quietly re-stranding everyone with no manager."

**We have the same duplication. Our exposure is narrower than theirs, and it is not zero.**
Checked rather than assumed, because the obvious version of this finding is wrong:

```
lib/employees/service.ts:21  export type EmployeeRole = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
lib/employees/service.ts:24  export const EMPLOYEE_ROLES: EmployeeRole[] = ['EMPLOYEE','MANAGER','ADMIN'];
lib/approvals/tiers.ts:33    import type { EmployeeRole } from '@/lib/employees/service';
lib/approvals/tiers.ts:59    export const APPROVER_ROLES: readonly EmployeeRole[] = ['EMPLOYEE','MANAGER','ADMIN'];
```

`tiers.ts` imports the **type** (a type-only import, erased at build, so no `pg` at runtime — the
right call) and duplicates only the **array**. So:

- **Renaming** a role is caught by the compiler, in both files. Not a risk. ExpenseOS's exposure is
  worse than ours here because their copy is bare strings with no shared type at all, which is why
  they needed a test.
- **Adding** a role is the live gap. A new member of `EmployeeRole` obliges whoever adds it to
  update `EMPLOYEE_ROLES` — which sits two lines below the type, so they will — while
  `APPROVER_ROLES` in another file silently omits it. The new role then cannot be named as an
  approver anywhere, `isApproverRole` returns false for it, and **no test fails**, because every
  approvals test uses the local copy.

Addition is the likely path, not the hypothetical one: `0008`'s own comment on `approver_role` says
the vocabulary "is going to stop being the fixed EMPLOYEE|MANAGER|ADMIN triple" once per-tenant
custom roles land.

**And we can do better than their test.** A test catches this at CI; a mapped type catches it at
`tsc`:

```ts
const APPROVER_ROLE_SET: Record<EmployeeRole, true> = { EMPLOYEE: true, MANAGER: true, ADMIN: true };
export const APPROVER_ROLES = Object.keys(APPROVER_ROLE_SET) as readonly EmployeeRole[];
```

`Record<EmployeeRole, true>` is exhaustive by construction, so adding a role to the union breaks the
build in this file until somebody decides whether it may approve. Same trick AP-12 asks for on every
predicate over `approver_kind`. Still type-only, still no `pg`. Small, in shipped code, and it
belongs with VX2-2 — which is about to add a third copy in the resolver.

---

## audit (VX2-6, next) — `packages/audit/src` — PARTIAL, ~80% read

Source read: `canonical.ts` (1.2 KB), `chain.ts` (2.5 KB), `verify.ts` (4.3 KB) in full.
**Not yet read:** `writer.ts` (3.0 KB), `types.ts`. Reconciled against the two in-house references,
whose DDL was read directly from the sibling repos rather than recalled: VeloLedger
`audit.audit_event` (`prisma/migrations/0001_init`) and VeloPulse HRIS `audit_event`
(`0001_init_hris_schema`).

### AU-1 · ExpenseOS's chain is GLOBAL and tenant-blind — three changes, none optional ⚠

The single most important finding for VX2-6, and it is not a defect in ExpenseOS: they are one
enterprise on one database, so a single chain is correct there. It is wrong for a pooled
multi-tenant database in three separate places, and all three are easy to port verbatim by
accident.

**1. One advisory lock for the whole database.**

```ts
const AUDIT_CHAIN_LOCK_KEY = 0x41554454; // 'AUDT'
await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;
```

Every appender in the system serializes on that one key. Ported as-is, tenant A's write throughput
becomes coupled to every other tenant's audit traffic — a noisy-neighbour problem on the hot path of
every state change. Use the two-argument form keyed per tenant:

```sql
SELECT pg_advisory_xact_lock(1096041044, hashtext(<org id>::text))  -- 1096041044 = 0x41554454
```

`0x41554454` fits in int4 (1096041044 < 2^31-1) and `hashtext` returns int4, so the two-key form
takes it directly. Two organizations whose ids collide in `hashtext` would serialize together, which
costs a little contention and breaks nothing — it is not a correctness risk, only a performance one.

**2. The head read has no tenant predicate.**

```sql
SELECT "entryHash" FROM "Audit" ORDER BY "id" DESC LIMIT 1 FOR UPDATE
```

So tenant B's row becomes `prev_hash` for tenant A's next row, and the chains interleave. Under RLS
that is not merely untidy, it is **unverifiable**: verifying tenant A's chain would require reading
tenant B's rows, which the policy forbids — so verification would only work as a superuser, which
defeats the point of having a tenant-scoped audit log. The head read must be
`WHERE organization_id = <org> ORDER BY sequence DESC LIMIT 1`, and RLS supplies the predicate
anyway, which is a nice property: get the query wrong and RLS still scopes it.

Keep `FOR UPDATE` alongside the advisory lock, and keep ExpenseOS's comment explaining why the lock
is the thing doing the work — it is the best line in the package:

> "`SELECT ... FOR UPDATE` alone cannot do this: on an empty table it locks zero rows, so concurrent
> first appenders both read `prevHash = null` and fork the genesis."

Per-tenant, "an empty table" becomes "this tenant's first ever audit row", which is a state every
tenant passes through on its first day. So the genesis race is not a theoretical edge here — it is
reachable during onboarding, for every customer.

**3. `organization_id` is not in the hash payload.** Their nine fields are `occurredAt`, `actorId`,
`actorName`, `action`, `entityType`, `entityId`, `details`, `ipAddress`, `prevHash` — no tenant.
In a pooled database that means a row's tenant attribution is **outside** the integrity guarantee: an
`UPDATE audit_entry SET organization_id = <other tenant>` would move a row between tenants' histories
without breaking any hash. Add `organizationId` to the payload. It costs nothing and it is the one
field a multi-tenant audit log cannot afford to leave unprotected.

### AU-2 · UUIDv7 vs `bigserial` — settled on evidence, and the reason is not the dependency

The open question was whether the chain key should be a UUIDv7 (as ExpenseOS uses) or VeloLedger's
`uuid` + `sequence bigserial`. Reading `verify.ts` answers it:

> "Walks Audit rows ordered by id (= UUIDv7 timestamp)"

ExpenseOS needs v7 **because it has no sequence column** — the id is doing double duty as the chain's
order. VeloLedger already separates the two:

```sql
id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
sequence  bigserial NOT NULL UNIQUE,
```

Take VeloLedger's shape. The cheap reason is that it needs no new dependency — `uuid` is not in
VeloExpense's `package.json` (checked), `gen_random_uuid()` is built in, and `lib/receipts/service.ts`
already uses `randomUUID` (v4).

The better reason is correctness. A UUIDv7 is minted by the **application** from its own clock, so
two appends in the same millisecond, or two app instances with skewed clocks, can order rows
differently from the order they were actually appended in — while the hash chain records the true
append order. The advisory lock keeps the *head read* correct, but the *verifier* walks by id, so id
and chain can disagree and the disagreement reads as tampering. A `bigserial` is assigned by the
database inside the same serialized transaction and cannot disagree.

### AU-3 · The frozen payload — what goes in, and the one field I would add

HANDOFF says freeze this once, so here is the proposed payload, with ExpenseOS's exclusions kept and
their reasons:

| field | in hash? | why |
|---|---|---|
| `organization_id` | **YES — added** | AU-1.3. Not in theirs; unprotected tenant attribution is not acceptable here. |
| `occurred_at` | yes | Use `clock_timestamp()`, not `now()` — `now()` is transaction-start, so several audit rows in one transaction would share a timestamp. Existing VeloExpense convention. |
| `actor_id` | yes | `ON DELETE RESTRICT`. HANDOFF already records the lesson: an actor column inside the hash with `SET NULL` means one hard delete permanently breaks verification of every row that actor wrote. |
| `actor_name` | yes | Denormalized and frozen at write time on purpose, so a later rename does not alter history. |
| `actor_role` | **YES — added** | Theirs excludes it, with a comment inviting exactly this: *"actorRole is intentionally NOT in the hash… If you need actorRole integrity, surface a follow-up."* "Under what authority was this done" is a question an auditor asks, and after AP-13 — a privileged user approving their own report — it is the specific question. Cheap now, impossible later. |
| `action`, `entity_type`, `entity_id` | yes | The what and the on-what. |
| `details` (jsonb) | yes | See AU-5 for the BigInt trap. |
| `ip_address` | yes | `inet`, following VeloLedger. |
| `prev_hash` | yes | The chain itself. |
| `id`, `sequence` | no | Self-referential — a row cannot hash its own identity. |
| `request_id`, `user_agent` | no | Operational. Theirs excludes them; no reason to differ. |
| `expires_at` | no | Mutated by retention, so hashing it would make a retention pass look like tampering. |

### AU-4 · The purge watermark — port this, it is the non-obvious part

`verify.ts` takes a `seedPrevHash` for a reason worth quoting, because nobody designs this until it
bites:

> "Needed after a retention purge: the deleted head means the oldest surviving row's `prevHash`
> references a row that no longer exists, which is indistinguishable from tampering. The caller
> supplies the purge watermark here so the gap reconciles instead of reading as a break."

For us the watermark has to be **per tenant** — one tenant's purge must not require another's
verification to be seeded. That means storing it, not passing it: a small `audit_chain_state` row per
organization holding the last purged entry's hash, or the same two columns on `organization`. Either
way it is part of VX2-6, not a later retention ticket, because the *verifier's* contract depends on
it existing.

Window semantics to keep as-is: when a window starts mid-chain, read the row immediately before it to
seed `expectedPrev`, so a windowed verify still proves integrity **at the window boundary** rather
than just within it.

### AU-5 · `canonical()` throws on BigInt — and VeloExpense's money is bigint

Their canonicalizer sorts object keys, drops `undefined`, preserves `null`, serializes `Date` as
ISO-8601, and:

```ts
if (typeof value === 'bigint') {
  throw new TypeError('canonical(): BigInt values are not supported in audit payloads');
}
```

Port that throw exactly. It matters more for us than for them: VeloExpense money is minor units in
`bigint` columns, and `lib/money.ts` is deliberately string/bigint with no float anywhere. A caller
writing `details: { totalMinor: BigInt(x) }` would throw **at audit-write time**, which means inside
the transaction that was recording a state change — so a sloppy detail payload fails the business
operation, not just the log line.

The rule for VX2-6's writer, and it needs to be in the function's doc comment: **amounts go into
`details` as strings.** `pg` already returns `bigint` columns as strings, so the natural path is
correct and only an explicit `BigInt()` breaks it. A test asserting the throw is worth more than the
comment.

### AU-6 · What the verifier cannot tell you, and must not claim to

`sequence bigserial` produces **gaps** — a rolled-back transaction consumes a sequence value and
never fills it. So a gap is normal, and a gap is also what a deleted row leaves behind. The two are
indistinguishable by sequence alone.

That is fine, because deletion is caught by the hash: the next surviving row's `prev_hash` no longer
matches. But it means the verifier must **never** treat sequence contiguity as a signal, and an admin
reading "sequence 41 is missing" must not be told that is tampering. VeloLedger's
`sequence bigserial NOT NULL UNIQUE` has the same property. Worth a comment in the migration, because
"the numbers should be consecutive" is the first thing anyone assumes on seeing the column.

---

## The GA audit's P0/P1s — one now traced to source

ExpenseOS `origin` carries fix branches whose names map onto the GA audit findings:
`fix/fx-reciprocal-rates`, `fix/self-approval-guard`, `fix/date-input-clickable`,
`fix/bound-money-inputs`, `fix/refuse-zero-total-submit`, `fix/netsuite-preflight-dimensions`.

- **CAD-exclusion-from-totals → traced.** See PE-7. Mechanism confirmed by reading
  `validate.ts` + `facts.ts` on the version Drive holds. The *fix* diff has not been read, so port
  the fix rather than assuming PE-7's remedy matches theirs.
- **approval defaults → `fix/self-approval-guard`, READ.** See AP-13, AP-14, AP-15. It turned out
  to be three findings, not one: a SOX-grade privileged self-approval (their F15 / F20, blocker
  B3), a read-side/write-side authorization disagreement, and the F42 simulator gap. The guard
  itself is portable; its *accepted consequence* is not, and AP-14 is the decision that follows.
- **date picker → `fix/date-input-clickable`, NOT read.** UI; bears on VX2-4 at most.

Two of these are already dodged in VeloExpense — see PE-5 and the "already ahead" list in
`SPEC-BASELINES.md`: `fix/bound-money-inputs` (our `parseAmountToMinor` rejects extra decimals) and
`fix/refuse-zero-total-submit` (VX1-8 refuses an empty report).

## notifications (VX2-7 next, VX2-8 after) — `packages/notifications/src` + `apps/worker/src` — PARTIAL, ~75% read

Read from ExpenseOS SOURCE (not the module doc), 2026-08-29:
`packages/notifications/src/{activity,templates,templateKeys}.ts`, `apps/worker/src/{notification-dispatch,channels}.ts`,
and the `Activity` / `Notification` / `NotificationTemplate` / `NotificationTemplateVersion` /
`ReplyThread` models plus the notification fields of `User` from `packages/db/prisma/schema.prisma`.

Not yet read: `subjectLinks.ts`, `commentThreads.ts`, `replyThreads.ts`, `actionTokens.ts`,
`email.ts`, `slack.ts`, the digest job, and `NotificationPreferences.tsx` (the last refused on mime
type and was not chased — it is a VX2-7 input and should be read before the preferences UI is
built). Everything below is VX2-7 unless marked VX2-8.

### NT-1 · The whole module is tenant-blind, and the loose subject id makes RLS non-optional ⚠

AU-1 found three specific places where the audit chain was tenant-blind. Here there is nothing to
enumerate: **no notification table carries a tenant at all**, and the schema says so on purpose.
A case-insensitive search for `organizationId|tenantId|orgId|workspaceId|model Organization|model
Tenant` across all 4,329 lines of `schema.prisma` returns exactly one hit, and it is a comment:

> `/// The configured/active state of a Module. Single-tenant: one installation`
> `/// per Module (unique). A future tenant model adds `tenantId` here only.`

So `activity`, `notification` and the template tables all need `organization_id` + `ENABLE`/`FORCE
ROW LEVEL SECURITY` and a row in the isolation test. That much is the standing house rule and needs
no argument. What DOES need saying is why RLS is the only guard available on `activity`:

```prisma
model Activity {
  subjectType String
  subjectId   String   @db.Uuid   // loose — no FK
```

`Activity.subjectId` is a bare uuid with no foreign key, and `ReplyThread` is the same
(`/// Loose ids (no FK): the inbound path re-validates the subject + recipient`). That is forced by
the polymorphism — a column cannot reference four different subject tables — so **there is no FK to
fall back on if the tenant predicate is missing.** A subject id is a value a caller supplies. In a
pooled database, a leaked or guessed report id would read another tenant's activity stream, and
nothing in the schema would stop it. Every other tenant table in VeloExpense has a real FK as a
second line; this one will not.

Two consequences to build in:

1. `organization_id` on `activity` and `notification`, FORCE RLS on both, and the read path must
   never take a `subjectId` without also being inside `withOrg`. That is already how every
   `lib/<domain>` module works, so this is a "do not make an exception here" note, not new work.
2. The isolation test needs a **join-walk case** for this table specifically — notification →
   activity → a subject id belonging to another tenant — the same shape VX1-9 added for
   line-item → expense → report. Without it, RLS on the two tables is asserted and the thing the
   tables are actually exposed to is not.

### NT-2 · The preference map promises an in-app switch that nothing reads — and VX2-7's acceptance requires one ⚠

Three places describe the preference map, and they do not agree.

The schema comment says in-app is part of it:

> `// Notification delivery. slackUserId is cached from the Slack integration`
> `// (users.lookupByEmail). notificationPreferences is a per-type × per-channel`
> `// override map { [activityType]: { inApp?, email?, slack? } }; code applies`
> `// sensible defaults when a key is absent.`

The type says it is not:

```ts
export type PrefMap = Record<string, { email?: boolean; slack?: boolean } | undefined>;
```

And `channels.ts`'s header says why:

> `* Per-recipient channel selection for notification dispatch. Pure (no DB) so it`
> `* can be unit-tested in isolation. In-app delivery is unconditional and handled`
> `* elsewhere; this decides only the external channels (email / Slack).`

"Handled elsewhere" is `notifyRecipients`, which writes one `Notification` per recipient and **never
looks at preferences at all**. Meanwhile `NotificationChannel` is `IN_APP | EMAIL | SLACK`, so
IN_APP exists as a template channel but not as a preference. Whether the preferences SCREEN offers
an in-app toggle is the one thing not yet read (`NotificationPreferences.tsx`); if it does, it is a
shipped dead control.

**This collides with VX2-7's acceptance criterion, which is "a decision notifies the submitter
in-app; preferences suppress it."** Their arrangement cannot satisfy the second clause. Suppressing
in-app means the preference is consulted at FAN-OUT time, in `notifyRecipients`, not at dispatch
time — a different place in the flow from where ExpenseOS put it. **Blocking decision (D2).**

### NT-3 · The channel defaults, portable verbatim

```ts
function defaultChannels(type: string): { email: boolean; slack: boolean } {
  if (type === 'COMMENT') return { email: false, slack: false };
  return { email: true, slack: false };
}
```

> `/** Per-activity-type defaults when the user hasn't overridden: comments stay`
> ` * in-app only (no email noise / storms); everything else emails. Slack is`
> ` * always opt-in. */`

Two things to keep beyond the values. First, **email is opt-OUT and Slack is opt-IN** — asymmetric
on purpose, because an unasked-for email is an annoyance and an unasked-for DM is an intrusion.
Second, and structurally more important: **the stored map holds only OVERRIDES**, and an absent key
falls to the code default:

```ts
email: prefs[type]?.email ?? def.email,
```

So adding an event type needs no backfill and no migration, and a tenant's stored preferences never
have to be rewritten when the taxonomy grows. Port that shape exactly; a map that stores every
type × channel explicitly would need a data migration per new event.

### NT-4 · The board's template-resolution ladder is the design ExpenseOS **deleted** ⚠ changes VX2-7's spec

The Phase-2 board's scope note for VX2-7 says:

> template resolution exact → any-subject → shipped catalog string

That middle rung — "any-subject" — is not a feature. It is an artefact of keying a template on its
coordinates, and ExpenseOS has already removed it. Their own postmortem, verbatim from
`templateKeys.ts`:

> `* Templates used to be keyed on `(channel, eventType, subjectType, locale)`.`
> `* That was not an identity, it was a set of coordinates, and the table was the`
> `* cross-product of whatever shape `packages/i18n/.../notifications.json``
> `* happened to have. A flat catalog entry produced a row whose subject was NULL`
> `* and therefore rendered as "Any"; a nested block produced one whose subject was`
> `* its block name. Nothing chose that mix — it fell out of the JSON. Two locales`
> `* then doubled every row, so one sentence lived in two records that could drift`
> `* apart with nobody able to see it.`

and from the `NotificationTemplate` model:

> `///   * `locale` in the key meant EN and FR-CA were SEPARATE ROWS. One sentence,`
> `///     two records, two version histories, and no way to see that an admin had`
> `///     reworded the English and left the French saying the old thing.`
> `///   * `subjectType` was nullable, so the list showed a mix of "Any",`
> `///     "TRAVEL_REQUEST" and "Expense report" with nothing having chosen that`
> `///     mix …`
> `///   * neither field is stable. Renaming an activity type orphans its wording.`

The replacement is **one row per (`key`, `channel`) carrying every locale in Json columns**, with
`(eventType, subjectType) → key` moved out of the schema and into an explicit, tested table in code.

**This is VX2-1 happening again** — the plan describing a shape the source has since replaced — with
the difference that this time it was caught before the migration rather than after the PR.
**Blocking decision (D1).** Note that one of their three reasons (locale doubling) does not apply to
VeloExpense today, since French is explicitly deferred; the other two do.

`templateKeyFor` is a lookup, and the file is explicit that this is not a naming rule:

> `* It is deliberately NOT derived`
> `* from a naming rule: the same key legitimately serves several activities (a`
> `* card is "issued" whether the event hangs on the card or on the request that`
> `* asked for it), and a rule producing `virtual_credit_cards.request_issued` for`
> `* one of them would be a rule quietly inventing a second template.`

Key format, and the reason the owner prefix is a closed list rather than free text:

```ts
export const TEMPLATE_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
```

> `* The prefix is scoped to real owners rather than left free-form so two features`
> `* cannot both invent `request_submitted` and collide, and so a key says which`
> `* part of the product is responsible for the sentence.`

36 registry entries covering 46 `(eventType, subjectType)` pairs and 20 distinct event types.

### NT-5 · `fromTemplate` is the field that makes VX2-7's acceptance test honest — and their own suite got exactly this test wrong ⚠

`renderTemplate` returns:

```ts
export interface ResolvedTemplate {
  subject: string | null;
  body: string;
  blocks: unknown;
  /** True when a stored template supplied the text (vs the catalog fallback). */
  fromTemplate: boolean;
}
```

VX2-7's acceptance criterion is *"an empty template table still renders shipped copy."* ExpenseOS
wrote that test and it did not work. From `resetCatalogCache`'s doc comment:

> `* That is not hypothetical. "falls back to default copy when the catalog has no digest`
> `* strings" asserted on the fallback copy while never once reaching it: the real catalog was`
> `* served, and the assertion passed only because those strings happen to be character-`
> `* identical to the code's fallbacks. Rewriting the fallback in source left all 20 tests`
> `* green. The test named a behaviour it could not observe.`

Their cause was a module-level catalog cache that the first test in the file fixed for every later
one. Ours would not be that — VeloExpense has no i18n catalog to memoise — but the failure MODE
transfers exactly: **when the fallback string and the template string are equal, asserting on the
output cannot distinguish which path produced it.** So VeloExpense's version of that test asserts
`fromTemplate === false`, and the fallback fixture uses copy that is deliberately *not* a substring
of any template. Assert the path, not the sentence.

Two smaller lessons in the same comment, both worth adopting: a module-level cache needs an exported
reset **or it should not be module-level in a file under test**, and a once-per-process warning latch
has the identical problem (`resetSlackWarnings` exists for exactly that reason — "a suite written
without this has one real assertion and a row of companions that pass because nothing was logged AND
because nothing could have been").

### NT-6 · Substitution — four rules, port all four

```ts
export function applyPlaceholders(
  source: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return source.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
```

1. **Named `{placeholder}` replacement and nothing else.**
   > `* Substitution is deliberately dumb: named `{placeholder}` replacement against a`
   > `* supplied value map, nothing else. No expressions, no property access, no`
   > `* conditionals. A template editor that evaluates expressions against the`
   > `* notification context is an injection surface and a support burden, and the`
   > `* need it serves is rewording sentences.`
2. **An unknown placeholder is left VERBATIM, not blanked.**
   > `* An unknown placeholder is left verbatim rather than blanked — `{amont}` in the`
   > `* output is a visible typo somebody fixes, whereas an empty gap reads as a`
   > `* product bug and hides the cause.`
3. **Only SCALAR payload entries become values.** From the dispatcher:
   > `// Scalar payload entries become placeholders, so a template can say`
   > `// "report {number} is missing {missing} receipt(s)" without this handler`
   > `// knowing anything about receipts. Non-scalars (arrays like ADJUSTED's`
   > `// `fields`) are dropped rather than stringified as "[object Object]".`
4. **Reserved names are assigned LAST so a payload key cannot shadow them** —
   `{ ...payloadValues, actor, link, cta }`, with the comment saying exactly that. Worth a test: a
   payload carrying `actor` must not win.

### NT-7 · `renderVersion` takes CONTENT, not a template id — keep the split even without preview

> `* Shared by delivery and by the admin PREVIEW, which is why it takes content`
> `* rather than a template id: preview has to render a version that is not`
> `* published, and delivery must never render one that is. Keeping the rendering`
> `* identical while the SELECTION differs is the whole point of the split.`

Also: it returns **null** when the version carries no text for the locale or its fallback, "so the
caller can drop to the catalog instead of sending an empty message". A half-authored template is a
miss, not an empty body. Port the signature even if VX2-7 ships no preview and no version table
(D4) — a pure `render(content, values)` is what makes both additive later.

### NT-8 · The registry has a COLLISION guard and no EXHAUSTIVENESS guard — and here that is right

At module load:

```ts
      // Two keys claiming one activity is unresolvable at runtime — whichever
      // won would depend on array order, which is not a decision anybody made.
      if (existing && existing !== def.key) {
        throw new Error(...);
      }
```

But `eventType` and `subjectType` are plain `string` everywhere, there is no `Record<EventType, …>`,
and adding an event type is therefore **silently unmapped rather than a type error**.

That is the same shape as AP-19, where I chose the compile-time guard over ExpenseOS's test-based
mitigation. **Here I would not**, and the reason is the consequence of a miss. In AP-19 an unmapped
role meant a rung that routes nowhere. Here:

> `* A pair with no entry resolves to `null`, and `renderTemplate` then falls back`
> `* to the i18n catalog exactly as it did before templates existed. That is the`
> `* behaviour for events nobody has written copy for yet, and it is why adding an`
> `* activity type cannot break delivery.`

An unmapped event degrades to shipped copy, which is a working notification. Forcing every new event
type to have authored copy before it can be added would make the taxonomy expensive to grow for no
safety gain. **Keep their behaviour; the collision guard ports, the exhaustiveness guard does not.**
Recorded as a considered non-divergence so a later reader does not "fix" it.

### NT-9 · A frozen legacy copy gap, and the rule worth stealing from it

> `* Note where one key serves more than one subject. Card limit-increase requests`
> `* have never had copy of their own — they have always rendered the card-request`
> `* sentences, because the old resolver fell through to the NULL-subject row. That`
> `* is preserved here verbatim rather than quietly changed; it is a copy gap to`
> `* close with words, not with a schema migration.`

VeloExpense has no legacy table and so nothing to freeze. The transferable rule is the one to keep:
**an accidental fallthrough gets written down explicitly rather than silently corrected**, because
correcting user-visible copy under cover of a structural migration means nobody reviews the change
as a copy change. It applies directly to VX2-8's EMAIL approvers, which VX2-4a currently hides.

### NT-10 · `Activity.type` and `Activity.subjectType` are bare strings, deliberately

The schema comment on `Activity.type` lists the values in prose and constrains nothing, and the
sibling model does the opposite:

> the sibling `ApprovalInstance.subjectType` *does* use an `ApprovalSubjectType` enum — `Activity`
> deliberately does not.

Same reasoning, and the same house pattern, as `expense_policy.kind` in VX1-7: adding an event type
must not need a migration, so the taxonomy lives in code and the column is text. Consistent with
what VeloExpense already does; port as-is.

### NT-11 · Two measured "silent gate" incidents, and the observability rule they imply

Email:

> `// The recipient wants email and the activity qualifies, but the `email``
> `// integration isn't installed/active — so nothing sends. Silence here`
> `// is what made "notifications aren't going to email" un-diagnosable`
> `// across several UAT rounds: no error, no log, no delivery.`

Slack, in the same handler:

> `// The identical hole as the email gate three lines up, whose own comment`
> `// records what it cost … What the warning has to carry is WHICH of the`
> `// failures it is: "nobody installed Slack", "somebody installed it and left the`
> `// bot token blank", and "this process cannot decrypt the config because`
> `// PG_CRYPTO_KEY is missing from the worker" all used to arrive as the same`
> `// absence of a message.`

And why the latch is per-reason rather than once:

> `* Per reason, not once outright, because the reasons are fixed in sequence — an`
> `* operator pastes a bot token, restarts nothing, and the next thing they need to be`
> `* told is that the signing secret is still missing. One latch would have swallowed that.`

Mostly VX2-8. The part that lands on VX2-7 is the rule underneath: **every place a notification is
deliberately not created must be observable.** VX2-7 adds exactly one such place — a preference
suppressing in-app (D2) — and that one is self-explanatory from the preferences screen, so it needs
no log. The rule is recorded here so VX2-8 does not have to rediscover it.

### NT-12 · The Slack id cache — two TTLs and three repair paths (VX2-8)

Recorded now because it is the most expensive thing in the module to get wrong and it will be read
in a later thread.

```ts
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

> `* · a **negative** was cached for a week, so correcting somebody's Slack email left`
> `* them unreachable until it lapsed;`
> `* · a **positive** was never re-checked at all (`if (cached) return cached`), so a`
> `* person who moved to a different Slack account was unreachable *forever*.`

And the third failure, separate from both: an **inconclusive** answer (rate limit, revoked token,
missing scope, a 502) written down as "no such Slack user" —

> `// Writing that down as "this person has no Slack account" is exactly the mistake the`
> `// old `string | null` return made, and it cost a week of silence per occurrence.`

The design rule, in their words: *"A cache whose only correction is waiting is the thing being fixed
here."* Three repair paths, not one — TTL lapse, Slack refusing the id on send (which is the only
PROOF the id is dead), and a manual clear from the profile screen.

### NT-13 · Fan-out semantics, port verbatim

```ts
export async function notifyRecipients(db, activityId, recipientIds): Promise<void> {
  const unique = [...new Set(recipientIds)].filter(Boolean);
  if (unique.length === 0) return;
  const created = await db.notification.createManyAndReturn({ ... });
  await Promise.all(created.map((n) =>
    enqueue('notification.dispatch', { notificationId: n.id }).catch((e) =>
      console.warn('[notifications] enqueue dispatch failed', n.id, e))));
}
```

- **De-dupe recipient ids**, and no-op on an empty set. The submitter is frequently also an
  approver's delegate or the actor; a fan-out that double-writes puts two identical rows in one bell.
- **Enqueue failure is non-fatal**, with the reason stated: *"the in-app rows are already written"*.
  In-app is the channel that must not depend on a queue being up. VeloExpense has no queue until
  VX2-8, which makes this free now and is the right ordering — the always-on channel lands first.
- **`recordActivity` and `notifyRecipients` are two calls**, not one. A caller can record an event
  without telling anybody, which is what makes the stream usable as a timeline as well as a mailbox.

### NT-14 · `appOrigin()` is read at CALL time, from three variables (VX2-8)

> `* · the deployed task definition sets `AUTH_URL`, not `APP_URL` … so `APP_URL` was empty in`
> `* dev and prod — and an empty origin makes `deepLink()` AND `issueActions()` return null.`
> `* Every notification email in a deployed environment therefore went out with no link and no`
> `* approve/reject buttons, which is indistinguishable from "this notification was never meant`
> `* to be actionable".`
> `* · module load happens on import … Today `main.ts` imports that first so local dev works,`
> `* but the guarantee is an import ORDER — one re-sort away from silently emptying every link.`

Both halves transfer to VeloExpense, which reads `AUTH_URL` in `auth.ts` and has no `APP_URL`.

### NT-15 · The digest is deferred, so `emailedAt` must not ship

`Notification.emailedAt` exists only to serve the digest:

> `/// When the email pipeline finalized this row (sent immediately, or resolved`
> `/// by the periodic email digest). Null = still pending a digest. Only digest-`
> `/// eligible types ever sit pending; immediate types are excluded by type.`

Digest scheduling is on the board's own deferred list. So VX2-7 ships **no** `emailed_at` column: a
nullable timestamp nothing ever sets is indistinguishable from a bug, and the digest will need its
own migration anyway. `DIGEST_TYPES` (`COMMENT`, `ADJUSTED`, `CARD_STATUS`) is recorded here so the
list does not have to be re-derived.

### NT-16 · Where the three streams sit, because there are now three

VeloExpense will carry `expense_report_event` (VX1-8), `audit_entry` (VX2-6) and `activity`
(VX2-7). Three overlapping logs is a smell, so the boundary is worth stating once rather than
being rediscovered:

| Table | Grain | Answers | Tamper-evident |
| --- | --- | --- | --- |
| `expense_report_event` | one status TRANSITION of one report | "what happened to this report, in order" — the user-facing timeline | no |
| `audit_entry` | any control-relevant change to any entity | "prove nobody edited the record" | yes, hash-chained |
| `activity` | one NOTIFIABLE event on a subject, with render params | "who needs telling, and what does the sentence say" | no |

The question worth asking is whether `activity` earns its place or whether the fan-out could hang
off `expense_report_event`. **It earns it, and not on taste:** `TASK_ASSIGNED`, `DEADLINE_NEAR` and
`RECEIPT_REMINDER` are not status transitions of a report, so `expense_report_event` is the wrong
grain for three of the events VX2-7 has to deliver. Hanging notifications off it would work for
Phase 2's happy path and then need unpicking at the first reminder.

One decision follows from the table: **a decision on a report now writes four things in one
transaction** — the status transition, the audit entry, the activity, and N notifications. All four
or none, in the same `tx` the engine already opens. That is not a new pattern (VX2-3 already couples
the decision and its audit row) but it is the largest single transaction in the product so far.

### NT-17 · The approve-link token — portable almost verbatim, and the one line to keep is the disclaimer

`packages/notifications/src/actionTokens.ts`, read in full. 32 random bytes base64url, only the
sha256 persisted, bound to `(taskId, action, recipientId)` with an `expiresAt`, and consumed by a
CONDITIONAL write:

```ts
export async function consumeActionToken(db: Db, id: string): Promise<boolean> {
  const res = await db.actionToken.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return res.count === 1;
}
```

> `/** Mark a token consumed (single-use). Returns true only for the call that`
> ` * actually consumed it — the conditional write guards against double-submit. */`

That is the same shape as VX2-3's atomic claim (`WHERE id = $1 AND status = 'PENDING'`, then
`rowCount !== 1`), which is a good sign: two independent single-use guarantees in this codebase now
have one idiom.

The load-bearing sentence is the file header's, and it is what makes the whole feature safe:

> `* The token only authenticates the actor and binds one action to one task; the caller still`
> `* re-runs canDecide + the atomic claim, so it never bypasses authorization.`

So an approve-link is an AUTHENTICATION mechanism, not an authorization one. VX2-8 must route the
click through `assertCanDecide` and `engine.decide` exactly as the browser does — the token replaces
the session, and nothing else. A token that carried its own permission would be a way to approve a
report after being removed as its approver.

Two things do NOT port:

1. **`ActionToken` is tenant-blind**, like every other table in this module (NT-1). It needs
   `organization_id` + FORCE RLS. Note the consequence for the click handler: the request arrives
   with a bare token and NO session, so there is no org to set — the lookup has to happen with the
   service role (`withoutOrg`) to find the token's tenant, and everything after it inside
   `withOrg(that tenant)`. **That is the only place in this product where a `withoutOrg` read is
   driven by an untrusted value**, so the token hash has to be the whole lookup key and the row's
   `organization_id` the only thing taken from it.
2. **The expiry has nowhere to come from.** ExpenseOS computes
   `tk.expiresAt ?? addBusinessDays(new Date(), DEFAULT_TTL_BUSINESS_DAYS)` and its dispatcher notes
   "tokens live five business days". VeloExpense has **no task TTL** — AP-8's expiry policy is
   ported as a spec and nothing implements it, which is recorded in HANDOFF §5 as one of the two
   things VX2-2 did not close. So the token lifetime is a VX2-8 input with no source answer:
   a fixed window is the only option available, and five business days is the number ExpenseOS
   chose.

### NT-18 · Email transport is PLATFORM-level and env-configured — which answers a question I was going to ask

`packages/notifications/src/email.ts`, read in full. There is no per-tenant SMTP anywhere:

> `* SMTP_HOST set → real send via nodemailer SMTP (SMTP_PORT / SMTP_SECURE /`
> `* SMTP_USER / SMTP_PASS, SMTP_FROM or EMAIL_FROM sender).`
> `* SMTP_HOST unset → log to console (EMAIL_TRANSPORT=console forces this), so`
> `* flows stay testable without a mail server.`

The `integration` table that `notification-dispatch.ts` consults supplies exactly two things: an
active/inactive GATE, and a `fromOverride`. The transport itself is process configuration. So the
per-tenant part of email in ExpenseOS is *the from address*, and everything else is the platform's.

That maps cleanly onto VeloExpense, which has no module/integration system at all: the gate becomes
"is SMTP configured", and per-tenant customisation is deferred with nothing lost. **The console
transport is the part worth copying deliberately** — it is what lets an e2e assert on a rendered
email without a mail server, which is the same argument VX1-9 made for choosing `s3rver` over MinIO
("one Node process — no Docker for CI or a laptop").

Three details to port with it:

- **The console path NEVER throws; SMTP errors propagate.** Deliberate asymmetry: a developer
  without a mail server must not see failures, and a real send that failed must not be swallowed.
- **`verifyEmailTransport()`** exists for an admin "Test connection" button, and returns a
  `{ ok, message }` rather than throwing. NT-11's silent-gate incidents are the reason a product
  needs this at all: the operator has to be able to ask whether email works and get a sentence back.
- **`Auto-Submitted: auto-replied` (RFC 3834)**, with the best comment in the file:
  > `* Added for `Auto-Submitted: auto-replied` (RFC 3834): a machine-generated reply has to say`
  > `* so, or a well-behaved out-of-office responder answers it and the two of them keep going.`

  Free to add and impossible to discover from first principles.

### NT-19 · VeloExpense has no queue, no worker and no Redis — and the plan does not say to add one ⚠ blocking

ExpenseOS's dispatch is a BullMQ job (`enqueue('notification.dispatch', …)`) consumed by a separate
`apps/worker` process against Redis. VeloExpense has none of those three, and VX2-8's acceptance
criterion needs durable job state regardless of how it is stored:

> An approval email arrives with working actions; a failed send retries and shows in the **admin
> queue**; every job sets `app.current_org`.

Three substrates, and the choice is architectural rather than a matter of taste:

**(a) BullMQ + Redis + a worker process.** Ports ExpenseOS's shape, and gets retry, backoff and
dead-lettering for free. Costs a new deployment dependency in the Docker image, in CI and on every
laptop — and the admin queue screen then reads Redis, so an admin surface depends on a second
datastore whose contents are not RLS-scoped and not backed up with the database.

**(b) A Postgres outbox table plus a poller.** `SELECT … FOR UPDATE SKIP LOCKED`, an `attempts`
counter, `next_attempt_at`, `last_error`. No new infrastructure; the admin queue is a table with a
policy on it; per-job tenant context (the VX0-8 requirement) is a column the worker wraps in
`withOrg`. Costs: we write the backoff, the claim, the visibility timeout and the dead-letter
ourselves — the parts BullMQ gives away.

**(c) Send inline from the request.** Fails the acceptance criterion twice (no retry, no queue) and
couples an approval transaction to an SMTP timeout. Not viable; recorded so it is visibly rejected
rather than silently unconsidered.

**Recommendation: (b).** Not because outboxes are fashionable, but because this codebase has already
made this exact call once and written down why. VX1-9 chose `s3rver` over MinIO for the e2e —
"one Node process — no Docker for CI or a laptop" — and the same sentence applies to Redis. The
retry/admin-queue requirement is satisfied by columns that the admin screen reads directly, and a
tenant's undelivered mail being subject to the same RLS as everything else is a property worth
having rather than an accident to work around.

One design point that follows and needs stating: the worker must read across tenants to find work
(`withoutOrg`) and then do each job inside `withOrg(row.organization_id)`. That is the second place
in the product where a `withoutOrg` read exists, and like NT-17's it must take nothing from the row
except the tenant id.

### NT-20 · "Teams" is on the board and has no source to port

The board's VX2-8 title is "Delivery worker (email/Teams/Slack)". ExpenseOS ships **email and
Slack**; there is no Microsoft Teams code anywhere in the notification package or the worker, and
`NotificationChannel` is `IN_APP | EMAIL | SLACK`. So Teams is not a port, it is new work against a
third API — and VX2-7's `notification_preference.channel` CHECK constrains the column to those three
values, which means adding Teams is a migration as well.

Recorded rather than quietly dropped, because "the board said Teams" is exactly the kind of thing a
later reader finds and treats as a missing feature rather than a scope decision.

### NT-21 · Slack is the larger half of VX2-8, and its cost is not the code

`apps/worker/src/notification-dispatch.ts` (read in full, NT-11/NT-12) plus
`packages/notifications/src/slack.ts` (13 KB, **not yet read**) plus an interactions endpoint, a
signing-secret verification path, a `users.lookupByEmail` cache with two TTLs and three repair paths,
and a per-subject DM thread root. The code is portable; what it drags in is a Slack app
registration, a bot token and a signing secret per deployment, and an inbound HTTP endpoint that
must verify request signatures.

Worth noting what Slack buys that email does not: ExpenseOS's Slack path has INTERACTIVE buttons
when a signing secret is present ("decide in Slack via the interactions endpoint") and falls back to
URL buttons pointing at the same confirm page as the email when it is not. So the email path is a
strict prerequisite for the Slack path, and shipping email alone leaves nothing stranded.

## expense-reports · the reimbursement transition (VX2-9) — `apps/web/src/server/routers/expenseApprovals.ts`, read in full 2026-08-29

One procedure, `markReimbursed`, is the only path to `REIMBURSED` in that router. Its siblings, for
orientation: `myTasks`, `myDecided`, `myTeam`, `report`, `expenses`, `chaseReceipts`, `decide`,
`decideBulk`, `reassign`, `returnForEdit`, `setFxOverride`.

### RB-1 · Their reimbursement records NOTHING, and the audit row is empty too — DIVERGING

```ts
      return withAudit(
        ctx.db,
        {
          action: auditActions.report.reimburse,
          entityType: 'ExpenseReport',
          entityId: report.id,
          actor: actorOf(ctx),
          details: {},
        },
        (tx) =>
          tx.expenseReport.update({
            where: { id: report.id },
            data: { status: ExpenseReportStatus.REIMBURSED },
            select: { id: true, status: true },
          }),
      )
```

One column written, and `details: {}`. The emptiness is the striking part rather than an oversight
of mine in reading it: the SAME FILE passes `details: { taskId, note }` from `decide` and
`details: { rate, fromCurrency }` from `setFxOverride`. So somebody thought about the payload on the
neighbouring mutations and had nothing to put in this one, because there is nothing to put — no
`reimbursedAt`, no `reimbursedById`, no payment reference, no method, no batch, no amount snapshot.
Contrast their own `fxRateOverrideAt` / `fxRateOverrideById`, which that file does write.

The only record of who paid and when is the audit row's actor and timestamp.

**DECIDED: diverge.** `0013` adds `reimbursed_at`, `reimbursed_by_id` and an optional
`reimbursement_reference` to `expense_report`. Three reasons, in order of weight:

1. `approved_at` already exists on that table. A payment with no timestamp beside an approval with
   one is an asymmetry somebody will read as a bug, and "when was this paid" should not require
   walking a hash chain.
2. The reference is the only field that connects the flag to the money. RB-6 below establishes that
   `REIMBURSED` is bookkeeping-free — nothing is posted, nothing reconciles — so without a reference
   the status asserts a payment happened and offers nothing to check it against.
3. It is three columns on an existing table, so there is no new RLS surface and the coverage guard
   is unaffected.

### RB-2 · The double-payment race is a REAL DEFECT in their code, and this codebase already has the fix idiom ⚠

The read is outside the transaction and the write does not re-assert what the read checked:

```ts
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { id: true, status: true },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      if (report.status !== ExpenseReportStatus.APPROVED) { … }
      return withAudit(…, (tx) =>
          tx.expenseReport.update({
            where: { id: report.id },              // <- id ONLY
            data: { status: ExpenseReportStatus.REIMBURSED },
```

So two concurrent calls — a double-click, or two AP clerks working the same list — both pass the
guard and both write. The result is one payment with two `report.reimburse` audit rows and two
notifications, on the one transition in the product that means money left the building. There is no
version column, no idempotency key, and no `updateMany` with a status predicate.

**This is the fourth appearance of the same problem in this port, and VeloExpense already has the
answer three times over:** VX2-3's decision claim (`WHERE id = $1 AND status = 'PENDING'`, then
`rowCount !== 1`), VX2-8's `consumeActionToken`, and VX2-8's `claimDelivery`. So `reimburseReport`
uses the identical shape — `UPDATE … WHERE id = $1 AND status = 'APPROVED'` and a rowCount check —
and the read above it exists only to produce a good error message, exactly as `decide`'s does.

### RB-3 · No self-payment check anywhere — DIVERGING, with the AP-14 exception ⚠

Authorization is a single static permission and nothing else:

```ts
  markReimbursed: withPermission(P.expense.report.reimburse)
```

No eligibility check, no ownership check, no entity scoping — and, notably, **no check that the
actor is not the submitter.** So an AP user can mark their own report paid, in a codebase whose own
header calls self-approval a control worth building the `canDecide` ordering around (AP-13).

The asymmetry is hard to defend on their side: approval is an opinion about whether money *should*
move, payment is the assertion that it *did*. If the first is worth a SOX-grade guard, the second is
worth at least the same.

**DECIDED: refuse self-reimbursement, with AP-14's existing break-glass.**
`allow_sole_approver_self_approval` gates it, because the case that forces an exception is identical
— a tenant where the admin who submits is the only person who can act — and a second flag nobody
remembers to set is worse than one flag with a widened meaning. `0013` therefore also updates that
column's COMMENT rather than adding `allow_self_reimbursement`; the cost accepted is that the
column's NAME now under-describes it, which a comment can fix and a forgotten flag cannot.

Recorded because a later reader will find the flag's name and think it is being misused.

### RB-4 · Holding the reimburse permission also grants blanket READ of every report

Not a defect, but a coupling worth seeing before it is copied:

```ts
  if (perms.includes(P.expense.report.readAll) || perms.includes(P.expense.report.reimburse)) {
    return true;
  }
```

and again, as a hard gate on the cross-report expense list:

```ts
      if (
        !perms.includes(P.expense.report.readAll) &&
        !perms.includes(P.expense.report.reimburse)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
```

Defensible — you cannot pay what you cannot read — but it means "let this person mark payments" and
"let this person read every expense in the company" are one grant.

**Moot in VeloExpense today and worth writing down anyway.** There is no finance role: roles are
EMPLOYEE | MANAGER | ADMIN, so reimbursement is ADMIN-only and an ADMIN already reads widely. The
coupling becomes a real decision on the day per-tenant RBAC lands — which is already on the
unticketed list — and at that point an AP role that can pay but not browse is the thing to design
deliberately rather than inherit.

### RB-5 · `REIMBURSED` is terminal with no undo — and `setFxOverride` walks straight through it

There is no `unmarkReimbursed`, no reversal, no correction path. `REIMBURSED` is terminal as far as
that router is concerned.

Worse, one mutation ignores status entirely. `setFxOverride` carries **no status guard whatsoever**,
so it can restamp FX and recompute the total of an already-reimbursed report — changing the amount
after the payment it describes. Their own comment on that function is about a different failure and
is worth reading anyway, because it is the same class of thinking:

> `* It is a BULK WRITER, not a second conversion path: the rate is stamped onto`
> `* every expense on the report in that currency as a MANUAL snapshot, and the`
> `* roll-up reads the expenses. That matters because the expense's snapshot is`
> `* what gets posted to NetSuite — a report-level rate the expenses didn't know`
> `* about would have produced a report total its own line items contradict.`

**VeloExpense is already ahead here, structurally rather than by vigilance.** `assertDraft()` is the
single write gate (VX1-6) and every report/expense/line mutation calls it, so a report past DRAFT is
read-only at the data layer — a post-payment total change is not something we have to remember not
to do. And VeloExpense has no FX override at all; PE-1 is the currency gap and it is still open.

**The missing undo is a genuine gap and it is NOT closed by VX2-9.** A mis-clicked reimbursement has
no route back except SQL, on a status that also freezes the report. Recorded as unticketed work
rather than folded in: reversing a payment flag is a control question (who may, and what does the
audit trail say) and not a one-line status write.

### RB-6 · Reimbursement does not touch the ledger — the GL hand-off is at APPROVAL

`postApprovedReport` is imported once and called only from `decide` and `decideBulk`:

```ts
      // An approved report is a liability, so NetSuite gets it now rather than
      // when somebody remembers (rule 7). A no-op unless this decision was the
      // terminal one.
      postApprovedReport(ctx.db, res.subjectId);
```

`markReimbursed` calls no accounting or export function, writes no journal reference, and records
nothing a ledger could reconcile a payment against. So in their design `REIMBURSED` is a
bookkeeping-free flag asserting that AP paid out-of-band.

Two consequences, both useful:

- **VX2-9 stays a one-day ticket honestly**, rather than by leaving something out. There is no GL
  work to defer because there is none on this path.
- **Phase 3's accounting adapter hooks APPROVAL, not payment**, and the reason is in that comment —
  an approved report is already a liability. Worth having in writing before the adapter is designed,
  since "post it when we pay it" is the intuitive and wrong answer.

### RB-7 · Their notification is fired outside the transaction and not awaited

```ts
      ).then((updated) => {
        notifyReportReimbursed(ctx.db, report.id, ctx.rbac.id);
        return updated;
      });
```

Un-awaited, after the commit, with no catch — so a failed notification is lost silently and the
caller cannot know. Also worth noting: `markReimbursed` does not call `executeWorkflowEffects`,
unlike `decide` and `decideBulk`, so no workflow effects fire on payment.

VeloExpense already diverges here and should keep diverging: VX2-7 puts the notification INSIDE the
transaction that caused it, on the reasoning recorded in `notifyTaskOwner` — the alternative loses
notifications silently, and NT-11 is a record of what silent non-delivery costs. So the REIMBURSED
notification is written in the same transaction as the status change, all-or-nothing.

`REIMBURSED` also needs adding to `lib/notifications/catalog.ts` with a template key and shipped
copy. VX2-7 deliberately left it out — "an event type nothing emits is a preference row nobody can
explain and a template nobody can test" — and there is a test asserting the taxonomy is exactly five
events, so adding the sixth is a visible decision rather than a drift.

### RB-8 · What their guard refuses, ported verbatim including the sentence

```ts
      if (report.status !== ExpenseReportStatus.APPROVED) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only approved reports can be marked reimbursed.',
        });
      }
```

Note what it does NOT check, all of which is deliberate on their side and should stay that way:
whether the report has any expenses, whether receipts exist, whether policy violations are resolved
(`report.violations` is loaded by the read query and never consulted), or whether the total is
non-zero. Those were all questions for the submit gate (VX1-8) and the approval gate; asking them
again at payment time would refuse a report somebody has already approved, which is the wrong place
to relitigate it.

The one addition: because `APPROVED` is the only permitted source status, an already-`REIMBURSED`
report falls into the same branch — so "cannot pay it twice" and "cannot pay an unapproved report"
are one guard, and RB-2's atomic claim is what makes that guard actually hold.

## accounting · the integration registry and the ledger hand-off (VX3 planning) — `packages/platform`, `packages/integrations-netsuite`, read 2026-08-29

Read at ExpenseOS `5a11a647`. **Note the drift before using any line number below:** the Plan and
the Differences Chart were both written against `fb1cead`, and the NetSuite package has been
reworked since (`NetSuiteAccount` was created, dropped, recreated and renamed across four
migrations). This is the first section of this audit where the spec source has visibly moved under
the plan, which is exactly what Plan §6's baseline tags exist to catch — see AC-15.

Orientation. The registry is `packages/platform/src/{types,registry,capabilities,reconcile}.ts`
plus the catalog at `apps/web/src/server/platform/catalog.ts`. The ledger hand-off is
`packages/integrations-netsuite/src/{postExpenseReport,sync,records,recordLink}.ts`, the seam at
`apps/web/src/server/lib/netsuitePosting.ts`, and three workers under
`apps/worker/src/handlers/netsuite-*.ts`. ~7,500 LOC in the NetSuite package alone.

### AC-1 · There is NO adapter contract to port, and the Plan tells us to build one ⚠ NET-NEW

This is the finding that shapes the whole phase, and it inverts the usual instruction. `IntegrationDescriptor` is
pure declarative metadata — every field is a slug, a localized string, a string array or a JSON
schema:

```ts
export interface IntegrationDescriptor {
  slug: string; name: LocalizedText; description: LocalizedText;
  capabilities: Capability[]; affectsEntities?: AffectableEntity[];
  providesModules?: string[]; configSchema?: JsonSchema; configUiSchema?: UiSchema;
  setup?: SetupInstructions;
}
```

No function members, no module path, no `import()` handle. There is no interface, base class or
implementation registry that an integration conforms to. NetSuite is reached from generic code three
ways, all vendor-specific: direct imports of `@expenseos/integrations-netsuite` from four routers and
four workers; a hardcoded `switch (input.slug)` for connection testing whose `default` returns
`No Test Connection implementation for integration '<slug>'`; and five vendor-named job types
(`integration.netsuite.postExpenseReport`, …). Config loading is copy-pasted seven times — the same
`findUnique({ where: { slug: '<literal>' }, ... take: 1 })` in `integrations-netsuite/src/config.ts`,
`googleMaps.ts`, `serpapi.ts`, `notification-dispatch.ts`, `anthropicConfig.ts`, `expenses.ts`,
`virtualCardTransactions.ts`.

None of that is a criticism of ExpenseOS: with exactly one accounting system, a switch is cheaper
than an abstraction. It is a statement about what Phase 3 is. The Plan's risk register asks for the
opposite and says why: *"Adapter contract — define the accounting-adapter contract once (VeloLedger)
so QuickBooks/Xero/Sage are repeatable; avoid per-vendor special cases leaking into core."*
**So VX3-3 designs a contract rather than porting one, and that is the plan speaking, not a
shortcut.** The standing rule is to port from source except where the plan calls for a difference;
here it calls for one in as many words.

### AC-2 · The REGISTRY, unlike the adapter, is worth porting nearly verbatim

Code is the source of truth, the row is a reflection, and the file says so:
*"Specs are code-owned. The DB rows are a persisted reflection used for referential lookups and to
hang the admin-toggled installation state off of — they are never the source of truth for a spec's
shape."* `reconcile.ts` upserts every descriptor by slug at boot, validates cross-references BEFORE
writing anything (there is a test named for it), and re-reads `setup` from code at request time
rather than persisting it.

Two flaws to fix rather than inherit:

1. **Stale rows are never pruned.** `reconcile.ts` has no delete path, so a descriptor removed from
   the catalog leaves a row that still lists in the admin API with its old `configSchema`.
2. **The whole reconcile is wrapped in one try/catch at boot**, and their own test file records the
   blast radius: *"a typo in `requiresIntegrations` does not fail the build, does not fail the boot,
   and does not fail loudly: it silently skips the ENTIRE reconcile, so no module or integration row
   is created or updated, and every module-gated page 404s with nothing in the logs pointing at the
   cause."* This is the third measured "silent gate" incident in this audit (NT-11 holds the other
   two) and the rule is the same: a gate that fails closed must say so.

### AC-3 · Multi-installation keyed by `code`, and the tenant dimension is a comment

`IntegrationInstallation.integrationId` is deliberately non-unique — *"an integration TYPE may have
several labeled installations (e.g. two Google Workspace connections). `code` is the
per-installation unique identifier. Reads that want 'an' installation use `take: 1`."* Every
installation-level procedure keys on `code`, not slug.

Two things a porter must not miss. First, the schema docstring three lines above that comment still
says *"Single-tenant: one installation per Integration (unique)"* — the two contradict each other
and the correct one is the newer inline note. Second, the only mention of tenancy in the entire
ExpenseOS repo is `schema.prisma:1903`: *"A future tenant model adds `tenantId` here only."* So
"per-tenant credentials" in the Plan has no implementation to port at all — `integration_installation`
becomes a tenant table with RLS in VeloExpense, and `code` unique **per organization** rather than
globally.

Then note what that breaks, which they already half-know: `loadNetSuiteConfig` does
`installations: { where: { active: true }, take: 1 }` with **no ordering**, so two active
installations of one type resolve arbitrarily. Nothing detects that state. The port either enforces
one active installation per (org, integration) or makes the choice explicit; picking silently is not
an option once the row is tenant-scoped and a customer can create it.

### AC-4 · Credentials are pgcrypto inside the config blob — and one path writes them in cleartext ⚠ SECURITY

The design is better than it sounds and worth porting. There is no credential table: secret values
live in `IntegrationInstallation.config` (Json), and **which** keys are secret is derived from the
UI schema — `secretFieldNames` returns fields whose `'ui:widget' === 'password'`. Encryption is
Postgres pgcrypto invoked by the app, ciphertext base64-wrapped behind a version marker and written
back into the same column:

```
"Secret-typed config values … are encrypted with Postgres `pgcrypto` (`pgp_sym_encrypt`) under the
 same `PG_CRYPTO_KEY` used for VCC PAN/CVV. The ciphertext is base64-wrapped behind an `enc:v1:`
 marker and stored back inside the existing `IntegrationInstallation.config` Json column — no schema
 change, no new column."
```

Read-path hygiene is good too: the API returns `redactSecrets(...)` plus a `secretsSet` name list,
blanks round-trip as "unchanged", and the audit row records `{ slug, code }` with an explicit
`// never log the config blob`.

**The gap is the marker.** Decryption is marker-driven and tolerant by design — *"any top-level
string value beginning with `enc:v1:` is decrypted; everything else (including legacy plaintext
written before this change, or before the backfill ran) passes through untouched."* Tolerance plus a
second writer is the defect: `apps/web/src/server/platform/bootstrap.ts` writes
`clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? ''` straight into `config` and **never calls
`encryptSecretFields`** (the symbol does not appear in the file — verified). So an env-bootstrapped
installation stores a password-marked secret in cleartext and the reader accepts it without a
murmur. Port the encryption; do not port the tolerance. In VeloExpense a secret-marked field that
arrives without the marker should be refused at the write, not silently stored — a tenant's
accounting credentials are not a place for a compatibility shim we have no legacy rows to need.

### AC-5 · `capabilities` is declared, validated, persisted, and consulted by nothing

`CAPABILITIES` is a closed union — `AUTH_PROVIDER, USER_DIRECTORY, GL_CODING, VCC_ISSUER,
RECEIPT_OCR, EXPENSE_SYNC, AI_ASSISTANT` — asserted at boot and stored in `Integration.capabilities`.
Grepping the app for any of those strings outside the catalog and `packages/platform` returns
**zero** hits. `integrationsWithCapability` and `integrationsAffecting` have no callers; so do
`createRegistry`, `isIntegrationActive` and `activeIntegrationSlugs` — all dead. The admin list
endpoint drops the field entirely. The file's own comment that *"the auth framework keys off
AUTH_PROVIDER specifically"* is stale.

Real gating is by module slug, and the `netsuite-gl` module hardcodes the vendor
(`requiresIntegrations: ['netsuite']`) rather than the capability it declares. **This is the exact
shape of the trap NT-4 recorded**: a taxonomy that reads as an identity from outside and is decided
by something else in fact. Either the port resolves the accounting adapter BY capability — which is
what makes "QuickBooks in a second tenant" work without a switch — or it does not ship the field.
Declaring it and ignoring it is how VX2-7's `EVENT_KEY_MAP` collision guard would have been if
nobody had built the ladder.

### AC-6 · Posting is triggered by APPROVAL — from four call sites, and one transition has no hook at all

RB-6 recorded the rule; here is the whole surface. `postApprovedReport` is enqueued from:

1. `decide` — the terminal approval decision. The comment is the one RB-6 quotes: *"An approved
   report is a liability, so NetSuite gets it now rather than when somebody remembers (rule 7)."*
2. `decideBulk` — the same call.
3. **`submit`**, for a report that auto-approves on submission: *"A report that approved on SUBMIT —
   no matching workflow, or one that resolved immediately — reaches APPROVED without any approval
   decision ever being recorded, so the post-on-approve hook in expenseApprovals never fires. It was
   silently never sent to NetSuite."* Past tense: this was a bug they fixed.
4. A manual admin push from the posting dry-run.

And a fifth path that is not a hook but a net: a cron sweep every 30 minutes across the business day
picks up APPROVED reports with no settled sync row. Its header names the hole it covers —
*"an approval TTL expired with onExpire=APPROVE, which drives the report terminal from the worker's
sweep — a path with no post-on-approve hook at all."*

**The lesson for VeloExpense is structural, not a port detail.** Four call sites and a sweep exist
because the trigger is attached to *callers* rather than to the transition. VeloExpense already has
one place where every terminal transition is written — `lib/expenses/lifecycle.ts`, behind
`assertDraft()` and the atomic claim — and VX2-6's `withAudit` already serializes an audit row with
the business change in one transaction. The hand-off belongs there, beside the audit append, where
it cannot be forgotten by a new caller. Note that VeloExpense has no TTL at all (HANDOFF §5), so
path 5's forcing case does not exist here yet; when a TTL lands it must go through the same seam.

### AC-7 · The post is fire-and-forget with one attempt, and a cron sweep is the retry

`postApprovedReport` returns `void` and wraps its body in `void (async () => { ... })().catch(log)`.
It runs after the audited transaction has committed, and the reasoning is sound:

```
 * Fire-and-forget on purpose. An enqueue that fails is logged and dropped rather than surfaced —
 * the approval already happened and is not in doubt … Failing the approval over a Redis hiccup
 * would be the worse trade.
```

It re-reads status rather than trusting the decision (*"an intermediate approval on a multi-tier
workflow is not a terminal outcome"*) and skips `SYNCED | DENIED | RECONCILED`. The job is enqueued
with `attempts: 1`: *"a BullMQ retry storm against an accounting system is not a recovery
strategy."* Retry is therefore the sweep, capped at `MAX_SWEEP_ATTEMPTS = 5` — sized against a
measured incident, *"three reports at 46 attempts each — 138 guaranteed-to-fail posts"* — and past
the budget there is no dead state, only a log line: `GIVING UP on … needs a human re-push`.

**VeloExpense should not build any of that machinery, because it already has it.** VX2-8's
`notification_delivery` is a Postgres outbox with `attempts`, `next_attempt_at` backoff,
`claimed_at`/`claimed_by` as a visibility timeout, a `DEAD` state and an admin queue — chosen over
Redis for exactly the reason quoted above. An enqueue that is a row in the same transaction as the
approval cannot be lost by a Redis hiccup, which removes the need for the fire-and-forget trade AND
the sweep that compensates for it. That is the single largest simplification Phase 3 gets for free,
and it is only available because VX2-8 diverged.

### AC-8 · The "posted but not recorded" row is automatically re-posted, and the only guard is unverified ⚠ REAL DEFECT

The two-phase structure is right and the comment states the invariant exactly:

```
  // Phase 2 — persist. The record now EXISTS in NetSuite, so a failure here must
  // NOT leave a re-postable FAILED row: a retry would hit NetSuite's
  // externalId-uniqueness guard and wedge.
```

Then the catch on that phase calls `fail(...)`, which upserts
`status: 'FAILED', lastError: <"…do NOT re-post: …">, attempts: { increment: 1 }` — a re-postable
FAILED row, the one thing the comment forbids. The sweep selects
`status: { notIn: ['SYNCED','DENIED','RECONCILED'] }, attempts: { lt: 5 }`, so that row qualifies and
is re-posted automatically, up to five times, with the words "do NOT re-post" sitting in its
`lastError` column. **The instruction is addressed to a human and enforced against nobody.**

What stands between that and a duplicate liability in the ledger is NetSuite rejecting a second
record with the same `externalId` — and the transport carrying that claim is marked, in its own
header, *"⚠️ The field ids below follow the documented REST Record schema but are UNVERIFIED against
a live account."* So the guard is an assumption about a third party, asserted by no test, protecting
the one transition where a duplicate means money booked twice.

This is the fourth-and-a-half appearance of RB-2's shape: a status read outside the write, and a
write that does not re-assert it. The answer is the same one this codebase has used five times —
a conditional write. `UPDATE integration_post SET status='POSTED' WHERE id=$1 AND status='CLAIMED'`
with a `rowCount !== 1` check, and a state that means *posted upstream, not recorded locally* which
no automatic path may leave. Not "do not re-post" in a string.

### AC-9 · There is NO chart-of-accounts template — and the vendor-neutral account table was DELETED ⚠ blocking

The Plan puts *"selectable starter chart-of-accounts templates (global templates → per-tenant
instances)"* in Phase 1 and the Differences Chart lists it as a required dimension. HANDOFF §6
already records that VeloExpense never built it. What this audit adds is that **it cannot be
ported, because ExpenseOS deleted the only table it could have come from**:

```sql
-- Remove the ExpenseOS `Account` lookup. Its only functional consumer was
-- VirtualCard.ccAccount, which now points at NetSuiteAccount …
DROP TABLE IF EXISTS "AccountExternalId";
DROP TABLE IF EXISTS "Account";
```

After that migration there is no vendor-neutral account model in ExpenseOS at all. Accounts exist
only as `NetSuiteAccount`, a cache filled by a twice-daily SOAP pull; a grep for chart-of-account
templates across `packages`, `apps` and `docs` finds prose only; there is no accounts seed file and
no manual account-entry screen. The seed creates exactly two rows, non-prod, with a fictional id and
a comment saying so, purely so the tax accounts resolve. Their own seed comment describes the
resting state honestly: a category's GL account is *"null when NetSuite has never synced, which is
the normal state of a fresh environment."*

So an ExpenseOS install with no accounting connection has an empty chart of accounts and every
category unmapped — a state that is fine for one company that certainly has NetSuite, and not fine
for a product where a tenant signs up on a Tuesday and connects a ledger on Friday. **VX3-1 is
therefore design, not port**, and it is the first ticket of the phase because three things wait on
it: the adapter's "pull chart of accounts", Module 12's `GL_MAPPING_GAP`, and Phase 4's Budgets —
where `Budget.glAccountId` is a **required** FK to `NetSuiteAccount`, so as the schema stands a
tenant cannot create a single budget row without a synced NetSuite chart.

### AC-10 · The line SNAPSHOTS its GL account on write — port this verbatim, including the reason

```
/// The GL account this line posts to, SNAPSHOTTED from its category when the line is
/// written — not read through the category at report time.
```

One helper does all the stamping and names its four call sites — the tRPC create, the tRPC update,
the worker's extraction prefill, the worker's determination rebuild — and states the rule: *"The
stamp is a SNAPSHOT, not a cache… stamp on write, and never refresh."* Posting resolves the line's
own account first and the category only as a fallback, so *"the report posts to the account the line
was coded to when it was filed, not to wherever its category points today."*

It also refuses an account that is inactive upstream, and — the part worth keeping — a category with
no account is a *problem collected for the approver*, not an error thrown at the employee:
*"Nullable, and a null blocks nothing: a category with no account is a configuration gap, and the
employee filing the expense is not who fixes it."* That is the same instinct as VX1-8's submit gate
and AP-13's ordering. Port the nullable column, the stamp-on-write, the resolution order, the
inactive refusal and the sentence.

### AC-11 · Payment is a one-directional POLL, and it is the only writer of `REIMBURSED` — DIVERGES from VX2-9 ⚠ decision

`postExpenseReport` never writes `ExpenseReport.status`. The only status write in the entire NetSuite
loop is the payment poller, which runs hourly across the business day, reads `payStatus` back from
NetSuite and sets `REIMBURSED` inside `withAudit` with a system actor. It is deliberately
one-directional: *"A report NetSuite reports as still owing is left alone rather than 'corrected'
back to APPROVED."* The report is posted `UNPAID` because *"ExpenseOS approving a claim authorises
it; it does not pay it."*

**VX2-9 built the opposite**: `reimburseReport` is a human action on an admin screen, refuses
self-payment, records actor, date and an optional reference, and says on the screen in those words
that pressing it does not pay anybody. Both designs are coherent and they cannot both be the
authority. The fork is a real decision for whoever picks up the adapter ticket:

- **Poller drives `REIMBURSED`** — the ledger is the source of truth for "paid", which it arguably
  is, and the AP screen becomes redundant for connected tenants. But `reimbursed_by_id` is `NOT
  NULL`-paired with `reimbursed_at` by a CHECK constraint (`0013`), so a system actor needs a
  representation, and VX2-9's self-payment control has nothing to bite on.
- **Human action stays authoritative, poll is advisory** — the poller records `payStatus` and
  surfaces a discrepancy, and a person still marks it paid. Keeps VX2-9's controls; means a
  connected tenant does the same work twice.

Not resolved here on purpose. It is a controls question, not a schema one, and it belongs to the
ticket rather than to a planning pass.

### AC-12 · The reference caches are install-global singletons — the port cannot host two ledgers as they stand

Seven cache tables — `NetSuiteBusinessUnit`, `NetSuiteSubsidiary`, `NetSuiteDepartment`,
`NetSuiteClass`, `NetSuiteLocation`, `NetSuiteAccount`, `NetSuiteGlVendor` — each keyed
`netsuiteId @unique`, none carrying a tenant or installation column. Soft-deleted via
`isActive = false` *"so historical mappings keep resolving"*, which is the right instinct and should
be ported. The pull is SOAP, twice daily by cron (`0 4,16 * * *`, a locked decision in their comment)
plus manual, with runs tracked on `NetSuiteSyncRun`: states `RUNNING | COMPLETED | ERROR | DISABLED
| CANCELLED`, cooperative cancel, `updatedAt` as a heartbeat, and a ten-minute stale-run reclaim
whose comment is the reason it exists — *"one dead run wedges every future sync forever with
'already running' — which once froze the reference cache for ~3 weeks."*

`@@unique(netsuiteId)` is the thing that has to go: in VeloExpense the natural key is
`(organization_id, installation_id, external_id)`. Note the sync module already draws the line the
port needs: *"The caches are a RECONCILIATION layer, not the correlation source — dimension
resolution at post time goes through ExpenseOS entities' externalIds."*

### AC-13 · The `netsuite-gl` gate exists and is bypassed in four places — the list to design against

The Plan asks to *"generalize/gate NetSuite-specific fields so non-NetSuite tenants never see
them."* ExpenseOS does have the gate — a `netsuite-gl` module, deliberately not default-on, checked
by `isModuleActive` — and the VCC pages and the employee directory use it correctly. Where it leaks,
which is the useful part:

- **`Budget.glAccountId` is a REQUIRED FK to `NetSuiteAccount`** with `onDelete: Restrict`, and the
  Budgets page is not behind the gate. Module 10 cannot store a row without a NetSuite chart.
- **`pickers.glAccounts` / `pickers.vendors` query the NetSuite tables from a plain
  `protectedProcedure`** — no module gate, no permission gate, on the grounds that this is
  *"non-sensitive reference data"*. On a tenant with no NetSuite they return empty lists rather than
  being absent, which is the worst of the three options.
- **Three generic admin screens render a GL-account field** sourced from the NetSuite cache —
  expense categories, mileage rates, travel categories — none consulting the gate.
- **The expense workbench shows a NetSuite posting badge and push button** on every APPROVED report
  to anyone holding `netsuite.sync.push`, gated only in the mutation.
- **`ExpenseAllocation.classId` → `NetSuiteClass`** is the third cost dimension on a core table, and
  the *only* class taxonomy in the product, while `BusinessUnit` and `Department` are native models.
  Analytics carries a special case for it because *"NetSuiteClass carries a plain `name`, not a
  localized label."*
- Also: `User.nsClassId` on the core user table, four NetSuite default-coding columns on
  `VirtualCard` and `VirtualCardRequest`, five NetSuite enums re-exported from the shared `db`
  package, a `netsuite:` permission block granted wholesale to the admin system role, eleven
  `integration.netsuite.*` audit actions in the shared action registry, and NetSuite named in shared
  i18n copy on business-unit, job-level and fiscal-year admin screens.

VeloExpense has none of this today, so the ticket is preventive rather than remedial: a **generic
per-tenant dimension set** (the vendor-neutral shape behind class/location/subsidiary) plus the rule
that a vendor name may not appear in a core table, a shared enum, a permission slug or an audit
action. `LegalEntity` → `LegalEntityExternalId` is the pattern that already does this correctly on
their side, and their own posting module documents the split; copy that, not the columns.

For the record, `eblock` / `edealer` are tenant identity rather than NetSuite modelling and appear
only in seed data, comments and tests — no application code branches on them. The Differences Chart
lists them under data/seed, and that is where they stay.

### AC-14 · `GL_MAPPING_GAP` checks the CATEGORY, not the line — and not whether the account still exists

The control counts line items in the period whose **category** has a null `glAccountId`, grouped per
category and ranked by spend, at severity `INFO`. Two blind spots, both of which matter once the
snapshot of AC-10 exists: it does not look at `ExpenseLineItem.glAccountId`, so a line with an
unstamped snapshot whose category IS mapped is invisible to it; and it does not check `isActive`, so
an account that was deactivated upstream passes the control and then fails at post time with
`GL account "X" … is inactive`. Its predecessor table, `GlMapping`, was dropped with a migration
comment worth reading twice: *"it has also never had a writer in this codebase — nothing has ever
inserted a row, so it can only ever have been empty, and the one reader (the GL_MAPPING_GAP control)
treated an absent row as 'unmapped', which is what it always was."* A control reading a table nobody
writes is the fraud-module cousin of NT-5's test asserting on copy it never reached.

### AC-15 · The spec source has moved, and there are still zero baseline tags ⚠ John action

The Plan and the Chart were written against ExpenseOS `fb1cead`. `~/ExpenseOS` is now at
`5a11a647`, and the accounting surface is demonstrably among what changed — `NetSuiteAccount`
created, dropped, recreated and renamed; `GlMapping` dropped; the generic `Account` dropped; the
card clearing account re-pointed. Plan §6 asks for `git tag veloexpense-spec/<module>-YYYYMMDD
<sha>` per ported module so that catching later changes is *"a mechanical re-diff, not a memory
exercise"*, and HANDOFF §6 has recorded since 2026-08-27 that `git tag -l` returns nothing.

Phase 2 could arguably live without them. Phase 3 cannot: the accounting module is the one place
where the Plan's own sync strategy flags the source as unstable — *"still-in-flux items last
(webhooks/GL-recon, analytics scheduled-exports/KPI…)"* — and this section's line numbers are
already a perishable good. **Tag `accounting` at `5a11a647` before VX3-3 starts**, or the first
question of the first adapter ticket is "which version of their code was this read at", and the
honest answer will be a guess.

## tenancy · foreign keys do not respect RLS (found 2026-08-29 building VX3-1)

Not a port finding — this one is about VeloExpense's own schema, which is why it has its own prefix.
Found by testing migration `0014`'s new constraints against a real Postgres 16 rather than reading
them, and then checking whether the property was specific to the new table. It is not.

### TN-1 · A tenant can point a foreign key at another tenant's row ⚠ needs a ticket

Postgres performs referential-integrity checks as the constraint's owner **with row-level security
bypassed**. So a plain `REFERENCES <tenant table>(id)` does not scope anything to a tenant:

```
-- as veloapp, app.current_org = tenant 1
INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
VALUES ('<tenant-1>', '<tenant-2 app_user id>', 'X', 'CAD');
-- -> ALLOWED
```

That is a pre-existing FK on a shipped table, not one of `0014`'s.

**What it is not.** There is no disclosure. Reading back through the reference returns nothing —
both an inner and an outer join were checked, and RLS still filters the target row. A tenant cannot
learn anything about the row it just referenced.

**What it is.** An integrity hole and a missing backstop, and the shape it leaves behind is nastier
than it first sounds:

```
gl_account_id set: true, resolvable: false
```

A category that looks mapped and joins to nothing. Note what that does to the control AC-14
describes, which counts categories where `glAccountId IS NULL`: this row is NOT null, so a
cross-tenant reference reads as *correctly mapped* to the very check meant to find unmapped ones.

It also contradicts a stated house rule. HANDOFF §1 says tenancy is RLS, and NT-1 leans on exactly
that — `Activity.subjectId` is a polymorphic uuid with no FK at all, and the entry says "RLS is the
only guard". RLS guards READS. It does not guard FK targets. Both statements need the qualifier.

**Exposure: 45 tenant-to-tenant foreign keys across ~20 tables** (query below reproduces the list).
Every one of them accepts a cross-tenant id today.

```sql
WITH tenant AS (
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped))
SELECT src.relname || '.' || a.attname || ' -> ' || tgt.relname
FROM pg_constraint k
JOIN tenant src ON src.oid = k.conrelid
JOIN tenant tgt ON tgt.oid = k.confrelid
JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
WHERE k.contype = 'f' ORDER BY 1;
```

**The fix is structural, not a trigger.** A composite foreign key through `organization_id`:

```sql
ALTER TABLE app_user ADD CONSTRAINT app_user_org_id_uniq UNIQUE (organization_id, id);
ALTER TABLE expense_report ADD CONSTRAINT expense_report_submitter_fkey
  FOREIGN KEY (organization_id, submitter_id) REFERENCES app_user (organization_id, id);
```

Verified: the cross-tenant insert above is refused, a same-tenant insert is unaffected, and it holds
with no trigger and no cooperation from RLS — the constraint cannot be bypassed by a permissive
policy or a superuser connection, which is more than RLS itself can say. Two details worth carrying
into the ticket:

- **`ON DELETE SET NULL` must name its column** — `ON DELETE SET NULL (gl_account_id)`. The
  unqualified form nulls EVERY referencing column, `organization_id` included, which is `NOT NULL`,
  so the delete fails instead of clearing the mapping. Postgres 15+ syntax; this project is on 16.
- **MATCH SIMPLE is what we want**: with a NULL in any referencing column the constraint is skipped,
  so a nullable FK stays nullable.

`0014` adopts the pattern for the two FKs it introduces, plus `gl_account.parent_id`. **The other 43
are their own ticket** — it is one migration touching almost every table in the schema, it needs an
isolation test per FK, and it wants a CI guard so a new tenant-to-tenant FK cannot be added in the
weak form. Folding a schema-wide security change into a chart-of-accounts PR is how it would go
unreviewed.

## Not yet audited

`expense-reports` (`packages/expense-lines`, `packages/money` — **do `money` first**, it is where
arithmetic edge cases hide and the likeliest home of the CAD defect), `receipts`
(`packages/storage`, `packages/receipt-extraction`), `employees-org` (`packages/rbac`),
the rest of `packages/approvals` (`engine.ts`, `engine-core.ts`, `graph.ts`, `schema.ts`,
`schema.approverFallback.test.ts` — the two test files this section was blocked on are now read),
and the rest of `packages/money` (`money.ts`, `currencies.ts`, `dinero.ts`, `format.ts`).
Also still unread inside `notifications`, and named in the NT section's header: `subjectLinks.ts`, `commentThreads.ts`, `replyThreads.ts`, `actionTokens.ts`, `email.ts`, `slack.ts`, the digest job, and `NotificationPreferences.tsx` — the last of which is a VX2-7 input, not a VX2-8 one, and should be read before the preferences screen is built.

**Still needed from outside Drive:** `git diff origin/main...origin/fix/self-approval-guard`. It is
the last unread input to VX2-2 — `SELF_APPROVAL` is declared in `routing.ts` with nothing behind it,
and AP-6's rule 2 says their self-block was *incomplete*, so the fix branch may well be where the
subordinate case got closed.
