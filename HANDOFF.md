# VeloExpense — Build Handoff (context for a fresh thread)

_Last updated: 2026-08-27 (Phase 1 COMPLETE through VX1-10; Phase 2 IN PROGRESS from VX2-1). Paste this whole file into the new thread as context._

## 0. What VeloExpense is
The commercial, **multi-tenant** SaaS expense product, built for third-party SMB
customers. It is a **rebuild** on the shared Velotech foundation, using the
mature **ExpenseOS** app as the behavioral spec (NOT a code lift-and-shift).
Two separate codebases:
- **ExpenseOS** = EINC's single-tenant instance (the spec source). Repo: `github.com/carmigo/ExpenseOS`. Synced into the Google-Drive "PeopleOS HRIS System/ExpenseOS" folder; pull as gh user `johnrim-lab`.
- **VeloExpense** = this repo, `github.com/velotechsystems/product-veloexpense`, in the poly-repo monorepo at `~/code/velotechsystems`.

## 1. Non-negotiable house rules (Velotech)
- **Tenancy = pooled + Postgres RLS from day one.** Authoritative doc: `~/code/velotechsystems/product-veloledger/.claude/references/multi-tenancy.md`.
  Every tenant table: `organization_id uuid NOT NULL REFERENCES organization(id)`, org-id index, `ENABLE`+`FORCE ROW LEVEL SECURITY`, and:
  ```sql
  CREATE POLICY tenant_isolation ON <t>
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
  ```
  - `NULLIF(...,'')` is REQUIRED (pooled connections return '' not NULL; `''::uuid` errors). Proven by the isolation test.
  - The app connects as a **non-superuser** role (`veloapp`) — superusers bypass RLS even with FORCE.
  - **Global tables = reference data only.** Today that is `organization` and `currency`, and
    nothing else — see the correction in §6. Everything else is tenant-scoped.
  - **RLS scopes rows to the ORG, not to a PERSON.** Anything employee-owned needs a second
    ownership check in the action layer, or a colleague who guesses an id can read/edit it
    (see VX1-6's `onReport` helper).
- **Session var name is `app.current_org`** (locked; do not use `app.current_organization_id`).
- **Architecture = Next.js server actions + `lib/<domain>/` modules. NO tRPC** (matches VeloLedger; the original plan said tRPC — overridden).
- **Shared libs are VENDORED, not npm deps.** Copy the lib's `src/` into the app and pin the commit. `@velotech/auth-kit` is vendored at `src/auth-kit/` (pinned `e1db5c1`). `@velotech/ui` tokens are vendored at `app/velotech-tokens.css` + `app/tailwind-v4.css`; components come via `npx shadcn add https://velotechsystems.github.io/lib-ui-kit/r/<name>.json`.
- **Git flow: this repo uses MERGE-COMMIT PRs (not squash).** So stacked branches are simple: `git fetch origin && git checkout -b <next> origin/main`. Always fetch before branching (local `origin/main` goes stale between merges).
- **Every new tenant table** must have RLS + be added to the isolation test. CI's RLS-coverage guard fails the build otherwise.

## 2. Repo / stack facts
- Next.js 16 (App Router, Turbopack) · React 19 · Tailwind v4 · shadcn (`radix-nova`, `components.json`) · Postgres (own DB) · Node 24 (`.nvmrc`).
- Auth: NextAuth v5 via vendored auth-kit (`auth.ts`), Google + Microsoft Entra, invite-only, org-slug login. Session stamps `organizationId`.
- `tsconfig` target is **ES2022** (needed for BigInt literals).
- Key files:
  - `lib/db/client.ts` — pg pool + `transaction()`.
  - `lib/auth/actor.ts` — `requireActor(tx, email)`: the acting employee, read from the DB inside the tenant transaction (never from the session token, which outlives a demotion).
  - `lib/tenant/context.ts` — `withOrg(orgId, fn)` sets `app.current_org` LOCAL; `withoutOrg(fn)` = service-role escape hatch.
  - `lib/tenant/request.ts` — `withCurrentOrg(fn)` bridges auth session → `withOrg`.
  - `proxy.ts` — Next 16 edge middleware (note: Next 16 renamed `middleware`→**`proxy`**; export a `proxy` function).
  - `lib/expenses/service.ts` + `app/expenses/actions.ts` — the VX1-4/VX1-6 pattern to copy for new domains (service = pure functions over a tenant `QueryRunner`; actions = thin `'use server'` wrappers).
  - `lib/employees/service.ts` + `app/admin/employees/` — VX1-2; also the pattern for an admin-gated surface.
  - `lib/receipts/service.ts` + `lib/storage/` + `app/receipts/actions.ts` — VX1-5; the storage seam. `lib/receipts/constants.ts` holds what the browser may import (the service pulls in `pg`).
  - `app/expenses/{page,layout,ui}.tsx`, `app/expenses/new/`, `app/expenses/[reportId]/` — VX1-6; the workbench, and the pattern for a user-facing (not admin) surface.
  - `lib/money.ts` — the ONLY place minor units convert. String/bigint math, never float.
  - `e2e/` + `playwright.config.ts` + `scripts/e2e-storage.mjs` — VX1-9; the only tests that drive a real browser and a real presigned upload. `npm run e2e` (builds, then runs).
  - `lib/expenses/lifecycle.ts` — VX1-8; submit/recall/history. Its OWN module because `lib/policy/service.ts` already imports `lib/expenses/service.ts`, and submitting needs both — putting it in either would make them import each other.
  - `lib/approvals/tiers.ts` + `lib/approvals/service.ts` + `lib/approvals/routing.ts` — VX2-1. `tiers.ts` is PURE (the ladder, the starter set, `planApproval`); `service.ts` is the rung CRUD plus the reads VX2-2/2-3/2-4 need; `routing.ts` is TYPES ONLY — the seam VX2-2 implements and where an advanced graph tier would slot in.
  - `lib/policy/rules.ts` + `lib/policy/service.ts` — VX1-7; rule TYPES in code, rule INSTANCES in `expense_policy`. `rules.ts` is PURE (no DB) and is where a new rule kind is added. `app/admin/expense-policies/` is the config surface, `app/expenses/[reportId]/policy-panel.tsx` the employee-facing one.
  - `test/rls-isolation.test.ts` — the RLS gate; extend it for each new tenant table.
  - `scripts/seed.mjs` — `npm run seed` (demo + blank tenants, synthetic data; demo has admin/manager/employee with a wired reporting line).
- Migrations are plain SQL under `prisma/migrations/NNNN_name/migration.sql`, applied with `psql -f` (no Prisma migrate wired yet). Current: `0001_init`, `0002_reference_and_employees`, `0003_expense_reports`, `0004_employee_roles`, `0005_receipt_upload_state`, `0006_policy_engine`, `0007_report_lifecycle`, `0008_approval_schema`.
- **Gotchas learned the hard way:**
  - `vitest.config.ts` sets **`fileParallelism: false`** — the DB suites share one Postgres and each `TRUNCATE`s in `beforeAll`. Parallel files race (duplicate slugs, FK violations). Do not remove while the suites share a database; give each new suite its own org slugs too.
  - `npx shadcn add` guesses a **`src/` layout** (the repo has `src/auth-kit/`), but `tsconfig` maps `@/*` → `./*`. After every add: `mv src/components/ui components/ui` and `mv src/lib/utils.ts lib/utils.ts`. lib-ui-kit ships no table/select/badge — those are hand-rolled against the vendored tokens in `app/expenses/ui.tsx`.
  - Authorization is read from `app_user.role` **inside the tenant transaction**, never from the session token.
  - A `<form>` may not be a child of `<tr>`. Editable table rows use the HTML `form="id"` attribute with the `<form>` elements rendered after the table — one form per row, still no client JS.
  - eslint's `react-hooks/immutability` rule rejects `window.location.href = url` in a client component; use `window.location.assign(url)`.
  - **`now()` is the TRANSACTION start time.** Two audit rows written in one transaction share it, and ordering by it comes back arbitrary. `expense_report_event.created_at` defaults to `clock_timestamp()` for that reason; `policy_violation` (already merged with `now()`) is ordered by its identity columns in `listViolations` instead. A test caught this, not a review.

## 3. Local dev environment
```bash
# Postgres (Docker), host port 5433
docker run --name veloexpense-pg -e POSTGRES_PASSWORD=velo -e POSTGRES_DB=veloexpense -p 5433:5432 -d postgres:16
# apply all migrations as superuser
for f in prisma/migrations/*/migration.sql; do psql "postgres://postgres:velo@localhost:5433/veloexpense" -f "$f"; done
# non-superuser app role (RLS applies) — run once
psql "postgres://postgres:velo@localhost:5433/veloexpense" <<'SQL'
CREATE ROLE veloapp LOGIN PASSWORD 'velo';
GRANT CONNECT ON DATABASE veloexpense TO veloapp;
GRANT USAGE ON SCHEMA public TO veloapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO veloapp;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veloapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO veloapp;
SQL
# env for tests / app
export ADMIN_DATABASE_URL="postgres://postgres:velo@localhost:5433/veloexpense"   # superuser (test truncate)
export DATABASE_URL="postgres://veloapp:velo@localhost:5433/veloexpense"          # app role (RLS)
npm install && npm test && npm run build && npm run typecheck && npm run seed
# end-to-end (VX1-9): builds, starts its own S3 surface + the standalone server
npx playwright install chromium   # once
npm run e2e
```
**`npm run start` does NOT serve this app.** `next.config.ts` sets
`output: 'standalone'`, and with that setting `next start` prints a warning and
serves something other than what ships. Use `npm run start:standalone` (it copies
`public/` and `.next/static` beside the standalone server first) — that is what
the e2e and the Docker image run.
Receipts (VX1-5/VX1-6) additionally need MinIO and `STORAGE_*` in `.env.local` — see the header
of `lib/storage/index.ts` for the exact vars and the docker command. **The bucket needs a CORS
rule allowing `PUT` from the app origin**: the browser uploads directly, so without it every
upload fails in the browser while every test still passes (tests use `MemoryStorage`).

GitHub repo vars set: `RUNNER_LABEL=ubuntu-latest`, `BACKEND_DIR=.` (others inherited org-wide). Ruleset `default-main-protection`: Repository admin = Always-allow bypass; merge PRs with `gh pr merge <n> --squash --admin` if needed (repo actually uses merge commits though).

## 4. Standard per-ticket loop
```bash
git fetch origin
git checkout -b feat/<ticket> origin/main
# ...write migration (if any) + lib/<domain> + app/<route>/actions.ts + test...
psql "$ADMIN_DATABASE_URL" -f prisma/migrations/<new>/migration.sql   # if a migration
npm test && npm run build && npm run typecheck
git add -A && git commit -m "<ticket>: ..." && git push -u origin feat/<ticket> && gh pr create --fill
# CI must be green; merge in the UI or: gh pr merge <n> --merge --admin
```
CI (`.github/workflows/ci.yml`) spins up Postgres, applies migrations, creates `veloapp`, runs the **RLS-coverage guard** + isolation test + build/typecheck. Standard Velotech workflows (security, release-drafter, cut-release, velotech-lifecycle/implementation, dependabot) are stubs → `velotechsystems/infra-ci-cd@v1`.

**Refresh THIS file on the feature branch, before the PR is opened** — a handoff commit pushed
to a branch after its PR merged never reaches main (that is how the VX1-5 refresh was lost).

## 5. STATUS — where things stand
**Phase 0 (foundation & tenancy) — COMPLETE, merged to main:**
VX0-1 scaffold · VX0-2..6 tenancy spine + RLS isolation gate (green) · VX0-7 SSO (vendored auth-kit + login page) · VX0-9 seeds · VX0-10 CI + standard workflows + Dockerfile. (VX0-8 worker/MCP tenant-context deferred until those surfaces exist.)

**Phase 1 (tenant-scoped expense loop) — IN PROGRESS:**
- VX1-1 ✅ merged (PR#10): reference data (legal_entity, business_unit, department, per-tenant expense_category) + employee fields on app_user. Migration `0002`.
- VX1-3 ✅ merged (PR#11): `expense_report → expense → expense_line_item` + `receipt`, `expense_report_status` enum, per-tenant `organization.expense_report_seq`. Migration `0003`.
- VX1-4 ✅ merged (PR#12): `lib/expenses/service.ts` (createReport w/ EXP-###### numbering, addExpense, addLineItem/removeLineItem, totals recompute, get/update/delete) + `app/expenses/actions.ts` + `test/expenses.db.test.ts`. Included the tsconfig ES2017→ES2022 fix for BigInt literals.
- VX1-2 ✅ merged (PR#13): `lib/employees/service.ts` (directory list w/ search + filters + pagination, get, direct reports, cycle-safe recursive manager chain, create, patch-with-nulls update, guarded deactivate) + `app/admin/employees/` (directory, detail, new — server components posting plain `<form action={serverAction}>`, no client JS) + `test/employees.db.test.ts`. Migration `0004` adds `app_user.role` (EMPLOYEE|MANAGER|ADMIN), CHECK constraints on role/status, a no-self-manager CHECK, and directory indexes. **Decisions:** the directory is ADMIN-only; deactivation refuses when the employee still has direct reports unless `reassignReportsTo` is given; an admin cannot deactivate themselves.
- VX1-5 ✅ merged (PR#14): `lib/storage/` (Storage interface + S3/MinIO driver on AWS SDK v3 + MemoryStorage for tests) and `lib/receipts/service.ts` (two-phase presigned upload, attach/detach, signed download, remove, `startFromReceipts`) + `app/receipts/actions.ts` + `test/receipts.db.test.ts`. Migration `0005` adds `receipt.status` (PENDING|STORED), makes `size_bytes` nullable until confirmed, and adds the inbox index. **Decisions:** bytes never pass through Next (browser PUTs/GETs presigned URLs); `confirmUpload` HEADs the object and records the real size rather than trusting the client; the RLS-scoped SELECT *is* the download permission check; keys are `org/<org-id>/receipts/<receipt-id>/<filename>`. Tests run entirely on MemoryStorage, so CI needs no bucket or credentials.
- VX1-6 ✅ merged (PR#15): the report workbench — `/expenses` (list, filters, pagination), `/expenses/new`, `/expenses/[reportId]` (header form, expense cards, line-item table, totals) + `app/expenses/[reportId]/receipt-drawer.tsx` + `lib/money.ts` + `lib/receipts/constants.ts` + `test/money.test.ts` and a VX1-6 block in `test/expenses.db.test.ts`. **No migration** — no schema change, so the RLS-coverage guard was untouched. Service grew filtered `listReports`, `getReportWorkbench`, `updateExpense`/`removeExpense`/`updateLineItem`, `listCategories`/`listCurrencies`, `minorUnitForReport`. **Decisions:**
  - **`assertDraft()` is the single write gate** — every report/expense/line mutation calls it, so a report past DRAFT is read-only at the data layer, not just in the UI. VX1-8's transition builds on this.
  - **Ownership:** report actions resolve the actor with `getEmployeeByEmail` inside the tx and require `submitter_id === actor.id || role === 'ADMIN'`. MANAGER gets no extra reach until the Phase-2 approval engine. `/expenses` lists your own reports; an ADMIN can widen with `?scope=all` (the action only honours `submitterEmail: null` for ADMINs).
  - **`updateReport` moved from COALESCE to patch-with-nulls** (absent key = leave, explicit null = clear), matching `updateEmployee` — under COALESCE, clearing a field from a form was impossible. A currency change cascades to the report's expenses (single-currency MVP).
  - **`parseAmountToMinor` REJECTS more decimals than the currency has** rather than rounding; a silently rounded 12.345 puts a report a cent off its receipts.
  - **Client JS exists in exactly one component**, the receipt drawer, because the presigned PUT is a three-step browser flow no `<form action>` can express. Everything else is a server component posting a plain form.
  - Form validation failures redirect back with `?error=…` and render in a banner rather than throwing into the Next error boundary.

- VX1-7 ✅ merged (PR#17 — confirm the number when the PR opens): policy engine v1. Migration `0006` adds `expense_policy` + `policy_violation` (both FORCE RLS, both in the isolation test) and the `policy_severity` enum. `lib/policy/rules.ts` (pure rule registry + the four starter rules) · `lib/policy/service.ts` (rule CRUD, `validateReport`, acknowledge) · `app/admin/expense-policies/` · `app/expenses/[reportId]/policy-panel.tsx` · `test/policy.db.test.ts`. **Decisions:**
  - **Rule TYPES in code, rule INSTANCES in rows** (ExpenseOS v2 architecture). `expense_policy.kind` is deliberately NOT a CHECK constraint — adding a rule kind must not need a migration. The service validates it against `RULE_KINDS` instead.
  - **`validateReport` runs inside the same transaction as every save**, from the expense write actions. A report that saves is a report that has just been validated; reads never re-run the rules.
  - **Re-validation reconciles rather than replaces:** a finding that still fires is refreshed, one that stops firing is deleted (acknowledgement and all), and an acknowledged finding that still fires stays acknowledged — unless its severity is now BLOCK, which clears the acknowledgement.
  - **`policy_violation.finding_key` fixes an ExpenseOS bug.** ExpenseOS keys violations on `(ruleCode, lineItemId)` and its own Module 9 doc records the consequence: "a rule that emits several findings for one line silently loses all but the first". `finding_key` joins the identity, so e.g. three receipt-less expenses raise three findings. There is a test for exactly this.
  - **BLOCK findings cannot be acknowledged** (service refuses, UI offers no form), and an acknowledgement **requires a note** — an override with no reason tells an auditor nothing.
  - **The starter set lives only in `DEFAULT_POLICIES`** (rules.ts), applied by "Restore starter rules" on the admin page. `scripts/seed.mjs` deliberately seeds no policies, so there is no second copy to drift. A fresh tenant therefore has NO rules until someone restores them.
  - `ValidationSummary.blocking` is the flag VX1-8's submit gate reads.

- VX1-8 ✅ merged (PR#18 — confirm the number when the PR opens): submit + state gate. Migration `0007` adds `expense_report_event` (FORCE RLS, in the isolation test). `lib/expenses/lifecycle.ts` (submit / recall / history / readiness) · `app/expenses/[reportId]/lifecycle-bar.tsx` · `test/lifecycle.db.test.ts`. **Decisions:**
  - **The policy engine RE-RUNS inside the submit transaction** rather than trusting the findings the last save stored. Otherwise a rule an admin added thirty seconds ago would not apply — the exact hole an employee would learn to exploit. There is a test for it.
  - **BLOCK refuses, WARNING does not.** Module 9 is explicit that warnings propagate to the approver; the employee may acknowledge them with a justification instead. The refusal carries the blocking findings on the error so the UI can list them.
  - **An empty report cannot be submitted** (no line items = nothing to reimburse). Not in the ticket; it is obviously right and cheap.
  - **Recall covers SUBMITTED and RETURNED → DRAFT** and clears `submitted_at`, because that column means "currently submitted at". The audit trail is what remembers it once was.
  - **The submit button is always live on a DRAFT** and the SERVER refuses with a reason. A disabled button with no explanation is the worst version of this interaction, and the authoritative check has to be server-side regardless.
  - The audit row snapshots the total and the violation counts the gate saw, so a later rule edit cannot rewrite the history of why a submit was allowed.

- VX1-9 ✅ merged (PR#19 — confirm the number when the PR opens): Phase-1 isolation + e2e. The RLS harness now covers ALL nine tenant tables (added `expense`, `expense_line_item`, `receipt`, plus a join-walk test proving a line-item→expense→report join cannot cross tenants). Playwright happy path in CI: `playwright.config.ts` · `e2e/auth.setup.ts` · `e2e/expense-flow.spec.ts` · `scripts/e2e-storage.mjs`. **Decisions:**
  - **The e2e mints its session cookie** (encodes the same Auth.js JWT the app would issue, with AUTH_SECRET) rather than driving the login page. SSO is invite-only through Google/Entra and cannot run in CI; the alternative — a test-only credentials provider — means shipping a login bypass guarded by an env flag. The bypass lives only in `e2e/auth.setup.ts`; nothing in `app/` or `lib/` knows the e2e exists. Cost: the login page itself is not covered, and an auth-kit claim/cookie change breaks it loudly (the first request lands on /login).
  - **Storage for the e2e is `s3rver`, not MinIO or MemoryStorage.** MemoryStorage signs `memory://` URLs no browser can fetch, which is exactly how every vitest suite stays green while a real upload is broken. s3rver is one Node process — no Docker for CI or a laptop — and it validates the SigV4 presigned URL AND answers the CORS preflight, so the CORS trap this handoff warns about now fails CI instead of someone's browser.
  - **The e2e serves the standalone build**, since `next start` does not work with `output: 'standalone'` (found by running it).
  - **Report titles carry a per-run id.** The e2e runs against the seeded demo tenant, which is not reset between runs, so a rerun or CI's one retry would otherwise leave several reports sharing a title.
  - Writing the spec surfaced a real gap, now fixed: **receipt attach/detach/remove/confirm re-run the policy engine** for the affected report. Before, satisfying RECEIPT_REQUIRED left the block on screen until some unrelated save.

- VX1-10 ✅ merged (PR#20 — confirm the number when the PR opens): receipt authorization. No migration. `lib/auth/actor.ts` (new) · access predicates in `lib/expenses/service.ts` and `lib/receipts/service.ts` · every action in `app/receipts/actions.ts` gated · `test/access.db.test.ts`. **What was wrong:** receipt actions relied on RLS alone, so any signed-in colleague holding a receipt id could download, detach or delete it, and receipts could be added to or removed from a SUBMITTED report that was supposed to be frozen. **Decisions:**
  - **A receipt has two legitimate owners** — the uploader, and the submitter of the report it is attached to. The receipt-first flow depends on both: one person can upload into their inbox and attach it to a report someone else owns.
  - **`canModifyReceipt` inherits the report's draft gate.** A frozen report whose receipts can still be deleted is not frozen. An unattached (inbox) receipt has no report, so nothing freezes it.
  - **MANAGER still gets nothing extra.** Its reach belongs to the Phase-2 approval engine, and inventing it early means guessing at rules that ticket will specify.
  - The predicates are PURE and the ownership lookup is one SQL read, so the truth table is unit-tested rather than asserted by reading action code. `test/access.db.test.ts` also asserts the row IS visible under RLS — that is what made the hole invisible.
  - `app/expenses/actions.ts` was refactored onto the same shared predicate, so reports and receipts cannot drift apart.

**Phase 1 is COMPLETE** (PRs #10–#20).

**Phase 2 (approvals, notifications, audit) — IN PROGRESS:**
- VX2-1 ✅ merged in TWO passes — **PR #22 shipped the first shape, PR #23 reconciled it against
  VeloLedger.** If you are reading `git log` and find two versions of `0008`, that is why; the file
  on `main` after #23 is the only one that was ever correct. **Migration `0008` was REWRITTEN IN
  PLACE rather than amended by an `0009`** — migrations here are plain SQL applied with `psql` and
  carry no checksums, so nothing detects the change: any database that applied the PR-#22 version
  of `0008` (a local dev DB, most likely) **must be dropped and re-migrated**. CI is unaffected, it
  builds a fresh database every run. In-place was the right call with no deployed tenants and one
  developer; once a tenant exists this stops being acceptable and a corrective migration is the
  only safe route.

  Migration `0008` adds FIVE tenant tables —
  `approval_policy`, `approval_policy_approver`, `approval_request`, `approval_task`,
  `delegation` — all FORCE RLS and all in `test/rls-isolation.test.ts` (17 tenant tables under
  the guard now). `lib/approvals/tiers.ts` (pure) · `lib/approvals/service.ts` ·
  `lib/approvals/routing.ts` (types only) · `test/approval-tiers.test.ts` +
  `test/approvals.db.test.ts`. 183 vitest tests across 10 files, all green. **No engine, no UI**
  — opening and moving a run is VX2-3, after VX2-6's audit log.

  **WHY THERE WERE TWO PASSES — the process lesson, not just a schema note.** The first shape was
  designed from the ExpenseOS Module 8 spec plus this repo's own conventions, and it reached
  one-approver-per-rung. It was already merged before anyone checked `product-veloledger`, which
  the Differences Chart names as the reference for exactly this feature — and which had shipped
  that same design in `0037` and **replaced it in `0066`**. Check the monorepo for an in-house
  pattern BEFORE designing a schema, not after merging one.

  **RECONCILED AGAINST VELOLEDGER, not ExpenseOS.** The Differences Chart specifies "simple
  tiered/threshold default for SMBs (cf. VeloLedger AP bill-approval tiers)", so
  `product-veloledger` is the named in-house reference. What it actually shipped:
  `0037_bill_approval` (one threshold + a set of approvers) → `0038_bill_approval_steps`
  (cumulative multi-step) → **`0066_bill_approval_tiers`, which REPLACED the cumulative step
  model** with mutually exclusive value ranges, each tier owning an ORDERED list of approvers who
  may be external email addresses → `0067_bill_approval_token` (the emailed approve-link).
  - **ADOPTED:** the rung → ordered-approvers decomposition (a rung is NOT one approver),
    external EMAIL approvers, `position` ordering. VeloLedger learned in 0066 that
    one-approver-per-rung does not survive a real approval matrix; no reason to relearn it.
  - **NOT ADOPTED — mutually exclusive value RANGES.** VeloLedger approves a bill, which has no
    manager chain behind it. An expense ladder is inherently cumulative ("the manager always
    signs, and finance as well past $5k"), ranges force the lower approvers to be repeated in
    every higher band, and the VX2-1 ticket specifies ordered tiers on `threshold_minor`.
  - **NOT ADOPTED YET — `bill_approval_token`.** That is VX2-8. **Consequence, and it matters:
    an EMAIL approver is storable but NOT actionable, so VX2-2's resolver must REFUSE a rung
    carrying one** (`RoutingErrorCode.EMAIL_APPROVER_UNSUPPORTED`) rather than create a task
    nobody can decide. Delete that code when VX2-8 lands.

  **Decisions:**
  - **The ladder is CUMULATIVE and each rung's approvers FLATTEN into numbered steps.** A report
    collects every enabled rung whose threshold it meets in `sequence` order; each rung's
    approvers emit one step each in `position` order. `step` is global to the report, `position`
    is within the rung — conflating them is how "approval 2 of 3" starts lying.
  - **`sequence` is separate from `threshold_minor`** so an admin can reorder who signs first
    without renumbering money. Ordering is by sequence; applicability is by threshold.
  - **A disabled rung is skipped without shifting the rest of the ladder.**
  - **An unconfigured tenant gets an IMPLICIT direct-manager step** (`IMPLICIT_STEP`). The one
    place approvals departs from VX1-7's precedent: no policy RULES is benign (nothing flags),
    but no approval rungs is not — either every report auto-approves (fails OPEN, forbidden) or
    nothing can be submitted until an admin configures a ladder (the onboarding friction the
    risk register warns about). An implicit step still puts a human in the path.
  - **A rung with NO approver is refused, not skipped** (`RUNG_WITHOUT_APPROVER`), and a plan
    needing more than 5 FLATTENED steps is refused, not truncated — truncating drops the tail,
    i.e. the finance sign-off on the largest reports.
  - **`approver_role` has NO CHECK constraint**, deliberately. The Differences Chart requires
    "per-tenant custom roles with tenant-scoped permissions", so the EMPLOYEE|MANAGER|ADMIN
    triple will stop being the vocabulary and a CHECK would mean a migration that day. Validated
    against `APPROVER_ROLES` in `tiers.ts` instead — the same reasoning that keeps
    `expense_policy.kind` out of a CHECK (VX1-7). **That makes the service the only gate**, and
    there are tests on both sides: the service rejects `'CFO'`, the database accepts it.
  - **`approval_policy_approver.approver_user_id` is `ON DELETE RESTRICT`**, not SET NULL: an
    approver named in a live ladder must not vanish and silently shorten every future approval.
    Module 12's audit-actor lesson, applied pre-emptively. Employees are soft-deleted anyway.
  - **`approval_task.assignee_id` is NULLABLE**, with `assignee_email` beside it and a CHECK that
    one of the two is present. This is the direct cost of external approvers — VeloLedger hit the
    same wall and solved it the same way in 0066. `listTasks` LEFT JOINs the assignee; an inner
    join would silently drop an external approver's step from the timeline.
  - **Receipt-view acknowledgement is captured at decision time**, per-rung
    (`require_receipt_view_ack`, default ON) with `receipt_view_acknowledged_at` **and
    `receipts_present_at_decision`**. Module 12's `APPROVED_WITHOUT_RECEIPT` control had to
    approximate "the approver never looked" as "the report has no receipt on file"; the count
    makes the honest control possible and costs one integer now.
  - **`policy_snapshot` on the run is authoritative; the `approval_policy` rows are a convenience
    join.** Same reasoning as `expense_report_event.context` (0007). A RETURN + resubmit opens a
    NEW run rather than re-banding the old one, or an employee returned at three sign-offs could
    trim a line and resubmit into one.
  - **One RUNNING run per report is a partial unique index**, not an engine check. **One task per
    `(request_id, step)`**; a quorum rung is the only thing that would relax it.
  - **`updatePolicy` replaces the approver set WHOLESALE when the patch names it**, and leaves it
    untouched when it does not. Patching an ordered list element-by-element cannot distinguish
    "delete position 2" from "I only mentioned position 1".
  - **Overlapping live delegations from one person are NOT constrained in the schema.** The
    constraint needs `EXCLUDE USING gist` over `(from_user_id WITH =, daterange WITH &&)`, hence
    `btree_gist` — a new deployment dependency for CI, the Docker image and every laptop, to
    prevent a conflict the resolver can settle. **VX2-2 must pick the most recently created live
    delegation and have a test for that tie.**
  - `resolved_via` pre-admits `DELEGATION`/`REASSIGNED`/`EMAIL` and `approval_task_status`
    pre-admits `SKIPPED`, so VX2-4/VX2-5 need no migration — the trick 0007 played.
  - **`test/rls-isolation.test.ts`'s "a tenant sees only its own rows" changed**: each org now has
    TWO users (a delegation needs a second person), so the assertion sorts and expects both. Same
    guarantee, wider fixture.

Phase 2's board is in §6.

**Phase 2 board — 10 tickets, ~26 dev-days** (ExpenseOS Modules 8, 11, 12). Build order:
VX2-1 approval schema + tiers → VX2-6 tenant-scoped audit log → VX2-2 routing resolver →
VX2-3 approval engine + transitions → VX2-5 delegations ∥ VX2-4 approver inbox + decision UI →
VX2-7 notification core → VX2-8 delivery worker (email / Teams / Slack) → VX2-9 reimbursement →
VX2-10 Phase-2 isolation + e2e. The load-bearing decisions, so they are not relitigated if the
board is out of reach:
- **Audit lands BEFORE the engine.** VX2-3 writes into the trail from its first commit; bolting
  an audit log onto transitions that already exist is the retrofit antipattern the plan calls
  out for RLS, and it leaves a hole where the early history should be.
- **Simplified tiered approvals; the ExpenseOS graph engine stays out of the default path** —
  the Port & Build Plan's risk register is explicit that it is SMB onboarding friction. Keep the
  resolver behind one interface (VX2-2) so an advanced tier can slot in later.
- **Per-line rejection is out.** ExpenseOS decided against it and never built it, though its
  Module 8 use cases still describe it.
- **Freeze the audit hash payload once, at VX2-6.** Two lessons ExpenseOS paid for: an actor
  column inside the hash with `onDelete: SetNull` means one hard user delete permanently and
  unrepairably breaks verification of every row that user wrote; and concurrent appends must be
  serialized or two rows fork the chain and read as tampering forever.
- **Decide receipt-view acknowledgement BEFORE building VX2-4.** Nothing in ExpenseOS records
  that an approver opened a receipt, which forced Module 12's control to approximate it as
  "approved with no receipt on file". Nearly free to capture at decision time, expensive after.
- **MANAGER is deliberately unprivileged today** — `canViewReport` / `canEditReport` and
  `canViewReceipt` / `canModifyReceipt` grant a manager nothing beyond their own reports. VX2-4
  is where that opens, and it must open THROUGH those predicates, not around them.
- `expense_report_event` needs no migration: its CHECK already admits APPROVE / REJECT / RETURN
  / REIMBURSE. VX0-8 (worker + per-job tenant context) folds into VX2-8.
- Fraud detection and control evaluation (Module 12, slices 2–3) are deferred to Phase 4 — both
  are retrospective and need approval history before they mean anything.

## 6. Planning docs (in the ExpenseOS Google-Drive folder, `Specifications_and_Planning/`)
- `VeloExpense-Port-and-Build-Plan.docx` (7-phase plan + ExpenseOS→VeloExpense sync strategy)
- `ExpenseOS-vs-VeloExpense-Differences-Chart-rev2.docx`
- `VeloExpense-Phase-0-*.docx`, `VeloExpense-Phase-1-Tickets.docx`
- `VeloExpense-Phase-2-Tickets.docx` — **NOT in the Drive folder** (checked 2026-08-27: the
  newest file there is `VeloExpense-Phase-1-Tickets.docx`, and a Drive-wide title search finds no
  Phase-2 document). It exists only as the .docx John holds locally and re-attached in chat. The
  Drive API upload truncated the binary once (13.5 KB arrived as 10.8 KB, missing its ZIP central
  directory) and the corrupt copy was trashed; the CloudStorage path is not grantable via
  `device_request_folder_access` either, so a Cowork session cannot write it. **Because it has now
  gone missing twice, the board is transcribed below — do not treat the .docx as the only copy.**

### Phase 2 board, transcribed (build order; ~26 dev-days)

| ID | Title | Acceptance | ~d |
| --- | --- | --- | --- |
| VX2-1 | Approval schema + tiers | Migrates clean; the four new tables are in the isolation test; the RLS-coverage guard passes | 2 |
| VX2-6 | Tenant-scoped audit log | Every state change writes one entry; verification detects a tampered row; a purge leaves the surviving chain verifiable | 3 |
| VX2-2 | Routing resolver | Unit truth table over chain, absence, delegation, self-approval, depth bound; no eligible approver fails CLOSED | 2 |
| VX2-3 | Approval engine + transitions | Submit → approve round-trips; reject and return behave; a decision and its audit row are atomic (both or neither) | 3 |
| VX2-5 | Delegations | A delegated approver receives the task; the scope filter is honoured; an expired delegation is ignored | 2 |
| VX2-4 | Approver inbox + decision UI | A manager approves a direct report's report in the browser; sees no one else's queue; self-approval refused server-side | 4 |
| VX2-7 | Notification core (in-app) | A decision notifies the submitter in-app; preferences suppress it; an empty template table still renders shipped copy | 3 |
| VX2-8 | Delivery worker (email/Teams/Slack) | An approval email arrives with working actions; a failed send retries and shows in the admin queue; every job sets `app.current_org` | 4 |
| VX2-9 | Reimbursement transition | Submit → approve → reimburse completes, every step audited; refuses a report that is not APPROVED | 1 |
| VX2-10 | Phase-2 isolation + e2e | Isolation and e2e green in CI; RLS-coverage guard still passes; chain verification runs on every build | 2 |

Scope notes worth keeping: VX2-6 is `audit_entry` + `withAudit()` (business change and audit row
in ONE transaction, serialized per tenant) + an admin trail with server-side filters + windowed
integrity verification + a retention flag (7-year floor) and a purge job with a chain watermark.
VX2-7 is `activity` + `notification` with a per-user preference map (type × channel) and template
resolution exact → any-subject → shipped catalog string. VX2-8 absorbs VX0-8. Also deferred, on
purpose: per-legal-entity template scope, French template localisation, digest scheduling.

### Plan-fidelity corrections (found 2026-08-27 reading the Plan + Differences Chart)

Both source documents were re-read end to end against the code. Three things had drifted; the
first is a factual error this file used to assert.

1. **Chart-of-accounts templates DO NOT EXIST, and §1 used to claim they did.** The Plan puts
   "global reference tables (CoA templates, country/currency)" in Phase 0 and "selectable starter
   chart-of-accounts templates (global templates → per-tenant instances)" in Phase 1; the
   Differences Chart lists it as a required dimension. **Reality: the only global tables are
   `organization` and `currency`.** There is no CoA template table and no `country` table; the
   only GL hook anywhere is a bare `expense_category.gl_account text`. Both phases are marked
   complete and neither delivered it. This blocks nothing today, but **Phase 3's VeloLedger
   adapter has to "pull chart of accounts"** and Module 12's `GL_MAPPING_GAP` control needs a
   mapping to check, so it needs a ticket before Phase 3. No ticket cut yet — deliberate, John's
   call on 2026-08-27.
2. **lib-ui-kit adoption is thin, and the Plan's risk register names this exact risk** ("port
   screens onto lib-ui-kit as each module lands; don't dual-maintain ExpenseOS primitives"; the
   Chart marks the UI decision `[DECIDED]`). The registry at `~/code/velotechsystems/lib-ui-kit`
   ships EIGHT ui primitives — button, input, **textarea, popover, dialog, command, sonner,
   input-group** — plus confirm-dialog, account-select and toast. VeloExpense has pulled **two**
   (button, input). Everything else — table, select, badge, cards, empty rows — is hand-rolled in
   `app/expenses/ui.tsx`, which has quietly become a second primitive library. Note the registry
   genuinely has no table/select/badge, so the honest fix is to CONTRIBUTE those upstream, not to
   grow `ui.tsx`. See the proposed ticket below.
3. **Zero spec-baseline tags.** Plan §6 asks for `git tag veloexpense-spec/<module>-YYYYMMDD
   <sha>` per ported module plus a per-module delta log, so catching later ExpenseOS changes is
   "a mechanical re-diff, not a memory exercise". `git tag -l` returns nothing after ten Phase-1
   tickets. This cannot be reconstructed later — you would be guessing which sha each module was
   read at — and it gets more expensive every ticket. **John action; this session has no git.**

Also worth knowing: **per-tenant custom roles** are a required dimension in the Differences Chart
("role builder already exists") but appear in NO phase of the Plan. VX2-1's `approver_role` is
built for it (no CHECK constraint), but the requirement itself is unassigned.

### Proposed, not yet on the board

- **VX2-11 (proposed) — lib-ui-kit catch-up, ~1–2d.** Pull the six unused registry components
  (`npx shadcn add https://velotechsystems.github.io/lib-ui-kit/r/<name>.json`, then the
  `src/` → root move the repo's tsconfig requires); replace the hand-rolled `selectClass` /
  `textareaClass` in `app/expenses/ui.tsx` with the registry `textarea` and a real select;
  contribute `table`, `select` and `badge` UP to `lib-ui-kit` rather than keeping them local.
  **Do this BEFORE VX2-4**, which is four days of new screens and will otherwise double down on
  `ui.tsx`. Acceptance: `components/ui/` holds every primitive the app uses, `app/expenses/ui.tsx`
  contains only VeloExpense-specific composites, and lib-ui-kit has a PR for the three additions.

**Exit criteria:** a full submit → approve → reimburse round trip driven from an approver inbox
AND from an emailed or Teams action, every transition notified and recorded in a tenant-isolated
audit trail whose chain verifies in CI, with two tenants side by side seeing none of each other's
approvals, notifications or audit entries.
- ExpenseOS status/dashboard docs + the live Cowork artifact `expenseos-dev-dashboard` (weekly refresh).

## 7. Immediate next action for the new thread
1. **Nothing here has been clicked by a human.** The Playwright happy path covers
   the main flow in a real browser, which is most of what a manual walkthrough
   was for, but nobody has looked at these screens. Worth 20 minutes before
   Phase 2 builds on top: MinIO up with `STORAGE_*` in `.env.local` (there are
   none today) and the bucket CORS rule; an `app_user` row in the demo tenant
   matching a real Google/Entra identity with `role='ADMIN'`; then "Restore
   starter rules" on `/admin/expense-policies`, or nothing will ever flag.
2. **VX2-6 next** — the tenant-scoped audit log, which lands BEFORE the engine so
   VX2-3 writes into the trail from its first commit. Freeze the hash payload
   once: whatever identifies the actor must never be nullable-on-delete (use
   `ON DELETE RESTRICT`, as `expense_report_event.actor_id` already does), and
   concurrent appends must be serialized per tenant or two rows fork the chain
   and read as tampering forever. Note `audit_entry` does NOT replace
   `expense_report_event`: that one is the report's user-facing timeline
   (from/to status), the audit log is the hash-chained compliance record across
   every entity type. Then VX2-2's resolver — and it owns the overlapping-
   delegation tie-break the 0008 comments leave to it.
3. **Still no admin surface for the approval ladder.** The board never assigns
   one (VX1-7 shipped `/admin/expense-policies` with the engine; VX2-1 is
   schema-only at 2 days). `ensureDefaultLadder` and the rung CRUD exist and are
   tested, so a page over them is small — decide whether it rides with VX2-4 or
   takes its own ticket, but a tenant cannot tune the ladder until it exists.
4. Dependabot has open PRs for **vitest 4** and **typescript 7** — major bumps
   across TEN suites now, and typescript 7 also touches the Playwright types.
   Take them deliberately, on their own branch.
5. **Porting discipline — read `docs/porting/SPEC-BASELINES.md` first.** Port from
   ExpenseOS **SOURCE**, not from the `NN-module.md` summaries. Everything through
   VX2-1 was designed from the docs instead, which cost VX2-1 a full rewrite, and
   that file records the baselines, the gap-audit caveat, and the per-module rule.
   Then re-implement tenant-scoped (server action + lib module + RLS + isolation
   test), and check `product-veloledger` / `product-velopulse-hris` for an
   in-house pattern before designing a schema. Keep VCC/Travel OFF for MVP;
   NA-first.
   **CORRECTION to what this file used to say:** `read_file_content` works fine on
   ExpenseOS `.ts`/`.tsx` files in Drive. The old claim that they need
   `download_file_content` (base64) is wrong, and it is a large part of why the
   source felt expensive to reach and the docs got used instead. Beware that Drive
   flattens the tree and several products are synced into it — one `audit.ts` in
   that corpus is VeloPulse HRIS's, not ExpenseOS's. Confirm provenance from
   content, never from the filename.
