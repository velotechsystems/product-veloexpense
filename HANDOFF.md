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
-- SEQUENCES too, or the FIRST migration that adds a serial/bigserial column after
-- this setup ran leaves veloapp unable to INSERT into that table: "permission denied
-- for sequence <name>". Found the hard way by 0010's audit_entry.sequence, which is
-- the first sequence-backed column in the schema. CI is NOT affected — it grants
-- ON ALL SEQUENCES after applying migrations, so the sequence already exists — which
-- is exactly why this can only ever break on a developer's machine.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO veloapp;
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
VX2-1 approval schema + tiers ✅ → VX2-6 tenant-scoped audit log ✅ → VX2-2 routing resolver ✅
(taken EARLY, out of board order — see below) → VX2-3 approval engine + transitions ✅ →
VX2-4 approver inbox + decision UI ✅ (+ VX2-4a ladder admin ✅) →
**VX2-5 delegations ← NEXT** → VX2-5 delegations ∥ VX2-4 approver inbox + decision UI →
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

**VX2-2 shipped ahead of VX2-6, deliberately.** The board puts audit first so VX2-3 writes into
the trail from its first commit, and that still holds — VX2-3 has not started. VX2-2 jumped the
queue because auditing ExpenseOS source for VX2-6 surfaced a live SOX-grade defect in their
approval path (GAP-AUDIT AP-13) whose fix changed VX2-2's design, and it was cheaper to build the
resolver while that reading was fresh than to re-read it later. VX2-6's two open inputs (UUIDv7 vs
`bigserial`; whether per-tenant audit export is in scope) are unchanged and still unanswered.

**What VX2-2 shipped** — `0009`, `lib/approvals/resolver.ts`, `lib/approvals/eligibility.ts`,
`test/routing.db.test.ts` (32 tests). Five behaviours, each ported from ExpenseOS source rather
than designed, and each traceable to a defect they measured:
- the self-approval refusal runs FIRST in the decision guard, ahead of the admin override and
  ahead of the assignee path;
- that guard is enforced at DECISION time, not only at routing time, because VX2-4 and VX2-5 can
  move a task onto the submitter after clean routing;
- an unresolvable MANAGER approver goes to `ADMIN_FALLBACK` — 11% of ExpenseOS's active users had
  no manager, so refusing the submit would strand a ninth of a tenant;
- a manager chain shorter than `manager_level` degrades to the most senior person found and
  records the shortfall in `escalation_level`;
- a ROLE rung becomes an unassigned claim pool (`approval_task.claim_role`) rather than the
  resolver arbitrarily naming one holder.
Plus the AP-14 break-glass (`organization.allow_sole_approver_self_approval`, OFF by default),
without which a sole-admin SMB tenant's reports are undecidable by anyone.

**What VX2-6 shipped** — `0010`, `lib/audit/{canonical,chain,service,verify}.ts`,
`test/audit.db.test.ts` (27 tests) and `test/audit-canonical.test.ts` (6). Ported from ExpenseOS
`packages/audit/src` read in full, with the three multi-tenancy corrections that a verbatim port
gets wrong (GAP-AUDIT AU-1): the advisory lock is keyed PER TENANT rather than one key for the
database, the head read carries a tenant predicate — without which chains interleave and RLS makes
verification impossible — and `organization_id` is IN the hash payload, so a row's tenant
attribution cannot be changed without breaking it.
- **The payload is frozen**, and the in/out table lives in `0010`'s header next to the columns it
  excludes, because the risk is not somebody changing it deliberately, it is somebody adding a
  column and hashing it because that seemed thorough. Two additions to ExpenseOS's nine:
  `organization_id`, and `actor_role` (theirs excludes it with a comment inviting the change).
- **The chain cannot fork structurally**, not just by discipline: a unique index on
  `(organization_id, prev_hash)` plus a partial unique index giving one genesis row per tenant.
  ExpenseOS relies on the advisory lock alone, which any path that forgets it defeats silently.
