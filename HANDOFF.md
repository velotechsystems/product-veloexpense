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
- **A `'use server'` module exports its OWN `export async function`s and NOTHING else.**
  No re-export, no `export const`, no `export type`, no `export default`. Next registers
  every export of such a file as a server action; an export it cannot wrap makes it register
  **none of them** — the build stays clean and the page's forms fail in a browser with
  `Failed to find Server Action "…". This request might be from an older or newer deployment.`
  That message names a cause that is not the cause, and it cost a wrong diagnosis on VX2-10
  (`export { inspectToken };` in `app/approve/actions.ts`) before anyone read
  `.next/server/server-reference-manifest.json` and saw the page had no actions at all.
  A page needs a non-action helper from a lib module, it imports it from the lib module.
  CI's `npm run check:actions` guard fails the build on both halves of this — the export
  shape, and any page whose co-located actions file registered nothing.

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
- Migrations are plain SQL under `prisma/migrations/NNNN_name/migration.sql`, applied with `psql -f` (no Prisma migrate wired yet). Current: `0001_init` … `0014_chart_of_accounts` (fourteen; the list was stale at `0008` for six tickets — check `ls prisma/migrations` rather than trusting this line).
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
# VX2-8 env (all optional; each has a documented off state)
#   APP_URL          the origin every emailed link is built on. WITHOUT IT the mail
#                    still sends and carries no links at all — read GAP-AUDIT NT-14
#                    before deciding that is acceptable in a deployed environment.
#                    Falls back to AUTH_URL then NEXTAUTH_URL, so one variable can
#                    configure both auth and links.
#   SMTP_HOST        set it and mail is really sent (SMTP_PORT / SMTP_SECURE /
#                    SMTP_USER / SMTP_PASS, SMTP_FROM or EMAIL_FROM as sender).
#                    UNSET means the console transport: messages are written to the
#                    server log and nothing leaves the machine, which is the
#                    intended local default. EMAIL_TRANSPORT=console forces it even
#                    with SMTP_HOST set.
#   WORKER_SECRET    the bearer token for POST /api/internal/notifications/drain.
#                    UNSET means that route refuses everything (404) and the queue
#                    only moves via the admin screen's "Send waiting mail now".
#                    Fail-closed on purpose.
export APP_URL=http://localhost:3000
export WORKER_SECRET=dev-only-not-a-secret
# VX3-3 — REQUIRED to connect an accounting integration. Exactly 32 bytes,
# base64: the envelope refuses a passphrase or a wrong length rather than padding
# it, because accepting one means a product encrypted under eight bytes of
# entropy. The admin screen says so before anybody types a credential.
export SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
# The stub ledger is registered ONLY under this flag. Never set it in a deployed
# environment: it accepts every post and reports success, so a finance team would
# watch a queue drain to nowhere.
export INTEGRATIONS_ENABLE_STUB=1

# env for tests / app
export ADMIN_DATABASE_URL="postgres://postgres:velo@localhost:5433/veloexpense"   # superuser (test truncate)
export DATABASE_URL="postgres://veloapp:velo@localhost:5433/veloexpense"          # app role (RLS)
npm install && npm test && npm run build && npm run typecheck && npm run seed
# end-to-end (VX1-9): builds, starts its own S3 surface + the standalone server
npx playwright install chromium   # once
npm run e2e
# The e2e's S3 surface listens on 9401, NOT 9000 — a local MinIO on 9000 (the
# command in lib/storage/index.ts uses it) was being silently adopted by
# Playwright's port probe, which cannot tell MinIO from s3rver, and three receipt
# specs then failed about uploads with the storage sink's startup line simply
# absent from the log. The sinks are no longer reused either, so a busy port now
# stops the run and names itself. Both can run at once now.
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

