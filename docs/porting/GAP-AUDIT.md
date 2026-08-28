# Gap audit — VeloExpense vs ExpenseOS source

Findings from reading ExpenseOS **source** against shipped VeloExpense code. Separate from
`SPEC-BASELINES.md`, which is the mechanism; this is the findings log.

Each entry is: what ExpenseOS does, what we do, whether it is a live defect / a latent gap / a
deliberate divergence, and what to do. **Nothing here is a bug report until the "status" says so** —
several checks came back with VeloExpense ahead, and those are recorded too so a later "faithful
port" does not regress us.

---

## policy-engine (VX1-7, VX1-8) — PARTIAL, ~15% read

Source read: `packages/predicate/src/engine.ts` (11.4 KB). **Not yet read:** `builtinKinds.ts`
(28 KB), `kinds.ts` (20.8 KB), `validate.ts` (18.6 KB), `facts.ts`, `paramsSpec.ts`,
`messageKeys.ts`. The rule engine lives in `packages/predicate` — there is no `packages/policy`.

### PE-1 · Policy thresholds have no currency — LATENT GAP, worth a ticket

**ExpenseOS:** line amounts are converted to a policy currency (`SystemFlag policyCurrency`,
default **CAD**) via the latest `FxRate` row before being compared against a limit. When no rate
exists the limit rule **degrades to `INFO` severity with a `fxRateMissing` payload** — the header
comment is explicit: *"never silently skip, never crash."*

**VeloExpense:** `expense_policy` has **no currency column**. `params.thresholdMinor` is a bare
bigint compared directly against line amounts. The only currency reference anywhere in the policy
layer is `formatMinor(amount, context.report.currency_code, …)` in `rules.ts` — that is *message
formatting*, not comparison.

**Why it is latent rather than live:** VX1-6 made the MVP single-currency by cascading a report's
currency to its expenses. But nothing constrains a *tenant* to one currency — report A can be USD
and report B JPY, and one `thresholdMinor` is compared numerically against both. The admin page
also hard-codes 2 decimals (`parseAmountToMinor(raw, 2)`) with the comment "every currency
VeloExpense ships has minor_unit 2", which is an assumption, not an enforcement.

**Do:** a ticket to add a policy currency (tenant-level default, per-rule override) plus
ExpenseOS's degrade-to-INFO behavior when a rate is missing. **Blocks nothing today; must land
before multi-currency, and certainly before Phase 3 posts to an accounting system.** This is also
the same family as the GA audit's *CAD-exclusion-from-totals* P0/P1 — see the note below.

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

## Note on the GA audit's P0/P1s

The ExpenseOS GA-readiness audit (2026-08-27) found live P0/P1 defects including a **date picker**
issue, **CAD excluded from report totals**, and wrong **approval defaults**. Those specifics have
not been read yet — only their titles were relayed. PE-1 above is the mechanism most likely behind
the CAD one (a CAD-defaulted policy currency in a US entity, with limits silently degrading when no
FX rate exists), **but that is inference, not the finding.** Read the GA report before treating them
as the same thing.

---

## Not yet audited

`expense-reports` (`packages/expense-lines`, `packages/money` — **do `money` first**, it is where
arithmetic edge cases hide and the likeliest home of the CAD defect), `receipts`
(`packages/storage`, `packages/receipt-extraction`), `employees-org` (`packages/rbac`),
`approvals` (`packages/approvals` — the graph engine, required reading before VX2-2).
