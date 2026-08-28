# Gap audit — VeloExpense vs ExpenseOS source

Findings from reading ExpenseOS **source** against shipped VeloExpense code. Separate from
`SPEC-BASELINES.md`, which is the mechanism; this is the findings log.

Each entry is: what ExpenseOS does, what we do, whether it is a live defect / a latent gap / a
deliberate divergence, and what to do. **Nothing here is a bug report until the "status" says so** —
several checks came back with VeloExpense ahead, and those are recorded too so a later "faithful
port" does not regress us.

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

## approvals (VX2-1 shipped; VX2-2 next) — `packages/approvals/src` — PARTIAL, ~30% read

Source read: `delegation.test.ts` (5.0 KB) — the `resolveAssignment` contract;
`noManagerFallback.db.test.ts` (27 KB) — the no-eligible-approver behaviour, which *is* VX2-2's
acceptance criteria; `expire.test.ts` (1.4 KB) — the expiry-outcome policy table.
**Not yet read:** `engine.ts` (62.5 KB), `engine-core.ts` (14.8 KB), `graph.ts` (5.9 KB),
`schema.ts` (11 KB), `schema.approverFallback.test.ts`.

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

### AP-7 · `approval_task_assignee_present` forbids the shape the `role` fallback needs

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

---

## The GA audit's P0/P1s — one now traced to source

ExpenseOS `origin` carries fix branches whose names map onto the GA audit findings:
`fix/fx-reciprocal-rates`, `fix/self-approval-guard`, `fix/date-input-clickable`,
`fix/bound-money-inputs`, `fix/refuse-zero-total-submit`, `fix/netsuite-preflight-dimensions`.

- **CAD-exclusion-from-totals → traced.** See PE-7. Mechanism confirmed by reading
  `validate.ts` + `facts.ts` on the version Drive holds. The *fix* diff has not been read, so port
  the fix rather than assuming PE-7's remedy matches theirs.
- **approval defaults → `fix/self-approval-guard`, NOT read.** Bears directly on VX2-2's resolver
  and VX2-1's `DEFAULT_LADDER`. Self-approval refusal is already in
  `lib/approvals/routing.ts`'s error codes as `SELF_APPROVAL`, but nothing implements it yet.
  **Read this branch before VX2-2.**
- **date picker → `fix/date-input-clickable`, NOT read.** UI; bears on VX2-4 at most.

Two of these are already dodged in VeloExpense — see PE-5 and the "already ahead" list in
`SPEC-BASELINES.md`: `fix/bound-money-inputs` (our `parseAmountToMinor` rejects extra decimals) and
`fix/refuse-zero-total-submit` (VX1-8 refuses an empty report).

## Not yet audited

`expense-reports` (`packages/expense-lines`, `packages/money` — **do `money` first**, it is where
arithmetic edge cases hide and the likeliest home of the CAD defect), `receipts`
(`packages/storage`, `packages/receipt-extraction`), `employees-org` (`packages/rbac`),
the rest of `packages/approvals` (`engine.ts`, `engine-core.ts`, `graph.ts`, `schema.ts`,
`schema.approverFallback.test.ts` — the two test files this section was blocked on are now read),
and the rest of `packages/money` (`money.ts`, `currencies.ts`, `dinero.ts`, `format.ts`).

**Still needed from outside Drive:** `git diff origin/main...origin/fix/self-approval-guard`. It is
the last unread input to VX2-2 — `SELF_APPROVAL` is declared in `routing.ts` with nothing behind it,
and AP-6's rule 2 says their self-block was *incomplete*, so the fix branch may well be where the
subordinate case got closed.
