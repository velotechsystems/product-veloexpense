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
  - **RLS GUARDS READS. IT DOES NOT GUARD FK TARGETS.** Postgres runs referential-integrity
    checks as the constraint's OWNER with row-level security BYPASSED, so a plain
    `REFERENCES app_user(id)` accepts another tenant's id — no policy is consulted, and a
    superuser connection or a permissive policy makes no difference either way. **Every
    tenant-to-tenant FK is therefore COMPOSITE through `organization_id`:**
    ```sql
    ALTER TABLE <target> ADD CONSTRAINT <target>_org_id_uniq UNIQUE (organization_id, id);
    ALTER TABLE <src> ADD CONSTRAINT <src>_<col>_fkey
      FOREIGN KEY (organization_id, <col>) REFERENCES <target> (organization_id, id);
    ```
    Declare the composite FK AFTER the `UNIQUE` it references — Postgres validates at
    `CREATE TABLE`. `ON DELETE SET NULL` must NAME ITS COLUMN (`SET NULL (<col>)`); the
    unqualified form nulls `organization_id` too, which is `NOT NULL`, so the delete fails.
    `MATCH SIMPLE` is the default and what we want: a NULL in any referencing column skips
    the constraint, so a nullable FK stays nullable. Migration `0019` converted the 42 that
    predated the rule (GAP-AUDIT TN-1); a CI guard and `test/tenant-fk.db.test.ts` keep the
    count at zero.
- **An adapter's PREREQUISITES are the adapter's business.** `available()` on the
  adapter decides whether a tenant may connect it, read at CALL time (NT-14).
  `registry.ts` must not name a slug — it used to (`a.slug !== 'stub-ledger' || …`),
  which is the shape `check:vendor` exists to stop and only escaped it because
  "stub-ledger" is not a vendor name. This is also what lets an adapter ship dormant:
  QuickBooks reports unavailable until the platform's credentials exist.
- **Session var name is `app.current_org`** (locked; do not use `app.current_organization_id`).
- **Architecture = Next.js server actions + `lib/<domain>/` modules. NO tRPC** (matches VeloLedger; the original plan said tRPC — overridden).
- **Shared libs are VENDORED, not npm deps.** Copy the lib's `src/` into the app and pin the commit. `@velotech/auth-kit` is vendored at `src/auth-kit/` (pinned `e1db5c1`). `@velotech/ui` tokens are vendored at `app/velotech-tokens.css` + `app/tailwind-v4.css`; components come via `npx shadcn add https://velotechsystems.github.io/lib-ui-kit/r/<name>.json`.
- **Git flow: this repo uses MERGE-COMMIT PRs (not squash).** So stacked branches are simple: `git fetch origin && git checkout -b <next> origin/main`. Always fetch before branching (local `origin/main` goes stale between merges).
- **Every new tenant table** must have RLS + be added to the isolation test, and **every FK it points at another tenant table must be composite** (above). Three CI guards fail the build otherwise: RLS coverage, isolation-suite coverage, and the tenant-FK guard.
- **NO VENDOR NAME OUTSIDE `lib/integrations/<vendor>.ts`.** Not in a table, a column, a type, a
  CHECK literal, a shared enum, a constant, an audit action or a permission slug. Core resolves an
  integration by CAPABILITY — `resolveCapability(tx, 'POST_EXPENSE_REPORT')` — and vendor-specific
  DATA lives in a row (`integration_installation.integration_slug`), never in DDL. Comments are
  exempt: naming what ExpenseOS did with NetSuite is how this project keeps its reasoning.
  `npm run check:vendor` fails the build otherwise, and it found a real one the first time it ran
  (GAP-AUDIT AC-17).
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
# VX3-8 — QuickBooks Online. PLATFORM-level, not per tenant: one Intuit app serves
# every tenant, and each tenant authorises that app against their own company. The
# same shape NT-18 established for email transport, and for the same reason.
#
# WHILE THESE ARE UNSET, QUICKBOOKS IS INVISIBLE: `available()` returns false, so no
# tenant can see or connect it. Setting them is the whole activation step — no
# migration, no code change, no release.
#   QUICKBOOKS_CLIENT_ID
#   QUICKBOOKS_CLIENT_SECRET
#   QUICKBOOKS_ENVIRONMENT   'production' switches the API host off sandbox.
#                            Unset means SANDBOX, which is the safe default.
# APP_URL is also REQUIRED for this: the redirect the far end sends the admin back
# to is built from it, and the authorise action refuses with a sentence rather than
# guessing an origin.

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

### What can and cannot be verified without a Mac — CORRECTED 2026-08-30

A standing assumption in these notes was wrong and cost a round trip on VX3-8. The
claim was "the device VM cannot build, so typecheck is John's step". Only the first
half is true.

| Command | Runs in the Linux VM over the mounted repo? | Why |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | **YES** | `tsc` is pure JavaScript. Verified: it caught a planted `const x: number = "s"` with exit 2, and passes clean otherwise. |
| `npx eslint` | **YES** | Same reason. |
| `npx vitest run` | YES (with a database) | |
| `next build` | **NO** | Turbopack/SWC load NATIVE binaries, and `node_modules` on the mounted volume is macOS while the shell is Linux. |
| `npm run check:actions` | **NO** | It reads `.next/server/server-reference-manifest.json`, so it needs a build first. |

**So typecheck and lint are NOT John's step and never were.** VX3-8 shipped six
`TS2345` errors — an `IntegrationError` code union I extended in one file and not in
its declaration — that `npm test` could never have caught, because **vitest transpiles
without type checking**. One `tsc --noEmit` before handing over would have caught all
six. Run it, every ticket, before writing out the commands.

`next build` and `check:actions` cannot run on the DEVICE, which is also the pair
that catches a broken `'use server'` module (VX2-10) and any `.tsx` mistake.

**They do NOT need the Mac, though — corrected 2 Sep during VX4-5 part 2.** The cloud harness has a
Linux `node_modules`, so `npm run build` and `npm run check:actions` both run there, and so does the
full Playwright suite (point the chromium project's `launchOptions.executablePath` at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, and set `AUTH_SECRET` or `auth.setup.ts`
refuses to mint a session). The only container-copy edit still needed is stubbing the two `Geist`
calls in `app/layout.tsx`, because egress blocks `fonts.googleapis.com`. So a ticket that touches a
`.tsx` no longer has to hand the build over unverified — VX4-5 part 2 did not.

**TWO files now carry container-only edits: `app/layout.tsx` and `playwright.config.ts`.** Neither
may be copied back to the device wholesale — patch them in place. VX4-7 part 3 copied
`playwright.config.ts` over and shipped the container's `launchOptions.executablePath` into the
commit; CI has no browser at that path, so all 123 specs failed to launch with
`browserType.launch: Failed to launch chromium because executable doesn't exist`. The habit that
prevents it: before shipping, `md5` every modified file on both sides and patch, don't copy, any
that differ. **And `npm run check:harness` now enforces it** — `scripts/check-harness-leak.mjs`,
first step in CI, fails the build on a harness path in committed source, on a Playwright config that
pins a browser binary, and on a `next/font/google` import whose loader is never called (the font stub
is a deletion, so that contradiction is the only trace it leaves). It is NOT in `npm run e2e`: the
harness has both edits applied and is correct when it does.

### The device shell has no GitHub credentials, and its `main` is ancient
`git fetch` fails there ("could not read Username for 'https://github.com'"), and the local `main`
in that checkout is still at **PR #11**. So `git checkout main` there silently moves the whole tree
back to Phase 1 — it happened once, and was recovered by checking the feature branch out again. Git
READS are fine (`git --no-optional-locks log/status/diff`); branch switching and fetching belong in
John's own terminal, where `gh` is authenticated as `Velotechsys`.

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

### Writing a Playwright spec you cannot run
`tsc` and `eslint` pass on a spec built entirely of selectors and fixtures that do not exist —
they type-check strings. VX3-9a burned two CI rounds on that: six elements matching an adapter
name, a connect form that disappears once connected (so CI's one retry failed differently and hid
the real failure three tests later), a `getByText` on an input's `defaultValue` that could never
fail, invented button labels, a category called **Travel** the seed does not have (68100 is the
ACCOUNT's name; the category is Ground Transportation), a $125 report with no receipt that the
starter BLOCK rule stops at submit, and an approval done as the SUBMITTER when the seeded
reporting line routes it to `owner@demo.test`.

So before pushing a new spec:
1. **Take selectors from a passing spec**, not from the component read once. `expense-flow` owns
   the workbench, `approval-flow` owns submit→approve→reimburse and the `.auth/*.json` states.
2. **Check the fixtures the assertions name** — category labels, account numbers, who approves —
   against `scripts/seed.mjs` and the migration, not against what the names suggest.
3. **Assume the file re-runs from the top** (`retries: 1` + `mode: 'serial'`) and that the demo
   tenant is NOT reset between runs. Titles want a per-run stamp, and anything a run LEAVES behind
   is the next run's input: a connected integration hides its own connect form (`availableAdapters()`
   excludes it), and mail nobody drained sits in the outbox until the next run's first drain delivers
   it to an assertion that was looking for its own. Wipe what the file needs empty in a `beforeAll`
   (superuser `Pool`, as `ledger-flow` does) and drain what it enqueues in an `afterAll`. **CI is
   fresh every run and will not catch any of this** — an assertion that holds only because the
   environment is disposable is the shape to watch for.
4. **Amounts over $25 need a receipt.** `expense-flow`'s `beforeAll` restores the starter rules and
   runs before every later file; RECEIPT_REQUIRED is BLOCK above $25.00.
5. **A `getByText` never matches an input's value** — if the assertion cannot fail, it is not one.
6. **`count()` does not auto-wait**, and neither does `innerText()`. After a click that navigates,
   they answer about the page you just left. Anchor on an auto-waiting `expect(...)` first, then ask.
   This is how VX3-9a skipped a required checkbox and got a refusal ten lines away from the cause.
7. **`innerText()` answers `''` for anything not RENDERED** — a `<style>`, a `<template>`, anything
   under `display: none`. It is defined in terms of rendered text, so an assertion reading a
   `<style>` block through it can only ever pass vacuously. Use `textContent()`, and assert the
   result is non-empty before matching on it. Caught in VX4-3's spec by working through this list
   rather than by a CI round, which is what the list is for.

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
  not, so RLS is the whole guard. **That claim only became true with VX3-10.** When it was written
  the other FKs were single-column, and a single-column FK is not a second line against anything —
  Postgres checks it with RLS bypassed and accepts another tenant's id (TN-1). Since `0019` they are
  composite and the sentence means what it says; `activity` remains the one table it does not apply
  to. `test/rls-isolation.test.ts` therefore gained a join-walk case
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
  other 42 were not; VX3-10's migration `0019` converted every one of them, and the
  house rule in §1 now carries the pattern.

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

**What VX3-6 shipped** — audit rows for the three manual queue actions, a dry run,
and four tests. **No migration.** Much smaller than the two days boarded, because
VX3-4 had already shipped the queue screen — and one of its criteria turned out to
be a GAP in what VX3-4 shipped rather than new work.

- **VX3-4 SHIPPED THREE OVERRIDE BUTTONS WITH NO AUDIT ROW, and that was my
  omission.** VX3-6's acceptance criterion says "a manual push is audited and
  attributed"; a grep for `auditAppend` in `app/admin/ledger-queue/actions.ts`
  returned zero. Send-now, retry and withhold each override something the system
  decided on its own, which is exactly the class of action an audit trail exists for.
  Three new actions: `LEDGER_POST_SENT_MANUALLY`, `LEDGER_POST_RETRIED`,
  `LEDGER_POST_WITHHELD`. No migration needed — `audit_entry.action` is a free
  string validated non-empty, deliberately, so a new action never needs one.
- **THE RETRY AUDIT READS THE STATE BEFORE THE RETRY**, because what an auditor
  needs is what the operator OVERRODE and `retryNow` resets precisely that. It
  records `overrodeNeedsReview`, and that flag is the point: retrying a
  NEEDS_REVIEW row is an operator asserting the ledger does NOT already hold this
  bill. If they are wrong, that row is the record of who decided.
- **`entityType` IS THE REPORT, NOT THE QUEUE ROW.** `audit_entry` is read by
  report; an auditor asking "what happened to EXP-000123" should find the ledger
  hand-off in the same chain as its approval. A queue row is an implementation
  detail that may be retried away.
- **THE SEND-NOW AUDIT IS AFTER, WITH THE OUTCOME.** It cannot share a transaction
  with the send, because the send deliberately holds none open while it talks to the
  ledger. The operator's action is "sent this now" and the outcome is the part worth
  recording.
- **THE DRY RUN DOES NOT CONTACT THE LEDGER**, and the screen says what that costs.
  `draft_bill` has no validate-only mode, so the only way to have the ledger confirm
  a bill is acceptable is to send it one. So a clean dry run means VeloExpense has no
  objection — not that the ledger will accept it. A closed period and a missing
  vendor are the two commonest real failures and neither is discoverable without
  asking. That sentence is on the screen, not just here.
- **THE DRY RUN IS NOT AUDITED, deliberately.** It changes nothing and reads only
  what the operator can already see on the report. An audit trail full of "somebody
  looked" is how the entries that matter get lost.

**A note on the board:** VX3-6 was sized at two days assuming the screen was part of
it. It was not — VX3-4 needed a queue screen to be reviewable at all, so it built
one. What was genuinely left was a day. The remaining tickets should be re-read the
same way before being picked up; VX3-9's e2e in particular may be larger than
boarded now that there are two adapters and a pull to cover.


**What VX3-10 shipped** — migration `0019` (55 `ADD CONSTRAINT` statements: 13
`UNIQUE (organization_id, id)` additions and 42 FK drop/recreate pairs),
`test/tenant-fk.db.test.ts`, a `Tenant FK guard` step in CI, the §1 house rule above,
and one fixture fix. **TN-1 is closed: every tenant-to-tenant FK in the schema is
composite through `organization_id`.**

- **THE MIGRATION WAS GENERATED, NOT TYPED.** The body came out of `pg_constraint` on
  a live schema, with each `confdeltype` read back and written into the recreated
  constraint. Doing it by hand would have been 42 chances to transcribe a delete action
  wrongly — and a `CASCADE` that quietly became a `NO ACTION` is the kind of defect
  that surfaces years later as orphaned rows. The reproducing query is in the migration
  header.
- **Delete actions were preserved exactly:** 19 NO ACTION, 16 CASCADE, 3 SET NULL,
  4 RESTRICT before; the same distribution after, plus the 7 already-composite from
  `0014`/`0016`/`0017`. Three behavioural tests pin one of each class rather than
  trusting the count — `RESTRICT` in particular, because it and `NO ACTION` behave
  identically until somebody defers a check, so a mechanical rewrite could have
  flattened it silently.
- **THE ISOLATION TEST IS GENERATED, TOO, and that is the point of it.** It walks
  `pg_constraint` and requires every tenant-to-tenant FK to be composite. The ticket
  asked for "one isolation assertion per FK"; 42 hand-written assertions would have
  covered the schema on the day they were written and rotted on the day somebody added
  the 43rd. The generated form cannot rot, and it carries a guard against ITSELF: it
  asserts the enumeration returns more than 40 rows, so a renamed catalogue column or a
  typo in the CTE fails the test instead of emptying the offender list and passing.
- **The strongest case in the suite runs on the SUPERUSER connection.** That is the
  argument for a composite key over a trigger or a policy: RLS is not merely satisfied
  there, it is bypassed, and the constraint refuses the cross-tenant row anyway. A guard
  built on policies would let it through.
- **A REAL DEFECT IT SURFACED, in a test rather than in shipped code.**
  `test/audit.db.test.ts` had been writing audit rows into its SECOND tenant with an
  actor belonging to the FIRST — `insertRaw` defaulted every row's actor to a
  module-level `actorId` — and had done so since VX2-6 with nothing objecting, because
  the old FK does not care which tenant the target is in. The composite FK objected
  immediately. The fixture now gives each tenant its own actor. Worth recording as
  evidence rather than tidying away: this is what the hole looks like in practice, and it
  went unnoticed for six phases inside the suite that exists to catch exactly this.
- **`0019` changes WHICH rows may be referenced, not what happens when one is deleted.**
  No data migration and no backfill: there was no cross-tenant row in any database to
  clean up, and if one existed the `ADD CONSTRAINT` would fail loudly rather than drop it.
- **What is NOT covered.** `activity.subject_id` is untouched — polymorphic, no FK
  possible, RLS is still the whole guard there (NT-1, now qualified). And global
  reference tables (`organization`, `currency`, `coa_template*`, `fx_rate`) are out of
  scope by definition: a single-column FK to a global table is correct.

**Verified:** all 19 migrations applied clean on a fresh Postgres 16; the tenant-FK
enumeration returns zero weakly-declared FKs after `0019` and correctly names one when a
constraint is regressed to the single-column form on a copy of the database; **25 suites /
483 tests green against the `0019` schema** — including every DB suite in the repo except
the two whose deps the container harness cannot install. `next build`, `npm run lint` and
`npm run typecheck` are John's step (the device VM cannot build: `linux/arm64`
`node_modules` vs macOS).


**What VX3-7 shipped (the guard half)** — `scripts/check-vendor-neutral.mjs`, a
`check:vendor` npm script and a CI step, plus the three things the guard found.
**The dimension half is blocked upstream, so VX3-7 stays open** — see the correction
in §6 and GAP-AUDIT AC-16.

- **THE GUARD FOUND A REAL DEFECT ON ITS FIRST RUN, which is the argument for it.**
  `lib/integrations/dispatch.ts` — the GENERIC drain — imported the
  refused-versus-ambiguous classifier from `lib/integrations/veloledger.ts` **by
  name**. So VeloLedger was the only adapter that could ever report "this was
  refused, nothing happened upstream", and every other adapter's failure fell
  through to the ambiguous branch. `NEEDS_REVIEW` is deliberately a state no
  automatic path retries (AC-8), so a QuickBooks tenant with a mistyped credential
  would have had every report land in NEEDS_REVIEW on a **401** — a failure that
  certainly never reached QuickBooks and should simply have backed off and retried
  — and a human would have had to clear each one by hand. It also broke VX3-3's own
  acceptance criterion, which says adding an adapter touches no shared file: it
  would have had to touch that one.
  - Fixed by moving `AdapterError` and `isDefinitelyNotApplied` **onto the
    contract**. `LedgerError extends AdapterError` and keeps its name for logs.
  - **The default is still the dangerous case:** anything that is not an
    `AdapterError` classifies as ambiguous, so an adapter that lets a vendor SDK's
    own error escape costs a human one click rather than costing a company a
    duplicated bill. There is a test for exactly that.
- **THE TEST SUITE HAD ENCODED THE BUG AS CORRECT BEHAVIOUR.**
  `test/ledger-post.db.test.ts`'s "a REFUSED failure stays retryable" asserted
  `NEEDS_REVIEW`, with a comment explaining that *"only the VeloLedger adapter can
  say definitely not applied"*. True, and that was the bug. The stub could not
  produce a refusal at all — it threw a bare `Error` — so no test could reach the
  branch. `stubControl().failNext(msg, refused)` and `failNextBare(msg)` now exist,
  and the assertion is `FAILED` with one attempt spent. **A test double that cannot
  produce one of two outcomes hides a bug in the outcome it cannot produce.**
