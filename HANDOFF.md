# VeloExpense — Build Handoff (context for a fresh thread)

_Last updated: 2026-08-25 (through VX1-6). Paste this whole file into the new thread as context._

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
  - **Global tables = reference data only** (currency, chart-of-accounts templates, country). Everything else is tenant-scoped.
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
  - `lib/tenant/context.ts` — `withOrg(orgId, fn)` sets `app.current_org` LOCAL; `withoutOrg(fn)` = service-role escape hatch.
  - `lib/tenant/request.ts` — `withCurrentOrg(fn)` bridges auth session → `withOrg`.
  - `proxy.ts` — Next 16 edge middleware (note: Next 16 renamed `middleware`→**`proxy`**; export a `proxy` function).
  - `lib/expenses/service.ts` + `app/expenses/actions.ts` — the VX1-4/VX1-6 pattern to copy for new domains (service = pure functions over a tenant `QueryRunner`; actions = thin `'use server'` wrappers).
  - `lib/employees/service.ts` + `app/admin/employees/` — VX1-2; also the pattern for an admin-gated surface.
  - `lib/receipts/service.ts` + `lib/storage/` + `app/receipts/actions.ts` — VX1-5; the storage seam. `lib/receipts/constants.ts` holds what the browser may import (the service pulls in `pg`).
  - `app/expenses/{page,layout,ui}.tsx`, `app/expenses/new/`, `app/expenses/[reportId]/` — VX1-6; the workbench, and the pattern for a user-facing (not admin) surface.
  - `lib/money.ts` — the ONLY place minor units convert. String/bigint math, never float.
  - `test/rls-isolation.test.ts` — the RLS gate; extend it for each new tenant table.
  - `scripts/seed.mjs` — `npm run seed` (demo + blank tenants, synthetic data; demo has admin/manager/employee with a wired reporting line).
- Migrations are plain SQL under `prisma/migrations/NNNN_name/migration.sql`, applied with `psql -f` (no Prisma migrate wired yet). Current: `0001_init`, `0002_reference_and_employees`, `0003_expense_reports`, `0004_employee_roles`, `0005_receipt_upload_state`.
- **Gotchas learned the hard way:**
  - `vitest.config.ts` sets **`fileParallelism: false`** — the DB suites share one Postgres and each `TRUNCATE`s in `beforeAll`. Parallel files race (duplicate slugs, FK violations). Do not remove while the suites share a database; give each new suite its own org slugs too.
  - `npx shadcn add` guesses a **`src/` layout** (the repo has `src/auth-kit/`), but `tsconfig` maps `@/*` → `./*`. After every add: `mv src/components/ui components/ui` and `mv src/lib/utils.ts lib/utils.ts`. lib-ui-kit ships no table/select/badge — those are hand-rolled against the vendored tokens in `app/expenses/ui.tsx`.
  - Authorization is read from `app_user.role` **inside the tenant transaction**, never from the session token.
  - A `<form>` may not be a child of `<tr>`. Editable table rows use the HTML `form="id"` attribute with the `<form>` elements rendered after the table — one form per row, still no client JS.
  - eslint's `react-hooks/immutability` rule rejects `window.location.href = url` in a client component; use `window.location.assign(url)`.

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
```
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

**Phase 1 remaining tickets** (see `…/ExpenseOS/Specifications_and_Planning/VeloExpense-Phase-1-Tickets.docx`):
- VX1-7 Policy engine v1 (ExpensePolicy + PolicyViolation tenant tables, validate-on-save, starter rules: per-transaction limit, receipt-required, category active, non-negative; inline warning panel; admin Expense Policies page).
- VX1-8 Submit + state gate (DRAFT→SUBMITTED, block on BLOCK violations, justify soft warnings, recall, audit row).
- VX1-9 Phase-1 isolation + Playwright e2e in CI.

## 6. Planning docs (in the ExpenseOS Google-Drive folder, `Specifications_and_Planning/`)
- `VeloExpense-Port-and-Build-Plan.docx` (7-phase plan + ExpenseOS→VeloExpense sync strategy)
- `ExpenseOS-vs-VeloExpense-Differences-Chart-rev2.docx`
- `VeloExpense-Phase-0-*.docx`, `VeloExpense-Phase-1-Tickets.docx`
- ExpenseOS status/dashboard docs + the live Cowork artifact `expenseos-dev-dashboard` (weekly refresh).

## 7. Immediate next action for the new thread
1. **Click the loop through in a browser** — VX1-6 was verified by typecheck, lint, the 50-test
   suite and `next build`, but never exercised in a real browser. Before it can be:
   stand up MinIO, set `STORAGE_*` in `.env.local`, **add the bucket CORS rule allowing `PUT`
   from the app origin**, and insert an `app_user` row in the demo tenant whose email matches
   your real Google/Entra identity (`role='ADMIN'` for the admin surfaces). The seeded
   `*@demo.test` users are synthetic and cannot sign in (invite-only SSO). Worth a close look:
   the line-item rows use the HTML `form="id"` attribute, which compiles and lints but has not
   been clicked.
2. **VX1-7 (policy engine v1)** is the next ticket. It adds the first new tenant tables since
   VX1-3 — so it needs `organization_id` + FORCE RLS + the `tenant_isolation` policy on both
   `expense_policy` and `policy_violation`, AND an extension to `test/rls-isolation.test.ts`,
   or CI's RLS-coverage guard fails the build. Hook `validate()` into the save path behind
   `assertDraft`, and render violations in the workbench (`app/expenses/[reportId]/page.tsx`
   already has an `ErrorBanner` and a card layout to hang a warning panel on).
3. Dependabot has open PRs for **vitest 4** and **typescript 7** — both are major bumps across
   all five test suites. Take them deliberately, not alongside a feature branch. Vitest 4 still
   honours `fileParallelism`, so the race fix survives.
4. When porting any ExpenseOS behavior: read the relevant ExpenseOS router/model as the spec,
   then re-implement tenant-scoped (server action + lib module + RLS + isolation test). Keep the
   graph approval engine and VCC/Travel OFF for MVP; NA-first. Note the ExpenseOS source files
   in Google Drive are `.ts`/`.tsx` — the Drive MCP needs `download_file_content` (base64) for
   those, not `read_file_content`.
