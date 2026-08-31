# ExpenseOS spec baselines

VeloExpense re-implements ExpenseOS behavior; it does not merge ExpenseOS code. The Port & Build
Plan §6 makes that survivable with two mechanisms, and this file is the index for both:

1. **A baseline tag per module**, in the **ExpenseOS** repo (`github.com/carmigo/ExpenseOS`),
   naming the commit that module was ported from.
2. **A delta re-diff**, so catching later ExpenseOS changes is mechanical:

   ```bash
   # from an ExpenseOS checkout
   git fetch origin
   git diff veloexpense-spec/<module>-<stamp>..origin/main -- <that module's paths>
   ```

   Fold in what changed, then move the tag forward. In the plan's words, this "turns *did we miss
   a change?* into a mechanical re-diff, not a memory exercise."

The tags live in a **different repository** from this one, which is exactly why this file exists:
without an index inside `product-veloexpense`, the mapping is invisible from where the work
happens. Create the tags with `./tag-spec-baselines.sh`, run from an ExpenseOS checkout, and paste
its output table below.

## Read this before trusting a delta diff

**Everything through VX2-1 was ported from the module DOCS (`NN-module.md`), not from ExpenseOS
source.** That was a mistake — it cost VX2-1 a full rewrite (PR #22 shipped a schema VeloLedger had
already deprecated; PR #23 replaced it) and it is the reason these baselines are being backfilled
rather than recorded as each ticket landed.

The consequence for anyone running a delta diff: the output will contain **two different kinds of
change mixed together** —

- genuine ExpenseOS commits since the baseline (what the mechanism is for), and
- behavior that was **never ported in the first place**, because it was in the source and not in the
  summary.

So a large diff on `expense-reports` or `policy-engine` is not evidence that ExpenseOS moved fast.
Treat the first re-sync of each module as a gap audit, not a catch-up. Modules tagged for tickets
that have not started yet (`audit`, `notifications`) are clean baselines and carry no such caveat.

## Why one shared baseline, and why it is deliberately early

A per-module sha cannot be reconstructed after the fact. `fb1cead` is the commit the Port & Build
Plan names as the basis of its ExpenseOS functionality audit (2026-08-22); Phase 1 was built
2026-08-24..26, against module docs claiming "verified against code 2026-08-14". So `fb1cead` sits
at or before every port so far.

That direction of error is the safe one. An **early** baseline makes the delta diff show some
changes that were already incorporated — noise, and cheap to dismiss. A **late** baseline hides
changes that were never ported — a silent gap, and expensive. From here each module's tag moves
forward independently as it is re-synced, so the shared baseline is a starting point only.

## Baselines

Fill this in from `tag-spec-baselines.sh` output — it resolves real ExpenseOS paths from
`git ls-files`, so the paths recorded here come from the repo rather than from a guess.

> **The script was BROKEN and is fixed (2026-08-31).** Its own sanity check was
> `git ls-files | grep -qE '/(expenses|policies)\.ts$'` under `set -o pipefail`: `grep -q` exits
> on the first match, `git ls-files` takes SIGPIPE and dies with 141, `pipefail` fails the
> pipeline, and the script aborted with *"this does not look like the ExpenseOS repo"* **while
> standing in it**. Measured 8 failures out of 8. It is a race, so it can also pass — which is how
> it went unnoticed, and worse than failing every time. Now done in pure shell with no pipe, and
> the file list is read once instead of once per module.

| Module | Ported by | Baseline tag (`fb1cead9`, 2026-08-21) | ExpenseOS paths |
| --- | --- | --- | --- |
| `reference-data` | VX1-1 (PR #10) | `veloexpense-spec/reference-data-20260827` | `apps/web/src/server/routers/businessUnits.ts`<br>`apps/web/src/server/routers/departments.ts`<br>`apps/web/src/server/routers/expenseCategories.ts`<br>`apps/web/src/server/routers/legalEntities.ts` |
| `employees-org` | VX1-2 (PR #13) | `veloexpense-spec/employees-org-20260827` | `apps/web/src/server/routers/adminLookup.ts`<br>`apps/web/src/server/routers/roles.ts`<br>`apps/web/src/server/routers/users.ts` |
| `expense-reports` | VX1-3 (#11), VX1-4 (#12), VX1-8 (#18) | `veloexpense-spec/expense-reports-20260827` | `apps/web/src/server/routers/expenses.ts` |
| `receipts` | VX1-5 (#14), VX1-6 (#15), VX1-10 (#20) | `veloexpense-spec/receipts-20260827` | `apps/web/src/server/routers/expenses.ts` |
| `policy-engine` | VX1-7 (PR #17) | `veloexpense-spec/policy-engine-20260827` | `apps/web/src/server/routers/policies.ts` |
| `approvals` | VX2-1 (PR #22, #23) | `veloexpense-spec/approvals-20260827` | `apps/web/src/server/routers/approvalWorkflows.ts`<br>`apps/web/src/server/routers/delegations.ts`<br>`apps/web/src/server/routers/expenseApprovals.ts` |

Tagged and pushed 2026-08-27 from the `~/ExpenseOS` clone. ExpenseOS is a monorepo: the tRPC
routers live under `apps/web/src/server/routers/`, and shared logic lives in `packages/*`
(`@expenseos/audit`, `@expenseos/rbac`, `@expenseos/db`, …).

### `accounting` — its own baseline, at its own commit (2026-08-31)

Separate table, because the six above share `fb1cead9` and this one does not. Phase 3 read the
accounting surface directly and recently, so it gets the sha it was actually read at rather than
the deliberately-early shared one.

| Module | Ported by | Baseline tag (`5a11a647`, 2026-08-28) | ExpenseOS paths |
| --- | --- | --- | --- |
| `accounting` | VX3-1..VX3-8 (PR #50–#55, #61, #62) | `veloexpense-spec/accounting-20260831` | `apps/web/src/server/routers/netsuiteSync.ts`<br>`packages/integrations-netsuite/src/postCardTransaction.ts`<br>`packages/integrations-netsuite/src/postExpenseReport.ts`<br>`packages/integrations-netsuite/src/recordLink.ts` |

**Tagged and pushed 2026-08-31** as `johnrim-lab` — annotated, at `5a11a647`, verified in the
clone and accepted by `carmigo/ExpenseOS`.

`5a11a647` was HEAD for the whole of 2026-08-29 → 08-31, the window in which the Phase-3 planning
pass and VX3-1..VX3-8 read this surface, so one baseline covers all eight tickets. The stamp is the
TAGGING date, matching the convention the six above set.

**How much the accounting surface had already moved**, measured across the two baselines over the
paths in the re-sync command below:

```
git diff --stat fb1cead..veloexpense-spec/accounting-20260831 -- \
  apps/web/src/server/routers/netsuiteSync.ts \
  packages/integrations-netsuite/src packages/db/prisma/schema.prisma
→ 15 files changed, 2683 insertions(+), 131 deletions(-)
```

That is the gap a shared `fb1cead` baseline would have hidden for this module, and the reason it
gets its own. The same command against `origin/main` is currently EMPTY, which is the correct
answer — the tag is at `origin/main`.

The table lists only the four unambiguous basenames the script could resolve — `index.ts` matches
37 files in this monorepo and `config.ts`/`records.ts` two each. The re-sync command below covers
`packages/integrations-netsuite/src` wholesale, which is where the rest of it lives.

**Also read but deliberately NOT in the tag:** `apps/web/src/server/routers/budgets.ts`. AC-9 reads
it to establish that `Budget.glAccountId` is a REQUIRED foreign key to the NetSuite account cache —
a fact that constrains Phase 4 — but budgets themselves are not ported, and tagging a file we have
not ported from would overstate what the baseline means.

### Full diff paths per module

ExpenseOS is a pnpm-style monorepo: `apps/web/src/server/routers/*.ts` is the API surface, the
behavior lives in `packages/*/src`, and the schema is `packages/db/prisma/schema.prisma`. A router
diff alone misses the logic, so each module's re-sync command below covers its routers **and** its
packages **and** the schema. Brace expansion is the shell's, not git's — paste these into zsh/bash
as written.

```bash
# reference-data
git diff veloexpense-spec/reference-data-20260827..origin/main -- \
  apps/web/src/server/routers/{businessUnits,departments,expenseCategories,legalEntities}.ts \
  packages/db/prisma/schema.prisma

# employees-org      (packages/rbac = the permission registry + role builder)
git diff veloexpense-spec/employees-org-20260827..origin/main -- \
  apps/web/src/server/routers/{users,roles,adminLookup}.ts \
  packages/rbac/src packages/db/prisma/schema.prisma

# expense-reports    (money + expense-lines are where the arithmetic lives)
git diff veloexpense-spec/expense-reports-20260827..origin/main -- \
  apps/web/src/server/routers/expenses.ts \
  packages/expense-lines/src packages/money/src packages/db/prisma/schema.prisma

# receipts           (storage = presigned upload; receipt-extraction = OCR, not ported)
git diff veloexpense-spec/receipts-20260827..origin/main -- \
  apps/web/src/server/routers/expenses.ts \
  packages/storage/src packages/receipt-extraction/src packages/db/prisma/schema.prisma

# policy-engine      (predicate = the matchCondition DSL VX1-7 deliberately trimmed)
git diff veloexpense-spec/policy-engine-20260827..origin/main -- \
  apps/web/src/server/routers/policies.ts \
  packages/predicate/src packages/db/prisma/schema.prisma

# approvals          (packages/approvals = the ~5,400-LOC graph engine)
git diff veloexpense-spec/approvals-20260827..origin/main -- \
  apps/web/src/server/routers/{expenseApprovals,approvalWorkflows,delegations}.ts \
  packages/approvals/src packages/db/prisma/schema.prisma
```

```bash
# accounting        (the adapter surface Phase 3 was designed against)
git diff veloexpense-spec/accounting-20260831..origin/main -- \
  apps/web/src/server/routers/netsuiteSync.ts \
  packages/integrations-netsuite/src packages/db/prisma/schema.prisma
```

When `audit` and `notifications` get baselined, their paths are:

```bash
# audit         apps/web/src/server/routers/audit.ts packages/audit/src packages/jobs/src
# notifications apps/web/src/server/routers/{notifications,notificationTemplates}.ts \
#               packages/notifications/src packages/jobs/src
```

### The 25 packages, and which matter to us

`api-scopes` `approvals` `assistant` `audit` `db` `design-system` `expense-lines` `fraud` `i18n`
`integrations-google` `integrations-netsuite` `jobs` `mcp-server` `money` `notifications`
`platform` `predicate` `rbac` `receipt-extraction` `storage` `tax` `travel-lines` `travel-search`

Direct counterparts to VeloExpense code, and therefore **the highest-value gap-audit targets**:

| ExpenseOS package | VeloExpense counterpart | Note |
| --- | --- | --- |
| `packages/money/src` | `lib/money.ts` (80 lines, hand-rolled) | Money math is where edge cases hide, and the GA audit's **CAD-exclusion-from-totals** defect most likely lives here or in `expense-lines`. Audit this first. |
| `packages/expense-lines/src` | `lib/expenses/service.ts` line-item paths | Line totals, tax, mileage. |
| `packages/storage/src` | `lib/storage/` | Presigned upload seam — ours was written independently. |
| `packages/approvals/src` | `lib/approvals/` | **The graph engine. Never read before VX2-1 was designed** — this is the package whose existence the Differences Chart summarises as "~5,400-LOC graph engine". Read it before VX2-2/VX2-3 even though the graph itself stays out of the default path: the resolver, absence-walking and delegation semantics are in here. |
| `packages/predicate/src` | *(none — trimmed)* | The `matchCondition` DSL. VX1-7 deliberately shipped without it; if a predicate DSL is ever wanted, port rather than invent. |
| `packages/rbac/src` | `app_user.role` + pure predicates | ExpenseOS has a role builder + permission registry. The Differences Chart requires per-tenant custom roles, which is why `approval_policy_approver.approver_role` has no CHECK constraint. |
| `packages/audit/src` | VX2-6 (not yet written) | Read: `chain.ts`, `writer.ts`, `verify.ts`, `canonical.ts`, `types.ts`. |
| `packages/notifications/src`, `packages/jobs/src` | VX2-7 / VX2-8 | `jobs` also holds `audit-purge`, `notification-dispatch`, `channels`. |
| `packages/design-system/src` | `lib-ui-kit` + `app/expenses/ui.tsx` | ExpenseOS's own primitives — the ones the plan says to retire in favour of lib-ui-kit. Do **not** port from here. |

Out of MVP scope, nothing ported, no baseline needed: `travel-lines`, `travel-search`, `tax`,
`fraud`, `integrations-netsuite`, `integrations-google`, `assistant`, `mcp-server`, `i18n`,
`api-scopes`, `platform`.

**Not baselined yet, on purpose:** `audit` (VX2-6) and `notifications` (VX2-7/VX2-8). Tagging them
at `fb1cead` would claim we ported from a commit nobody has read. (`accounting` was in this list
until 2026-08-31 and is now baselined at its own commit — see above.) They get a baseline at whatever
`origin/main` is when their ticket lands. This matters especially for `notifications`: a **654-file
update landed on ExpenseOS `main`** recently (travel build-out, NetSuite posting, **notification
template-key changes**), so porting those from August would port a shape that has since moved.

Deliberately absent: `virtualCards*`, `travelRequests`, `netsuiteSync`, `budgets`, `analytics`,
`fraudFlags`, `controlEvaluation`. VCC and Travel are off for the MVP; NetSuite becomes one
optional adapter in Phase 3; Budgets and Analytics are Phase 4; fraud detection and control
evaluation are Phase 4 by decision. Nothing has been ported from them, so nothing needs a baseline
until it is.

## Delta log — `accounting`, and why this mechanism is not bureaucracy

Run ten minutes after the baseline existed, `fb1cead..5a11a647` is **91 commits, 16 of them
touching the accounting surface**, plus a new migration
`20260824153000_netsuite_sync_reconciled` that postdates the Differences Chart entirely.

**Three of those commits land on work VeloExpense has already shipped**, and none was known when it
was built:

- **`1d9429e2` — "fix(netsuite): refuse an uncoded post instead of letting NetSuite reject it"
  (#324)**, then **`76aafe31` — "fix(netsuite): refuse an uncoded post on every path, not just the
  card one" (#351).** This is precisely the failure class **AC-16** describes and VX3-7's
  pre-flight closes: a post accepted locally and rejected at the far end, where the fix is to refuse
  before sending. ExpenseOS shipped it **twice**, because the first fix covered one call path and
  missed the others — which is the same shape AC-6 records for their four posting call sites, and a
  direct argument for VeloExpense's single choke point in `lib/integrations/dispatch.ts` over a
  check per caller.
- **`2a2e7033` — "fix(e2e): code the dimensions the NetSuite pre-flight now requires" (#340).**
  Their pre-flight came to require dimensional coding — which is the half of **VX3-7** currently
  blocked on VeloLedger having nowhere to send a dimension. Read this before that half restarts.

That is the argument the Plan's §6 ask was making, demonstrated rather than asserted: without the
baseline, finding these three means reading 91 commits or not finding them at all.

## Known ExpenseOS defects — do NOT port these forward

**The premise of porting has one exception: ExpenseOS's open bugs.** A GA-readiness audit of
ExpenseOS (2026-08-27, in that repo's `Testing_QA/`) found **P0/P1 defects that are live in
ExpenseOS today**, and three of them sit in modules on the baseline list above:

| Area | Defect (per the 2026-08-27 GA audit) | Affects our module |
| --- | --- | --- |
| Date picker | _details needed from the GA report_ | `expense-reports` |
| Totals | CAD excluded from report totals | `expense-reports` |
| Approvals | approval defaults wrong | `approvals`, `policy-engine` |

**So for those three modules, port the FIXES, not the baseline.** A faithful port from `fb1cead`
carries the defects into VeloExpense. Before porting further into `expense-reports`, `approvals` or
`policy-engine`, read the GA report's P0/P1 entries and record here which behavior is deliberately
NOT being copied.

### And the reverse — where VeloExpense is already ahead

Porting is not blanket-superior, and the 2026-08-25 audit's prior findings show several places where
a VeloExpense decision already avoids an ExpenseOS bug. Worth knowing so a "faithful port" does not
*regress* us:

- ExpenseOS's amount field mangles typed input (`125.50` → `125.500.00`). VeloExpense's
  `parseAmountToMinor` rejects extra decimals rather than rounding or mangling (VX1-6).
- In ExpenseOS a **$0.00 empty report and a blank-title report can be submitted and approved**.
  VX1-8 refuses to submit an empty report, and a title is required at creation.
- A terminated ExpenseOS employee still shows 10 direct reports. VX1-2's deactivate refuses while
  direct reports remain unless `reassignReportsTo` is given.
- ExpenseOS's Policy Rules/Violations screens render raw enum codes and raw i18n keys
  (`receiptThresholdBlock`). `lib/policy/rules.ts` carries real labels and descriptions.
- ExpenseOS notifications don't mark read (the bell count sticks) — relevant to VX2-7.

The rule this implies: **port the behavior, not the bug.** When ExpenseOS source and a known defect
disagree, the defect wins the argument about what NOT to copy, and the divergence gets recorded here
rather than discovered later.

## Where the ExpenseOS source actually is

Two routes, and the second is the one a Cowork session can use:

- **The repo**, `github.com/carmigo/ExpenseOS` — pull as gh user `johnrim-lab`, *not* `Velotechsys`
  (see project memory on the two accounts). Required for tagging and for `git diff`.
  **There appear to be TWO checkouts:** `~/ExpenseOS`, and the Google-Drive folder
  `.../Claude CoWork Folders - RIM/PeopleOS HRIS System/ExpenseOS`, which the GA-audit handoff
  states *is* a clone of `carmigo/ExpenseOS` (remote `origin`, branch `main`). Tags created in one
  do not exist in the other until pushed, so **push them** —
  `git push origin 'refs/tags/veloexpense-spec/*'`, narrower than `--tags`, which would push every
  stray local tag in that clone up to the shared repo.
- **The Google Drive sync**, under "PeopleOS HRIS System/ExpenseOS". A Cowork session can read
  these directly. **`read_file_content` works on ExpenseOS `.ts` files** — an earlier note in
  `HANDOFF.md` claimed they needed `download_file_content` (base64), which is wrong and is a large
  part of why source felt expensive to reach and the docs got used instead.

  Drive flattens the tree, so a filename is not a path and two products' files can share a name.
  One `audit.ts` in that corpus is **VeloPulse HRIS's**, not ExpenseOS's — it references SIN
  handling and matches `product-velopulse-hris`'s `audit_event` migration. Confirm provenance from
  file content, never from the title.

## Rule for every future ported module

1. Read the ExpenseOS **source** for the module, not only its `NN-module.md` doc. A doc saying
   "built, and far beyond this document" (Module 8 said exactly that) is a warning, not a licence.
2. Check `product-veloledger` and `product-velopulse-hris` for an in-house pattern — the
   Differences Chart names VeloLedger as the structural reference for several dimensions. Read the
   *latest* migration on a topic; later ones supersede earlier ones.
3. Port it. State in the migration or module header which ExpenseOS behavior is kept, which is
   dropped, and which plan-mandated difference forces a change.
4. **Tag the baseline in the same session**, while the sha is still known — and tag it at the
   START of the module, before reading source, not after shipping. Use the script, which resolves
   real paths and refuses to move an existing baseline:

   ```bash
   cd ~/ExpenseOS
   ONLY=<module> DRY_RUN=1 bash <this repo>/docs/porting/tag-spec-baselines.sh <sha> <YYYYMMDD>
   ONLY=<module>             bash <this repo>/docs/porting/tag-spec-baselines.sh <sha> <YYYYMMDD>
   git push origin 'refs/tags/veloexpense-spec/*'
   ```

   `ONLY=` exists because modules no longer share one baseline: an unfiltered run at a new sha
   walks into the script's own refusal to move the six Phase-1 tags, and `FORCE=1` would move them,
   which destroys the record. Then paste the printed row into the table above.
   **Push it** — `git push origin --tags` would push every stray local tag in that clone; the
   namespaced refspec above pushes only these.