- **A DRAFT IS NOT A POST, and three things can refuse one after we call it done.**
  Their `createBill` stores `expense_account_number` as PLAIN TEXT on `bill_line`
  with no foreign key and no existence check; numbers are resolved in
  `buildAndPostBillJournal`, which runs when a **human posts**. So a bill can draft
  perfectly and be permanently unpostable, in their UI, with no path back to us:
  1. **the account number is not in their chart** — now PRE-FLIGHTED against
     `list_accounts` before drafting, and refused locally with the numbers named and
     "pull the chart of accounts" as the instruction. Costs one extra read per post.
     Most likely of the three, because VX3-1's starter template is numbered from
     VeloLedger's chart but **VX3-5's pull is optional** — a tenant that never
     pulled is sending numbers on faith.
  2. **the number is a rollup there** — `ROLLUP_ACCOUNT` at post time.
     NOT detectable: `list_accounts` returns number, name, type, normalBalance,
     isActive and subLedger, and no postability.
  3. **segments in `required` mode with no vendor and no company default** —
     `SEGMENTS_REQUIRED` at post time. NOT detectable: no tool exposes segment mode.
  `testConnection` and the ledger-queue screen now say which of the three is checked
  and which two are not, rather than showing a green tick that means less than an
  admin will assume.
- **The pre-flight FAILS OPEN on an empty chart**, deliberately. An empty
  `list_accounts` is not evidence of absence — a tool that answered oddly, a shape
  mis-read, a permission that hides accounts — and refusing every post in this
  product because of a bad read at the far end is a worse outage than the defect.
- **`lib/accounts/validate.ts` no longer says "VeloLedger 0028" to an admin.** That
  parenthetical was in a CSV validation error shown on screen, to somebody who may
  be running QuickBooks and has no idea what VeloLedger 0028 is. The lesson moved
  to the comment; the message now says what actually happens to a line coded to a
  rollup.
- **THE GUARD ITSELF TOOK THREE ATTEMPTS, and both failures are instructive.**
  Substring matching reported 180 offenders, every one the word "message"
  containing "sage" — a guard that cries wolf gets `|| true` appended within a week.
  `\b<vendor>\b` fixed that and then MISSED `QUICKBOOKS_SPECIAL_CASE`, because `_`
  is a word character, and would have missed `quickBooksClient` too — precisely the
  shapes a leak takes, so it was blind to the surfaces it exists to police while
  appearing to work. It now tokenizes on non-letters, splits camelCase, and asks
  whether any contiguous run of components spells a vendor name.
  Comments, `INSERT`/`UPDATE`/`COPY` row data and `COMMENT ON` provenance are
  excluded on purpose — a guard that forbade naming NetSuite in a comment would
  delete this project's reasoning along with its risk.
- **First tests the VeloLedger adapter has ever had** (`test/veloledger-adapter.test.ts`,
  `fetch` stubbed). It still has never met a real VeloLedger — that item stays open
  on the tracker — but which calls we make, in what order, and what we refuse to send
  are now pinned. The load-bearing assertion is not "it threw": it is
  `expect(calls).toEqual(['resolve_period', 'list_accounts'])`, because a refusal
  that happens after `draft_bill` would leave the unpostable draft at the far end.

**Verified:** 26 suites / 492 tests green. Each fix was checked against its own
absence rather than only asserted: with the old VeloLedger-only classifier restored
the refusal test fails `expected 'NEEDS_REVIEW' to be 'FAILED'`, and with the
pre-flight disabled three tests fail with `promise resolved "{ externalId: 'b-1' }"`
— the bill drafted with a bogus account number. The guard was exercised on a scratch
copy of the tree against ten cases: six leak shapes caught (SCREAMING_SNAKE constant,
camelCase identifier, audit action, permission slug, CHECK literal, column name) and
four legitimate uses passed (a slug in an INSERT, `COMMENT ON` provenance, comments
naming vendors, and words containing vendor substrings). `next build`, `npm run lint`
and `npm run typecheck` are John's step.


**What VX3-8 shipped — the PLUMBING half; QuickBooks is dormant on purpose** —
migration `0020`, `lib/integrations/oauth.ts`, `lib/integrations/quickbooks.ts`, an
`available()` gate on the contract, a generic callback route, a Connect button, and
`test/integration-oauth.db.test.ts`. **John's decision, 2026-08-30: a QBO client is
not onboarded yet, so VeloExpense should carry the setup to connect later.** The
VeloLedger upstream asks (AC-16) are deferred with it.

- **THE REAL GAP WAS NOT "WRITE A QBO ADAPTER".** It was that the integration layer
  could only express *paste a value into a form*: `ConfigField` is
  `text | url | secret`, `AdapterConfig` is `Record<string, string>`, and connecting
  is a form POST that encrypts the secret fields. QuickBooks is OAuth2
  authorization-code — a redirect, a callback carrying a code and a company id, an
  access token, and a refresh token that ROTATES and eventually dies. None of that
  is a form field. Discovering it on the morning a client is onboarded is the bad
  version of this ticket; AC-18 records it.
- **What ships is the half that does NOT need an account.** The redirect, the state
  handling, the exchange, the refresh, the re-consent path, encrypted storage —
  generic OAuth2, fully tested through a stub. What does NOT ship is the Bill
  mapping: `quickbooks.ts` declares **no capabilities**, so
  `resolveCapability(tx, 'POST_EXPENSE_REPORT')` can never select it and no approved
  report will be sent to it. Writing that payload from documentation and shipping it
  unexecuted would produce exactly what GAP-AUDIT criticises on the other side —
  ExpenseOS's NetSuite transport carries its own *"UNVERIFIED against a live
  account"* warning.
- **The split of labour is the design.** Core owns the state (minted from
  `randomBytes`, stored as a sha256, single-use, ten-minute TTL), the encryption,
  the refresh scheduling, and the "needs a human" versus "try again" distinction.
  The adapter contributes three vendor-shaped functions and never sees the state at
  all — so an adapter author cannot get the dangerous part wrong.
- **THE STATE IS TREATED AS A CREDENTIAL, because it is one.** Whoever can replay it
  can attach their own accounting account to somebody else's installation. Hence
  the hash-not-the-value storage (the `action_token` precedent from `0012`), and
  hence consuming it BEFORE the exchange: a failed exchange then costs the admin one
  extra click, where exchanging first would leave a window in which the same state
  could be replayed with a different code. One click against an account takeover.
- **THREE OF MY OWN BUGS, all caught by tests rather than by reading:**
  1. **`installIntegration` never learned to write `auth_kind`**, so every OAUTH2
     installation would have described itself as `CONFIG`. Found by an assertion I
     wrote in `beforeEach` *because* I was assuming it — and it also turned out that
     `active = true` on install is illegal for OAUTH2 (`0020`'s `oauth_complete`
     CHECK), since nothing is authorised yet.
  2. **`completeAuthorisation` joined `integration_installation` inside
     `withPlatformRead` and got nothing, every time.** That is the hatch working as
     designed: `0020` grants `platform_read` to the state table and to NO other, so
     a join reaches a table with no tenant context and RLS filters everything. The
     fix reads the state alone, learns the tenant, then uses `withOrg`.
  3. **The worst one: the needs-consent flag was written on the transaction the
     function then threw out of, so the rollback erased it.** The flag would never
     have persisted — no admin would ever be told, and every post would have called
     the far end again to be refused again, forever, silently. It now commits on its
     own connection first, the same shape VX3-4's `markNeedsReview` uses. Nothing
     about the original code looked wrong; a test asserting `active` is false
     afterwards is the only reason it was found.
- **A refresh failure is classified in BOTH directions.** `invalid_grant` becomes
  `OAuthConsentRequired` → flag, deactivate, tell the admin. Anything else — a
  timeout, a 5xx — leaves the row untouched so the next attempt retries. Marking a
  working connection dead because the network blipped is the same class of mistake as
  AC-17, one layer down, and there is a test for each direction.
- **`stub-oauth` exists for the same reason `stub-ledger` does**, and VX3-7's lesson
  is why it can produce every outcome: a rotating refresh, a refresh needing consent,
  a merely-failing refresh, and a bare error. A test double that cannot produce one
  of two outcomes hides every bug in the outcome it cannot produce.
- **Not verified, and flagged rather than guessed:** Intuit's developer docs are
  JavaScript-rendered and could not be fetched, so **no token lifetime is quoted
  anywhere in the code** — expiries come from the far end's own `expires_in` and
  `x_refresh_token_expires_in` and are stored as absolute timestamps. The two
  endpoint hosts want a glance against current documentation before the first real
  connection. That check belongs to onboarding day, and it is on the ticket rather
  than assumed done.

**Verified:** `0020` applied clean on a fresh database with all 20 migrations; its
four CHECK constraints exercised behaviourally (an active OAUTH2 row with no refresh
token is refused, a CONFIG row carrying tokens is refused, an unauthorised OAUTH2 row
is fine, a malformed state hash is refused); the new table's composite FK refuses a
cross-tenant installation reference; **27 suites / 510 tests green**, including 17 new
OAuth cases and the isolation suite extended for the new tenant table (which CI's
isolation-coverage guard requires). `next build` is John's step, and this ticket touched two `.tsx` files, so
the build is the first thing that will exercise them. **`typecheck` and `lint` were
NOT run before the first handover and should have been — see the correction in §3.
They are green now: six `TS2345` errors from an unextended `IntegrationError` code
union were fixed after John's build found them.**


**What VX3-9a shipped (part 1 of 2)** — the OAuth wiring defect closed
(GAP-AUDIT **AC-19**), `lib/integrations/errors.ts`, `scripts/e2e-ledger.mjs`, a
posting-capable `stub-oauth`, and `test/veloledger-sink.db.test.ts`. **Part 2 —
the second seeded tenant and the two-tenant browser spec — is the half that needs
`next build` and Playwright, so it is deliberately not in this PR.**

- **THE DEFECT IS THE HEADLINE, and it was in `main`.** VX3-8's `freshAuthConfig`
  — decrypt, refresh-if-due, classify a dead refresh token — was called by nothing
  but its own seventeen tests. Core handed adapters `usableConfig()` alone, which
  for an OAUTH2 adapter is EMPTY. So VX3-8 stored tokens correctly and never used
  them: a posting adapter would get no token, and QuickBooks' Test button said
  "Not authorised yet" **forever, including right after a successful
  authorisation**. See AC-19 for why no test could catch it — VX3-7's lesson
  recurring one layer up, two tickets after I wrote it into this codebase.
- **THE VELOLEDGER ADAPTER HAS NOW MET A REAL HTTP FAR END.** `scripts/e2e-ledger.mjs`
  serves the tool surface (`list_entities`, `resolve_period`, `list_accounts`,
  `draft_bill`), honours the idempotency key, and 401s an unauthenticated call.
  `test/veloledger-sink.db.test.ts` starts it itself and drives the REAL adapter
  through `postOne` — so **VX3-7's account pre-flight is proven against a far end
  that really answers with a chart**, refusing a number it does not have with
  nothing drafted. The tracker item stays open (it still has not met a real
  VeloLedger) but it is no longer at zero.
- **Why a sink and not module state:** Playwright drives a separate standalone
  server, so a browser test cannot read module variables, and `integration_post`
  stores `external_id` and `installation_id` but **not the payload**. "Asserts the
  payload" is impossible without the payload leaving the process. Third instance of
  the `e2e-storage.mjs` / `e2e-mail.mjs` argument.
- **`stub-oauth` posts now**, reversing my own VX3-8 decision — that comment is
  quoted in `stub.ts` beside the reversal, because the worry it raised was real and
  the cost of acting on it was a hidden bug.
- **My typecheck caught two arity errors before handover**, which is the §3
  correction from VX3-8 working as intended rather than a claim about it.

**Verified:** 28 suites / **517 tests**, `tsc --noEmit` clean, `eslint` clean (two
pre-existing warnings), vendor guard clean, no NUL bytes. The defect fix and the
pre-flight were each checked against their own absence. `next build` and the e2e
remain John's.

**What VX3-9a part 2 shipped** — a second populated tenant (`second`), a third
`storageState`, the sink wired into `playwright.config.ts`, and
`e2e/ledger-flow.spec.ts`: four tests covering per-tenant adapter resolution, the
posted payload, cross-tenant invisibility through the app, and a real 502 becoming
NEEDS_REVIEW. **The spec is the one thing in this ticket I could not run** — it
needs `next build` and Playwright. Everything around it is verified.

- **NO LEDGER IS SEEDED, and the first version tried to.** A `secret`-typed config
  field is encrypted ON WRITE by TypeScript a `.mjs` seed cannot import, and
  `decryptSecret` REFUSES an unmarked value rather than trusting it (AC-4). So a
  seeded plaintext `apiKey` is not "insecure but working" — it is a row that throws
  the moment the app reads it, and the e2e would have failed with a crypto error
  rather than anything about ledgers. Verified, not assumed. The spec connects each
  ledger through the real form instead, which uses the shipping encryption path and
  is **the first coverage the connect screen has ever had**.
- **`seedReportingLine` HAD TWO BUGS, and VX3-10 is what surfaced them.** It was
  hardcoded to the demo tenant (`le.name = 'Demo Co Inc.'`, a chain of
  `*@demo.test`), and every lookup relied on RLS for tenant scoping with no
  `organization_id` predicate. Fine as `veloapp`; wrong as a superuser, which
  bypasses RLS even under FORCE — the second tenant's users were assigned the DEMO
  tenant's business unit. It **failed loudly** because the composite FK refused
  `(organization_id, business_unit_id) = (second, <demo's unit>)`; a single-column
  `REFERENCES business_unit(id)` would have ACCEPTED it and left a pointer into
  another tenant's org chart. TN-1's exact case, caught in practice. Now
  parameterised with explicit predicates, and verified correct under BOTH roles.
- **An ordering hazard in my own spec, found by reasoning rather than running.**
  `approval-flow.spec.ts` runs first and approves a report, which enqueues a post
  that stays PENDING (no ledger connected → SKIPPED, no attempt burnt, by VX3-4's
  design). The moment this spec connects a ledger, that row becomes due — so a
  drain without flushing would post somebody else's report and both `posted: 1` and
  `count: 1` would fail for reasons unrelated to the test. It now flushes, resets
  the sink, then measures. `workers: 1` is what makes flushing sufficient.
- **Latent, noted, not fixed:** config-field input ids on the connect screen are
  `new-<fieldName>` and NOT adapter-scoped, so two adapters sharing a field name
  would collide. None do today. The spec scopes its selectors to each `<form>`
  rather than relying on that accident.

**Verified:** the seed runs clean and idempotent on a fresh 21-migration database
as **both** `postgres` and `veloapp`, with per-tenant org placement and manager
chains correct in each; `tsc --noEmit` clean; `eslint` clean but for one
pre-existing warning; vendor guard clean; 28 suites / 517 tests; `playwright
--list` discovers the four new tests and the third setup project. **Not verified:
the spec's assertions**, which need a browser.