**Phase 2 (approvals, notifications, audit) — COMPLETE (PRs #22–#47):**
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

**What VX2-8 shipped** — migration `0012` (two tenant tables),
`lib/notifications/{email,action-tokens,outbox,dispatch,approve}.ts`, a new
`withPlatformRead` in `lib/tenant/context.ts`, `app/approve/`,
`app/admin/notification-delivery/`, `app/api/internal/notifications/drain/`,
`test/delivery.db.test.ts`, four more cases in `test/rls-isolation.test.ts`, and
`nodemailer` as a dependency. An approver can now decide from an email without
signing in, and an admin can see whether the mail went out and why not.

**EMAIL ONLY.** Slack and Teams are their own tickets — see GAP-AUDIT NT-20/21 and
the decision table. ExpenseOS has no Teams code at all, so the board's title was
never costed; Slack is real but it is the larger half and email is a strict
prerequisite for it (their Slack buttons fall back to the same confirm page the
email links to).

- **THE QUEUE IS POSTGRES, NOT REDIS**, and this is the largest architectural
  divergence in Phase 2. ExpenseOS enqueues a BullMQ job consumed by a separate
  `apps/worker` process. Redis would be a new dependency of the image, of CI and of
  every laptop, and the admin queue screen would then read a datastore that is
  neither RLS-scoped nor backed up with the database. The precedent is VX1-9
  choosing `s3rver` over MinIO: "one Node process — no Docker for CI or a laptop."
  The cost is the four things BullMQ gives away, all written by hand in
  `outbox.ts`: the claim, the backoff, the visibility timeout and the dead letter.
- **`withoutOrg` DOES NOT SEE ACROSS TENANTS, and believing it does was the trap
  this ticket walked into.** It still connects as `veloapp` under FORCE RLS, so an
  unset `app.current_org` makes every policy body `organization_id = NULL`, which
  is NULL, which is not true — an unset context sees ZERO rows on every tenant
  table. That is a guarantee this schema has and the isolation suite asserts. A
  poller and an approve-link click both genuinely have no tenant, so `0012` gives
  its two tables a SECOND policy gated on `app.platform_task`, reached only through
  the new `withPlatformRead`. FOUR things keep it from being a hole, and a later
  reader should not relax any of them:
  **(a)** only two tables have the policy — it is not a master key, and adding a
  third is a migration somebody writes on purpose;
  **(b)** `FOR SELECT` only, so a platform task can FIND a row and never change
  one — it must switch into the tenant to act;
  **(c)** the policy bodies are NARROWED — the poller sees only due work, the token
  handler only unconsumed, unexpired tokens;
  **(d)** transaction-local, like `withOrg`.
  There is a test for each, including one proving the flag does nothing on
  `expense_report`, `audit_entry`, `app_user` or `notification`.
- **THE NARROWING TURNS A CHECK INTO A ROW THAT ISN'T THERE, which is better than
  a check.** ExpenseOS rejects a used or expired token with an `if`:
  `if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null;`
  Here the `platform_read` policy excludes both cases, so the token's tenant cannot
  even be resolved — the guard cannot be forgotten, reordered, or defeated by a
  clock the application reads instead of the database. The application `if` is
  ported anyway: two independent guards is the right number for a credential, and
  the second one covers the tenant-scoped read, where `tenant_isolation` is the
  policy in force and carries no expiry predicate.
- **A TOKEN AUTHENTICATES; IT DOES NOT AUTHORIZE.** ExpenseOS's header is the whole
  safety argument — "the caller still re-runs canDecide + the atomic claim, so it
  never bypasses authorization" — so the click goes through `engine.decide`, which
  opens with `assertCanDecide`, exactly as the browser does. And explicitly NOT
  with `isAdmin: true`: an admin clicking their own emailed link gets the authority
  the ladder gave them, and the override stays something done deliberately from
  the report by somebody signed in. The case that makes this matter is a link that
  has sat in a mailbox for four days, which is precisely when the approver may have
  been removed from the ladder or deactivated.
- **NOTHING HAPPENS ON A GET**, and of everything in this ticket this is the
  property most likely to be "simplified" later by someone who has not been bitten
  by it. Mail clients, link scanners and corporate security gateways prefetch links
  in mail — a GET that approved would be approved by Outlook on the recipient's
  behalf. `/approve` renders a question with the facts on it (who submitted, how
  much, which step, how many receipts); the decision is a POST.
- **THE CATCH IS OUTSIDE `withOrg`, deliberately.** `decideFromToken` consumes the
  token and then decides, in ONE transaction. Catching the engine's error inside
  would COMMIT the consume — burning a single-use credential on a decision that did
  not happen, so a recipient who forgot to tick the receipt box would find their
  link dead. Letting it escape rolls the consume back and the link still works.
- **`SENT` MEANS THE TRANSPORT ACCEPTED IT**, not that it arrived, and the admin
  screen says so in those words. A queue that says "sent" gets read as "delivered"
  and then the next question has nowhere to go. The screen also separates DEAD ("we
  tried and could not") from CANCELLED ("there was never anything to send"), because
  collapsing them puts "this is fine" and "somebody look at this" in one bucket.
- **The error text is stored and displayed VERBATIM.** NT-11 records two ExpenseOS
  incidents where a non-delivery produced "no error, no log, no delivery" and was
  "un-diagnosable across several UAT rounds". An SMTP rejection carries the reason —
  a bad address, a refused sender, a rate limit — and paraphrasing it is how
  "delivery failed" becomes all anybody can find out.
- **`appOrigin()` reads at CALL time from three variables**, ported from NT-14's
  incident: their deployment set `AUTH_URL` and the code read `APP_URL`, so "every
  notification email in a deployed environment went out with no link and no
  approve/reject buttons, which is indistinguishable from 'this notification was
  never meant to be actionable'." VeloExpense reads `AUTH_URL` in `auth.ts` and had
  no `APP_URL`, so it would have walked into exactly this. There is a test that
  unsets all three and asserts the mail still sends, carries no links, and mints no
  tokens for a link nobody can follow.
- **`Auto-Submitted: auto-generated` (RFC 3834)** on every message. Free, and
  impossible to derive from first principles — ExpenseOS's comment is the reason: "a
  machine-generated reply has to say so, or a well-behaved out-of-office responder
  answers it and the two of them keep going."
- **A retry re-mints and retires the previous links.** They cannot be reused —
  only the hash is stored, so the raw value is unrecoverable by design — and leaving
  them live would accumulate one credential pair per attempt for one task. Cost,
  stated because it is real: if an earlier attempt did reach the recipient, its
  buttons now fail and they land on a page that says so.
- **An admin retry resets `attempts` to 0 and KEEPS `last_error`.** Without the
  reset a DEAD row dies again on the next poll and the button appears to do nothing;
  keeping the error means the screen can still say what went wrong while the new
  attempt is in flight. So `attempts` means "attempts since the last manual retry",
  and the column is documented that way rather than pretending to be a lifetime
  count.
- **The drain route is fail-closed and returns 404, not 401.** With `WORKER_SECRET`
  unset it refuses rather than running open — an unconfigured deployment should have
  a queue that does not move, not an endpoint anybody can post to. 404 because an
  endpoint that says "wrong password" confirms it exists.
- **`drainOutbox` is the same function the route, the admin button and the tests
  call.** VX1-9's lesson was that a path only tests exercise proves nothing about
  what ships.
- **One unreachable branch is marked as such:** `prepareEmail`'s "recipient has no
  email address" cannot fire, because `app_user.email` is `text NOT NULL` (`0001`).
  It is kept because that non-nullability is an accident of the SSO model rather
  than a decision about notifications, and there is deliberately no test — no
  fixture can produce it.

**THE MEMORY TRANSPORT PROVES COMPOSITION, NOT DELIVERY**, and VX1-9 already paid
for this lesson: "MemoryStorage signs `memory://` URLs no browser can fetch, which
is exactly how every vitest suite stays green while a real upload is broken."
Everything in `test/delivery.db.test.ts` proves the message was composed and the
outbox behaved. Nothing in it proves SMTP works. **VX2-10 needs a real sink** — an
in-process SMTP server is the `s3rver`-shaped answer, and it is the only way the
e2e can assert that an approver receives a link and can click it.

**THE SCHEDULER LIVES OUTSIDE THE CODEBASE.** Nothing calls
`/api/internal/notifications/drain` yet — a cron entry, an ECS scheduled task or a
platform cron has to, and until it does the queue only moves when an admin presses
"Send waiting mail now". That button exists precisely because a queue that depends
on an unconfigured external thing looks broken on the day it ships. Two consequences
worth knowing: the polling interval IS the delivery latency, and the admin button
drains ACROSS TENANTS (the poller has no tenant), which is defensible while this is
one deployment per customer set and is the first thing to revisit if that changes.

**What VX2-9 shipped** — migration `0013` (three columns, no new table),
`lifecycle.reimburseReport` + `lifecycle.listPayableReports`, a sixth event type in
`lib/notifications/catalog.ts`, `app/admin/reimbursements/`, and
`test/reimbursement.db.test.ts`. **Phase 2's exit criterion is met: a report now
goes submit → route → notify → decide → reimburse, end to end, in a browser.**

Read GAP-AUDIT RB-1..RB-8 before touching it. Four things a later reader will
otherwise undo:

- **THE DOUBLE-PAYMENT RACE IS REAL IN THEIR CODE AND FIXED IN OURS.** ExpenseOS
  reads the status in one query and writes with `where: { id }` — the update never
  re-asserts what the read checked — so two concurrent calls both commit,
  producing two audit rows and two notifications for ONE payment, on the single
  transition in this product that means money left the building. Ours is
  `UPDATE … WHERE id = $1 AND status = 'APPROVED'` with a `rowCount !== 1` check,
  and the read above it exists only for the error message. **This is the fourth
  appearance of that shape in the port** — VX2-3's decision claim, VX2-8's
  `consumeActionToken`, VX2-8's `claimDelivery` — and the fourth time the answer is
  a conditional write rather than a lock. There is a test that runs two real
  overlapping transactions and asserts exactly one payment happens.
- **YOU MAY NOT PAY YOUR OWN REPORT**, and ExpenseOS has no such check anywhere on
  that path — a static permission is the whole authorization. That is hard to
  defend in a codebase whose `canDecide` ordering exists because self-APPROVAL is a
  SOX-grade control (AP-13): approval is an opinion that money *should* move,
  payment asserts that it *did*. The exception is **AP-14's existing break-glass,
  reused rather than duplicated**, because the forcing case is identical — a tenant
  where the admin who submits is the only person who can act. `0013` widens that
  column's COMMENT to say it now governs payment too. Its NAME under-describes it,
  and that was the accepted cost: one flag with a stale name beats two flags where
  the second is never set. The audit row records
  `selfReimbursedUnderBreakGlass`, so "who paid their own claim" is a query.
- **A REIMBURSEMENT RECORDS DATE, ACTOR AND AN OPTIONAL REFERENCE.** Theirs writes
  one column and passes `details: {}` to its own audit call — while the same file
  passes real details from `decide` and `setFxOverride`, so the emptiness was
  considered rather than forgotten. Diverged because `approved_at` already existed
  (the asymmetry reads as a bug), and because the reference is the only thing
  connecting the flag to the money. Two CHECK constraints hold it together: the
  timestamp and actor move as a pair, and `(status = 'REIMBURSED') = (reimbursed_at
  IS NOT NULL)` — so a bug that stamped the columns without moving the status
  cannot leave a report that has been paid and still looks payable.
- **THE LEDGER HAND-OFF IS AT APPROVAL, NOT PAYMENT**, and this is the finding
  Phase 3 needs. ExpenseOS calls `postApprovedReport` only from `decide` /
  `decideBulk`, with the reason in the comment: *"An approved report is a
  liability, so NetSuite gets it now rather than when somebody remembers."*
  `markReimbursed` touches no accounting function at all. So `REIMBURSED` is a
  bookkeeping-free flag asserting AP paid out-of-band — which is why VX2-9 is
  honestly a one-day ticket rather than one with something left out, and why the
  accounting adapter must hook approval. "Post it when we pay it" is the intuitive
  and wrong answer.

Smaller, each with a reason:

- **The sixth event type was a deliberate addition, and a test made it visible.**
  `test/notification-catalog.test.ts` pins the taxonomy to an exact list, so adding
  `REIMBURSED` failed that test until the list was updated on purpose. That is
  exactly what the pin is for — VX2-7 left the event out because "an event type
  nothing emits is a preference row nobody can explain", and VX2-9 is when
  something started emitting it.
- **The shipped copy deliberately does NOT use `{reference}`.** The reference is
  optional at payment time, and an absent placeholder renders VERBATIM (NT-6 rule
  2) — so a tenant that never records one would send "`{reference}`" to every
  claimant. A tenant that always records one can add it to their own wording.
- **The notification is inside the transaction**, where theirs is fired after the
  commit and un-awaited with no catch. Same choice VX2-7 made and for the reason in
  `notifyTaskOwner`: NT-11 is a record of what silent non-delivery costs.
- **The AP screen says "this does not pay anybody" in those words.** "Mark
  reimbursed" invites the reading that pressing it moves money, and the only thing
  worse than a queue nobody works is a queue somebody works believing it does more
  than it does. It also declines to sum a mixed-currency list — PE-1 is a live
  reminder of what happens when a figure quietly assumes one currency.
- **Payment is refused only on status.** Not on receipts, not on unresolved
  violations, not on a zero total. Those were questions for the submit gate (VX1-8)
  and the approval gate; asking them again at payment time would refuse a report
  somebody has already approved. Ported as-is — RB-8 records that theirs makes the
  same choice.
- **`assertDraft()` already froze the report**, so VeloExpense is structurally
  ahead of a live defect on their side: their `setFxOverride` carries NO status
  guard and can recompute the total of an already-reimbursed report, changing the
  amount after the payment it describes.

**THERE IS NO UNDO, and VX2-9 does not add one.** `REIMBURSED` is terminal and it
also freezes the report, so a mis-clicked payment has no route back except SQL.
ExpenseOS has no reversal either. This is a real gap and it is deliberately
unticketed here rather than folded in: reversing a payment flag is a control
question — who may, and what the audit trail says about it — not a status write.

**What VX2-10 shipped** — `scripts/e2e-mail.mjs`, `e2e/approval-flow.spec.ts`, a second
session in `e2e/auth.setup.ts`, `test/chain-verify.check.ts` with its own
`vitest.chain.config.ts`, two new CI steps, and `smtp-server` as a devDependency.

**PHASE 2 IS COMPLETE.** Eleven tickets (VX2-1..VX2-10 plus VX2-4a), migrations `0008`
through `0013`, and the plan's exit criterion — a full submit → approve → reimburse
round trip — is now not merely true but PROVEN in CI, in a browser, through a real
mail server.

- **THE E2E SENDS REAL MAIL, and that is the whole point of the ticket.** Every VX2-8
  test runs on the in-memory transport, which proves a message was composed and
  nothing about whether mail works. VX1-9 had already written down what that costs:
  *"MemoryStorage signs `memory://` URLs no browser can fetch, which is why the
  vitest suites can be green while a real upload is broken."* The specific failure
  only a real server can catch: **quoted-printable breaking an approve token across
  two lines.** nodemailer encodes long lines, an approve link is a long line, and the
  result would be every approve link in production dead while 24 tests stayed green.
  `scripts/e2e-mail.mjs` decodes QP for exactly that reason, and the comment there
  says so — if you ever wonder why a test sink parses MIME at all, that is why.
- **THE APPROVER DECIDES WITH NO SESSION.** The spec opens the emailed link in a
  browser context with `storageState: { cookies: [], origins: [] }` — an empty one,
  not the default project state — because a person who never signs in is the entire
  feature. A spec that reused the signed-in context would pass on a build where the
  token did nothing.
- **NOTHING HAPPENS ON THE GET, asserted rather than asserted-in-a-comment.** The
  spec loads the approve page, checks the report is STILL `SUBMITTED`, and only then
  presses the button. Mail scanners and security gateways prefetch links; this is the
  guard on the property most likely to be "simplified" later.
- **THE DRAIN GOES THROUGH THE ROUTE, not the library.** It is the only place the
  bearer-secret gate is exercised, and the gate is fail-closed — so a broken
  `WORKER_SECRET` wiring would otherwise surface as "no mail ever arrives" with
  nothing pointing at why. There is also a test that posts with no secret and with a
  wrong one, and expects 404 both times.
- **REIMBURSEMENT IS DONE AS THE APPROVER, NOT THE SUBMITTER**, and that needed a
  second minted session. The demo tenant has the AP-14 break-glass ON, so paying as
  the submitter would have exercised the EXCEPTION and quietly stopped testing the
  control (RB-3). `owner@demo.test` is both the submitter's manager and an ADMIN, so
  they are the approver and the person who can pay.
- **CHAIN VERIFICATION NOW ACTUALLY RUNS ON EVERY BUILD**, and before this it did
  not. What ran was `verifyChain` over rows the audit suite wrote itself — which
  proves the verifier works and says nothing about whether the PRODUCT writes a
  verifiable chain. `test/chain-verify.check.ts` runs after the seed and the e2e,
  per tenant, over rows the app wrote through its real paths. The failure it exists
  to catch is a caller handing `append()` a payload the canonicalizer treats
  differently — a BigInt, a key order, a Date rendered two ways — which no unit test
  written beside that caller would notice, because it would hash and verify
  consistently within itself.
  - **It is `.check.ts`, not `.test.ts`, and excluded from `npm test`.** Two reasons,
    the first of which is not obvious: `test/rls-isolation.test.ts` inserts audit rows
    with DELIBERATELY fake hashes (`'a'.repeat(64)`, with a comment saying it tests RLS
    and not the chain), so a real verification running after it would fail on correct
    code. And it is only worth anything after the seed and the e2e, which `npm test`
    precedes.
  - It also asserts the chain CONTAINS `APPROVAL_RUN_OPENED`, `REPORT_APPROVED` and
    `REPORT_REIMBURSED` — because a verifier that scanned zero rows would otherwise
    pass, and a regression that stopped auditing decisions would produce a smaller,
    still-valid chain.
- **A SECOND RLS GUARD: every tenant table must APPEAR IN the isolation suite.** The
  existing guard proves each has a policy; this one greps the suite for each table
  name. They are different claims and the second is the one that rots — a table added
  with correct RLS and no test is asserted by nobody, and the first guard would stay
  green forever.

Smaller:

- **The e2e's amount is £18.50, under the $25 receipt threshold**, deliberately: this
  spec is about approvals and `expense-flow.spec.ts` owns the policy gate. A useful
  side effect is that it exercises the *no receipts attached* warning on the approve
  page, where the default rung still asks the approver to confirm they reviewed them.
- **The spec asserts BOTH links are present** (approve and reject, in that order), so
  a change to the order in `dispatch.ts` fails here rather than silently rejecting
  things somebody meant to approve.
- **`Auto-Submitted: auto-generated` is asserted on the wire**, not just in the unit
  test — it is the header that stops an out-of-office responder and the app arguing
  with each other indefinitely (NT-18).
- **The mail sink logs SMTP errors rather than throwing.** A dead sink turns one
  informative failure into every later test timing out on a port that stopped
  answering.

**WHAT THE E2E STILL DOES NOT COVER**, so nobody reads "e2e green" as more than it is:
the login page (SSO cannot run in CI — VX1-9's trade, unchanged), delegation and the
approver inbox in a browser, the notification preferences screen, the template wording
screen, and Slack anything. The first is deliberate; the rest are simply untested by a
browser and would be the obvious content of a Phase-2 follow-up e2e if one is ever
wanted.

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

**What VX3-1 shipped** — migration `0014` (two global template tables, one tenant
table, two columns and a trigger), `lib/accounts/{csv,validate,service}.ts`,
`app/admin/chart-of-accounts/`, the GL snapshot in `lib/expenses/service.ts`,
`test/{coa-csv,accounts.db}.test.ts`, four new isolation tests, and a seed that
gives the demo tenant a real chart. **The chart-of-accounts debt from Phase 1 is
closed.**

Read GAP-AUDIT AC-9, AC-10, AC-14 and TN-1 before touching it. Five things a
later reader will otherwise undo:

- **THIS ONE COULD NOT BE PORTED, AND THAT IS THE FINDING.** ExpenseOS DELETED its
  vendor-neutral account table (`20260617233000_drop_expenseos_account`), so
  accounts exist there only as `NetSuiteAccount` — a cache filled by a twice-daily
  SOAP pull — with no template, no accounts seed and no manual-entry screen. Their
  own seed comment states the resting position: a category's GL account is null
  *"when NetSuite has never synced, which is the normal state of a fresh
  environment"*. Fine for one company that certainly has NetSuite; not fine for a
  product. **So the shape comes from VeloLedger's `public.account` instead**, which
  is the right source twice over: house sibling, and the reference adapter Phase 3
  posts to.
- **THE ACCOUNT NUMBERS ARE VELOLEDGER'S, VERBATIM, AND THAT IS THE FEATURE.**
  All 28 rows of the `na-expense-claims` template come from
  `product-veloledger/docs/Starter-Chart-of-Accounts.csv`. VX3-4 posts by matching
  on `number`, so a "tidied" number here silently breaks the adapter — there is a
  test pinning four of them for exactly that reason. It is the EXPENSE-CLAIM subset
  of their 279: a claim cannot reach a balance-sheet account, a salary line or
  deferred income tax, and shipping those would be 250 rows of picker noise.
  68100/68200 stay split because **meals are 50% deductible in Canada** and merging
  them is a tax error, not a simplification.
- **`is_postable` IS DERIVED, NEVER PASSED IN.** Ported from VeloLedger
  `0028_account_postable`, whose comment records the incident: rollups used as
  headings, nothing preventing postings, and *"the 'invoice posted but IS shows no
  revenue' bug where a line hit 40000 and vanished from the presentation"*. They
  had to BACKFILL the flag because a manual value had drifted from the tree; here
  the validator derives it and *errors* if a CSV declares it wrongly, and
  `createAccount` demotes a parent in the same transaction as adding its first
  child. VeloExpense has no journal, so the guard is a trigger on the two places
  an account is chosen — a category's mapping and a line's snapshot — which is
  what makes it hold for paths nobody has written yet.
- **THE LINE SNAPSHOTS ITS ACCOUNT ON WRITE** (AC-10), so a report posts to the
  account it was coded to when it was filed, not to wherever its category points
  months later. Re-stamped ONLY when the category changes; amount, tax and
  description edits leave it alone. Nullable, and a null blocks nothing — theirs
  and worth keeping: *"a category with no account is a configuration gap, and the
  employee filing the expense is not who fixes it."*
- **DEACTIVATE IS THE REMOVAL; DELETE IS THE EXCEPTION.** `removeAccount` refuses
  anything with a category, a line or a child, and the screen only offers it when
  all three are zero. A snapshot that can vanish is not a snapshot.

Smaller, each with a reason:

- **`expense_category.gl_account` (text) was DROPPED, not kept alongside.** Its only
  reader was one SELECT, and the seed's values (630500, 640100, …) were invented
  numbers matching no chart anywhere — a column that looks authoritative and
  resolves to nothing. ExpenseOS made the same free-text → FK move and recorded the
  same reason.
- **Templates are GLOBAL, and `0001_init` already said they would be**: its comment
  names "chart-of-accounts starter templates" as global reference data alongside
  `currency`. The CI RLS guard keys off an `organization_id` column, so the two
  template tables are correctly outside it — do not add one to make the guard
  happy.
- **Instantiation is two passes in one transaction**, and the second pass is a
  comma-join with every predicate in `WHERE`. That is not style: an UPDATE's target
  table cannot be referenced from a JOIN condition inside FROM (*"invalid reference
  to FROM-clause entry for table g"*). It typechecked, it linted, and it would have
  left every account parentless. Found by running it against a real Postgres.
- **Instantiating over a populated chart is REFUSED**, as is importing over one.
  Half one template and half another is not a chart. Replacing a populated chart is
  a different operation — it invalidates every mapping — and it deliberately does
  not exist yet.
- **The CSV import is all-or-nothing** and carries line-numbered errors to the
  screen. Ported from VeloLedger's `import-coa` CLI minus its CSV hash, which
  exists there to make a bootstrap re-runnable and is unnecessary here because an
  import into a populated chart is refused outright.
- **`0014`'s three FKs are COMPOSITE, through `organization_id`** — see TN-1. The
  other 43 in this schema are not, which is VX3-10.

**What VX3-2 shipped** — migration `0015` (one global table, two columns),
`lib/policy/rates.ts`, currency conversion in `lib/money.ts`, the threshold-currency
panel on `/admin/expense-policies`, `test/policy-rates.test.ts` and nine new
cross-currency cases in `test/policy.db.test.ts`. **PE-1 is closed: VeloExpense has
no live defects.**

Read GAP-AUDIT PE-1, PE-3 and PE-7 before touching it. Five things a later reader
will otherwise undo:

- **THE LINE IS CONVERTED INTO THE THRESHOLD'S CURRENCY, not the reverse.** A
  threshold is what an admin typed; converting it would print a number nobody chose
  back at them, and it would drift every time a rate moved. The consequence to keep:
  the finding's message names BOTH currencies whenever a conversion happened,
  because "is $700.00, over the $500.00 limit" with one figure USD and the other CAD
  is the sentence that hid this defect for two phases.
- **A MISSING RATE IS AN INFO FINDING, NEVER A GUESS.** ExpenseOS's v2 predicate
  path returns the unconverted amount when a rate is absent, so 10,000 JPY minor
  units get compared against a CAD threshold with no signal at all (PE-7). Ours
  emits `fxRateMissing` at INFO and does not block — an unenforceable rule must not
  become an outage caused by a missing reference row. That needed PE-3
  (`Finding.severity?`), which is now in.
- **A RULE WITH NO AMOUNT MUST NOT BE ABLE TO DEGRADE.** "Every expense needs a
  receipt" is about presence, so `RECEIPT_REQUIRED` with no floor is checked BEFORE
  any conversion is attempted. A BLOCK that a missing rate can quietly turn into a
  note is not a control. There is a test for exactly that.
- **RECIPROCALS ARE DERIVED, NOT STORED.** `fx_rate` holds one direction;
  `rates.ts` inverts. This is PE-7's bug avoided at the source: ExpenseOS's source
  is the Bank of Canada, which publishes CAD-quoted pairs, and its lookup is
  forward-only — so an admin who correctly set a US entity's policy currency to USD
  found EVERY CAD amount unconvertible, which their GA audit recorded as "CAD
  excluded from totals". Two stored rows for one pair can disagree; a derivation
  cannot. **No triangulation**: an unknown pair returns null and degrades loudly
  rather than routing through a pivot and rounding twice.
- **RATES ARE BOUNDED BY THE REPORT'S OWN DATE.** A report filed in March is judged
  against March's rate, so re-validating an old report does not change its findings
  because the market moved. The bound is the latest `txn_date` the report carries,
  falling back to today.

Smaller, each with a reason:

- **The conversion is BigInt throughout** — `convertMinor` in `lib/money.ts`, one
  rounded division with no intermediate truncation, half-even so a long run does not
  drift upward. ExpenseOS uses dinero.js for this; adding a dependency to multiply
  two integers would have broken the house rule that `lib/money.ts` is the only
  minor-unit converter. `rateToScaled` REFUSES a rate with more than eight decimals
  rather than truncating one, because a truncated rate silently moves every
  threshold it touches.
- **`minor_unit` comes from the `currency` table, never from 100.** Every currency
  this product ships has two decimals and JPY has none; there is a test converting
  JPY both ways for the day that matters.
- **`0015` SEEDS NO RATES.** A plausible-looking rate in a global table is worse
  than an absent one — stale from the moment it is written, with nothing saying so.
  `scripts/seed.mjs` inserts one obviously-round fixture pair (USD->CAD at 1.35, a
  fixed `as_of`) so the demo tenant and the e2e can convert, and it inserts only ONE
  direction so the derivation is exercised by default rather than only by a unit test.
- **The admin screen warns BEFORE the reports do.** The panel lists which report
  currencies cannot be converted into the policy currency, because an admin who
  changes that setting and gets it wrong otherwise finds out through INFO findings on
  individual reports, one at a time.
- **A new rule has no currency select; an existing row does.** A rule created
  without one uses the tenant's currency, which is the right default for nearly
  every rule; the row select is where a tenant with two entities changes it.

**STILL MISSING, and now the honest gap in this area: there is no rate SOURCE.**
`fx_rate` is a table an admin cannot yet write to and no job fills. The demo seed is
the only writer. A scheduled Bank-of-Canada fetch (their source, and it is free and
unauthenticated) plus a manual-entry screen is a small ticket and it is unticketed —
until it exists, a tenant with two currencies gets INFO findings rather than
enforcement, which is at least loud.

**What VX3-3 shipped** — migration `0016` (one tenant table), `lib/crypto/secrets.ts`,
`lib/integrations/{contract,registry,stub,service}.ts`, `app/admin/integrations/`,
four new test files and two new isolation tests. **A tenant can connect a ledger,
test it, and disconnect it, and core can find an adapter without knowing a vendor
name.** No real ledger yet — that is VX3-4.

Read GAP-AUDIT AC-1..AC-5 before touching it. Six things a later reader will
otherwise undo:

- **THIS IS THE ONE FILE IN THE PORT THAT IS DESIGNED, NOT PORTED**, and the Plan
  asks for it in as many words. AC-1: ExpenseOS has no adapter contract —
  `IntegrationDescriptor` is pure metadata with no function members, and NetSuite is
  reached by direct import from four routers and four workers, a
  `switch (input.slug)` whose default returns an error string, and five vendor-named
  job types. With one accounting system that is the cheaper engineering. The Plan's
  risk register: *"define the accounting-adapter contract once (VeloLedger) so
  QuickBooks/Xero/Sage are repeatable; avoid per-vendor special cases leaking into
  core."*
- **RESOLUTION IS BY CAPABILITY. Core never asks which vendor a tenant is on.**
  `resolveCapability(tx, 'POST_EXPENSE_REPORT')`. AC-5 is why this matters: ExpenseOS
  declares a closed capability union, asserts it at boot, stores it on every row —
  and a grep for those seven strings outside the registry returns ZERO hits, because
  real gating is `requiresIntegrations: ['netsuite']`. A taxonomy that reads as an
  identity from outside and is decided by something else in fact is the NT-4 shape.
  **VX3-8's diff is the test of whether this held**: adding QuickBooks must touch no
  file in core.
- **NO REFLECTION TABLE, and that is a deliberate divergence.** ExpenseOS upserts a
  global `Integration` row per descriptor at boot. AC-2 records the cost: stale rows
  are never pruned, and the whole reconcile is one try/catch whose failure their own
  test describes — *"a typo … silently skips the ENTIRE reconcile, so no module or
  integration row is created or updated, and every module-gated page 404s with
  nothing in the logs pointing at the cause."* `0006` already had the better
  convention: *"validated against the code registry, NOT a CHECK constraint."* So
  `integration_slug` is text, the registry is code, and there is nothing to
  reconcile, prune, or fail silently at boot.
- **THE ENCRYPTION KEY NEVER LEAVES THE APP.** AES-256-GCM in Node, versioned
  envelope, key read at CALL time from `SECRET_ENCRYPTION_KEY`. ExpenseOS does the
  equivalent with pgcrypto — `pgp_sym_encrypt(${plaintext}, ${key})` — so the key
  travels to the database on every read and write. They are bind parameters rather
  than statement text, so this is not the disaster it first sounds like, but Postgres
  can be configured to log bind parameters and the key then exists in the database
  process too. GCM rather than CBC because it AUTHENTICATES: a tampered credential
  fails to decrypt instead of returning plausible bytes.
- **`decryptSecret` REFUSES AN UNMARKED VALUE.** This is the tolerance not ported.
  Theirs passes any non-`enc:v1:` value through untouched — and `bootstrap.ts` writes
  a Google client secret straight into `config` without ever calling the encrypt
  helper, so an env-bootstrapped installation stores a password-marked secret in
  cleartext and the reader accepts it silently (AC-4). We have no legacy rows to be
  tolerant of. `auditSecrets()` exists to find that state if a future writer creates
  it, and there is a test that simulates exactly their bug.
- **ONE ACTIVE INSTALLATION PER INTEGRATION**, a partial unique index in `0016`.
  AC-3: theirs resolves with `installations: { where: { active: true }, take: 1 }` and
  NO ordering, so two active installations pick arbitrarily and nothing detects it.
  Several installations are still allowed — that is what `code` is for, and two
  QuickBooks companies for two subsidiaries is a real shape — but only one active.

Smaller, each with a reason:

- **Availability is read at CALL time; shape is checked at module LOAD.** The first
  version read `process.env` at load and a test could not vary it, because ES imports
  are hoisted and the registry loaded before the test body ran. NT-14 had already
  written the rule for `appOrigin()`. The collision and capability-pairing guards do
  NOT depend on the environment, so they stay at load — a declared capability with no
  method behind it is a startup failure, not a `TypeError` mid-post.
- **`assertAdapterShape` and `assertNoDuplicateSlugs` are exported** so a test can
  see them fire. A throw at module load cannot be asserted on, and a guard nobody has
  observed working is NT-5's shape: *"the test named a behaviour it could not
  observe."*
- **`0016`'s FK is composite and RESTRICT.** Composite per TN-1. RESTRICT because the
  first version was `SET NULL (connected_by_id)`, which CONTRADICTS the paired
  `(connected_at IS NULL) = (connected_by_id IS NULL)` CHECK — nulling the actor while
  the timestamp stays set violates the pair, so deleting the user failed with a check
  error instead of clearing attribution. Only a delete surfaces that. RESTRICT is also
  right on its own terms, and is what `0013` chose for `reimbursed_by_id`.
- **DISCONNECT DESTROYS THE CREDENTIAL.** The row stays, so the history of what was
  connected and by whom survives and a reconnect keeps its `code`; the secrets are
  removed from the jsonb, not merely blanked on the way out. A disconnect that leaves
  a working credential in the database is not a disconnect.
- **A secret is ABSENT from the screen, not masked.** Masking implies the value is
  present and merely hidden, which is how one ends up in a page's HTML source. An
  existing secret shows an empty box and the words "already set"; blank means unchanged.
- **A THROWN adapter is a failed test, not a failed request.** An admin pressing
  "test" is asking a question and an exception page is not an answer.
- **The stub adapter is real and drives the tests.** Same argument as VX2-8's MEMORY
  transport and VX1-9's s3rver, and the same warning: VX1-9 recorded that
  *"MemoryStorage signs `memory://` URLs no browser can fetch, which is why the vitest
  suites can be green while a real upload is broken."* A stub reachable in production
  would be worse, so it is behind `INTEGRATIONS_ENABLE_STUB`.

**What VX3-4 shipped** — migration `0017` (one tenant table), `lib/outbox/policy.ts`
(shared with VX2-8), `lib/integrations/{post-outbox,dispatch,veloledger}.ts`, the
enqueue hook on the approval transition, `/api/internal/ledger/drain`,
`app/admin/ledger-queue/`, and `test/ledger-post.db.test.ts`. **An approved report
now reaches VeloLedger as a draft AP bill.**

Read GAP-AUDIT AC-6, AC-7, AC-8 and AC-11 before touching it. Six things a later
reader will otherwise undo:

- **THE TRANSPORT IS HTTP, NOT MCP, AND THE PLAN'S WORDING MISLEADS.** The Plan says
  "the VeloLedger MCP adapter". The TOOLS are MCP tools; the transport cannot be —
  `product-veloledger/lib/mcp/server.ts` says so itself: *"Transport: stdio (standard
  MCP local-server pattern). Phase 3 adds SSE/HTTP"*, and that is VeloLedger's Phase
  3, not ours. A server action cannot speak stdio to another product across a
  network. What IS reachable is their REST v1 route over the SAME registry —
  `POST /api/v1/<tool>` with a bearer key, and *"adding a new MCP tool automatically
  exposes it at /api/v1/<name>"*. So the adapter calls tools by name over HTTP, and
  the names and payloads are already right for the day an HTTP MCP transport exists.
- **IT DRAFTS; IT DOES NOT POST, and that is a feature.** `draft_bill`'s banner:
  *"agents draft AP vendor bills; humans post via UI."* VeloExpense proposes a
  payable and somebody in VeloLedger posts it, so a mis-configured expense system
  cannot corrupt a general ledger. A BILL rather than a journal because RB-6 is right
  about what an approved report is — *"an approved report is a liability"* — and that
  is accounts payable.
- **AC-11 IS SETTLED, and the answer fell out of the above.** The adapter never
  writes `REIMBURSED`. There is no payment to observe, because nothing has been
  posted yet — so VX2-9's human action keeps its self-payment control and its
  NOT-NULL-paired actor. ExpenseOS's poller being the only writer of `REIMBURSED` in
  its whole NetSuite loop is a consequence of its adapter posting directly, which
  ours does not.
- **THE ENQUEUE IS ON THE TRANSITION, IN THE APPROVING TRANSACTION.** Beside the
  audit append in `lib/approvals/engine.ts`, guarded on `reportStatus === 'APPROVED'`
  so an intermediate step of a multi-tier workflow does not queue anything. AC-6:
  ExpenseOS hangs its post off FOUR call sites plus a 30-minute sweep, and one of
  those was added after a report that auto-approved on submit was *"silently never
  sent to NetSuite"*. It is also enqueued whether or not anything is connected —
  whether a ledger exists is the poller's question, so a tenant connecting next week
  finds last week's approvals waiting.
- **`NEEDS_REVIEW` IS THE STATE AC-8 EXISTS TO DEMAND, and the poller CANNOT SEE
  IT.** It means the ledger accepted the bill and recording that here failed. `0017`'s
  narrowed `platform_read` policy does not match the status, so the row is invisible
  to the poller even if a future change forgot to exclude it. Compare theirs: the same
  situation is written as a retryable FAILED row with *"do NOT re-post"* in
  `lastError`, and their sweep re-posts it five times — an instruction addressed to a
  human and enforced against nobody.
- **A FAILURE IS EITHER REFUSED OR AMBIGUOUS, and conflating them is the bug.**
  401/403/404/422 were refused before the handler ran, so nothing exists upstream and
  the row stays retryable. A timeout, a network error or a 5xx MIGHT have applied, so
  the row becomes `NEEDS_REVIEW`. `isDefinitelyNotApplied()` is how the adapter tells
  the caller which. A plain thrown Error defaults to AMBIGUOUS, which is the safe
  direction.

Smaller, each with a reason:

- **The retry POLICY is shared; the TABLES are not.** `lib/outbox/policy.ts` holds
  MAX_ATTEMPTS, the backoff table and the claim timeout, and VX2-8's mail outbox now
  imports it. AC-7 said "do not build a queue" and the substance is honoured — nobody
  has to learn two sets of backoff semantics — but a mail delivery and a ledger post
  differ in payload, terminal states and audience, and merging the tables would have
  put a migration on working notification machinery into this PR.
- **The idempotency key is derived from the report id and NEVER regenerated.**
  VeloLedger namespaces it per API key server-side and refuses a second bill carrying
  the same one, so a retry after an ambiguous failure cannot double-post at the far
  end. A key that changed per attempt would make the mechanism decorative. This is a
  much better position than AC-8's NetSuite equivalent, whose only guard was
  `externalId` uniqueness asserted by no test in a transport marked *"UNVERIFIED
  against a live account"* — we keep `NEEDS_REVIEW` anyway, because a guard that
  depends on the other system behaving is not the guard.
- **`markNeedsReview` takes NULL, not `''`, for an unknown external id.** `0017` has a
  partial unique index on `(organization_id, external_id)`, so two empty strings in
  one tenant collide, the second write fails, and the row falls back to RETRYABLE —
  the one outcome the state exists to prevent. There is a test with two simultaneous
  ambiguous failures.
- **`testConnection` says what it has NOT proven.** It calls `list_entities`, a READ
  tool open to every role, so a key without `system_integrator` passes the test and
  fails on the first real report. The message says so rather than implying a working
  connection.
- **An unmapped GL account fails the POST, not the filing.** VX3-1's snapshot is
  nullable on purpose, but a bill line must name an account — so the adapter refuses
  with the category names in the message, which is actionable, and the employee who
  filed the expense is never involved.
- **Tax is passed through with NO recoverable account.** Which account an input tax
  credit posts to is a tax-engine decision this product has not made, and inventing
  one would put ITCs somewhere wrong quietly. Their schema makes the account optional.
- **Two drain routes, not one.** A mail outage must not stop approved reports reaching
  the ledger, and a ledger outage must not delay a notification. One route would
  couple the schedules and give an operator one number where two are needed.

**WHAT VX3-4 DOES NOT DO:** it does not pull a chart of accounts (that method exists
on the adapter and is VX3-5's to wire), it does not read payment status back, and it
has never spoken to a real VeloLedger — every test drives the stub. The first real
connection will find something; `testConnection` and the queue screen exist so that
what it finds is legible.

**What VX3-5 shipped** — migration `0018` (two columns, a widened key, one relaxed
constraint), `lib/accounts/pull.ts`, a "Pull from the ledger" button on the
chart-of-accounts screen, and `test/account-pull.db.test.ts`. **A connected tenant
can reconcile its chart against the ledger's.**

Read GAP-AUDIT AC-12 before touching it. Five things a later reader will otherwise
undo:

- **A MATCHING ACCOUNT IS ADOPTED, NOT DUPLICATED, and this is the ticket.** A
  pulled account whose NUMBER matches an existing row stamps that row's
  `external_id` and turns it `PULLED` — the same row, the same id. So a tenant that
  instantiated the starter template on day one, mapped its categories, and filed
  expenses for a month has none of that re-pointed when it connects a ledger. The
  test asserts the id is unchanged and the category mapping survives, because that
  is the property, not the row count.
- **AND THAT IS WHY VX3-1 TOOK VELOLEDGER'S NUMBERS VERBATIM.** For a VeloLedger
  tenant the match is near-total by construction. It is the payoff for resisting a
  tidy-up in `0014`, and the test pinning four of those numbers is what protects it.
- **ORPHANS ARE REPORTED, NEVER DEACTIVATED.** ExpenseOS deactivates them from its
  sync — "rows no longer present upstream are marked isActive = false (never
  hard-deleted…)" — and the never-hard-deleted half is right, because a line's
  `gl_account_id` is a SNAPSHOT and a snapshot that can vanish is not one. The
  deactivating half is not: a tenant whose ledger stops reporting an account it has
  been coding to for a year should be TOLD, not have its categories quietly
  unmapped by a job. The screen names them and leaves them usable.
- **AN EMPTY RESPONSE IS REFUSED.** An empty chart is far more often a wrong entity
  id or a permission problem than a genuinely empty ledger, and acting on it would
  report every local account as orphaned at once. Same instinct for DUPLICATE
  NUMBERS: refused before any write, because silently picking a winner is how a
  tenant ends up coding to the account it did not mean.
- **`is_postable` IS DERIVED FROM OUR TREE, NOT THE LEDGER'S VIEW.** A pull rebuilds
  parents by number and then recomputes the flag from who has children. The ledger's
  idea of a rollup is not necessarily ours, and VeloLedger's own `0028` is the
  record of what a stale flag costs.

Smaller, each with a reason:

- **`0014`'s `source_template` CHECK had to be RELAXED, and the reason is worth
  keeping.** It asserted "TEMPLATE is the only source that names a template", which
  was true when written and false the moment adoption exists: a template row the
  ledger has confirmed is `PULLED` and still, factually, came from that template.
  The first version of `pull.ts` hit the constraint on the adoption path and a test
  found it. Provenance is KEPT rather than cleared — clearing the column to satisfy
  the old rule would have destroyed information to preserve an assumption that had
  stopped being true.
- **The external-id key now includes the installation**, which `0014` said in a
  comment it eventually would. AC-12 is why it matters: ExpenseOS's seven caches are
  keyed `netsuiteId @unique`, install-global, with no tenant or installation column,
  so that schema cannot hold two ledgers side by side at all — which is exactly what
  the Plan's exit criterion asks for.
- **NO sync-run table, and that is the lesson rather than an omission.** ExpenseOS
  has one with a ten-minute stale-run reclaim, and their comment says why: "one dead
  run wedges every future sync forever with 'already running' — which once froze the
  reference cache for ~3 weeks." A reclaim is a fix for a LOCK. A pull here is a
  button, one HTTP call, one transaction, and holds no lock — so there is no run to
  wedge. If a scheduled background sync is ever added, that comment in `0018` is
  where to start, and the heartbeat reclaim is the part to bring.
- **The fetch is outside any transaction**, the reconcile inside one — same structure
  as the post dispatcher, and for the same reason.
- **`last_seen_at`'s value is not the point**; which rows a completed pull did NOT
  touch is.

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

### Phase 3 board, drafted 2026-08-29 — NO SOURCE DOCUMENT EXISTS FOR THIS ONE

Phases 0, 1 and 2 each had a tickets document. **Phase 3 does not.** The Plan describes it as five
prose work items plus an exit criterion and defers sizing until its open inputs are confirmed (all
four are now confirmed at their assumed defaults — §2 of the Plan). This board is therefore drafted
from the Plan's Phase-3 prose, the Differences Chart's accounting rows, and the source audit
recorded as GAP-AUDIT **AC-1..AC-15**. Read those fifteen findings before picking up any ticket
here; four of them change what the ticket is.

The Plan's Phase 3, verbatim:

> Integration registry per tenant; build the VeloLedger MCP adapter as the reference (post approved
> reports/expenses; pull chart of accounts). Then QuickBooks Online, then Xero, then Sage — same
> adapter contract; per-tenant credentials (encrypted). Generalize/gate NetSuite-specific fields so
> non-NetSuite tenants never see them; NetSuite becomes one optional adapter.
> **Exit:** a tenant connects VeloLedger and posts an approved report end-to-end; QuickBooks in a
> second tenant.

**The one thing to understand before reading the table.** Every phase so far has been a port, and
the standing rule is to port from source rather than build fresh. Phase 3 is the exception the rule
already contains, because the Plan asks for it in as many words: *"define the accounting-adapter
contract once (VeloLedger) so QuickBooks/Xero/Sage are repeatable; avoid per-vendor special cases
leaking into core."* AC-1 confirms there is nothing to port — ExpenseOS has no adapter contract at
all, and reaches NetSuite by direct import, a `switch (slug)`, and five vendor-named job types. With
one accounting system that is the cheaper engineering; with four it is the thing the Plan's risk
register warns against. **So VX3-3 designs, and the rest port.** What IS portable is listed against
each ticket.

| ID | Title | Acceptance | ~d |
| --- | --- | --- | --- |
| VX3-1 | Chart-of-accounts templates + per-tenant accounts | A new tenant picks a starter template at setup and gets its OWN accounts; a category maps to one; a line snapshots it on write; both tenant tables have RLS and appear in the isolation suite; the global template tables are reference data only | 3 |
| VX3-2 | Currency-aware policy thresholds (PE-1) | A tenant with a USD report and a CAD report compares each against a threshold in ITS currency; a missing rate degrades to INFO rather than passing silently; the existing policy suites stay green | 2 |
| VX3-3 | Per-tenant integration registry + the adapter contract | A tenant connects an integration without SQL; credentials are encrypted at rest and never leave the server; two tenants' installations cannot see each other (isolation test); one interface, no vendor name in core; adding a second adapter touches no shared file | 4 |
| VX3-4 | VeloLedger adapter — post an approved report | Approving a report enqueues a post in the SAME transaction as the audit row; the post is idempotent under concurrent attempts (two overlapping transactions, one post); an upstream failure never changes the report's status; posted-upstream-but-unrecorded is a state no automatic path may retry | 4 |
| VX3-5 | Pull the chart of accounts and reconcile | Connecting a ledger fills the tenant's accounts; an account withdrawn upstream deactivates rather than disappears, and historical mappings still resolve; a second run is idempotent; a stale run cannot wedge the next one | 2 |
| VX3-6 | Posting queue, dry run and manual push | An operator sees what is unposted and why, in words; a dry run writes nothing; a manual push is audited and attributed; a withheld report stays withheld | 2 |
| VX3-7 | Generic tenant dimension sets | A tenant defines its own cost dimensions and maps them per integration; no vendor name appears in a core table, a shared enum, a permission slug or an audit action; a tenant with no integration sees no integration fields anywhere | 2 |
| VX3-8 | QuickBooks Online on the same contract | A SECOND tenant connects QBO and posts end to end; the diff that adds it contains no change to core or to the VeloLedger adapter — that diff is the acceptance test for VX3-3 | 3 |
| VX3-10 | Composite foreign keys on every tenant-to-tenant FK (TN-1) | A tenant cannot reference another tenant's row — refused by the constraint, with the trigger/app layer removed from the test; one isolation assertion per FK; a CI guard fails the build on a new tenant-to-tenant FK declared the weak way | 3 |
| VX3-9 | Phase-3 isolation + e2e | Two tenants on two different ledgers, side by side, in CI; the RLS guards still pass; the e2e posts a real report through a stub ledger and asserts the payload | 2 |

~27 dev-days across ten tickets. VX3-10 was added on 2026-08-29, mid-VX3-1, when testing `0014`'s constraints turned up TN-1 — 45 tenant-to-tenant foreign keys that accept another tenant's id, because Postgres checks referential integrity with RLS bypassed. It sits late in the order only because nothing else waits on it; by severity it could go first. Build order is the table order, and only two edges are
hard: VX3-1 blocks VX3-4/5 (an adapter cannot pull a chart into tables that do not exist), and VX3-3
blocks both adapters. VX3-2 is independent of everything and can go in parallel or first — it is on
this board because a currency defect underneath something that posts amounts is the wrong order, not
because it is accounting work.

**What each ticket ports, so nobody rebuilds what exists:**

- **VX3-1** — the shape is net-new (AC-9: ExpenseOS DELETED its vendor-neutral `Account` table, so
  accounts exist only as a NetSuite cache and there is no template anywhere). But AC-10's
  stamp-on-write is portable almost verbatim, including the sentence *"a category with no account is
  a configuration gap, and the employee filing the expense is not who fixes it"*, and AC-14 says
  what the mapping-gap control must check that theirs does not.
- **VX3-3** — port the REGISTRY, design the CONTRACT. AC-2: descriptor in code, DB row as a
  reflection, cross-references validated before any write. AC-4: the pgcrypto-in-the-config-blob
  design with a version marker and UI-schema-driven secret marking — port it and **drop its
  tolerance of unmarked plaintext**, which is how their own env-bootstrap path stores a Google secret
  in cleartext. AC-3: `code`-keyed multi-installation, made unique per organization. AC-5:
  capabilities must either be what resolves the adapter or not ship.
- **VX3-4** — AC-6 (the trigger is approval, from four call sites in their code because it hangs off
  callers; here it goes in `lib/expenses/lifecycle.ts` beside the audit append, where a new caller
  cannot forget it), AC-7 (**do not build a queue — VX2-8's outbox already is one**, and a row in the
  approving transaction cannot be lost by a Redis hiccup, which removes both the fire-and-forget
  trade and the 30-minute sweep that compensates for it), and AC-8 (their "posted but not recorded"
  row is automatically re-posted five times with the words *do NOT re-post* in its error column;
  the answer is the conditional write this codebase has used five times).
- **VX3-5** — AC-12: port the soft-deactivate and the stale-run heartbeat reclaim (their comment:
  *"one dead run wedges every future sync forever … which once froze the reference cache for ~3
  weeks"*), and drop the global `netsuiteId @unique` for `(organization_id, installation_id,
  external_id)`.
- **VX3-7** — AC-13 is the list to design against, and it is preventive here rather than remedial:
  VeloExpense has no vendor columns yet. `LegalEntity` → `LegalEntityExternalId` is the pattern on
  their side that already does this correctly; copy that, not the columns.

**Open inputs, named rather than guessed:**

1. **Who owns "paid" — the poller or the person? (AC-11)** ExpenseOS's payment poller is the ONLY
   writer of `REIMBURSED` in its entire NetSuite loop; VX2-9 made reimbursement a human action with a
   self-payment control and a `NOT NULL`-paired actor. Both are coherent; they cannot both be the
   authority. This is a controls decision and it belongs to VX3-4, not to a planning pass.
2. **Does NetSuite ship as an adapter in this phase at all?** The Plan says only that it *"becomes
   one optional adapter"*. Nothing in the exit criterion needs it, and building it would mean porting
   ~7,500 LOC of SOAP and REST whose posting transport carries its own *"⚠️ UNVERIFIED against a live
   account"* warning. Recommendation: not in Phase 3.
3. **Xero and Sage are explicitly after the exit criterion** and are not on this board. Two adapters
   prove a contract; four only prove it more expensively.
4. **Spec-baseline tags (AC-15) are now blocking, not tidy.** The Plan and the Chart were written
   against ExpenseOS `fb1cead`; `~/ExpenseOS` is at `5a11a647`, and the accounting surface is
   demonstrably among what moved. Tag `accounting` at `5a11a647` before VX3-3 starts.

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
3. **THE PHASE 3 BOARD NOW EXISTS — §6, nine tickets, ~24 dev-days.** Drafted 2026-08-29 from the
   Plan's Phase-3 prose, the Differences Chart's accounting rows, and a full source audit of the
   ExpenseOS accounting surface recorded as **GAP-AUDIT AC-1..AC-15**. There is no Phase-3 tickets
   document and there never was one, so that board and the audit behind it ARE the specification.
   Start with the audit, not the board: four of the fifteen findings change what a ticket is.

   The three inputs that were in hand before the planning pass, and what the audit did to each:

   **(a) THE CHART-OF-ACCOUNTS TABLES ARE STILL MISSING** — now **VX3-1**, first ticket of the
   phase, and worse than "not yet built": AC-9 found that ExpenseOS **deleted** its vendor-neutral
   `Account` table (`20260617233000_drop_expenseos_account`), so accounts there exist only as a
   NetSuite cache filled by a twice-daily SOAP pull, and there is no chart-of-accounts template
   anywhere in their codebase. **This one cannot be ported. It has to be designed.** Three things
   wait on it: the adapter's "pull chart of accounts", Module 12's `GL_MAPPING_GAP`, and Phase 4's
   Budgets, where `Budget.glAccountId` is a REQUIRED FK to the NetSuite cache.

   **(b) THE ADAPTER HOOKS APPROVAL, NOT PAYMENT** (RB-6) — confirmed and widened by AC-6: their
   post is enqueued from FOUR call sites, including one added after a report that auto-approved on
   submit was *"silently never sent to NetSuite"*, plus a cron sweep covering a TTL path with no hook
   at all. The lesson is structural: the trigger hangs off callers there, and belongs on the
   transition here — `lib/expenses/lifecycle.ts`, beside the audit append. And AC-7 is the phase's
   free win: **do not build a queue.** VX2-8's outbox already is one, and a row written in the
   approving transaction cannot be lost, which removes both their fire-and-forget trade and the
   sweep that compensates for it.

   **(c) PE-1 IS CLOSED** — shipped as VX3-2 (migration `0015`). **VeloExpense has no live defects.**
   What replaced it on the untracked list is narrower and loud rather than silent: `fx_rate` has no
   SOURCE. No job fills it and no screen writes it, so a tenant with two currencies gets INFO
   findings instead of enforcement until someone loads a rate. A scheduled Bank-of-Canada fetch —
   their source, free and unauthenticated — plus a manual-entry screen is a small ticket.

   **Two things the planning pass turned up that are worth acting on separately:**

   - **AC-8 is a real defect in their shipped code, on the money path.** The "posted to NetSuite but
     recording the result failed" row is written as `FAILED` with `attempts` incremented, and the
     sweep re-posts exactly that row up to five times — with the words *do NOT re-post* sitting in
     its error column, addressed to a human and enforced against nobody. The only thing between that
     and a double liability is NetSuite rejecting a duplicate `externalId`, and the transport
     carrying that claim is marked *"⚠️ UNVERIFIED against a live account"* in its own header. Fifth
     appearance of RB-2's shape; same answer, a conditional write.
   - **AC-15: tag the spec baseline before VX3-3.** The Plan and the Chart were written against
     ExpenseOS `fb1cead`; `~/ExpenseOS` is now at `5a11a647`, and the accounting surface is
     demonstrably among what moved. Plan §6 has asked for `veloexpense-spec/<module>-YYYYMMDD` tags
     since the beginning and `git tag -l` still returns nothing. Phase 2 could live without them.
     Phase 3 cannot, because this is the one module the Plan's own sync strategy flags as unstable.
     **John action — this session has no git.**

   **The unticketed list is 20 items long** (see the tracker). Two graduated onto the board (CoA,
   PE-1). Still unticketed and now load-bearing: per-tenant RBAC (RB-4 — "may release payments" and
   "may read every expense in the company" are one grant), the audit retention purge, a reversal path
   for a mis-clicked reimbursement (RB-5), an admin navigation and a landing page, and Slack/Teams
   (NT-20/21 — Teams has no ExpenseOS source at all).

   **§6 correction, 2026-08-29:** `VeloExpense-Phase-2-Tickets.docx` IS in Drive after all — 13,595
   bytes, created 2026-08-27, and 13.5 KB matches the size §6 records as the good original. §6 says
   a Drive-wide title search found nothing on 2026-08-27; a title search on 2026-08-29 finds it. The
   transcribed board stays regardless — it cost nothing and the document has now been mislaid twice.

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