- **Append-only is a TRIGGER, with one explicit door** (`app.audit_purge = 'on'`) for retention.
  There is deliberately no REVOKE beside it: `veloapp` does not exist when migrations run, and CI's
  role setup re-grants everything afterwards. The trigger holds even against a superuser.
- **Three round trips per entry** — lock, head read, insert — and they cannot be collapsed. The
  hash is computed in JS from the head hash, so the insert cannot precede the read; and the read
  cannot share a statement with the lock, because Postgres does not guarantee a select-list function
  is evaluated before a subquery's row lock, which would reopen the genesis race.
- **The writer inserts `occurred_at` explicitly** rather than letting the column default fill it:
  the hash covers it, so the value hashed and the value stored must be the same one. A
  `DEFAULT clock_timestamp()` would produce a second, later instant and every row would fail
  verification immediately.
- **Sequence gaps are normal and the verifier must never check contiguity** — a rolled-back append
  consumes a value. Deletion is caught by the hash instead. There is a test pinning this so nobody
  "fixes" it into a bug.
- **Decided:** per-tenant audit EXPORT is out of scope (exporting a hash chain usefully means
  exporting the proof, and the format would otherwise be set by accident — it belongs with the
  Phase 4 controls work); `audit_entry` lives in `public` like every other table, diverging from
  VeloLedger's dedicated `audit` schema, because CI's RLS-coverage guard and `veloapp`'s grants
  assume `public` and a table the guard cannot see is the one you least want unprotected.

**What VX2-3 shipped** — `lib/approvals/engine.ts`, the `submitReport` / `recallReport` wiring,
`test/approval-engine.db.test.ts` (17 tests). A report can now go submit → approve end to end.
- **A submit OPENS the run, in the same transaction.** Coupled rather than left to the caller: a
  SUBMITTED report with no run is the fail-open state, indistinguishable from one waiting on a busy
  manager. The consequence is real and bit twice — a submit now FAILS when the ladder cannot be
  routed, so a tenant with no manager chain and no second administrator cannot submit at all.
- **A decision is claimed with a conditional write** (`AND status = 'PENDING'`, `rowCount === 1`),
  ported from ExpenseOS. Two decisions racing — a double-click, or assignee and admin — would
  otherwise both advance the run, materialize step N+1 twice and clobber the final status.
- **Authorization lives INSIDE `decide`** via `assertCanDecide`, not in the caller. ExpenseOS leaves
  it to the caller and that is exactly how their read-side and write-side predicates drifted (AP-15).
- **Recall CANCELS the run.** This was missing and the suite caught it: recall took the report to
  DRAFT and left the run RUNNING, so `approval_request_one_running_idx` meant the employee could
  never resubmit. `CANCELLED` is the right status and 0008 said so before the function existed.
- **Later steps are RE-ROUTED when they materialize**, not replayed from the open-time assignment, so
  an approver who went on leave in between is skipped. `openRun` routing every step up front is
  validation: it catches an unroutable step 3 at submit time, while the employee is there to be told.
- **Remaining PENDING tasks become CANCELLED, not ExpenseOS's SKIPPED** — 0008 gave SKIPPED the
  meaning "a step the resolver could not fill", and conflating them makes "how often could we not
  find an approver" unanswerable.

**What VX2-4a shipped** (the ladder admin surface, split out of VX2-4 — the item §7 had carried
since VX2-1 asking whether it rode with VX2-4 or took its own ticket) —
`app/admin/approval-ladder/`, `lib/approvals/approver-token.ts`, `test/approver-token.test.ts`
(16 pure tests). A tenant can now configure who approves what without SQL.
- **An approver is ONE select, not five fields.** Each option encodes the kind and its companion in
  a single token — `MANAGER:2`, `ROLE:ADMIN`, `USER:<uuid>`. A kind dropdown plus a field per
  companion needs client JS to hide the irrelevant three and lets an admin save "a specific person"
  with nobody chosen, which is the half-configured state `approval_policy_approver_complete` refuses
  and ExpenseOS needed a zod schema to police (AP-11). The token makes it unrepresentable.
