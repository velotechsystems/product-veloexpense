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
`approvals` (`packages/approvals` — the graph engine, required reading before VX2-2), and the rest
of `packages/money` (`money.ts`, `currencies.ts`, `dinero.ts`, `format.ts`).