**VX3-9a is COMPLETE and green** as of PR #65 — 14 Playwright tests, and the four
ledger ones needed three more rounds. Six defects, none in the code under test,
and `tsc` and `eslint` passed on every one: two invented selectors, two fixtures
assumed rather than read (a category called 'Travel' that does not exist — 68100 is
the ACCOUNT's name; and an approver who is somebody else), one leftover-state
class, and `count()` not auto-waiting. **HANDOFF §4 now carries the checklist**;
the leftover-state one is the item to internalise, because CI cannot see it — CI
gets a fresh database every run, so an assertion that holds only because the
environment is disposable passes there and fails on a laptop.

**What VX3-9b ships** — the OAuth redirect, walked in a browser, plus AC-22.

- `scripts/e2e-ledger.mjs` serves `GET /oauth/authorize`: a real consent page with
  an **Allow** and a **Deny** button, both redirecting with a GET because that is
  what every real provider does and what the callback route has to survive. The
  control port gained `GET /authorizations`, so a test can assert the
  `redirect_uri` THE APP built — APP_URL plus the slug, which is the one thing on
  that page that is the product's own doing, and NT-14 is the same defect for
  emailed links.
- `stub-oauth`'s `authorizeUrl` reads `INTEGRATIONS_STUB_AUTHORIZE_URL` at CALL
  time (NT-14 again). Unset it stays `https://stub.invalid`, unreachable on purpose
  so a vitest suite reaching for the network fails loudly rather than hanging.
- `e2e/oauth-flow.spec.ts`, seven tests: an OAUTH2 connection arrives INACTIVE and
  the screen says so; the admin consents at the far end and comes back connected,
  with Test then holding a real token (**AC-19's regression, in a browser**); an
  approved report posts carrying the token consent produced; **Deny** is a normal
  outcome that changes nothing; a **replayed callback** does nothing and says what
  an unknown one says; AC-22's guard refuses a second poster through the UI; and
  **Disconnect → reconnect → re-authorise**, which is the first time anybody has
  pressed the two buttons #66 fixed. Before this file,
  `/api/integrations/[slug]/callback` had never been reached by a browser at all.
- `e2e/helpers.ts` — the sink helpers, `submitAndApprove`, `connectLedger`,
  `wipeIntegrations` and `drainNotifications`, moved out of `ledger-flow.spec.ts`
  verbatim so both specs share one copy of the proven selectors.

### AC-23 — the OAuth callback sent the admin back to the wrong origin

Found by the new e2e on its first run, which is the whole argument for 9b existing.
`authoriseFromForm` builds the `redirect_uri` from `appOrigin()` (APP_URL); the
callback route built the way onward from `req.nextUrl.origin`. Bound to 0.0.0.0, or
behind any proxy, those differ — the run landed on
`http://0.0.0.0:3000/admin/integrations?notice=...is+connected`, an origin the
session cookie does not cover, and middleware bounced the admin to `/login` **after
a successful authorisation**. Tokens stored, connection live, person staring at a
login page. NT-14's family: an origin read from the wrong source. Now
`appOrigin() ?? req.nextUrl.origin`, and the spec anchors the expected origin at `^`
because the first version matched only the path and passed while the origin was
wrong.

### AC-22 — two active ledgers, and the posting target was a coin flip

Found scoping 9b, by reading `resolveCapability` to work out whether the new spec
could connect a second adapter safely.

`0016`'s partial index allows one active installation **per integration**, which
stops two VeloLedger connections and does nothing about a VeloLedger and a
QuickBooks — both declare `POST_EXPENSE_REPORT`. `resolveCapability` read the
active rows **with no ORDER BY** and returned the first one it liked, which is
physical heap order and moves whenever a row is updated. **That is AC-3, the
finding this audit opened against ExpenseOS, reproduced one level up.** Not
reachable in a deployed build yet (QuickBooks is dormant, so VeloLedger is the only
adapter declaring a capability); reachable the day a QBO client is onboarded, which
is AC-21's trigger too.

Closed by refusing rather than choosing — **ordering was deliberately not the fix**,
because a stable wrong ledger is still the wrong ledger and the tenant would have no
way of knowing which one won:

- `resolveCapability` raises `AMBIGUOUS_CAPABILITY` naming both connections;
  `dispatch.ts` treats it exactly as "nothing is connected" — SKIPPED, **no attempt
  burnt**, reason on the row — so the reports are still waiting when somebody
  disconnects one.
- `installIntegration` and `beginAuthorisation` refuse earlier, for the admin. A
  rival is a DIFFERENT product; the same adapter is the one-active case and keeps
  its own message. Conflating those broke two existing tests, which is how I found
  out.
- `capabilityAvailability()` for the two screens that only wanted a boolean: two
  connected ledgers must not turn `/admin/ledger-queue` into a 500, least of all
  the page an operator opens to ask why nothing is posting. It says so in words
  there, and hides the pull button (with a reason) on the chart screen.
- New leaf module `lib/integrations/conflicts.ts`, because `service.ts` already
  imports `oauth.ts` and the reverse would be the cycle `errors.ts` was extracted
  to break.

### AC-20 + AC-21 — the integration connect/disconnect pair (after #65)

Both found while writing VX3-9a's e2e, neither in its scope, both in
`lib/integrations/service.ts`.

- **AC-20: disconnect was a one-way door.** `installIntegration` only ever
  INSERTed; `UNIQUE (organization_id, code)` is **not** partial (only the
  one-active index is); and the connect form has no `code` input, so
  `connectFromForm` sends the slug every time. Reconnecting collided with the row
  the disconnect left behind and failed with *"the code 'veloledger' is already
  used here"*. **One disconnect and that integration could never be connected again
  from the screen** — while the ALREADY_ACTIVE error one step earlier advises
  "Disconnect it first". Now an `ON CONFLICT ... DO UPDATE ... WHERE active = false
  AND integration_slug = EXCLUDED.integration_slug` that reactivates the SAME row.
  A test named *"the same integration can be reconnected"* had existed since VX3-3
  and used a different `code`, which is the one path that worked.
- **AC-21 (security): disconnect left the OAuth refresh token in the row.** The
  function strips the adapter's declared secret fields out of the `config` jsonb —
  and `0020` put OAuth credentials in **columns**. So a disconnect deactivated the
  row and left a live, encrypted, rotating refresh token, plus
  `oauth_authorised_at` and `external_account_id`, which make the screen offer
  "Re-authorise" over nothing. Not exploitable today (QuickBooks is dormant and
  `resolveCapability` only selects active rows) and it would have become real on
  the day a client was onboarded. All of those columns are cleared now, on
  disconnect AND on reconnect.
- **The general form, and it is the second time:** moving a value out of a jsonb
  blob into a column takes it out of reach of every loop that iterates the blob.
  AC-19 was the same fact one layer up. When `0020`-style columns are added, grep
  for the code that thinks the blob is the whole story.

**Verified:** 106 tests across the seven integration suites, and both fixes proven
against their own absence — restoring the plain INSERT fails four assertions with
`the code 'main' is already used here`; leaving the columns alone fails with
`oauth_access_token survived the disconnect`.

### VX4-1 part 1 SHIPPED — the entitlement spine, the gate, and the guard

**Migration `0021`: `module_entitlement`.** `UNIQUE (organization_id, module_code)`, RLS + FORCE, a
composite FK on the actor (TN-1), and a covering index for the one read every gated call makes.
**ABSENCE MEANS OFF** — no `defaultOn`, no seeded default set. `enabled` is a column rather than the
row's existence, so turning a module off keeps who and when.

**`lib/modules/registry.ts` owns the codes, not the database.** Same reasoning as
`lib/integrations/registry.ts` and `0016`'s note on `integration_slug`: a build either has the code
that serves a module or it does not, and a row cannot make it true. `accounting` is available and
gates everything Phase 3 built; `budgets`, `analytics`, `travel` and `virtual_cards` are declared with
`available: false` — the dormant-QuickBooks pattern — so they cannot be enabled and gate nothing.

**The gate is in the SERVICE layer, and the guard is what makes it sound.** `requireModule(tx, code)`
at the top of 14 exports across `lib/accounts` and `lib/integrations`. `test/module-gates.test.ts` is
generated from the registry and fails in both directions: a listed export with no gate in its body,
and an export in a gated file that is neither gated nor exempted with a written reason. Verified by
sabotage — one deleted gate and one unlisted export, both caught by name.

**Reads stay ungated on purpose (AC-22).** A gated `listAccounts` makes "module off" look like "empty
chart". So the reads are open, both admin screens carry a sentence saying the module is off and what
that means, and `capabilityAvailability` returns the message instead of throwing — `/admin/ledger-queue`
is where somebody asks why nothing is posting.

**`dispatch.ts`: a disabled module is SKIPPED, no attempt burnt** — the third member of the same
family as "no ledger connected" and AC-22's ambiguity. A tenant who buys the module next month finds
this month's approvals still queued.

**Blast radius, stated plainly:** a fail-closed default broke **99 tests** in six accounting suites
until each entitled its own tenants — one line per suite, and that churn is the honest price of the
default. Two placement mistakes worth recording: `accounts.db.test.ts` recreates its org in a
`beforeEach`, so a `beforeAll` row was truncated away before the first test; and
`veloledger-sink.db.test.ts` calls `installIntegration` *inside* its `beforeAll`, so a row appended at
the end of that hook arrived after the gated call. Both were mechanical-insertion errors, both failed
loudly.

**Also corrected in flight:** `append()` refused my audit row — "entityType and entityId are both
required, or neither" — and the contract was right, so the entitlement row's id is now the entity. And
a comment claiming this guard runs before the build in CI was **false** (build is step one, `npm test`
is step twelve); the comment now states the trade instead of inventing a property.

### VX4-1 part 2 SHIPPED — the backstop, the screen, and the demonstration

**Migration `0022`.** `app_module_enabled(text)` — one STABLE, SECURITY INVOKER function so the
predicate is written once — and the `tenant_isolation` policies on `gl_account`,
`integration_installation` and `integration_oauth_state` now carry `AND app_module_enabled('accounting')`.
The predicate comes from the POLICY, so no query can omit it: not a new service function, not a raw
`tx.query` in a screen, not a job written next year by somebody who has never read the registry.

**THE TABLE THAT MUST NOT BE GATED, and this is the finding of part 2.** `integration_post` — the
posting queue — is deliberately left alone. `enqueuePost()` runs **unconditionally inside the
approving transaction** (`lib/approvals/engine.ts`, and its own comment says why). An entitlement in
that policy would make the WITH CHECK refuse the insert and **APPROVING A REPORT WOULD FAIL for every
tenant without the accounting module** — a core flow broken by an optional module's gate. Checked
before writing the migration, not after.

**Why gating `gl_account` is safe** for the core expense flow: `accountForCategory()` is called by
`addLineItem` for every line item filed by every tenant, and with the module off the join returns
nothing and the snapshot is NULL — which is exactly what VX3-1 already specified ("null is fine and
blocks nothing"). Existing `expense_line_item.gl_account_id` values survive, because referential
integrity is checked with RLS bypassed (TN-1): the rows go invisible, not orphaned, and come back.

**Proven behaviourally against a real Postgres, as `veloapp`:** demo entitled sees its 28 accounts;
`blank` (unentitled) sees 0 and its INSERT is refused; demo after disabling sees 0 while the 28 rows
are still there to a superuser; re-enabled, all 28 return. The seed also proves the ordering —
`seedModule` must precede `seedReferenceData` or the chart cannot be written at all.

**`/admin/modules`** lists every declared module with this tenant's state, shows an unavailable one
greyed rather than hidden (a customer asking for Budgets is a sales answer), and says *before* the
toggle is pressed that turning a module off **hides its data and does not delete it**.

**`e2e/modules-flow.spec.ts`** is the demonstration: turn accounting off through the screen, watch the
integrations and chart screens explain themselves and their data vanish, approve a report and see it
**queued rather than failed with no attempt burnt**, then turn it back on and watch the same report
post. Three layers have to agree for that to pass — `0022`'s policy, part 1's service gate, and
VX3-4's queue rule — and this is the only place they are exercised together.

**Ordering, handled at the root:** the new spec sorts between `ledger-flow` and `oauth-flow`, so it
restores the module in an `afterAll` AND `wipeIntegrations()` re-enables accounting for the tenants it
wipes. A spec that depends on another spec's cleanup fails the day somebody adds a file whose name
sorts between them.

**A defect the spec caught while being written:** with the module off, `/admin/ledger-queue` would
have printed AC-22's headline — *"Two ledgers can post, so nothing is posting"* — above a module-off
sentence. `capabilityAvailability` now returns a `problemKind` and the screen picks its headline from
it. Confidently wrong copy is worse than no copy, and nothing but writing the browser test would have
found it.

**AC-24, found by the e2e asserting a sentence the screen shows an admin.** A post skipped for a
configuration reason backs off an hour without burning an attempt — and **fixing the configuration did
not clear the backoff**, so an admin who turned the module on watched nothing happen while the screen
said the queue "drains on its own". `requeueWaitingPosts()` now runs in the same transaction as the
toggle: `PENDING` only (a `FAILED` row's retry schedule belongs to the far end that refused it) and
never a claimed row (moving the schedule under the process holding it is how a double-post starts).
Verified against absence — dropping the status predicate fails with `expected 2 to be 1`.

**AC-24 is now CLOSED for all four paths, and the placement was reversed.** Part 2 put the nudge in
the Modules screen's action on the grounds that "what an admin experiences" is a UI decision. That was
wrong in the way this ticket had just spent three days fixing — **a hook at the edge is a hook the next
caller forgets**, which is MT-3 — and two callers proved it at once: the OAuth callback activates an
installation without touching that action, and a ledger connect has the same problem with none of the
same code in the path. It now lives in `setEntitlement`, `installIntegration` (active installs only),
`disconnect` and `completeAuthorisation`. Verified against absence at three of them.

**Placement, for the third time:** the RLS backstop made the entitlement row's POSITION load-bearing —
it must exist before any accounting write, not at the end of a hook — and two suites failed from their
own setup until the row moved to immediately after org creation. The lesson is in HANDOFF §4's
checklist territory: when a default is fail-closed, setup order becomes part of the contract.

**Process fact:** `npx vitest` **cannot run in the device shell** — `node_modules` there is
macOS-native (`@rollup/rollup-linux-arm64-gnu` missing), the same reason `next build` needs the Mac.
Vitest runs on John's machine or in the cloud harness. Note also that the harness's copy of
`test/audit.db.test.ts` is stale (618 lines vs 637; the device's was fixed by VX3-10), so it fails
there and only there.

## 5a. PHASE 4 BOARD — drafted 31 Aug 2026, from the audit and not from the Plan's prose alone

**There is no Phase-4 tickets document, and there never was one** — same as Phase 3. This board comes
from the Plan's Phase-4 prose (per-tenant module enable/disable for VCC, Travel, Budgets and
Analytics; per-tenant branding and subdomain; Budgets and Analytics ported tenant-scoped; bilingual
plus en-US), the Differences Chart, HANDOFF's own deferrals (Module 12 slices 2–3 were pushed here
because they are retrospective and need approval history), and a **source audit of ExpenseOS at
`5a11a647`** recorded as GAP-AUDIT **MT-1..8 / BR-1..10 / BG-1..8 / AN-1..11 / IL-1..12**. Read the
audit first: five of those findings change what a ticket is, and two of them delete work.

**~20 dev-days across SIX tickets** (was eight: VX4-4 moved to Phase 5 and VX4-2 closed
superseded-by-construction — see the decisions below) — against Phase 2's ~26 and Phase 3's ~27. Two hard edges:
VX4-1 blocks almost everything, and VX4-5 was blocked on a chart of accounts that VX3-1 has already
shipped.

### What the audit deleted from the phase

- **Storage keys need no work.** BR-10: theirs have no tenant prefix; ours already return
  `org/<organizationId>/receipts/<id>/<file>` with the reason in the code. A day nobody has to spend.
- **Analytics' tenancy is already done.** AN-2/3/5/9 are four separate cross-tenant leaks in their
  analytics layer, all of the same shape: the privileged case is the *absence* of a predicate. RLS
  supplies the predicate below the query, and `test/rls-isolation.test.ts` proves it per table, so the
  class cannot recur here. What still ports is the money defect (AN-7) and the performance shape
  (AN-10) — which is a much smaller ticket than "port a BI module" sounds.
- **The report builder and scheduled exports do not exist** (AN-1). Four permissions are declared for
  them and nothing implements them. Do not estimate from the permission catalogue.

### The tickets

| # | Ticket | Why it is this shape | Days |
|---|---|---|---|
| **VX4-1** | **Per-tenant module entitlements** | MT-1: activation is a global singleton (`moduleId @unique`) and the schema says a tenant model "adds `tenantId` here only". MT-3: their gate lives at the edge, so 30 of 40 routers are ungated and a page can be gated while its data is not. Ours goes **below the router** — a `module` catalogue owned by code, an `organization_module` table (not a `settings` blob: MT-8/AC-21), and a **generated guard** proving every gated surface is covered, in the shape of the RLS-coverage and vendor-neutrality guards. | 3 |
| ~~**VX4-2**~~ | ~~Tenant-scoped settings, replacing the global singletons~~ **CLOSED — superseded by construction, 1 Sep 2026** | MT-2 named four global mechanisms holding what should be per-tenant settings, and the port was a typed settings registry. There is nothing to port *into*: every setting it names is already a per-tenant **column** here — NOT NULL, FK-validated where it has a domain, with a screen (`organization.policy_currency_code`, `module_entitlement`, per-org retention) — and a key-value registry would take those values out of reach of every constraint, index and RLS predicate, which is AC-21's lesson. All 27 `process.env` reads under `lib/` are platform-level by design, so the env half has nothing to convert. Same outcome analytics' tenancy had. **The audit of it did find a real defect** — PE-8, the policy currency's silent `'CAD'` fallback — fixed under this ticket's number, with **PE-9** boarded behind it. | ~~2~~ 0 |
| **VX4-3** | **Branding that actually renders** | BR-2 is the surprise: the fields, the admin form and the validation all exist and **nothing reads them**. So the port is the easy half and the render path is net-new — CSS custom properties injected per tenant (BR-3, deriving row/hover shades from the primary rather than hardcoding them), a tenant logo served pre-auth on the `public-icons` route's proven pattern (BR-4), `generateMetadata` instead of a static title (BR-5), and a branded email shell on VX2-8's template layer (BR-6). | 3 |
| **VX4-5** | **Budgets, tenant-scoped, on our own chart of accounts** | BG-2: `Budget.glAccountId` is a **required** FK into a NetSuite SOAP cache, and their vendor-neutral `Account` table was deleted — so budgets there are uncreatable without NetSuite. **VX3-1 already fixed this for us**; budgets point at `gl_account` and a vendor becomes an alias. Plus BG-1 (tenant column and composite keys on five tables, including an index Prisma cannot express), BG-3 (actuals recomputed over the whole fiscal year on every approval click, with an unbounded FX load → rollup), BG-6 (alert idempotency by mutable marker → our atomic-claim idiom). | 4 |
| **VX4-6** | **Analytics, tenant-scoped** | The tenancy half is free (above). The work is AN-7 — a missing FX rate is currently summed **as if it were base currency**, unflagged, while the budget code counts unconverted amounts for the same situation — and AN-10: unbounded ranges, no `date` index, and a home page that runs a full-history aggregate for every signed-in user. Plus AN-8's lesson: size the data with a predicate, never with a role check that then queries everything. | 4 |
| **VX4-7** ⏳ | **Locale: retag `en` → `en-CA`, add `en-US`** — parts 1 → 3 DONE. **VX4-7 CLOSED** (IL-1, IL-2, IL-4, IL-5/6, IL-7, IL-10, IL-11, UD-3, UD-5). fr-CA retired until its copy exists (0028) | IL-1: their `en` already formats as en-US (`3/4/2026`, `CA$10,799.00`), so this is a retag **and** an addition, 2 locales to 3 — touching URL segments, stored preferences and every `{ en: … }` Json key, whose arity is hardcoded in ~17 files (IL-7). Also: a company default locale, which does not exist there (IL-2); what a missing key does, decided before the third catalog exists rather than after two blank pages (IL-4); and the date-formatting calls that pass no locale (IL-10). | 3 |
| **VX4-8** ⏳ | **Module 12 slices 2–3: fraud detection + control evaluation** — part 1 (UD-8) and part 2 (slice 2, the four detectors) DONE; slice 3 (control evaluation) and the review UI next | Deferred to this phase since Phase 2 because both are retrospective and need approval history, which now exists. Their versions are driven by `SystemFlag` config (MT-2) and run as unconditional global crons (MT-5), so both land on VX4-1 and VX4-2. | 3 |

### VX4-8 part 2 SHIPPED — Module 12 slice 2: the four fraud detectors

Ported from `packages/fraud/src/{rules,scan}.ts` at `5a11a647`. All four of upstream's design
constraints survive unchanged, including the one worth repeating: **a rule produces a finding, never
a verdict.** Nothing here changes a report's state, blocks a payment or tells an employee anything —
"automated fraud accusations are how you get a wrongful-accusation problem instead of a fraud
problem."

**What the port had to change, and why:**

- **Their `Expense` carries `ownerId`, `amountMinor` and `date`; ours carries none of the first
  two.** Here an expense belongs to a report (which has the `submitter_id`) and the MONEY is on
  `expense_line_item`, because a split is the normal case. Every rule that talks about "this
  person's expense of $X" is expressed over a per-expense total computed from its lines. Same rule,
  different arithmetic. It also means an expense with NO lines has no amount — VX1-5's receipt-first
  flow makes those — and they are excluded rather than treated as zero, which would make every
  receiptless entry a duplicate of every other. There is a test for exactly that.
- **No stored English sentence.** `FraudFlag.reason` upstream is a rendered sentence with a record
  id interpolated into it. That is `policy_violation.message` again, three weeks after `0029`
  removed it. `fraud_flag` has `message_code` + `data`, rendered per reader by
  `lib/i18n/catalog/fraud-messages.ts`, and no uuid reaches a person.
- **`finding_key` is tenant-scoped.** Their `dedupeKey` is globally unique, so two organizations
  share a namespace. Nothing collides in practice because every key embeds uuids — the kind of
  safety that holds until somebody keys on a month and a rule code, as their SOD rule nearly does.
- **Config is per tenant.** Theirs is a global `systemFlag` (MT-2), so one tenant's noisy week
  retunes everybody's scan. `organization.fraud_config` is the same values, per org, with every
  field validated and falling back on its own — a scan that dies on a bad number reports nothing,
  which looks exactly like a scan that found nothing.
- **`DUPLICATE` is one rule and TWO sentences.** A duplicate inside one report is usually one dinner
  entered twice; across two reports it is the pattern worth opening both for. Fourth time in this
  port that a code designed for a CALLER has been coarser than what a READER needs.
- **External approvers are excluded from the concentration rule.** VX2-1 admits an EMAIL approver
  with no `app_user` row; a finding naming somebody with no record here is not actionable and
  `subject_user_id` could not point at them.

**The reconciliation is ONE statement, and its third case is a database rule.** Upstream does
`findUnique` → `create`/`update` per finding, so between their read of `status` and their write, a
reviewer pressing Dismiss loses. Here: `ON CONFLICT (organization_id, finding_key) DO UPDATE … WHERE
fraud_flag.status = 'ACTIVE'`. A flag somebody has already ruled on matches no `WHERE`, so it is not
written and not returned — suppression with no read, no race, and no branch a future edit can forget.
`RETURNING (xmax = 0)` separates created from refreshed; what comes back with nothing was suppressed.

**A failing rule is RETURNED, not logged.** Upstream `console.warn`s and carries on, so a rule that
has been throwing for a month looks exactly like a rule finding nothing.

**New module: `compliance`,** gated on `runFraudScan` in the service layer. The detectors are not
individually gated — they only read, over rows RLS already scopes, and four copies of a check the
single caller makes is MT-3 in the other direction.

**Two things the gates caught during the build, both worth recording:**

1. **`check:i18n` refused `MANUAL_FLAG`** — a sentence for a person-raised flag, written before the
   action that raises one exists. "Copy exists, no rule emits it" is the gate being exactly right;
   copy that ships ahead of its emitter gets translated and never shown. It arrives with part 3.
2. **`test/i18n-enum-catalog.test.ts`-style coverage caught a fixture, not a bug**: the combined
   render test only produced a same-report duplicate, so `DUPLICATE_OTHER_REPORT` was unreachable
   and the both-directions assertion failed. That assertion exists because part 2b shipped codes
   that matched and a sentence that still could not render.

**A known weakness in `check:i18n`'s message, not its verdict.** The ternary scan only counts codes
that are already declared, so a TYPO inside `cond ? 'A' : 'B'` is reported as "copy exists, no rule
emits it" rather than as the typo. The build still fails; the sentence points at the wrong file.
Inherited from part 2b and left alone rather than re-engineered inside a port.

### VX4-8 part 1 SHIPPED — UD-8: who sends an approved report

**John's call, 4 Sep.** `posting_trigger` is a per-org column (a COLUMN, per VX4-2's closure and
AC-21) with two values. **New organizations default to `AP_QUEUE`; every organization that existed
before migration 0030 was backfilled to `AUTOMATIC`.** The safe default is for people who have not
chosen yet — it is not a decision to make on behalf of people who already did, and a single
`DEFAULT 'AP_QUEUE'` would have stopped posting for every running tenant on deploy day with nothing
on any screen saying so. That is why `0030` is two statements, and why
`test/posting-trigger.db.test.ts` guards the shape of the DDL against a future "simplification".

**`HELD` is a queue status, not an absent row.** The obvious implementation — withhold the enqueue —
breaks AC-7 (the enqueue is a row in the approving transaction, which is why there is no cron sweep)
and creates a second source of truth for "approved and waiting", which is AC-14's shape. So the row
exists, is listed, and **is unreachable by the poller twice over, neither guard added by this
ticket**: `0017`'s `platform_read` policy matches `PENDING/FAILED`, and `claimPost` re-asserts the
same pair. Both were sabotaged separately; each fails a different test, which is what proves they
are independent rather than one guard written twice.

**`enqueuePost` decides the status, not its caller** (MT-3), and it does so in TWO statements. The
one-statement version — SELECT the trigger inside the INSERT — inserts zero rows when the tenant
context is missing and returns happily, turning a loud failure into a silently un-enqueued approval.

**The seeded demo tenant is `AUTOMATIC`, stated explicitly in `scripts/seed.mjs`,** because ten specs
approve a report and then assert something reached the ledger. `e2e/ap-queue.spec.ts` flips it and
covers the other half, and restores it in `afterAll` — with `workers: 1`, a spec that leaves the
fixture changed breaks whichever file runs next.

**Three test suites now set `posting_trigger = 'AUTOMATIC'` on their own org** (`ledger-post`,
`veloledger-sink`, `integration-oauth`). Their subject is what happens after a row is due; under the
new default every row would be HELD and every assertion about posting vacuous.

**`PostStatus` gained a runtime array (`POST_STATUSES`).** `test/i18n-enum-catalog.test.ts` kept a
hand-copied member list for it, adding HELD made that copy stale, and the file's own stale-copy check
said so — UD-9's shape exactly. The list is now derived, and `0030`'s status CHECK is tested against
the same array in both directions.

**Two corrections to my own earlier work, found by this ticket:**

1. **`e2e/pseudo-crawl.spec.ts`'s ratchet was counting user data.** `/expenses` went 44 → 50 because
   this ticket's e2e approves two reports — report titles are not copy and no catalogue will ever
   hold them, so the ceiling was measuring how many reports the suite had created. Excluding
   `<tbody>` was tried and **measured**: it drops the six-page total from 176 to 92, hiding 84
   genuine un-catalogued chrome strings to stabilise one page, so it was rejected. The ratchet now
   measures `/expenses` filtered to an empty table (`RATCHET_PATH`), which takes its baseline from 44
   to **19** — a tighter gate, verified by a sabotage that adds one hardcoded line and fails it at
   20. What it gives up: a hardcoded string appearing only inside a `/expenses` row is now invisible
   to the count. `/notifications` is still data-dependent with headroom, and says so.
2. **`npm run e2e:crawl` depends on the main e2e having run first.** Its "the server really is in
   pseudo mode" guard reads `/expenses`, and a freshly seeded tenant has no reports, so nothing is
   bracketed and the guard fails. CI's step order makes this true today; nothing states it. Run the
   suite before the crawl locally, or the failure looks like a pseudo-locale bug.

**Not done here:** switching to AUTOMATIC deliberately does NOT release what is already held. Those
reports were approved while a person was meant to decide. The screen says so and a test asserts it.

### VX4-7 part 3 SHIPPED — the crawl, and VX4-7 CLOSED

Baseline measured at HEAD before starting (1157 tests / 51 files) and after (**1165 / 52**).
**123 Playwright** twice in a row, plus **18** in the new pseudo-locale crawl. No migration.

**The third locale is a PSEUDO-locale, not French — John's call on 3 Sep.** Real `fr-CA` is 223
authored strings plus a data backfill for the localised DB columns. Writing them myself would ship a
locale no francophone has read, which is exactly what `0028`'s comment argues against at length.
`fr-CA` returns as a translation ticket; the machinery gets proven now.

**What a pseudo-locale does that coverage assertions cannot.** Parts 2a–2c closed the coverage half
properly. What none of it answers is *is this string coming from a catalogue at all* — a hardcoded
`<h2>` has no key to be missing and no locale to be absent from, so `check:i18n` cannot see it.
`PSEUDO_LOCALE=1` renders catalogue text as `⟦Ŝûƀmîttéd⟧`, so the un-catalogued text is the only plain
English on the page and a crawler can just look.

It is a TRANSFORM, deliberately not a member of `SUPPORTED_LOCALES`: no migration, no picker entry,
no tenant can store it, and **no request can turn it on** — the flag is read once at boot. That last
constraint is why `npm run e2e:crawl` needs its own config and its own server on shifted ports; a
cookie would have been one file instead of two and would have put a switch on the render path an
outsider can flip.

**THE NUMBER THIS PUT ON THE TABLE: 176 un-catalogued strings across six screens.** The product's UI
chrome — headings, buttons, columns, empty states — was never localised and never claimed to be. It
now has a per-page ceiling that can only go down. Boarded as **VX4-10**; cataloguing it is bigger than
2a, 2b and 2c together.

**TWO REAL DEFECTS, EACH FOUND BY A DIFFERENT HALF OF THE CRAWL.**

1. **`{row.eventType}` — the raw enum member — on the notifications screen.** Part 2a built
   `EVENT_TYPE_COPY` and moved eleven screens onto it; this one was missed, and no gate could see it
   because rendering an enum directly is a valid program. Worse:
   `e2e/approval-flow.spec.ts` matched that row by the literal `'APPROVED'` and had passed for four
   phases — the test was pinned to the defect. Fixing the render broke the spec, which is the correct
   order of events. `NOTIFICATION_WORDING_COPY` went in alongside it, because ` · your wording` was
   per-row chrome that made the page's count scale with how many notifications existed.

2. **Every one of the fifteen `/admin/*` pages answers HTTP 500 to a MANAGER or an EMPLOYEE.**
   `asAdmin` throws a bare `Error` inside a server component and nothing catches it. True since VX1-2
   and invisible because — the crawl's first finding — **every session `auth.setup.ts` ever minted was
   an ADMIN.** Four phases, thirteen specs, and no page in this product had ever been loaded as a
   non-admin. Authorization is INTACT (nothing leaks; the page never renders), but an ordinary
   permission denial is indistinguishable from the product being broken, and monitoring sees a 500
   every time the product works correctly. **Boarded as VX4-9**, not fixed here by John's call: the
   fix is a shared helper plus a refusal path across fifteen pages, and redirect-vs-403 is a product
   decision. `e2e/crawl.spec.ts` marks it `test.fail()`, so it goes RED the day it is fixed.

   Related and worth its own line: **`asAdmin` is copy-pasted into fourteen action files.** All
   fourteen predicates were diffed and are identical, so there is no hole today — said plainly,
   because "fourteen copies of an authorization check" invites the opposite assumption. It is fourteen
   places for the next one to diverge.

**THREE BUGS IN MY OWN WORK, ALL CAUGHT BY ASSERTIONS RATHER THAN REVIEW.**
The accent table mapped `t`, `T` and `Q` to themselves — a third of English passed through
unaccented — and `q` to `' q'`, a leading SPACE that silently inserted one into every word with a q.
Seven of the transform's eight properties held; the eighth ("no ASCII letter survives") is what
caught all four. The report-opening test skipped for all three roles because I pointed ADMIN at
`owner@demo.test`, who owns no reports — a skip that fires every time is a test that does not exist.
And `E2E_PORT` chose the port Playwright PROBES but never the one the server LISTENS on, latent until
part 3 needed a second server.

**And a ratchet I had to loosen.** The un-catalogued ceilings were exact matches, on the argument that
exact fails in both directions. Then the crawl ran after a full e2e and `/notifications` went red
because that suite creates notifications. A gate that goes red because the suite before it did its job
is a gate people disable — third time this ticket has landed on that — so it is an upper bound, and
the actual count is printed every run so a drop is visible.

**Sabotages, three, each re-run after `npm run build`.** Booting the crawl's server WITHOUT the flag
fails 4 (the "is this really pseudo mode" guard, which exists because the first attempt at this
sabotage did not actually turn the flag off); a badge bypassing `enumLabel` fails 2; a new hardcoded
heading fails the ratchet by name and count.

### VX4-7 part 2c-2 SHIPPED — IL-11 closed, and four disclosure paths no list contained

Baseline measured at HEAD before starting (1037 tests / 51 files) and after (**1157 / 51**). **49
Playwright** twice in a row. No migration. **142 message codes** in total.

**What closed.** The admin half of the reachable messages is catalogued and `errorParam`'s
transitional branch is deleted, so there is no path left that puts an exception's own text in front of
a person. Two cases now: a code, or the generic plus a log line. `renderUserMessage` also refuses an
uncatalogued value instead of passing it through, so a hand-edited link can no longer render arbitrary
text inside the product's error banner.

**The 2c-1 no-parameters constraint was walked back on purpose, and it is written down.** Fourteen
admin messages carry a COMPUTED value the page cannot show. The settling case is the contrast
message: `e2e/branding-flow.spec.ts` asserts all three ratios and its own comment says why. Parameters
ride base64url'd inside the error value (`?error=CODE~<blob>`), which is what kept all twenty
`ErrorBanner` call sites and every `searchParams.error` reader untouched — a second query key would
have meant twenty pages threading it, which is MT-3. `assertRenderableParams` refuses a UUID-shaped
value outright, because part 2c exists because a UUID reached a screen and a parameter channel
without that check is a nicer road in.

**`requires` is DERIVED here, DECLARED in `policy-messages.ts`.** A policy sentence is a function and
a function's body cannot be inspected — UD-5 req 3. A refusal is a template string, so the
placeholders are in it, and a hand-written list beside it is a second source of truth: the first
draft already had `APPROVER_OVERSPECIFIED` missing from it.

**FOUR DISCLOSURE PATHS, EACH FOUND A DIFFERENT WAY.**

| Where | What reached a screen | Found by |
|---|---|---|
| `lib/notifications/approve.ts:206` | anything `decide()` throws, on a page opened from an EMAIL link | reading the module — the gate scanned only `app/` |
| `lib/accounts/service.ts:213` | a third-party CSV parser's exception | cataloguing the module |
| `lib/accounts/service.ts:479` | a **Postgres trigger's** RAISE message, regex-matched and reshaped | cataloguing the module |
| `app/api/.../callback/route.ts:96` | **`error_description` off the provider's query string** — a remote party writing our banner | the strict renderer, via a FAILING E2E |

The last one is the keeper: making the renderer refuse unknown values turned a silent pass-through
into `oauth-flow`'s "Deny is a normal outcome" going red.

**BOTH GATES WERE WRONG BEFORE THEY WERE RIGHT, AND THAT IS THE LESSON.** Widening the raw-message
check to `lib/` flagged fifteen sites, most of them correct — `lib/integrations/dispatch.ts` builds
exactly that string for a delivery's `last_error`. **The pattern is not the defect; the destination
is.** It split in two: the spelling check stays `app/`-only (it is what caught the receipt drawer,
which has no URL at all) and a new destination check requires every `?error=${…}` anywhere to come
from `errorParam`, `errorCodeParam` or `encodeUserMessage`. The new params check then produced two
false positives of its own — a trailing shorthand key (`{ rule, maximum }`), and a multi-line object
with `${…}` inside — before its regex was replaced with a real brace scan. A gate that fails the
build on correct code teaches people to delete gates.

**Three things the new gates caught in my own work on their first run:** `COA_IMPORT_HAD_PROBLEMS`
declared `{detail}` while the throw site passed only `problems` (every bad CSV would have silently
shown the generic); `POLICY_SEVERITY_ABOVE_MAX` was passing `maximum` as a RAW ENUM MEMBER, so an
admin would have read "cannot be set above WARNING" — part 2a's defect walking back in through a
parameter three PRs later; and a first pass tagged the receipt-uploader check with
`MANAGER_NOT_IN_ORG`, rendering "That manager is not in this organization" at somebody uploading a
receipt.

**Copy discipline.** Ported, not rewritten — most of these were already written for the admin who
pressed the button, unlike the approvals half. The port rule was: move the sentence, keep the words,
change only what a code cannot carry. Two regressions from working off a truncated dump rather than
the source were caught and fixed: the contrast message lost "Try a deeper or lighter shade of the
same hue" (its only actionable clause), and `lib/branding/service.ts:229`'s magic-byte sniff — two
sentences behind a ternary — was missed entirely and is now two codes.

**Sabotages, three, re-run after `npm run build` where Playwright is involved.** Reinstating the
transitional branch fails 2 tests; making the renderer pass unknown values through fails 2; putting
`error_description` back in the banner fails `oauth-flow`. The params gate was separately checked in
both directions by dropping and adding a key at a real site.

**Still open — part 3, with the third locale:** IL-5/IL-6, the crawler pinned to one locale. Every
catalogue now has a coverage assertion over `SUPPORTED_LOCALES`, so what remains is the crawl, and
UD-3's role-crawl folds into it.

### VX4-7 part 2c-1 SHIPPED — a thrown error has two audiences, and one string served neither

Baseline measured at HEAD before starting (981 tests / 50 files) and after (**1037 / 51**). **49
Playwright** twice in a row. No migration.

**The framing IL-11 gave was wrong about our code, and finding that out was most of the ticket.**
It counts "157 English server messages rendered verbatim" and offers a choice between cataloguing
error copy and stopping the UI printing it raw. Ours are not English copy awaiting translation —
they are DIAGNOSTICS. `user ${actorId} may not decide approval task ${taskId}` reached the screen of
somebody who by definition had no right to that task, through
`?error=${encodeURIComponent(err.message)}`. Two internal UUIDs, unreadable, and more than they
should learn. Translating that into French would have been the wrong ticket.

**So the split is by AUDIENCE, not by language.** `message` is for the log — ids, statuses,
unchanged, still asserted on by the existing tests. `userMessage` is for the screen: a code into
`lib/i18n/catalog/errors.ts`, **or null**. Null is the load-bearing default. An error nobody decided
a person should read shows a generic sentence and its real message goes to the server log, so the
disclosure gap closes by construction rather than by remembering — MT-3, relearned a third time.

**The 2b finding reproduced one layer up, and it is the reason a `code` was not enough.** Nineteen
classes already carry a typed code union. `DelegationError`'s `INVALID_RANGE` covers three different
sentences; `LifecycleError`'s `WRONG_STATUS` covers four; `NOT_FOUND` covers both a user's mistake
and an invariant failure. A caller branching on a code does not need those apart. A person fixing a
form does. **An error code answers "what kind of failure is this"; a message code answers "what
should the person be told".** Exactly `rule_code` vs `message_code`, one layer up.

**No parameters in this catalogue, deliberately.** That constraint is what lets a code travel in
`?error=CODE` with no encoding scheme and be rendered by the PAGE in the reader's locale. A refusal
is a statement about the action somebody just took, on the screen they took it from, with their own
input in front of them — "the end date is before the start date" needs no dates in it. Where a
message wanted a value, the branch became its own code (`BLOCKED_BY_POLICY_ONE`/`_MANY`), which is
`POLICY_MESSAGE_CODES`' shape. One thing is lost: the blocking-violation count, and the policy panel
directly below the banner lists every one of them.

**`ErrorBanner` resolves the reader itself** rather than taking a `locale` prop like `StatusBadge`.
Twenty pages render it, and a prop twenty callers must remember is MT-3 again; `readerPrefs()` is
`cache()`d, so asking costs nothing on a page that already asked. The receipt drawer is the exception
and has to be — it is the one CLIENT component, so it takes the locale as a prop. The catalogue being
pure is what lets it cross that boundary at all.

**TWO THINGS FOUND BY TOOLS, NOT BY THE LIST I WAS WORKING FROM.**

1. **The e2e caught a regression in my own increment.** I converted five classes and left 21
   extending plain `Error`, so `errorParam`'s fallback swallowed every admin module's message and
   sent it to the generic. `branding-flow` failed on a contrast message it asserts by text. All 26
   classes now extend `DomainError` — which is the right end state anyway, and makes the fallback
   mean "not one of ours" rather than "not one of the five I got to".
2. **`check:i18n`'s new gate found two sites in the RECEIPT DRAWER**, the single client component in
   the product. Its failures never went near `?error=`, so it was outside every list this ticket was
   built from. What it printed was whatever crossed the server-action boundary or came back from an
   upload — a Next digest string in production, a browser fetch error otherwise. Neither is copy
   anybody wrote.

**Sabotages, four, each re-run after `npm run build` where Playwright is involved.** Reverting
`errorParam`'s generic to `err.message` fails 5 tests; a converted class going back to `extends
Error` fails 2 tests AND `tsc`; the old `err instanceof Error ? err.message` pattern in an action
fails the gate by name and line; `ErrorBanner` rendering the raw parameter fails `expense-flow`.

**Deliberately not in this PR — part 2c-2.** The ~55 remaining reachable messages, all admin-facing.
They still print their English through the transitional branch (`err instanceof DomainError →
err.message`), which is what keeps those screens saying what they say today. Deleting that branch
completes IL-11 and also stops arbitrary text in a link rendering as though the product said it.
**Name `AdapterError` when you do**: it can carry text from a far-end ledger's HTTP response, and the
transitional branch passes it through exactly as today's code does — status quo rather than a
regression, and the first thing 2c-2 should catalogue.

### VX4-7 part 2b SHIPPED — a violation says what the READER reads

Baseline measured at HEAD before starting (931 tests / 49 files) and after (**981 / 50**). **49
Playwright** twice in a row. Migration **`0029`** — run `npm run migrate` after merging.

**What it closes.** `policy_violation.message` was English, frozen at validation time, and shown to
every later reader — the approver, the auditor, the submitter coming back a month later. It was
frozen in a second way too: `$1,000.00` had been formatted once, in whatever locale the validating
request resolved to, which is exactly the mistake part 1b spent a PR establishing must not happen to
a stored value. Screens now render from `message_code` + `data` in the reader's locale.

**Three decisions worth keeping.**

1. **`rule_code` was not enough, and this is the non-obvious part.** Five rule kinds emit TEN
   sentences: a limit finding reads differently when the amount had to be converted,
   `RECEIPT_REQUIRED` has three shapes, and `BUDGET_OVERAGE` emits an overage plus a separate
   FX-floor note that deliberately coexist (what `finding_key` is for). Picking among them at render
   time means re-deriving, from `data`, the branch the rule already chose — the same decision made
   twice, in two places, from different information. `policy_violation.message_code` records the
   branch instead. Deliberately NOT a CHECK constraint: message codes change with every rule edit, so
   the constraint would be a migration per sentence — same call VX1-7 made for `expense_policy.kind`.

2. **`message` survives, as the audit record** (settled with John, 2 Sep). `resolve_note` is
   somebody's written justification for accepting THAT wording, and a template edited six months
   later must not silently rewrite what they agreed to. It is also the only thing pre-`0029` rows can
   show — their `data` never carried the labels the sentence interpolates, so there is nothing to
   backfill from and no honest way to invent one. `message_code = ''` means "show `message`", and
   `renderViolation()` is the one place that branch is taken.

3. **`message` is now a BYPRODUCT of the catalogue, not a second copy of it.** `finding()` in
   `rules.ts` renders it at `DEFAULT_LOCALE`, so the stored English and the per-reader render are the
   same function of the same inputs and cannot drift. Part 2a is the evidence for why that matters:
   three sentences were quietly reworded behind a comment claiming a verbatim port.

**UD-5 requirement 3 — the interpolated key a static scan cannot see — is closed at three depths.**
Each code declares a `requires` list; `fields()` refuses a missing key at render (returning a marker,
never throwing, because IL-4 is a missing key blanking a page); `test/i18n-policy-messages.test.ts`
runs the REAL rules over fixtures and asserts every declared key is in the `data` they actually emit;
and `check:i18n` compares the code set in the catalogue against the codes `rules.ts` emits **in both
directions** — copy with no rule is copy somebody translates and nobody sees.

**The bug this ticket reintroduced inside its own fix.** `renderPolicyMessage`'s first draft passed
the resolved COPY locale to `Intl`, so an `en-US` reader inheriting `en-CA` words also inherited
`en-CA` money. Copy falls back; formatting does not — a French reader reading English copy must still
see `1 300,00 $`. Caught by a test, not by review.

**Sabotages, all verified after a rebuild.** Removing `label` from one rule's `data` fails 10 tests
across 2 files; passing the copy locale to `Intl` fails 2; deleting a code from the catalogue fails
the gate AND `tsc` at 3 sites; adding copy no rule emits fails the gate; gutting `message_code` from
`SELECT_VIOLATION` fails the new e2e; and rendering `violation.message` in the panel fails it too.
**Note the method**: `playwright.config.ts` serves `npm run start:standalone`, so a source sabotage
without `npm run build` in between tests the PREVIOUS build and proves nothing — the first attempt at
the `SELECT_VIOLATION` sabotage came back fully green for exactly that reason.

**Deliberately not in this PR — VX4-7 part 2c.** IL-11's other half: ~87 error messages reachable
from the ~13 `?error=` paths (out of 265 throw sites across 26 classes; the rest are invariant guards
no UI can reach), and making the UI stop printing an unrecognised error raw. That second part is also
a small information-disclosure fix — `app/approvals/actions.ts:80` and siblings put ANY `Error`'s
message into a query string, not just a domain error's.

### VX4-7 part 2a SHIPPED — the enum catalogue, and one locale taken back off the shelf

Baseline measured at HEAD before starting (916 tests / 48 files) and after (931 / 49). 47 Playwright
twice in a row. Migration `0028`.

**`lib/i18n/catalog/enums.ts` — 16 rendered enums, 82 members, one render boundary.** It replaces
four hand-rolled label maps that disagreed about their own shape (one had copy with a raw fallback,
one had only colours, one used `row.status.toLowerCase()` as a substitute for copy) and eight sites
that rendered the SCREAMING_SNAKE value straight into the page. "This report is REIMBURSED and can
no longer be edited" was on a screen an employee reads.

The scope estimate in the ticket was 20 unions / 86 members. Measured, it is 16 / 82: `APPROVER_KINDS`
is only ever a predicate (`a.approver_kind === 'EMAIL'`), and task/request statuses are not rendered
at all. Cataloguing an enum nobody sees would make the coverage assertion claim more than it should.

**UD-5 req 1 is a TYPE, not just a test.** Each catalogue is `EnumCopy<TheUnion>` = `Record<TheUnion,
Copy>`, so a member added to a union and forgotten here does not compile. `Copy` requires `en-CA` and
permits the rest, which is the fallback chain expressed as a type: the default has nowhere to fall
back to, so a missing one is missing everywhere.

**UD-5 req 2 is why `test/i18n-enum-catalog.test.ts` imports the runtime arrays separately.** The
catalogue imports every union with `import type` — partly to stay pure (`REPORT_STATUSES` lives in a
module that imports `pg`), and partly because it means the catalogue CANNOT enumerate itself. The
test imports the arrays from the modules that own them and audits the catalogue against them.
`Object.keys(REPORT_STATUS_COPY)` would look almost identical and prove nothing.

#### `fr-CA` came back off the shelf, and that is the decision worth reviewing

Part 1 shipped three locales. Cataloguing showed `fr-CA` had no copy anywhere and no route to any, so
a French reader got French date and money formatting around English words — partial support that was
none. Reading enums from a catalogue would have turned each of those English words into a
missing-copy marker, i.e. made it visibly worse.

John's call: retire it until its copy exists. `SUPPORTED_LOCALES` now means "locales a reader can be
served in", `0028` shrinks the CHECK constraints to match and REFUSES to run if any tenant or user is
actually sitting on `fr-CA` (0027's precedent — where a migration cannot know what somebody meant, it
stops and says so), and the coverage assertion enforces that a shipped locale is a complete one.

**Sabotage-verified, because it is the whole point:** putting `fr-CA` back with an empty catalogue
fails SIX tests across three files, including the enum coverage one. The forcing function that was
missing when it shipped empty now exists.

One distinction the tests now have to keep straight, and it took a wrong assertion to find: a
RETIRED locale degrades to English (unknown tags read as the default chain — `fallbackChain`'s own
comment about stored values outliving a locale), while a SHIPPED locale with no copy gets the marker.
Both are right. The rule that a shipped locale must not fall back across a language boundary is now
asserted as that general property rather than by naming `fr-CA`, so it still fails the day somebody
writes `'fr-CA': ['fr-CA', 'en-CA']`.

#### Three copy regressions I nearly shipped while claiming I had not

The catalogue's first draft replaced the four existing maps with tidier-looking words and carried a
comment saying the wording was "ported verbatim". It was not — I wrote new strings and then asserted
fidelity I had never checked. `ledger-flow` caught it; the other two were found by then going back to
`git show HEAD:` for every map I had replaced.

- **`POSTED` was 'drafted in the ledger', not 'Posted'.** The material one. VX3-4 creates a DRAFT
  bill at the far end, so "Posted" claims a journal entry exists — to the person whose job is knowing
  whether one does.
- **`DELEGATED` was 'Covering', not 'Delegated to you'.** What an approver would actually say.
- **`IN_APP` was 'In-app', not 'In the app'.**

The one place the copy IS an improvement rather than a port is the delivery status, where the
previous code was `row.status.toLowerCase()` — which showed an admin the word 'dead' for a delivery
that ran out of attempts. That file now says so explicitly, because the other five are ports and the
difference should not have to be inferred.

**The e2e assertions moved to the catalogue rather than to the new strings.** `toHaveText('SUBMITTED')`
became `toHaveText(status('SUBMITTED'))`, which asserts THE SCREEN GOES THROUGH THE CATALOGUE and
cannot drift when somebody improves the wording. That it does not also check the copy is non-empty is
deliberate — the unit test refuses a blank default for any member, so the pair covers both halves
without either repeating the other.

**Still open for part 2b:** policy-violation messages re-rendered per reader from `rule_code` + the
`data` jsonb (populated at every emit site already, so no backfill), the per-class error copy across
~26 classes, and UD-5 req 3's runtime assertion for interpolated keys.

### VX4-7 part 1b SHIPPED — the render pass, and a root cause one layer below the ticket

Baseline measured at HEAD before starting (895 tests / 46 files) and after (916 / 48). 47 Playwright
twice in a row. The whole vitest suite also runs green under `TZ=Europe/Paris` and
`TZ=Australia/Sydney`, which is new and is the point of the ticket.

**The finding that reshaped the work.** node-postgres parses a `date` column into a JS Date at
SERVER-LOCAL midnight, so one stored `2026-03-04` is a different instant per deploy zone — and
rendering it in UTC gives **Mar 3** on any server east of UTC (measured: Paris and Sydney both). Our
`toISOString().slice(0, 10)` had that bug, and so does upstream's own remedy of formatting calendar
dates with `timeZone: 'UTC'`, which they apply at four sites with a comment at each. It is invisible
here only because the CI container runs UTC and the dev Mac runs Toronto, both west of it.

John's call was to fix it structurally: `lib/db/client.ts` now registers a type parser for OID 1082,
so a `date` arrives as `'YYYY-MM-DD'` text and has no timezone for anything to shift. The bug stops
being handled and becomes unrepresentable. `lib/budgets` had already reached this conclusion in one
module (`starts_on::text`, typed `string`); those casts are now belt-and-braces rather than the only
thing between the product and a day-shift. SQL comparisons are untouched, the JS ones compare ISO
strings which sort chronologically, and four permissive `Date | string` declarations were narrowed to
`string` so the compiler audits the rest.

**A sabotage proved the tests, not the fix.** Removing the parser and running the four date-heaviest
suites under `TZ=Europe/Paris` — 121 tests — changed nothing at all: they passed with the bug and
without it, because the calendar-date path had NO coverage. A defect measurable at the driver in four
lines was invisible to 895 tests. `test/i18n-dates.db.test.ts` and `test/i18n-format.test.ts` exist
because of that, and both fail if the parser is removed.

**Three kinds of date, three functions** (`lib/i18n/format.ts`), because the old `formatDate` was one
function doing three jobs and was wrong at two of them:

- `formatCalendarDate(value, locale)` — a `date` column. No zone involved; the same day for every
  reader on earth. Verified identical under UTC, Vancouver, Toronto, Paris and Sydney.
- `formatInstant(value, prefs)` — a `timestamptz`, in the READER'S zone. This is the live bug: 02:30
  UTC on the 4th is 18:30 on the 3rd in Vancouver, and the old formatter showed the 4th.
- `toDateInputValue(value, zone?)` — deliberately NOT locale-aware, because HTML requires
  `YYYY-MM-DD` and a browser given anything else shows an EMPTY field with no error, so submitting
  the form clears the date. Its output is assembled from `formatToParts` rather than laid out by a
  locale, so it is provably locale-independent.

**The gate grew teeth for that third one.** `scripts/check-i18n.mjs` now refuses a display formatter
inside an `<input type="date">` value. Neither the type system nor an e2e catches that shape — the
value is a `string` either way, and a test that fills the field overwrites whatever was there — so it
is a text property and gets a text gate. Sabotage-verified: restoring the original code makes it
exit 1.

**What moved:** 21 date sites, 13 money sites, `<html lang>` (part 1), and two surfaces where the
audience is NOT the reader:

- **Email** now composes in the RECIPIENT'S locale and zone. `renderMessage` has accepted a locale
  since VX2-7 and nothing ever passed one, so every email in the product rendered in the default
  regardless of who it was addressed to — IL-2's shape in the notification code. The recipient join
  was already there for the address, so this cost two columns. It matters more than the screens do:
  email is the one surface whose language cannot be corrected later, because `notification` stores no
  body and a policy violation can be re-rendered from its `rule_code` and `data`.
- **The in-app bell** now renders in the reader's locale; `listInbox` had the same unused parameter.

**Deliberately NOT done, and why:**

- **Policy violation messages stay English.** `policy_violation.message` is stored TEXT, baked at
  evaluation time, so two readers with different locales see one string. The right fix is to
  re-render from `rule_code` + the `data` jsonb — which is already populated at every emit site, so
  no backfill — and that is exactly UD-5 requirement 1, i.e. part 2's enum catalogue. Doing it here
  would have been part 2 arriving inside part 1b.
- **Five queries still default `minorUnit` to 2** (approvals inbox, reimbursements, ledger queue)
  because they do not join `currency`. Pre-existing, harmless while the product ships CAD and USD,
  and `lib/analytics/service.ts` already carries the warning. Those call sites pass `undefined`
  rather than a literal `2`, so the absence stays visible. Boarded, not folded into a locale PR.

### VX4-7 part 1 SHIPPED — the locale spine, and a date bug that is not a locale bug

`lib/i18n/` is four pure-or-nearly-pure files and one migration. Baseline measured at HEAD before
starting (822 tests / 43 files) and after (895 / 46) — the practice of measuring rather than
quoting, since the long-quoted "712" was two merges stale.

**`lib/i18n/locales.ts` — the registry.** `SUPPORTED_LOCALES = ['en-CA','en-US','fr-CA']`,
`DEFAULT_LOCALE = 'en-CA'`, `localeName` (endonyms, `Record<Locale, string>` so a new locale without
a name is a compile error), and an EXPLICIT fallback table. Three decisions worth knowing:

- **The chain is a table, not tag truncation.** Truncation is a rule that asserts a shorter tag is
  always a real fallback, so `fr-CA` would resolve through a non-existent `fr` and land on English —
  serving a French reader English as though somebody had decided to. Same class as their
  `normalizeLocale` = "starts with fr" (IL-9).
- **`en-US` inherits `en-CA`; `fr-CA` inherits NOTHING.** The second half is load-bearing and is the
  assertion a well-meaning edit would break. A silent English fallback is invisible to every
  reviewer reading in English, so missing French copy would ship forever; returning null makes it a
  bug report that files itself. `test/notification-catalog.test.ts` had an assertion PINNING the old
  behaviour (`renderContent({body:{en:'Hi'}}, 'fr-CA')` → `'Hi'`) — it is now inverted, with the
  reason in the test, because retagging it without flipping the expectation would have quietly
  failed the ticket.
- **`en-CA` and `en-US` genuinely differ in words**, not only formatting — cheque/check, GST/HST vs
  sales tax, postal code vs ZIP — which is why John chose a full-tag chain over language-keyed copy.

**`resolve.ts` — precedence with a caller for every rung** (IL-2's real finding): user → company →
`Accept-Language` → constant. The URL segment is a deliberate non-port; the company is inserted
ABOVE the browser on purpose. `negotiateLocale` is ~20 lines of BCP-47 Lookup replacing
`negotiator` + `@formatjs/intl-localematcher`, and the reason is not asceticism: their matcher takes
the default as its fallback argument and so CANNOT return "no match", which collapses two rungs into
one and makes the chain untestable.

**`0027` — `organization.default_locale`/`default_timezone`, `app_user.locale`/`timezone`.** Columns
on `organization` per 0023's settled argument (jsonb is out of reach of every constraint; and
`organization` is the one table read before anybody is signed in). NULL on `app_user` means "follow
the company" — a real answer, so an admin changing the default moves everybody who never chose.
The zone is validated by TRIGGER against `pg_timezone_names`, because a CHECK must be immutable and
`timezone()` is only STABLE; the failure it prevents is `Intl` throwing a RangeError on every render
of every page showing a date, for one tenant, which reads as an outage rather than a typo in a
settings row. Two `DO` blocks refuse the migration outright rather than migrate quietly: a template
carrying BOTH `en` and `en-CA` (two authored strings, equal claim), and any tenant with a locale in
`settings` jsonb — which finally turns 0001's aspirational comment into a checked claim.

**`scripts/check-i18n.mjs` + a CI step.** It IMPORTS `SUPPORTED_LOCALES` and hunts for any locale
tag outside the registry. Their `check-coverage.mjs` is the cautionary case one level up: it opens
by restating `['en','fr-CA']`, so a third locale there is not merely unwatched — every loop iterates
the stale pair and PASSES. Exit 2 (not 0) when it cannot read the registry or sees zero files, and
all eight outcomes were sabotage-verified. On its FIRST run it found `<html lang="en">` hardcoded in
the root layout since VX0-1 — the same `create-next-app` provenance as the `title: 'Create Next App'`
VX4-3 removed — and then found two copies of a locale→label map in the two screens I had just
written, i.e. IL-7 reproducing itself on the day it was closed.

**Three things only running it caught, all recorded in the code:**

1. **`revalidatePath('/', 'layout')` is required after a locale change.** Next preserves the root
   layout across the soft navigation a server action's `redirect()` performs, so the page's own
   sample updated while `<html lang>` on the same response still said the old locale — and since
   every client-side navigation also keeps the root layout, it would have stayed stale for the whole
   session. Found by `e2e/locale-flow.spec.ts`, which is why `<html lang>` is the assertion that file
   is built around: a screen reader picks its voice from it, so the gap is invisible to everyone who
   can see.
2. **A blank timezone reported itself as a bad zone name.** A BEFORE trigger runs ahead of the row's
   CHECKs, so `organization_default_timezone_nonempty` never got to speak and the first probe
   produced `"     is not an IANA timezone name"`. The trigger now owns the wording; the CHECK stays
   as the structural guarantee (0014's note: a trigger can be dropped, a constraint cannot be dropped
   by accident).
3. **The admin screen's first draft apologised for itself** — "the sample shows the setting currently
   saved, not the one selected above". Looking at the rendered page is what made that unacceptable.
   It now renders ALL THREE locales as a comparison table, which is better than a live preview
   because the question is comparative: `$10,799.00` sits directly above `CA$10,799.00`, and that
   pair is the whole of IL-1 on the screen where somebody can act on it.

**A sabotage found a weak test of my own.** Breaking `loadReaderPrefs` to short-circuit on "the user
has any preference" failed the independence test but left `by email … gives the same answer` green —
its fixture set only the user's locale and left the company on UTC, the value it would fall back to
anyway, so it passed for a second reason. Strengthened to disagree on both axes, and to assert the
pair absolutely rather than only `toEqual(byId)`, since comparing two implementations to each other
passes when both are wrong the same way. UD-5 req 2 in miniature.

**Both writes are audited, `from → to`, and the actor is REQUIRED** (an optional actor is an audit
call the next caller forgets — MT-3 applied to the trail). The reason is stronger than the one
`app/notifications/actions.ts` gives for preference changes: locale changes how money and dates
render on a financial record, and `03/04/2026` is two different days to two readers who dispute an
expense report months later. A cleared preference records as `'inherit'`, not null — `canonical()` is
in the hash and a null reads as "nothing recorded" where the fact is "this person chose to follow the
company".

#### The date finding, which is the part to read before starting part 1b

IL-10's class **does not exist here** — zero `toLocale*` calls anywhere. There is one formatter,
`formatDate` = `toISOString().slice(0,10)`, at ~20 sites. But two bugs sit in that one line and only
one is about locale: for a `timestamptz` it renders the **UTC day**, so a report approved 4 March at
18:00 PT shows as 5 March, live, in shipped code, for every reader west of UTC.

The naive fix is wrong in the other direction, and upstream's own scars say so: they format calendar
dates with an explicit `timeZone: 'UTC'` at four sites, each commented about behind-UTC readers
seeing the previous day. The schema has both kinds — **8 `date` columns** and ~90 `timestamptz` — and
one formatter is applied to both, so it is accidentally right for the calendar dates and wrong for
the instants. Part 1b therefore needs THREE functions: a calendar date formatted in UTC, an instant
formatted in the reader's zone, and `toDateInputValue`, which must stay ISO `YYYY-MM-DD` forever.

**That third one is the trap.** `app/expenses/[reportId]/page.tsx:292` feeds
`formatDate(expense.txn_date)` straight into `<input type="date">`. A locale-aware `formatDate`
renders `3/4/2026` there for en-US, Chrome silently rejects it, the field goes blank, and saving
clears the date — a data-loss bug introduced by the localisation fix. `app/admin/expense-policies/
page.tsx:54` already keeps its own separate `dateValue()` helper for this, correctly.

Part 1 ships the storage and the resolution and threads only `<html lang>`; `formatMinor` keeps its
default parameter (all 23 call sites still let it stand) rather than becoming required, because 23
mechanical edits inside a storage PR is where a wrong locale gets pasted. Part 1b moves every call
site at once, with a scan that refuses a display formatter in an `<input>` value.

### VX4-3 part 1 SHIPPED — the branding store, and the colour maths that is the actual ticket

Migration `0023` puts `brand_color`, `logo_bytes`/`logo_mime`/`logo_updated_at` and `login_tagline` on
**`organization`**, and the header explains why that beat the two alternatives. `organization.settings
jsonb` has claimed branding in its comment since `0001`, and VX4-1 already refused the blob for
modules (MT-8 / AC-21): every guarantee below would become an `if` in one code path. A new RLS table
was the VX4-1 shape and is actively wrong here — branding has to be readable with NO tenant context,
and under FORCE RLS an unset context sees zero rows, so it would work only for the reader that needs
it least. `organization` carries no `organization_id`, is not RLS-scoped, and is already the table
read by slug before anyone signs in.

**`logo_url` is a deliberate NON-port** and their own repo makes the case: their form takes
`z.string().url()` and renders it as `<img src>`, while `api/public-icons/[code]` — same problem,
twenty files away — streams bytes out of Postgres with `nosniff`, `attachment` and a sandbox CSP,
carrying the scar in its comment ("uploads are now raster-only, but rows may predate that"). We take
the bytes shape and make raster-only a CHECK. Eight constraints, every one probed for refusal by name.

**The colour work is the substance, and it is one hex in, everything out.** `lib/branding/color.ts` is
pure arithmetic: normalise, WCAG luminance and ratio, an OKLab conversion, and a seven-step ramp.
Three decisions worth not relitigating:

- **Derived shades are SOLID, never alpha.** ExpenseOS's `rowState.ts` is the recorded reason — alpha
  compounds between a `<tr>` and a sticky `<td>` and the leading cell goes visibly darker. "Derive the
  hardcoded shades" naively means `/15`, which is the bug they already paid for.
- **Computed in TypeScript, not emitted as `color-mix()`.** `color-mix` would be free and would get
  dark mode by mixing against a token that flips. Rejected because a test over a CSS string containing
  `color-mix(...)` asserts nothing about the resulting colour — this project's recurring lesson in a
  new hat. Computed hexes can be asserted, and are: round trip ≤1 byte over a sweep, monotonic
  lightness, hue retained, within 0.06 L of the hand-tuned sky it replaces.
- **OKLab, not sRGB.** sRGB mixing desaturates into chalk unevenly per hue, so a yellow tenant and a
  blue tenant would get ramps of different quality. Sabotaged both ways to check the tests can tell.

**`brand_color IS NULL` emits NOTHING** — no existing tenant's product changes appearance because this
shipped, and an absent colour stays distinguishable from a colour that happens to equal our sky.

**The contrast rule, per John's call of 1 Sep:** choose white or ink per tenant from luminance, refuse
only where NEITHER reaches 4.5:1. Measured over the 24-bit space that refuses **6.3%**, all of it
mid-luminance, so the rule costs an admin almost nothing. The refusal lives in the SERVICE, not the
form — MT-3 for the fourth time this phase, and a colour can also arrive from a seed, an import, or
whatever provisions a tenant in Phase 5. Its message names both ratios, because "contrast too low"
tells an admin nothing they can act on.

**Two live a11y defects in our OWN shipped palette fell out of the arithmetic, and neither is fixed
here** — `app/velotech-tokens.css` is shared VeloTech brand and recolouring the product is not this
ticket's call. Both are pinned numerically in `test/branding-color.test.ts`, so fixing the sheet makes
those tests fail, which is the intended signal to come back and delete them. (1) `--primary` #0284c7
on white is **4.10:1**, below AA, and ink would be 4.36:1 — the shipped pairing is the worse of two
short options. (2) Dark mode's `--accent-foreground` sits on `--accent` at **2.14:1**, because the dark
block replaces the surface and not the text on it; 7.09:1 in light. A branded tenant escapes (2) —
VX4-3's dark block moves that token — an unbranded one does not.

**BR-9 was missing from my own BR-1..10 audit.** Filled from source rather than renumbered: ExpenseOS
has no favicon file, no manifest, no `theme-color`, no apple-touch-icon, and `proxy.ts` excludes a
`/favicon.ico` that does not exist. Ours is worse — `app/layout.tsx` still says
`title: "Create Next App"`, live in every tab today. Part 2's `generateMetadata` is the same request
path as a per-tenant icon route, so they belong together.

**Part 2 is the render path:** `generateMetadata` + the icon route, the `<style>` injection in the
layout, `/api/branding/logo` (with the magic-number sniff `setLogo` deliberately defers to it), the
admin screen, and an e2e that sets a colour in one tenant and proves the other is untouched. **Part 3**
is the email shell (BR-6) on VX2-8's template layer — `htmlBody()` in `dispatch.ts:292` currently
builds bare `<p>` tags, the same finding their `notification-dispatch.ts:181` has.

### VX4-3 part 2 SHIPPED — the render path, and the tab that said "Create Next App"

`app/layout.tsx` exported `title: 'Create Next App'`, `description: 'Generated by create next app'` —
the `create-next-app` defaults from VX0-1, live in every tab of the product. `generateMetadata` now
answers **`<tenant name> · VeloExpense`**, tenant half first because a browser truncates the END of a
tab title and the half that says which window this is has to survive. ExpenseOS's own version is a
static `title: 'ExpenseOS'` export, so BR-5's fix was `generateMetadata` either way; the scaffold text
was a worse starting point, not a different problem. The tenant's logo doubles as the tab icon through
the same route, so the `?v=` stamp and the immutable cache apply to the favicon too — BR-9's per-tenant
icon question answered by the request path it shares with the title.

**The injection is one `<style>` in `<head>`, and both halves of that matter.** In `<head>` because a
`<style>` discovered in `<body>` repaints what has already been painted — a branded tenant would flash
sky blue on every cold load, the kind of defect that gets called "just a flicker" and never fixed. And
*after* the imported sheet, because these are overrides at equal specificity and the later one wins.
`dangerouslySetInnerHTML` is the only way to emit a stylesheet and is safe for a reason that is checked
rather than asserted: every value went through `token()`, which throws on anything that is not
`#rrggbb`, and the spec matches the whole emitted string against a strict shape — so an edit that
interpolates a tenant NAME there fails the suite instead of shipping a `</style>` escape.

**`brandingForRender` is wrapped in React's `cache()`, and that is not an optimisation for later.**
`generateMetadata` and the layout body both need it and Next calls them separately, so the naive
version is two sessions read and two queries on **every page in the product, forever**, to render one
title and one style block. AN-10 is the same lesson from the other direction: the cost that never shows
up in a test is the one on the path every request takes. It is also the one module allowed to turn "no
tenant" into "no branding" — the root layout wraps `/login`, so an unauthenticated visitor must get the
page unbranded rather than a stack trace. Nothing else is swallowed: a database that is down still
propagates, because a layout that renders a plausible unbranded page during an outage hides the outage.

**The magic-number sniff landed in the SERVICE, where part 1's comment said it belonged.** The declared
mime arrives from a multipart form, so on its own it is a claim. `0023` refuses `image/svg+xml` at the
column, which means the only way to get scriptable bytes in is to **lie about the type** — the CHECK
cannot tell and the sniff can. Its job is narrow and worth stating: it makes the stored `logo_mime`
TRUE, which is what makes `nosniff` mean anything, since `nosniff` tells the browser to trust our
Content-Type. Not a decode — a corrupt PNG with a good signature still stores, renders broken, and
harms nobody, and a full decode means an image library in the request path for a wordmark.

**A finding about my own defence, recorded because PE-8's lesson cuts both ways.** The
`bytes.length >=` guards in the sniff are **redundant today** — indexing a Buffer past its end yields
`undefined` and `Buffer.equals` across lengths is false, so every branch already answers null for a
short buffer. Established by sabotaging them away and watching NOTHING fail, not by reading the code.
They stay, with that written down, because the guard is the invariant and not the mechanism: a rewrite
reaching for `readUInt32BE` to read the WebP chunk size would throw on a short buffer. PE-8 was a
fallback that looked like dead defence and was not; this is one that IS, kept knowingly.

**`/api/branding/logo` is the `public-icons` route ported header for header** — `nosniff`,
`Content-Disposition: attachment` (ignored for `<img>`, so the page renders, but a top-level navigation
downloads instead of rendering uploaded bytes on our origin), and a sandbox CSP as the thing that makes
`0023`'s SVG refusal survive a future migration relaxing it. **One divergence:** theirs is
`max-age=300` with a comment explaining the compromise ("an icon change reuses the same URL, so cap
staleness"); ours carries `?v=<logo_updated_at>`, so it is `private, immutable` for a year and a
rebrand is a different URL. It is **not** public, unlike theirs — pre-auth branding is Phase 5 and will
need a route addressed by SLUG, which is a different route rather than a relaxation of this one.

**Two bugs of mine caught before CI saw them, both by reading rather than running.** The "Reset to
default" button was `<button name="brandColor" value="">` beside an input of the same name — a submit
button shares the form's namespace, so both entries landed in the FormData and `.get()` returned the
input's value. **The reset silently did nothing.** It has its own field now. And the spec read the
injected `<style>` with `innerText()`, which answers `''` for anything not rendered, so that assertion
could only ever pass vacuously — §4 gained a seventh entry for it.

**CI caught a third bug of mine, and finding out why exposed a fourth in the guard itself.**
`app/admin/branding/actions.ts` had `export interface BrandingPage`, and `check:actions` is right to
refuse it: Next registers every export of a `'use server'` module as a server action, cannot wrap a
type, and rather than failing the build **registers NONE of the module's actions** — so every form on
the page posts an id the server has never heard of. A silent, total failure from one `export` keyword.
The type is now unexported (`BrandingView`); `getModulesPage` returns an inline literal for the same
reason, so this is the house pattern rather than a workaround.

**The guard's own defect is the more useful finding.** Check 1 (export shapes) is pure source analysis
and needs no build; check 2 reads the build's manifest. Both used to report together at the BOTTOM of
the script — after the missing-manifest and stale-manifest bail-outs — so a stale manifest **threw away
an already-collected check-1 finding** and printed *"This is not a finding — the build simply has not
seen these files yet"* while holding one. That is why this reached CI: every local run of the guard
swallowed it, and the message said so confidently enough to be believed. Fixed by reporting check 1
before either bail-out, and verified by putting the `export` back and watching it report **without a
build**. Check 1 across all 18 `'use server'` modules is otherwise clean, so nothing else was hidden.

Worth stating as the general shape, because it is this project's recurring lesson wearing the guard's
own clothes: **a check that cannot produce one of its two outcomes hides every defect in the outcome it
cannot produce** — and a guard whose findings depend on a build it does not need is worse than no
guard, because it answers.

**Still unverified by me:** `e2e/branding-flow.spec.ts` (9 tests). vitest, `next build` and Playwright
cannot run in the device shell, so the spec has been through §4's checklist and nothing else. Its
riskiest assertion is the paint probe — it resolves `var(--primary)` into a real `color` and expects
`rgb(15, 118, 110)`, deliberately instead of reading the custom property back, because browsers
disagree about whether `getPropertyValue('--x')` substitutes `var(--y)` and asserting on that would
test Chrome's serialiser rather than our stylesheet.

**Part 3 is the email shell (BR-6)** on VX2-8's template layer: `htmlBody()` in `dispatch.ts:292`
builds bare `<p>` tags today, exactly the finding their `notification-dispatch.ts:181` has.

### The migration runner and its ledger — the class that broke VX4-3's e2e run (John's call, 1 Sep)

**What happened.** `0023` was merged and applied nowhere. `npm run e2e` built, passed
`check:actions`, seeded, then died inside `approval-flow` — a spec with nothing to do with branding —
on `column "brand_color" does not exist`, printed in a `[WebServer]` log rather than as a test
failure. VX4-3 part 2 is what made it total instead of local: the root layout now reads branding on
every render, so one missing column breaks every page in the product.

**Why nothing could have caught it.** Migrations were applied BY HAND from a README line;
`npm run e2e` never checked; and CI *cannot* notice drift, because CI creates a fresh database and
applies every file in a loop. Every path that might have seen it was structurally unable to.

**The fix, in the house pattern.** `scripts/migrate.mjs` + a `schema_migration` ledger (name,
checksum, applied_at) is the mechanism; `test/migrations.test.ts` is the generated assertion, in the
shape of the RLS-coverage, tenant-FK and vendor guards — it walks `prisma/migrations/` so migration
`0024` is covered the moment it exists. CI's shell loop is replaced by the same runner, so a laptop
and CI now share one code path. `npm run migrate` is a step in `npm run e2e` before the build.

**Why a ledger rather than "run CI's loop locally too":** that loop is correct only because CI's
database is empty. Replaying `0001..0023` over an existing database dies on the first `ADD COLUMN`,
and the alternative — `IF NOT EXISTS` through every migration — turns each one into a statement that
cannot tell "already applied" from "silently did nothing".

**Four refusals, each verified against a real Postgres:**

- **An edited applied migration.** The checksum is stored; if the file changed, the database and the
  repository disagree about what the schema *is*, and every later reading of the files is wrong.
- **A gap** — `0023` applied while `0022` is not. Applying `0022` now would run it against a schema
  it was never written for.
- **A populated database with an empty ledger.** It does NOT guess: probing for objects would either
  replay DDL or skip it. It asks for `--baseline <name|number|all>` once, which records without
  running. A fresh database needs no flag, because empty ledger + absent `organization` is
  unambiguous.
- **`--baseline` against a non-empty ledger** — refused rather than silently ignored.

**AND A WORSE ONE: the runner was correct and my INSTRUCTION was not.** The first real use of
`--baseline` was mine, in the handover text, and I told John to run `--baseline all` against a
database that was current through `0022` and had never seen `0023`. It did exactly what it was asked:
recorded `0023` as applied without running it. `npm run migrate` then reported *"nothing pending"*,
and the same six specs died on `column "brand_color" does not exist` — the original failure, now
with a clean bill of health on top. I had tested the `--baseline 0022` path minutes earlier and still
handed over the wrong value.

The lesson is not "be careful with the flag". A one-time step everybody runs, whose wrong answer is
silent and total, needs the tool to check the claim rather than the operator to get it right. So
`--baseline` now **verifies before it records**: it walks backwards from the newest migration being
baselined to the first one declaring a table or column it can read, and requires every one to be
present. The bad instruction is now refused, by name, with the right one in the message:

    migrate FAILED: --baseline all claims 0023_tenant_branding is already
      applied, but this database does not have what it creates:
      · organization.brand_color   … (five columns)
      If your database is current through 0022_module_policy_backstop, baseline THAT

Nothing is recorded when it refuses. `--baseline 0022` on that same database verifies against
**0021** — because `0022` declares only a function and policies, which the scanner deliberately
cannot read — then applies `0023` for real. A migration it cannot read at all is reported as *"recorded
unverified"*, never as verified: those are the two answers a check like this must never conflate.

**This also marks the limit of `test/migrations.test.ts`, worth stating plainly.** That guard compares
the ledger to the FILES, not to the SCHEMA. A lying ledger passes it — which is precisely what
happened. The schema check above closes the moment a lie can be introduced (a baseline); a ledger
edited by hand afterwards is still outside what either guard sees.

**A smaller bug of mine that only running it could find, and it is worth keeping in mind for any
script that both advises and acts.** The first version keyed the baseline branch on *"the ledger table did
not exist"*. But the ask `exit(1)`s **after** `CREATE TABLE IF NOT EXISTS` has already run — so on the
very next invocation the table existed, the branch was skipped, and the `--baseline` the script had
just told the user to pass was **silently ignored**: it went straight to applying `0001` against a
populated database and died on `relation "organization" already exists`. Guidance that leads to a
worse failure than the one it explains is the worst kind. The condition is now "the ledger is empty",
which is the honest test of *has this ever been recorded*.

**Every migration runs in one transaction with its ledger insert**, so a failure leaves neither a
half-applied schema nor a lie about it — verified with a deliberately broken `0024`: nothing leaked,
nothing recorded. Checked, not assumed, that no migration in this repo uses `CREATE INDEX
CONCURRENTLY` or opens its own transaction; one that needs `CONCURRENTLY` will fail loudly here,
which is the right place for that conversation.

### VX4-3 part 3 SHIPPED — the email shell, and a vacuous test of my own

BR-6, and its two halves point opposite ways: ExpenseOS's password-reset mail IS branded and
hardcoded (product name in both locales, `#0c2340`/`#f76b15` inlined), while their
`notification-dispatch.ts:181` has no wrapper at all. **We inherited the unbranded one** — `htmlBody()`
built four bare `<p>` tags. It now builds only the body and `emailShell()` wraps it: tables for
layout, inline styles, no `<style>` for Gmail to strip, nothing external, `role="presentation"` so a
screen reader does not read the scaffolding as data.

**No logo in the email, and it is a finding rather than a shortcut.** `/api/branding/logo` is
session-gated, so an `<img>` there **404s for every recipient** — not "blocked until they click show
images". And the recipient who most needs this mail is the approver deciding from a link *without ever
signing in*, who by construction has no session. CID embedding is the right answer, needs an
`attachments` field on `EmailMessage` and a multipart-assembling transport, and is filed rather than
half-built. Shipped: a text wordmark in the tenant's colour.

**The unbranded default is NOT `--vl-brand`, on purpose.** #0284c7 is 4.10:1 / 4.36:1 — below AA either
way. The app already renders it and that is not this ticket's call, but this surface is NEW and picking
a measured-inaccessible colour for fresh code is indefensible. The accent is the ramp's 600 step
(#0079bb, 4.72:1), derived so it cannot drift. The email's blue is a shade deeper than the app's; that
seam should stay visible until the sheet is fixed.

**A circular import, caught before it shipped, and the third instance of one shape.** `email-shell.ts`
needed `escapeHtml`, which lived in `dispatch.ts`, which imports `email-shell.ts`. Extracted to
`lib/notifications/html.ts` as a leaf and re-exported so no caller changed — the same move
`lib/integrations/errors.ts` was (VX3-6) and the reason `conflicts.ts` was placed as a leaf (AC-22).
**A shared helper belongs below both users, not inside one of them.** Worth promoting to a rule.

**AND MY OWN PROPERTY TEST WAS VACUOUS.** The sweep asserting "the rendered button is readable for
every colour a tenant can save" pulled the pair out of the HTML with
`/background:(#hex);color:(#hex)/` — which matches the `<body>` tag
(`background:#f1f5f9;color:#0f172a`) long before the button. Those contrast at 15:1, so the sweep
passed for all 1,331 colours **while never once looking at a button**. Found by sabotaging the shell to
always write white and noticing the sweep stayed green while a smaller test failed: the sabotage caught
the code, and the code's survival caught the test. The matcher is now anchored on
`display:inline-block`, and a separate assertion guards the helper so a markup reorder cannot make it
vacuous again.

That is the third time this session a check could not see one of its two outcomes — after
`check:actions` discarding its own finding, and `innerText()` on a `<style>` answering `''`. The
pattern worth carrying: **when a sabotage fails fewer tests than expected, the surviving tests are the
finding.**

### VX4-5 part 1 SHIPPED — the budget schema, and the department stamped at submit

Migration `0024`. **BG-2's blocker was already gone and this is where it shows:** their
`Budget.glAccountId` is a NON-NULLABLE FK into a twice-daily NetSuite SOAP cache whose
vendor-neutral `Account` table they deleted, so budgets there are uncreatable without NetSuite. VX3-1
built a tenant-owned chart of accounts, so `budget` points at `gl_account` and a vendor becomes an
alias. Their reconciliation argument is kept — the scope is an ACCOUNT, not a category, because a
category is how an employee describes a purchase and an account is what finance reports on.

**Three decisions worth not relitigating:**

- **`NULLS NOT DISTINCT` on the scope index.** BG-1's real defect: Postgres treats two NULL business
  units as distinct, so without the clause "the company-wide travel budget" could be created twice and
  every total afterwards would be wrong with nothing on screen to show it. Their ORM cannot express the
  clause and drops it; ours is written out. Verified refusing a duplicate.
- **Periods are rows with `starts_on`/`ends_on`, not an ordinal month.** Theirs hard-codes
  `MONTHS_IN_BUDGET_YEAR = 12` and rules 4-4-5 out; the audit said price that request rather than
  discover it. Twelve months is now a seeding decision, 4-4-5 is a different seeding decision, neither
  is a migration.
- **`unconvertible_minor` is its own column and is NEVER folded into `actual_minor`.** AN-7 inverted:
  their analytics sums an amount with no FX rate *as if it were already in base currency, unflagged*.
  A budget that quietly under-reports is worse than one that says it cannot answer. And
  `rolled_up_at IS NULL` means "never calculated", not "zero spend", so a screen can say which.

**The department is STAMPED at submit (John's call, 1 Sep).** `department_id` lives on `app_user`, so
the obvious rollup joins through the submitter — and then a transfer rewrites a closed period's totals
after the fact, nothing records why, and recomputing the same period twice can give two answers. The
report now carries its own copy, which is AC-10's stamp-on-write for the same reason VX3-1 stamps the
GL account. Existing rows are backfilled from each submitter's CURRENT department, and the migration
says out loud that this is approximate for anybody who has since transferred — better than leaving
them NULL, which would make every historical budget read as "no department".

**A bug caught by verifying a claim I had already written.** The first stamp keyed on `actorId`, with a
comment asserting that an `assertOwner` above had established the actor is the submitter.
**`submitReport` has no ownership check at all** — the action layer does it, and it permits
`submitter_id === actor.id || role === 'ADMIN'`. So an admin submitting somebody else's report is a
supported path, and the stamp would have written the ADMIN's department onto an employee's spend. It
now reads `expense_report.submitter_id` from the target row. `test/budgets.db.test.ts` puts the admin
in Sales and the employee in Engineering specifically so that mistake cannot pass again, and sabotaging
the fix back to `actorId` fails exactly that test.

**Also caught: the entitlement row's placement, for the third time in this ticket family.** The first
draft of the test created `gl_account` rows before writing `module_entitlement`, and `0022`'s policy
refused them — VX4-1's fail-closed default doing its job. The row now goes immediately after org
creation, which is where VX4-1 already learned it belongs.

**Part 2** is the reader: `PolicyContext` is `{report, expenses, policyCurrency, minorUnits, rates}`
and `evaluate` is pure and synchronous, so a budget snapshot has to be LOADED INTO the context by the
service — the rule cannot query. That makes the rule and its loader one unit, and the severity clamp
lands with them: a clamp with no rule carrying a maximum is untestable at evaluate time, and shipping
the rule with an `evaluate` that returns `[]` to make the mechanism look tested is the
stub-that-can-only-produce-one-outcome pattern that has cost this project four defects. **Part 3** is
alerts (BG-6's atomic claim), the screen, and the e2e.
*Part 2 has since SHIPPED — see the section below, which also records why it grew the rollup writer.*

### VX4-5 part 2 SHIPPED — the rollup, the rule, and both halves of the clamp

**No migration.** `0024` already had the columns; this is the code that fills them and the rule that
reads them. `lib/budgets/scope.ts` (pure) + `lib/budgets/service.ts` (the pg half) +
`BUDGET_OVERAGE` in `lib/policy/rules.ts` + the clamp in `lib/policy/service.ts` + three transition
hooks + `test/budget-scope.test.ts` and twenty new cases in `test/budgets.db.test.ts`.

**The board said "the rule and the clamp"; it ships with the ROLLUP WRITER as well, and that was a
decision (John, 2 Sep).** Nothing outside a test wrote `budget_period.actual_minor` /
`pending_minor` / `rolled_up_at`, so a `BUDGET_OVERAGE` shipped alone would have read
`rolled_up_at IS NULL` forever in production and could only ever have answered "not yet calculated".
That is the check-that-cannot-produce-one-of-its-two-outcomes shape this project has paid for four
times. The alternative — tests writing rollups in raw SQL, production silent until part 3 — would
have been green and hollow.

**Five decisions worth not relitigating:**

- **`resolveBudget` is most-specific-first and returns ONE budget, never every match.** Ported from
  ExpenseOS (`packages/approvals/src/budgets.ts:117-146`), including their tie-break: (account, BU,
  null) beats (account, null, department), because business unit is the coarser and more reliably
  populated dimension. Their reasoning for not summing matches is the part that matters — spend
  counted against both a department budget and the company-wide budget for the same account is
  double-counted, and the company total then drifts by however many department budgets exist, with
  both numbers looking plausible on their own.
- **A line's date falls back to `created_at::date`, not `current_date`.** `expense.txn_date` is
  nullable and an undated line still has to land in a period or the totals under-report (the AN-7
  family). `current_date` would make a budget total change overnight on its own; `submitted_at` moves
  when a report is recalled and resubmitted. The rollup and the rule share one SQL constant for this,
  because two copies of the expression is how they become two different answers.
- **ONE finding per budget period, which is the OPPOSITE of theirs — and their own comment says why
  they had to collapse.** ExpenseOS emits a single finding for the whole report because their
  violation identity is `(ruleCode, lineItemId)`, so a second report-level finding is silently
  dropped and a justification attaches to whichever row was first. `policy_violation.finding_key`
  (VX1-7) exists to fix exactly that, so the constraint that forced their shape does not apply here.
  The finer shape is also the better product: an acknowledgement carries a NOTE, and one note waving
  through "the travel budget and the marketing budget together" tells an auditor nothing about either.
- **Unconvertible spend gets its OWN finding, with its own key, beside the overage.** So the two
  coexist rather than one replacing the other. Being over budget stays *certain* even when some spend
  could not be converted (unconvertible can only add), and the projection is reported as a FLOOR
  rather than a total. AN-7 inverted, at the rule layer this time.
- **The loader may WRITE, once per period.** A period with `rolled_up_at IS NULL` has never been
  calculated, which `0024` is explicit is not the same as zero spend — reading it as a baseline would
  answer "under budget" for a period that might be fully committed. So the loader recomputes a
  never-calculated period on first sight. That is bounded (each period pays it at most once, and the
  transition hooks keep it fresh afterwards), it adds no new class of side effect (`validateReport`
  already writes, and already runs only on write paths), and it buys a guarantee the rule leans on:
  a snapshot never rests on an uncalculated period, so `BudgetSnapshot` carries no `rolledUpAt` and
  **the rule has no branch for one**. A branch that can never be taken hides every defect in the
  outcome it cannot produce.

**A vacuous test of my own, caught by writing the sabotage before believing the green.** The first
version of "does not fire when no BUDGET_OVERAGE instance is enabled" asserted `violations` is empty
— which **cannot fail**: with no rule instance there is nothing to emit whether the loader ran or
not, so it would have passed on a `validateReport` that loaded budgets on every single save, which is
precisely the cost the gate exists to avoid. It now asserts the loader's fingerprint instead: a
never-calculated period is still `rolled_up_at IS NULL`. Forcing the gate open fails it. Same family
as VX4-3's 1,331-colour sweep that matched the `<body>` tag.

**Eleven sabotage runs, each failing exactly the intended tests and nothing else:** read-half clamp
removed (1 test), write-half refusal removed (2), `maxSeverity` dropped from the definition (4,
including the guard that at least one rule declares one — without which the consistency guard passes
vacuously), unconvertible folded into the total (1), attribution precedence reversed (6, split across
the pure and DB layers), the never-calculated recompute removed (1), the engine hook narrowed to
APPROVED only (1), the recall hook removed (1), the projection dropping pending (2), the loader gate
forced open (1), the submit hook removed (5).

**A correction to my own part-1 work, recorded rather than quietly fixed.** `0024`'s
`budget_lookup` index is `(organization_id, fiscal_year) INCLUDE (gl_account_id)`, which anticipated
a fiscal-year-first lookup. The lookup part 2 actually makes is account-first over a date range
(`gl_account_id = ANY(...)` joined to periods overlapping a span), and that index does not serve it.
**Deliberately NOT fixed here:** `budget` holds tens of rows per tenant, so the scan is free, and a
migration to add an index nothing needs is worse than the note. Revisit if a tenant ever has
thousands of budgets.

**Verified:** `tsc --noEmit`, `eslint`, `check:vendor` clean on the device. In the cloud harness:
`npm run build` **and** `npm run check:actions` pass (with the documented `next/font/google` stub,
container-copy only — see §3), **775 vitest across 41 files**, and **31/31 Playwright**. The vitest
baseline was MEASURED at `fb4ddfc` in the same harness rather than assumed: **731**, so this ticket
adds 44. The tracker's "712" predates part 1 and was stale.

**Part 3** is unchanged: alerts on BG-6's atomic-claim idiom, the admin screen (which is also where
`BUDGET_OVERAGE` gets created — it is deliberately NOT in `DEFAULT_POLICIES`, because a fresh tenant
has no budgets and a starter rule that cannot fire trains people to ignore the page), and the e2e.
The "Add a rule" form's severity picker still offers BLOCK for every kind, because its rule is chosen
in the same submit and narrowing the list would need client JS in a screen that deliberately has
none; the service's refusal is the whole gate there, which is MT-3's rule. The per-row picker on an
existing rule DOES narrow, because there the kind is known.

### VX4-5 part 3a SHIPPED — threshold alerts, and three tests of mine that proved nothing

Migration `0025`. `lib/budgets/alerts.ts` + `crossedThresholdBp` in `scope.ts` + a `BUDGET` subject
and a `BUDGET_THRESHOLD` event in the notification catalogue + `includeActor` on the fan-out. Part 3b
is the `/admin/budgets` screen and the e2e, split from this on John's call (2 Sep).

**BG-6's mechanism, replaced rather than ported.** Their `alertedThresholdBp` is a mutable column
stamped after the fan-out, which double-sends three ways: two concurrent submits both pass the read;
the fan-out succeeds and the stamp throws into a `catch`; editing periods deletes and recreates the
rows. Ours is `budget_alert_claim`, a uniquely-keyed row — the idiom `notification_delivery` and the
approval-decision claim already use. Their PRODUCT rules are kept verbatim, including the ones that
are easy to get wrong: an empty recipient list means owner-only and never nobody, and a crossing with
nobody to tell is still recorded so that appointing an owner next month does not deliver a backlog.

**The SAVEPOINT, which is where this goes past theirs.** Their comment explains that the marker is
stamped last "so a failure re-fires next time rather than marking a crossing nobody was told about" —
and no ordering of two statements can satisfy both directions. Claim first inside a savepoint and the
choice disappears: a failed send rolls the claim back with it. It is also what lets the alert path
honour "never throw" from inside somebody else's transaction, because a caught error leaves a
Postgres transaction aborted unless there is a savepoint to roll back to — without one, swallowing an
alert failure would poison the submit that called it, which is the exact outcome the rule exists to
prevent.

**A GAP IN MY OWN PARTS 1 AND 2, corrected here.** `budgets` is one of the four modules the Plan names
as per-tenant, and `0024` created `budget` and `budget_period` with a plain tenant policy and no
module predicate — so the product had a working budgets module that the entitlement machinery said
did not exist. `0025` puts `app_module_enabled('budgets')` into every budget table's policy. That
also does the data-plane gating for free, which is what makes it safe mid-phase: `loadBudgetSnapshots`
and `recomputeForReport` run inside submit and approval for EVERY tenant, and a `requireModule` that
threw there would break submit for tenants without budgets. Under RLS they simply find nothing and
no-op. The `requireModule` calls and the registry flip to `available: true` belong with part 3b's
admin service, so `test/module-gates.test.ts` has gates to enumerate.

**THREE TESTS I WROTE PASSED WITHOUT EXERCISING WHAT THEY NAMED. All three were found by sabotage,
none by review.** This is the clearest run of "when a sabotage fails FEWER tests than expected, the
surviving tests are the finding" the project has had, so all three are recorded:

1. *"a claim at a HIGHER level suppresses a lower crossing"* — sabotaging `threshold_bp >= $2` to
   `= $2` failed nothing. Every path the test took re-crossed the SAME level, because the earlier
   report stayed in `pending`. For `>=` to be load-bearing the period must hold a claim at 100% and
   none at 90%, which happens only when it jumps past both in one movement and then comes back down
   *without* going under 90%. The fixture is now three transitions and the ordering is the test.
2. *the concurrency test* — twice. The first version pre-inserted a claim and submitted, but the
   fast-fail read catches `>= crossed`, which includes the equal case, so a sequential caller can
   never reach the `ON CONFLICT` at all. The second version ran two connections and committed A
   beside B, trusting the interleaving — and A's COMMIT is one round trip while B's path is three, so
   A always won and B returned early. It now runs B through a proxy `QueryRunner` that holds A open
   until B is at the INSERT. The proxy intercepts TIMING and never an outcome, so both results stay
   reachable — which is the line between a test double and the ones that cost us AC-17 and AC-19.
3. *"the LOADER's first-sight recompute does not alert"* — true for a second reason. The loader runs
   during a DRAFT save, and a draft is not counted spend, so the recompute found zero and nothing
   would have crossed whether the loader alerted or not. The fixture now writes an APPROVED report
   straight to the database — the way a seed, an import or a restored backup arrives — so the period
   really is over its threshold at loader time.

**Two existing guards had to change, and both got STRONGER rather than looser.**
`test/notification-catalog.test.ts` asserted every event type maps onto a template over
`'EXPENSE_REPORT'`, which hard-coded the assumption that every event is an expense-report event;
`BUDGET_THRESHOLD` is the first for which that is false, and it now asserts every event maps over at
least one shipped subject. `test/rls-isolation.test.ts` asserted exactly one entitlement row per
tenant, which was asserting the fixture; it now asserts every visible row belongs to the asking
tenant, with a non-empty check so the new form cannot pass vacuously.

**A test-hygiene lesson worth keeping.** A hand-managed connection returned to the pool with an open
transaction keeps its locks, and every later test touching the same table then waits five seconds and
times out. One real sabotage failure arrived as three, two of which pointed nowhere. The
two-connection test now rolls both back in a `finally` before releasing.

**`includeActor`, and why it is an option rather than a null actor.** Every other event in the
product excludes the actor, correctly — a threshold alert is about a running total, and a budget
owner who files the claim that breaks their own budget is exactly who needs telling (ExpenseOS says
so). The alternative was recording the activity with a null actor, which buys the fan-out at the cost
of the activity stream no longer knowing who moved the number.

**Verified:** `tsc`, `eslint`, `check:vendor` clean on the device. In the cloud harness on a fresh
database with all 25 migrations: `npm run build` and `npm run check:actions` pass, **790 vitest across
41 files**, **31/31 Playwright**. Baseline MEASURED at `e42b36f` in the same harness: **775**, so this
adds 15. **Nine sabotage runs**, each failing exactly its own tests — after the three above were
fixed, which is the only reason that sentence means anything.

### VX4-5 part 3b SHIPPED — the screen, the e2e, and VX4-5 CLOSED

No migration. `lib/budgets/admin.ts` (gated CRUD) + `/admin/budgets` + `e2e/budget-flow.spec.ts` +
the registry flip that finally makes `budgets` a real module. **VX4-5 is complete**: schema,
department stamp, rollup, `BUDGET_OVERAGE`, the severity clamp, threshold alerts, the screen.

**The module is available now, and the gates are what made it so.** Parts 1–2 shipped budget code
with `budgets` still declared `available: false`; 3a closed the data plane (`0025`'s RLS predicate)
and this closes the control plane — eight gated writers, six exemptions each carrying its reason.
The two most interesting exemptions are `recomputeForReport` and `loadBudgetSnapshots`: they run
inside submit, recall and every approval decision **for every tenant**, so a `requireModule` there
would throw mid-submit for tenants without budgets. RLS makes their rows unreachable instead, so
they find nothing and no-op — the same shape as `accountForCategory` being exempt in ACCOUNTING.

**The gate guard caught a gate that was real.** The first version wrote
`await requireModule(tx, MODULE)` with `const MODULE = 'budgets'`. The gate worked; the guard failed
it anyway, because `test/module-gates.test.ts` scans each function's TEXT for the LITERAL
`requireModule(tx, '<code>')` — deliberately, so a false pass would need somebody to write the call
and not mean it. A constant defeats the scan. The code now writes the literal eight times, and the
reason is a comment at the top of the file so the next person does not "tidy" it back.

**Percent in, basis points out, in exactly one place.** `0025` names the units trap and cannot solve
it — somebody meaning 90% who types `90` gets 0.9%, and both are legal integers. `percentToBp` is
the only multiplication in the product, it REFUSES a third decimal rather than rounding it (the
`parseAmountToMinor` rule), and the e2e asserts `9000` in the database after typing `90` in the form,
which is the only place that wiring is provable.

**FOUR ASSERTIONS BROKE BECAUSE THEY NAMED A FIXTURE INSTEAD OF A PROPERTY.** Making one module
available broke three tests in `test/modules.db.test.ts` and one in `e2e/modules-flow.spec.ts`, all
of which used `'budgets'` as their example of a module this build cannot serve. They are about the
dormant-declaration property, not about Budgets, so they now take
`listModules().find((m) => !m.available)` — with an explicit `toBeDefined()` floor, because the
generalised form would otherwise pass vacuously on the day nothing is dormant. Worth noticing as a
class: a test that hard-codes today's answer to a question the registry already answers will break on
the day the answer changes, which is precisely the day you want the test to be about something else.

**My own e2e broke an unrelated spec, exactly the way §4 warns.** `budget-flow` sorts before
`expense-flow`, whose `beforeAll` restores the starter rules and asserts the table holds exactly four.
The `BUDGET_OVERAGE` rule this file adds made it five, and `expense-flow` failed on an assertion with
nothing to do with budgets. The `afterAll` now removes the rule and the budget and drains the mail the
submit enqueued. "Anything a run leaves behind is the next run's input" — written down since VX3-9a,
and still the first thing to get wrong.

**What the e2e proves that the db tests cannot:** a threshold typed as a percentage arriving as basis
points; server actions posted from a screen with no client JS of its own; `rolled_up_at IS NULL`
rendering as "not yet calculated" rather than a confident $0.00; an over-budget report warning and
still submitting; and the alert landing in the owner's own notification list — the owner being the
person who submitted it, which is `includeActor` proved end to end. Fixtures were checked against
`scripts/seed.mjs` rather than guessed: the demo category 'Meals & Entertainment' maps to **68200**,
not 68100, because meals are split from travel as 50% deductible (`0014`). A budget on 68100 would
have attributed nothing and every assertion would have passed on an empty rollup.

**Two small things taken deliberately, and said out loud rather than folded in silently.** The
notifications table now has a `BUDGET` entry in its subject-path map, because `subjectHref` returns
null for an unmapped type and "your budget is over" as dead text with nowhere to go is the defect
that map exists to prevent; and `/admin/modules` links to `/admin/budgets`, because there is still no
global admin nav and a module made available with nothing pointing at its surface is a surface nobody
finds (GAP-AUDIT UD-4's neighbour).

**Verified:** `tsc`, `eslint`, `check:vendor` clean on the device. In the cloud harness:
`npm run build` and `npm run check:actions` pass, **803 vitest across 41 files**, and **35/35
Playwright** — 31 existing plus this ticket's four. Baseline MEASURED at `ee192a4` in the same
harness: **790**, so this adds 13. **Seven sabotage runs**, each failing exactly its own tests.

### VX4-6a SHIPPED — spend analytics: the money defect, the performance shape, and a rewrite

Migration `0026` (two indexes, no tables, no columns). `lib/spend/statuses.ts` +
`lib/analytics/service.ts` + the `analytics` module flipped available. **6b is the `/analytics`
screen and its e2e**, split on John's call (2 Sep).

**What the audit deleted, so the estimate was not four days of BI.** AN-1: their module is one router
with three procedures; the report builder and scheduled exports are four declared permissions with
nothing behind them. AN-2/3/5/9: four cross-tenant leaks, all "the privileged case is the ABSENCE of
a predicate" — a class RLS makes impossible here, with a per-table proof already in
`test/rls-isolation.test.ts`. What was left was a money defect and a performance shape.

**AN-7, inverted.** Theirs is one line — `return c ? c.amountMinor : amountMinor; // missing rate →
best-effort raw` — so yen are added to cents and reported as base currency with nothing on the
response to say so. Ours counts that spend in `unconvertible`, in its SOURCE currency, and never in a
total; `byCurrency` names what is missing so an admin knows which rate to add.

**UD-6, from the upstream delta review, applied.** Every group is valued at the rate for ITS OWN DAY
through `lib/policy/rates.ts`. Two identical USD amounts on two days with two rates produce two
figures, and a rate published later does not move an earlier month — asserted both ways, because
upstream's `b9e242d7` is the record of what happens otherwise.

**AN-10, and John's call on how.** Theirs loads every matching row into memory, aggregates in JS,
filters months in JS afterwards, has no `take`, and has both range ends optional with the home page
passing neither. Ours SUMS IN SQL over a range that is **refused when absent, not defaulted** — a
default is how theirs ended up aggregating all history on a page nobody thought was expensive. And
`0026` adds the index the audit says they lack: checked rather than assumed, `expense` carried only
`organization_id` and `report_id`, with nothing on `txn_date`.

**A REWRITE, from a sabotage I had not run yet.** The first design ran six queries, one per
dimension, each grouped by `(currency, day, value)`. Smaller, and wrong: each grouping rounds its own
conversion, so the header total and the category chart under it could differ by cents — which is
exactly upstream's `b9e242d7` ("Report header CAD 174.29 / the one line composing it CAD 174.14",
15¢ on $125.50, for a year). Rounding once per emitted figure does not fix it either: the sum of
rounded slices is not the rounded sum, and no arrangement of six independent groupings makes six sets
of slices agree. It is now ONE query grouped by every dimension at once, converted once per group,
with all six dimensions folded from the same converted rows — so they agree EXACTLY, and
`EVERY dimension adds up to the header, exactly` asserts it across all six with a non-zero floor so
it cannot pass vacuously. The honest cost: cardinality is now the distinct combinations of
`(currency, day, category, account, department, business unit, submitter, status)`, which on a busy
tenant approaches the line-item count. It is still the database summing over a bounded range, which
is the property AN-10 is about. It also removed all the interpolated SQL the six-query version needed.

**`lib/spend/statuses.ts` — one statement of what counts as spend, and the best sabotage of the
run.** AN-7's most useful sentence is not about FX: *"the two halves of the same product disagree
about whether an unconvertible amount is reportable"*, because each half decided for itself. That
split was one copy away here — `lib/budgets/service.ts` had a private `COUNTED` array and analytics
needed the same answer. Moving SUBMITTED from PENDING into COMMITTED in the shared module now fails
**eleven tests across budgets AND analytics**, which is the drift being structurally impossible
rather than merely documented. Renamed a variable while there: the rollup's `committed` was true for
SUBMITTED and fed `committed ? 'pending' : 'actual'`, so it meant the opposite of its name.

**Two fixtures the schema refused, twice, and it was right both times.** A raw-SQL REIMBURSED report
has to satisfy `expense_report_reimbursed_stamped` *and*
`expense_report_reimbursement_complete` — status implies the timestamp, and the timestamp implies an
actor, because "a report with `reimbursed_at` and no actor is a payment nobody made". Satisfied
rather than sidestepped by dropping REIMBURSED from the fixtures, since REIMBURSED counting as
committed spend is one of the claims.

**The module gate is on the READ here, and that is right for once.** Analytics owns no tables, so
there is no RLS backstop to add: it reads the expense loop's rows, already tenant-scoped. A tenant
without the module therefore has no analytics at all, and 6b's screen will render its own off-state
from the ungated `isModuleEnabled`, exactly as the chart-of-accounts screen does. Contrast BUDGETS,
where the gate had to be in the data plane because the rollup runs inside every tenant's submit.

**Verified:** `tsc`, `eslint`, `check:vendor` clean on the device. In the cloud harness on a fresh
database with all 26 migrations: `npm run build` and `npm run check:actions` pass, **822 vitest across
43 files**, **35/35 Playwright**. Baseline MEASURED at `01b16e9`: **803**, so this adds 19. **Seven
sabotage runs**, each failing exactly its own tests.

### VX4-6b SHIPPED — the analytics screen, and four things a validator cannot catch

No migration and NO NEW VITEST TESTS — 6b is a screen and an e2e, so the unit count is unchanged at
822 and that is the honest number rather than a suspicious one. `/admin/analytics` +
`e2e/analytics-flow.spec.ts` (5 tests). **VX4-6 is complete.**

**ADMIN-only, at `/admin/analytics`, and AN-8 is why there is no scope model.** This screen shows the
whole tenant's spend. ExpenseOS sizes that per reader — `view.own | reportingChain | all` — and AN-8
is the note on how that went: the permission that SIZES the data and the one that OPENS the screen
are separate, `ap-clerk` holds `viewAll` without `dashboardView`, so a permission nobody can
currently exercise grants company-wide spend the moment the gate moves. We have one axis, role, so
this is ADMIN-only and there is nothing to get wrong. A per-reader scope is a real feature and it is
deliberately not invented; when it arrives it belongs in the service beside the module gate, as a
PREDICATE, never as a role check that then queries everything.

**The screen defaults a range and the service still refuses one, and those are different things.**
Conflating them would be re-committing AN-10: their defect is an UNBOUNDED query, not the absence of
a convenient default. The page defaults to the year so far and says so in copy; the service refusing
to invent one is what stops any other caller reintroducing the full-history aggregate.

**The palette was COMPUTED.** Two series need two hues that survive colour-vision deficiency, and the
skill's rule is that the colour part is computable so compute it. Candidates run through the validator
against OUR surface (`#ffffff`), not a reference one:

| candidate | result |
| --- | --- |
| sky-600 + sky-300 | **FAIL** lightness band — `#7dd3fc` at L 0.83, outside 0.43–0.77 |
| brand + sky-200 | **FAIL** band *and* chroma floor — `#bae6fd` reads grey |
| brand-700 + sky-400 | **PASS** all checks; CVD ΔE 30.9, normal ΔE 31.3 |

So `--vl-brand-700` and `--vl-brand-400`, both already in the ramp. The surviving WARN is `#38bdf8`
at 2.14:1 on white, which obligates relief — "visible labels or a table view" — and the screen ships
both: a legend plus one selective direct label on the chart, and every breakdown is a real table with
the numbers in it.

**DARK MODE IS NOT A SEPARATE PALETTE, and that is a finding.** `--background` and `--card` are
`var(--vl-white)`, and the dark block in `app/velotech-tokens.css` does not redefine `--vl-white`. The
chart surface is `#ffffff` in both modes, so the palette validated against white IS the dark palette;
validating a second one against a surface nothing renders on would be paperwork. Same partial-dark
gap as the `--accent-foreground` defect already pinned in `test/branding-color.test.ts`.

**FOUR THINGS ONLY LOOKING AT IT CAUGHT.** The validator checks colour, not layout, so the procedure's
last step is to render it and look — which found: 44px bars that read as a toy at full width (thin
marks now, ≤22px); month labels printed as a bare `02`, a number a reader has to decode and cannot
tell from a day (`Feb ’26`); the unconvertible warning reading "7700 minor units of USD", which is
not a number anybody thinks in (formatted as money, with that currency's OWN minor unit carried on
the payload rather than assumed to be 2); and the headline figure wearing the series colour, when
"text wears text tokens, never the series color" — it is ink now, with a swatch beside the label.

**MY OWN CLEANUP BROKE THREE UNRELATED TESTS, and only on the SECOND run.** `receipt.expense_id` is
`ON DELETE SET NULL`, because VX1-5's receipt-first flow keeps unattached receipts in the uploader's
INBOX. So this spec's `DELETE FROM expense_report` did not delete their receipts — it moved them into
somebody's inbox, and `expense-flow`'s drawer then failed with `strict mode violation:
getByText('receipt.png') resolved to 2 elements`, three times, in a file with nothing to do with
analytics. The first full run passed because there was nothing to orphan yet. §4's rule 3, again, and
the fix is two lines; the suite now passes twice in a row, which is the property that actually
mattered.

**`check:actions` caught a dead-form bug in the file whose header warns about it.** The first version
of `actions.ts` had `export interface AnalyticsPage` three lines below the comment saying every export
must be an `export async function`. Next registers each export as a server action; it cannot wrap an
interface, and rather than failing it registers NONE of the module's actions — every form on the page
posting an id the server has never heard of. That is VX2-8's `/approve` bug exactly, and the guard
refused the build in those words. The interface is unexported now; the page infers the shape.

**Verified:** `tsc`, `eslint`, `check:vendor`, `check:actions` clean. In the cloud harness:
`npm run build` passes, **822 vitest across 43 files** (unchanged — 6b adds no unit tests), and
**40/40 Playwright**, run TWICE to prove the re-run property. The screen was rendered and inspected
as a full-page screenshot before any of this was written up.

### The two decisions, SETTLED 31 Aug 2026 (John)

**1. Host-based tenancy is PHASE 5.** VX4-4 is out of this board. The reasoning that carried it: a
subdomain only means something once tenants self-provision, and we already resolve the tenant from the
session's org, so branding (VX4-3) does not wait on it. Doing it in Phase 4 would have bought a
wildcard certificate and an apex `WEBAUTHN_RP_ID` into a phase that needs neither.

**What Phase 5 inherits with it**, so the audit work is not lost: BR-1 (ExpenseOS has no tenant
resolution at all — greenfield, nothing to port) and **BR-8**, which is the one with teeth — `APP_URL`
is a module-level constant, the CDK stack derives every origin from one `config.domainName` and issues
a certificate for that exact host **with no wildcard**, and `WEBAUTHN_RP_ID` is pinned to the host, so
**every passkey stops validating when a tenant moves subdomain** unless the RP id is the apex. NT-14
and AC-23 are the same family and both cost a round trip already.

**3. VX4-2 IS CLOSED, superseded by construction (1 Sep 2026).** Reasoning and evidence in GAP-AUDIT
MT-2's verdict and PE-8. Phase 4 is six tickets / ~20 days. Two things it leaves boarded, deliberately,
so neither gets lost in the closure:

- **PE-9 — 17 application-side copies of the tenant expression omit the `NULLIF`.** Not a leak and not
  a live defect: every site is reached through `withOrg`, and off that path the query fails closed
  either way. What it costs is legibility — the first caller to arrive without a tenant gets `22P02
  invalid input syntax for type uuid: ""` instead of a refusal naming the problem, which is precisely
  the wrong error to hand a scheduled job (MT-5 / VX0-8). One line per file × 17 plus a guard test in
  the house pattern, so the eighteenth copy cannot be written. Half a day.
- **Audit-retention purge as a job.** Per-org retention is already a column and `0010` already has the
  `app.audit_purge` hatch; what does not exist is the thing that runs. It is a scheduled job, so it
  boards with VX0-8's fan-out rather than under settings.

**2. A budget NEVER blocks.** Matches ExpenseOS's stated intent, and unlike theirs it has to be
enforced rather than commented.

**The code consequence, so VX4-5 does not rediscover it** — and the path in the first version of this
note was wrong: **there is no `lib/policy/engine.ts`**. The site is `lib/policy/service.ts:529`, inside
`revalidate`'s `desired` map. Corrected before VX4-5 read it, because a note pointing at a file that
does not exist is how somebody creates one. It resolves severity as
`f.severity ?? inst.severity` — the RULE INSTANCE decides, so an admin configuring a budget rule at
BLOCK turns a warning into a hard stop, exactly as BG-4 describes for theirs. A decision that a budget
never blocks therefore needs a **maximum severity on the rule definition**, clamped where severity is
resolved, not a comment on the rule. `SEVERITIES` is `['INFO','WARNING','BLOCK']`, so the clamp is an
index comparison against that array rather than a hand-written ordering.

**TWO places, not one, and both are needed.** `createPolicy` / `updatePolicy` must REFUSE a severity
above the rule's maximum, so the stored value can never disagree with what is evaluated and an admin
is told no rather than silently overruled. And `revalidate` must clamp anyway, because a row written
before the maximum existed — or by a seed, an import, or Phase 5's provisioning — has to evaluate
correctly regardless. Refusing at the write is the courtesy; clamping at the read is the invariant.
Test both: an instance configured at BLOCK is refused at the write, and a row forced to BLOCK in raw
SQL still emits WARNING.

### The scheduling problem this phase finally forces

MT-5: **the entire ExpenseOS worker is module-blind** — zero module checks in `apps/worker/src` or
`packages/jobs/src`, and all 16 recurring jobs are unconditional global crons. Ours has the same
shape for a different reason: `VX0-8` (worker + per-job tenant context) has been deferred since Phase
0 because there was no worker surface to hang it on. A per-tenant entitlement is the first thing that
cannot be honoured without it — a job has to fan out per tenant and check per tenant — so VX0-8 lands
inside VX4-1 rather than staying deferred.

### Exit criterion

Two tenants, side by side, with **different modules enabled, different branding, and different
locales** — one on `fr-CA`, one on `en-US` — each seeing only its own analytics and budgets, proved in
a browser. The Phase-3 exit criterion took the same shape and it is what found AC-19, AC-22 and AC-23.

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
| VX3-7 ◐ | Generic tenant dimension sets | A tenant defines its own cost dimensions and maps them per integration; no vendor name appears in a core table, a shared enum, a permission slug or an audit action; a tenant with no integration sees no integration fields anywhere | 2 (guard half shipped; dimension half BLOCKED — see below) |
| VX3-8 | QuickBooks Online on the same contract | A SECOND tenant connects QBO and posts end to end; the diff that adds it contains no change to core or to the VeloLedger adapter — that diff is the acceptance test for VX3-3 | 3 |
| VX3-10 ✅ | Composite foreign keys on every tenant-to-tenant FK (TN-1) | A tenant cannot reference another tenant's row — refused by the constraint, with the trigger/app layer removed from the test; one isolation assertion per FK; a CI guard fails the build on a new tenant-to-tenant FK declared the weak way | 3 (took ~1) |
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

  **CORRECTION, 2026-08-30 — a claim in an earlier handover was wrong.** After VX3-6 I wrote that
  VX3-7 was "mostly speculative" because *"VeloLedger's `bill_line` has no cost dimensions at all"*.
  The `bill_line` observation is true and the conclusion drawn from it is false. I read `0008` and
  stopped. **VeloLedger has a full dimension model**, added later and one layer below the bill:

  - `0035_dimensions` — `dimension` (per-ENTITY axes, not per-org, so a consolidated view can show
    one entity's "Department" beside another's "Cost Center"), `dimension_value` with a `parent_id`
    hierarchy for roll-ups, and `journal_line_dimension` tagging with
    `UNIQUE (journal_line_id, dimension_id)` enforcing one value per axis per line. Tagging is
    OPTIONAL and untagged lines keep working — no backfill.
  - `0060_segments` — `dimension.kind IN ('business_unit','department','custom')`, a partial unique
    index allowing at most ONE business-unit axis and ONE department axis per company, and
    `business_unit_department` as a many-to-many *"NOT a strict one-parent tree"*. Optionality lives
    in `entity_segment_config` (`off | optional | required`), and **an absent row means off**, which
    is the same no-backfill discipline VX2-7's preference map uses.
  - `0061_vendor_segment_defaults` — per-vendor default BU/Dept that pre-populates a drafted bill's
    expense line, mirroring `vendor.default_expense_account_number`.

  So the model is portable and worth porting. **What is NOT available is TRANSMISSION.**
  `DraftBillLineInput` is `description`, `unitPriceMinor`, `expenseAccountNumber`,
  `taxAmountMinor`, `taxRecoverableAccountNumber`, `quantityNumerator`, `quantityDenominator`,
  `notes` — and nothing else. There is no field for a business unit, a department or any dimension,
  and no MCP tool exposes segment mode either (`list_entities` returns id, name,
  functionalCurrency, reportingFramework and fiscalYearStartMonth). A bill drafted by VeloExpense
  therefore takes whatever BU/Dept the VENDOR default gives it, and VeloExpense cannot influence,
  read or verify that.

  **Which is why the dimension half is BLOCKED rather than done or deferred.** Building tenant
  dimension sets now would produce a screen a tenant can fill in and a payload that cannot carry
  the answer. The upstream asks are listed in AC-16 and want raising with VeloLedger before the
  dimension half is worth starting.

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
4. **Spec-baseline tags (AC-15) — `accounting` IS BASELINED AND PUSHED, 2026-08-31.**
   `veloexpense-spec/accounting-20260831`, annotated, at `5a11a647`, in `carmigo/ExpenseOS`.
   The re-sync diff was run both ways: empty against `origin/main` (correct — the tag is there),
   and 15 files / 2683 insertions from the Plan's `fb1cead`, which is the drift a shared baseline
   would have hidden. Remaining detail below is kept because the next module needs it.
   `docs/porting/SPEC-BASELINES.md` has the row, the re-sync command and a delta log;
   `tag-spec-baselines.sh` knows the module and gained an `ONLY=` filter (modules no longer share
   one baseline, and an unfiltered run at a new sha would hit the script's own refusal to move the
   six Phase-1 tags). **The tag needs a real tagger identity, which the Cowork shell does not have**
   — `git config user.name` is empty in that VM because its `$HOME` is not the Mac's — so creating
   an annotated tag from here would stamp it with nothing or with an invented name. Run it in a real
   terminal as `johnrim-lab`:
   ```bash
   cd ~/ExpenseOS
   ONLY=accounting DRY_RUN=1 bash ~/code/velotechsystems/product-veloexpense/docs/porting/tag-spec-baselines.sh 5a11a647 20260831
   ONLY=accounting            bash ~/code/velotechsystems/product-veloexpense/docs/porting/tag-spec-baselines.sh 5a11a647 20260831
   git push origin 'refs/tags/veloexpense-spec/*'
   ```
   **Correction to what this list said before:** it claimed zero baseline tags existed. Six do, and
   have since 2026-08-27. Only `accounting` was missing. `audit` and `notifications` are still
   unbaselined.

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

#### From the upstream delta review, 2 Sep 2026 (GAP-AUDIT `UD` section)

All 24 ExpenseOS commits since the Phase-4 pin `5a11a647` were read and each verdict checked against
OUR source. Four port; three are inputs to boarded tickets; one is a decision for John. Full evidence
and the verdict on every commit is in GAP-AUDIT — this is the board entry.

- **UD-1 — assert the ledger payload on the wire, ~0.5d.** `currencyCode` is required on
  `PostableReport` and both adapters send it, but the adapter test's fetch stub records tool NAMES
  only, so deleting `currency: report.currencyCode` fails nothing. Upstream lost money for a month in
  exactly that gap (a USD 74.19 charge booked as CAD 74.19). Capture bodies; assert currency, account
  numbers and the idempotency key.
- **UD-2 — check GL coding at SUBMIT, not at post, ~1d.** `outbox.dryRun` already computes
  `problems` and the adapter refuses an unmapped line in plain language; `submitReport` consults
  neither, so a category with no `gl_account_id` passes submit AND approval and fails days later in
  front of an operator who cannot fix it. One shared "what counts as postable" rule for both callers.
  Only when a ledger is connected, and BEFORE the policy pass — a fact, not a judgement.
- **UD-11 — audit what an edit changed, ~1–1.5d.** We audit transitions and approvals; we audit
  content edits NOWHERE. "Who changed this amount, from what, when" is unanswerable across every
  expense, report header and line item. Port their `auditDiff(before, patch)` → `{from, to}` plus an
  explicit `unchanged`. Watch AU-5: our `details` IS in the hash payload and `canonical()` throws on
  BigInt, which is most of our money.
- **UD-3 — a role-crawl e2e, ~0.5d.** Open every route as EMPLOYEE, MANAGER and ADMIN. Upstream's
  found a notification key that had rendered `MISSING_MESSAGE` since #95 and a page that scrolled
  sideways; three other guard layers could not see either. Folds naturally into VX4-7's e2e.
- **UD-4 — say whose reports `/expenses` is listing, minutes.** The heading says "Expense reports"
  over a list that is `submitter_id = me`. Take it with the next ticket touching that page.
- **Inputs to boarded tickets, not new work:** UD-5 gives VX4-7 three requirements (enum→catalogue
  with a generated assertion; never compare catalogues against each other, because agreement is not
  correctness; a static used-keys scan cannot see an interpolated key). UD-6 gives VX4-6 a second
  money defect to sit beside AN-7 — a rolled-up total re-valued at today's FX table, which we do NOT
  have today but which analytics is the natural place to introduce.
- **UD-8 — a QUESTION for John, not a ticket.** Upstream now lets an installation choose whether
  approval posts to the ledger or parks the report for AP to send, defaulting to the safe one. Ours
  posts on approval, unconditionally. Everything the other mode needs already exists; it is a
  decision about how finance operates.

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
3. **THE PHASE 3 BOARD NOW EXISTS — §6, ten tickets, ~27 dev-days.** Drafted 2026-08-29 from the
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