- **EMAIL approvers are NOT offered.** Stored by the schema, refused by the resolver until VX2-8, so
  offering one would let an admin save a ladder that breaks every submit in the tenant. Existing
  rows render read-only with a warning. Add it to `approverChoices` the day VX2-8 lands.
- **The codec is a PURE module, not in the `'use server'` file.** It is the contract between the page
  and the rows it writes, and one of its tests is a property: every choice the page offers must
  decode without throwing, so adding a kind and forgetting the decoder fails CI rather than on save.
- **Update replaces the rung's approver set wholesale**, which is `updatePolicy`'s documented
  behaviour — hence every approver of a rung being a select inside one form, and "set it to none and
  save" being how one is removed. No separate delete action to fall out of step.

**What VX2-4 shipped** — `lib/approvals/inbox.ts`, `app/approvals/`,
`app/expenses/[reportId]/approval-panel.tsx`, `test/approval-inbox.db.test.ts` (13 tests). A human
can now approve a report. The submit → approve round trip is reachable end to end by a person.
- **The inbox is defined by a SQL candidate query; `canDecide` only ever REMOVES from it.** That
  keeps the inbox and the decide path from disagreeing (AP-15) and gives the right answer for an
  admin: `canDecide` grants an admin any task, so filtering a broad query on permission alone would
  put every pending approval in the tenant in their inbox. An inbox means "waiting on ME" —
  assigned, delegated, or a role pool I hold; an admin reaches the rest from the report.
  COST: one `canDecide` per candidate, so ~60 round trips for an inbox of 20. If that ever matters,
  make `canDecide` batchable — do NOT reimplement it in SQL.
- **TWO access gates now, and they must stay separate.** `reachableReport` (ownership) for every
  WRITE, unchanged; `readableReport` (ownership OR approval interest) for reads only. Widening the
  single gate would have opened an edit hole: a recalled report is DRAFT again while its cancelled
  tasks remain, so a former approver would have been able to edit somebody else's draft.
- **Read access survives the decision.** "Has a pending task" would mean an approver approves and
  immediately cannot open what they approved, so cannot answer a question about their own decision a
  week later. Any task on any run of the report — assigned, decided, or a role pool they hold.
- **`canViewReport` is untouched.** MANAGER's reach opened THROUGH the existing predicate as an
  additional narrower grant, as this file required, not by editing it.
- **Deciding happens on the REPORT, not in the inbox.** No approve buttons in the list: an approver
  who has not opened the report has not seen what they are approving, and one-click approval from a
  list is how a rubber stamp gets built by accident.
- **`coveringFor` and `delegatedFrom` are different facts**, separated by a failing test.
  `delegated_from_id` is only set when the RESOLVER rerouted a task at creation time; the common
  case is a delegation created after submission, where the task stays assigned to the delegator and
  the delegatee is *covering for* them.

**What VX2-5 shipped** — `lib/approvals/delegations.ts`, `app/approvals/delegations/`,
`test/delegations.db.test.ts` (29 tests). **No migration**: `0008` shipped the table, VX2-2's
resolver already reroutes at routing time and VX2-4's `canDecide` already lets a delegatee act on a
task parked before the delegation existed. What was missing was a way to create one without SQL.
Phase 2's approval half is now complete and reachable by a person.
- **Arranging cover is SELF-SERVICE, not an admin errand.** The person who knows they are away is
  the person who can say so. Making it an admin request is how AP-5's incident happens — claims
  invisible in every queue, auto-rejected five business days later, 80 of 703 users affected.
  An ADMIN may additionally name a *different* delegator, and that check lives in
  `createDelegation`, not in the action: the page and the mutation ask the same function, so they
  cannot disagree (the AP-15 arrangement, same as `assertCanDecide`).
- **The page states the two things a delegation does NOT do**, because both surprise people and
  neither is discoverable: it does not take the work out of your own inbox (property (c)), and it
  does not chain (property (a), AP-16).
- **The one-hop truncation is DETECTED and named, not just documented.** If your stand-in has their
  own stand-in, the page says so — both names — on the row and again as a notice at creation.
  Computed for every listed row rather than only at create time, because the onward delegation is
  usually created *afterwards* (Alice arranges cover Monday, Bob goes away Wednesday), which is
  precisely the case a create-time-only warning would never catch.
- **`starts_on::text` / `ends_on::text`, deliberately.** `node-postgres` maps a `date` column to a
  JS `Date` at LOCAL midnight, so a delegation starting 2026-06-01 comes back as May 31st for
  anyone west of UTC and the UI shows the wrong day. These are calendar dates, not instants — the
  same reasoning `0008` gives for choosing `date` over `timestamptz` — and text is the only
  representation that survives the round trip. There is a test asserting the exact string, because
  a `Date`-typed assertion passes while the screen is wrong. `type="date"` submits 'YYYY-MM-DD',
  so there is no timezone anywhere in the path.
- **Overlaps are ACCEPTED, not refused.** 0008 leaves the tie-break to the resolver and VX2-2
  settles it by `created_at DESC` (property (b)); refusing an overlap here would refuse something
  the rest of the system already handles correctly. `onwardDelegation` uses the same ordering, so
  the warning names the person who would actually receive the work.
- **Revoked, never deleted.** `delegation_revocation_complete` requires both `revoked_at` and
  `revoked_by_id`, so the row can answer "who took my cover away, and when" — a deleted row cannot.
  Revoke is permitted to the delegator, whoever created it, and any admin; the button is rendered
  under exactly that condition, so it never appears where it would fail.
- **The delegatee is NOT allowed to revoke.** They are the obvious fourth candidate and they are
  excluded on purpose: declining cover is a conversation, not a database write, and letting them do
  it would let somebody silently drop a queue that is not theirs.
- **A non-ACTIVE delegatee is refused at creation.** Handing your approvals to somebody on leave or
  gone is a queue that goes nowhere — the resolver would skip up *their* manager chain, which is not
  what anybody meant by "cover for me".
- **Both ends of a delegation are audited** (`DELEGATION_CREATED`, `DELEGATION_REVOKED`), on the
  hash chain rather than as loose rows, and each flags whether an admin acted on somebody else's
  behalf. A delegation moves who may approve money; that is a control change.
- **ONE TEST WAS ADDED OUTSIDE THIS TICKET'S FILES, deliberately and not silently.**
  `test/routing.db.test.ts` gained *"refuses a delegatee who is the submitter of the report"*.
  `evaluate`'s self-approval refusal already ran ahead of the delegatee grant, and every other path
  into that guard had a test — assignee, admin override, claim pool — but the DELEGATEE path did
  not, because the resolver routes around a delegation whose delegatee is the submitter and so no
  such task could be created. **VX2-5 is what makes it reachable:** a delegation created AFTER the
  task exists never passes through the resolver, so a manager who hands their approvals to somebody
  whose report is already sitting in their queue hands over the ability to approve it. The code was
  already correct; the guarantee was untested on the one path this ticket opens.

**What VX2-7 shipped** — migration `0011` (four tenant tables), `lib/notifications/catalog.ts`,
`lib/notifications/service.ts`, `app/notifications/`, `app/notifications/preferences/`,
`app/admin/notification-templates/`, `test/notification-catalog.test.ts`,
`test/notifications.db.test.ts`, plus notification wiring inside `lib/approvals/engine.ts` and four
new cases in `test/rls-isolation.test.ts`. A decision now reaches the submitter, a submit reaches the
approver, and a recall tells the approvers whose queue just lost an item.

Read `docs/porting/GAP-AUDIT.md` NT-1..NT-16 before touching any of it. The three decisions that
shaped the ticket are in that file's "Decisions taken (2026-08-29)" table; the four below are the
ones a later reader will otherwise undo.

- **THE BOARD ASKED FOR A DESIGN EXPENSEOS HAD ALREADY DELETED, and this time it was caught before
  the migration.** The Phase-2 scope note says "template resolution exact → any-subject → shipped
  catalog string". That middle rung is not a feature — it is what a nullable `subject_type` KEY
  COLUMN looks like from outside, and their postmortem is explicit: *"That was not an identity, it
  was a set of coordinates … A flat catalog entry produced a row whose subject was NULL and therefore
  rendered as 'Any' … Nothing chose that mix — it fell out of the JSON."* So a template is one row
  per (`template_key`, `channel`), and `(event_type, subject_type) → key` is a lookup table in
  `catalog.ts` with a module-load collision guard. **This is the VX2-1 failure mode, and the reason
  it did not cost a rewrite this time is that the audit ran before the schema.**
- **A PREFERENCE CAN SUPPRESS AN IN-APP NOTIFICATION, WHICH EXPENSEOS CANNOT DO — and the mechanism
  matters more than the feature.** The row is written whenever ANY channel wants it, and the BELL
  filters on the IN_APP preference at READ time. Suppressing the row instead would make IN_APP a
  master switch: mute the bell and you silently mute the email VX2-8 sends from the same row. That
  trap is why `listInbox` / `unreadCount` / `markAllRead` all carry the same `NOT EXISTS` predicate
  and why `notifyRecipients` writes a row unless ALL THREE channels are off. **VX2-8 must not "fix"
  this by moving the check into the fan-out.** Consequence, tested: un-muting brings the history
  back, because nothing was thrown away.
- **`fromTemplate` is the field that makes the ticket's own acceptance criterion testable**, and it
  is there because ExpenseOS's version of that test did not work. Their comment: a test named
  *"falls back to default copy when the catalog has no digest strings"* *"asserted on the fallback
  copy while never once reaching it … passed only because those strings happen to be
  character-identical to the code's fallbacks. Rewriting the fallback in source left all 20 tests
  green. The test named a behaviour it could not observe."* When the shipped string and the stored
  template are equal, asserting the OUTPUT cannot tell you which path produced it. There is a test
  here that stores the shipped string verbatim as a template and asserts the two paths differ.
  **Assert the path, not the sentence** — the lesson generalises well past templates.
- **ONE THING WAS FOUND BY CHECKING RATHER THAN ASSUMING, and it would have been a runtime 22P02:**
  `audit_entry.entity_id` is typed `uuid` (`0010`), and a template's identity is its KEY — text. With
  `audit_entry_entity_complete` making it both columns or neither, the template audit entries carry
  no entity reference at all and put the key in `details`. The row id would have been the wrong
  answer anyway: a reset DELETES the row and leaves nothing to point at, while the key survives.

Smaller things, each with a reason worth not losing:

- **`activity.subject_id` is a polymorphic uuid with NO FOREIGN KEY**, because it cannot have one.
  Every other tenant table in this schema has an FK acting as a second line behind RLS; this one does
  not, so RLS is the whole guard. `test/rls-isolation.test.ts` therefore gained a join-walk case
  (notification → activity → `subject_id` → expense_report) AND a direct attempt at another tenant's
  real report id through that column. Both are in the suite because the table's exposure is not the
  same as the table's policy.
- **The stored preference map holds only OVERRIDES.** Absent = the code default, so adding an event
  type needs no backfill and nobody is pinned to today's default. That is why the preferences screen
  has THREE radio buttons per cell and not a checkbox: a checkbox would save "on" for everybody who
  had merely never expressed an opinion, and the property would be gone on the first save.
- **EMAIL and SLACK are shown on the preferences screen and DISABLED**, with the reason on screen.
  Nothing delivers on them until VX2-8, and a live toggle for a channel that cannot deliver is
  exactly the dead control NT-2 found in ExpenseOS — whose schema documents an `inApp` preference key
  that no code has ever read.
- **A fresh tenant has ZERO template rows and every message still renders.** Same shape as VX1-7's
  `DEFAULT_POLICIES` and for the same reason — "there is no second copy to drift". It also makes the
  acceptance criterion the NORMAL path rather than an edge case. Clearing a box on the admin screen
  DELETES the row, so "reset to shipped" and "shipped" are one state, not two that render the same.
- **A notification is written IN THE SAME TRANSACTION as the decision that caused it**, so a
  notification that cannot be written fails the decision. Same coupling VX2-3 chose for the audit
  row. The alternative is catching and carrying on, which loses notifications silently — and NT-11 is
  a record of what silent non-delivery costs ("un-diagnosable across several UAT rounds: no error, no
  log, no delivery"). A deliberate trade, not an oversight.
- **The actor is never notified about their own action**, filtered in one place rather than by each
  caller assembling a list that happens to exclude them. It is also what stops an admin
  self-approving under the AP-14 break-glass and receiving a bell about it.
- **Substitution is four rules and all four are ported with their reasons** (NT-6): named
  `{placeholder}` only and never an expression language; an unknown placeholder renders VERBATIM
  (`{amont}` is a visible typo, an empty gap reads as a product bug); only SCALAR payload entries
  become values (arrays are dropped rather than stringified as "[object Object]"); and `actor` is
  applied LAST so a payload key cannot shadow it. There is a test for each, including an end-to-end
  one with a payload carrying `actor: 'AN IMPOSTOR'`.
- **`SUBMITTED` and `REIMBURSED` are deliberately NOT event types.** The person who clicked Submit
  does not need telling that they clicked it, and `REIMBURSED` belongs to VX2-9 — an event type
  nothing emits is a preference row nobody can explain and a template nobody can test. There is a
  test asserting the list is exactly five, so adding one is a decision rather than a drift.
- **No `emailed_at`, no version table, no digest.** All three are ExpenseOS features whose reasons do
  not exist yet: `emailed_at` serves only the deferred digest, and a nullable timestamp nothing sets
  is indistinguishable from a bug. The pure `renderContent(content, values)` split IS ported, so a
  version table is additive rather than a rewrite.

**STILL NO ADMIN NAVIGATION, AND `/` IS STILL THE CREATE-NEXT-APP TEMPLATE.** This ticket adds three
more URL-only screens and — worse — an unread COUNT with nowhere to display it. A notification bell
is the first thing in this product that genuinely needs a global nav rather than merely wanting one:
`unreadCount` exists, is indexed for it, and no page outside `/notifications` can show it. The
cross-links now form a ring (`/approvals` ↔ `/notifications` ↔ preferences ↔ the ladder ↔ the
wording page). That is a stopgap and it is getting thin.

**HISTORICAL, kept because the reasoning still applies to the tickets left: VX2-4 CAME BEFORE
VX2-5**, a change from the board order. Both shipped (PRs #42 and #43). Everything the engine
does is currently unreachable by a human: there is no screen on which to approve anything, so the
whole of Phase 2 so far is exercised only by tests. VX2-5's delegation schema and resolver support
already shipped inside VX2-1 and VX2-2, so it is the smaller and later-costing of the two. VX2-4 is
also where MANAGER's reach finally opens, and it must open THROUGH the existing access predicates —
`canDecide` / `assertCanDecide` are the pair to render from and to gate on, never a second predicate
that happens to agree.

**RETENTION IS NOT BUILT.** The plan's Phase 2 bullet says "audit log + retention", and what
shipped is the log plus the two things retention will need: the `app.audit_purge` escape hatch and
the per-tenant watermark (`organization.audit_purged_through_sequence` / `_head_hash`, which the
verifier already reads so a purge reconciles instead of reading as tampering). The purge job itself
needs a ticket — it has no home on the board today.

**Two things VX2-2 did NOT close, both recorded rather than forgotten:**
- **Segregation of duties on the claim pool.** `canDecide` does not exclude the submitter's own
  subordinates from a ROLE pool. ExpenseOS does not either, and diverging would create a fresh
  dead end (in a small tenant the only other ADMIN may report to the submitter). The RESOLVER does
  exclude them where it picks a person itself. Closing the pool case needs a design that says what
  happens to the stranded task — its own ticket.
- **No TTL.** AP-8's expiry policy table is ported into the audit as a spec and nothing implements
  it. Every "assign it anyway and let expiry escalate" branch of ExpenseOS was replaced with
  something terminal because of this.

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

1. **KNOWN DEFECT IN SHIPPED CODE — `docs/porting/GAP-AUDIT.md`, finding PE-1.** Policy thresholds
   are currency-blind: `expense_policy.params.thresholdMinor` is a bare bigint compared straight
   against `amount_minor`, while `expense_report.currency_code` is per REPORT and a threshold is per
   TENANT. So a tenant with one USD report and one CAD report compares both against the same number
   — `500000` means $5,000 USD on one and about $3,650 USD on the other. VeloExpense ships CAD and
   USD, so this is live, not theoretical. **Needs a ticket** (policy currency + convert before
   comparing, adopting ExpenseOS's degrade-to-INFO-on-missing-rate rather than its silent fallback —
   see PE-7). Other open findings there: MO-2 (no `allocate` helper, so any future money split will
   lose or duplicate cents), PE-3, PE-4.


2. **Nothing here has been clicked by a human.** The Playwright happy path covers
   the main flow in a real browser, which is most of what a manual walkthrough
   was for, but nobody has looked at these screens. Worth 20 minutes before
   Phase 2 builds on top: MinIO up with `STORAGE_*` in `.env.local` (there are
   none today) and the bucket CORS rule; an `app_user` row in the demo tenant
   matching a real Google/Entra identity with `role='ADMIN'`; then "Restore
   starter rules" on `/admin/expense-policies`, or nothing will ever flag.
3. **VX2-8 next — delivery worker (email / Teams / Slack)** (VX2-1..VX2-7 are
   all done — see §5). It absorbs VX0-8's per-job tenant context and ships the
   approve-link token that finally makes EMAIL approvers routable (see the note
   at the top of `app/admin/approval-ladder/actions.ts`, which hides them until
   then). Read GAP-AUDIT **NT-11, NT-12 and NT-14 first** — they are three
   measured ExpenseOS incidents recorded specifically for this ticket: the
   silent integration gates ("no error, no log, no delivery"), the Slack id
   cache whose negative was cached for a week and whose positive was never
   re-checked at all, and `appOrigin()` reading the wrong environment variable
   so that every deployed notification went out with no link and no buttons.
   **And do NOT move VX2-7's IN_APP preference check out of `listInbox` into the
   fan-out** — §5 explains why that would silently mute email.
   Then VX2-9 reimbursement and VX2-10 Phase-2 isolation + e2e. The approval half of Phase 2 is complete and
   a person can submit, route, delegate, cover and decide end to end. What remains
   on the board: VX2-7 notification core · VX2-8 delivery worker (which absorbs
   VX0-8's per-job tenant context and ships the approve-link token that finally
   makes EMAIL approvers routable — see the note in
   `app/admin/approval-ladder/actions.ts`) · VX2-9 reimbursement · VX2-10 Phase-2
   isolation + e2e.

   **VX2-5 SHIPPED — the four properties below are now enforced and tested**, kept
   here because everything downstream still depends on them:
   **(a)** ONE hop, never a chain — A→B and B→C means a task of A's goes to B,
   not C (GAP-AUDIT AP-16). The recursive reading is intuitive and is also an
   infinite loop waiting to happen (A→B, B→A);
   **(b)** overlapping delegations break by `created_at DESC` — the newest
   instruction is the one the delegator meant. Ported, not invented;
   **(c)** a delegation does NOT take the task out of the delegator's inbox.
   Covering for somebody is not taking their queue away;
   **(d)** dates are inclusive on both ends, in the tenant's working timezone —
   0008 chose dates over timestamps deliberately, because "I am away these days"
   is not an instant and a half-open range invites an off-by-one at exactly the
   moment somebody is away and cannot fix it.
   Note `audit_entry` does NOT replace
   `expense_report_event`: that one is the report's user-facing timeline
   (from/to status), the audit log is the hash-chained compliance record across
   every entity type. Then VX2-2's resolver. The overlapping-delegation tie-break
   that 0008's comments leave to it is now ANSWERED from source, not invented:
   ExpenseOS orders by `created_at DESC` — the most recently created delegation
   wins (GAP-AUDIT AP-16, which also pins the one-hop rule: A→B, B→C means a
   task of A's goes to B, never C).

   **VX2-2's spec is now settled** — see the decisions table at the top of
   `docs/porting/GAP-AUDIT.md`, and AP-1, AP-5, AP-6, AP-10, AP-13. The five things
   that are NOT negotiable, because each traces to a measured ExpenseOS defect:
   (a) the self-approval check runs FIRST in the decision guard, ahead of the admin
   grant AND ahead of the assignee path — a privileged user approving their own
   report is a standard SOX exception and it shipped in ExpenseOS because the check
   sat thirty lines below `if (isAdmin) return true`; (b) the guard is enforced at
   DECISION time, not only at routing time, because VX2-4 and VX2-5 can move a task
   onto the submitter after clean routing; (c) an unresolvable MANAGER approver
   falls back to `ADMIN_FALLBACK` rather than parking or failing the submit — on
   ExpenseOS's dev data 11% of users had no manager; (d) a manager chain shorter
   than `manager_level` degrades to the most senior person found and records the
   shortfall in `escalation_level`; (e) the actor's own subordinates are refused
   transitively, using the existing cycle-guarded upward CTE in
   `lib/employees/service.ts` asked in the opposite direction. VX2-2 carries ONE
   migration, `0009`: `organization.allow_sole_approver_self_approval boolean NOT
   NULL DEFAULT false`, the audited break-glass without which a sole-admin SMB
   tenant's reports are undecidable by anyone. And every guard test runs twice,
   once with the caller's admin role set — a guard exercised only on the
   unprivileged path is how ExpenseOS's shipped.
4. **DONE — the approval-ladder admin surface shipped as VX2-4a**, its own
   ticket rather than riding with VX2-4. See §5. What remains unbuilt around it
   is navigation, not configuration.
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

6. **A tenant now needs TWO people who can approve each other's spend**, or the
   AP-14 break-glass flag. This arrived as a real failure, not a theory: the e2e
   signs in as `admin@demo.test`, who was the top of the seeded reporting line,
   and once submit began routing the ladder that user could not submit at all.
   The seed now has four users (`owner → admin → manager → employee`) and sets
   `allow_sole_approver_self_approval` for the demo tenant only. **Phase 5's
   self-serve onboarding has to satisfy this** — provisioning a one-person tenant
   produces a product that cannot submit an expense. No ticket exists.

7. **Local-dev credentials are committed in this file.** §3's setup block carries both
   connection strings inline, including the `postgres` superuser. Low severity for a throwaway
   container on localhost:5433, and it is genuinely convenient — but it is the first file a new
   contributor reads, so the habit propagates, and it matters the moment either password is
   reused somewhere that is not disposable. Cheap fix: move the two `export` lines to an
   untracked `.env.dev-admin` (or a direnv `.envrc`) and leave placeholders here.
   NOT a blocker; flagged because nobody had.

8. Dependabot has open PRs for **vitest 4** and **typescript 7** — major bumps
   across TEN suites now, and typescript 7 also touches the Playwright types.
   Take them deliberately, on their own branch.
