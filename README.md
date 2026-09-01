# product-veloexpense

VeloExpense — the commercial, multi-tenant expense platform (Velotech). Built on
the shared Velotech foundation (`@velotech/auth-kit`, `@velotech/ui`) with
ExpenseOS as the behavioral spec. Pooled multi-tenant: `organization_id` +
Postgres RLS on every tenant table (Velotech house standard).

## Stack
Next.js 16 (App Router) · React 19 · Tailwind v4 · shadcn/ui (`radix-nova`) ·
Postgres (own DB) · Node 24 (`.nvmrc`).

## Getting started (local)
```bash
nvm use                     # Node 24
npm install                 # installs next/react/pg/vitest + config
# Shared libs (VeloExpense is the first consumer — confirm the @velotech install
# mechanism / registry token, then):
#   npm install @velotech/auth-kit next-auth@^5.0.0-beta.29 @velotech/ui
# then uncomment the token @imports at the top of app/globals.css

npm run dev                 # http://localhost:3000
```

## Tenancy (do not bypass)
All tenant-scoped work runs through `withOrg(orgId, fn)` (`lib/tenant/context.ts`),
which sets `app.current_org` LOCAL to a transaction so Postgres RLS isolates the
tenant. Unset context sees zero rows (safe default). `withoutOrg()` is the
service-role escape hatch (migrations / cross-tenant admin only).

## Database + the RLS gate (VX0-6)
```bash
# ADMIN_DATABASE_URL (superuser) → the VeloExpense Postgres; DATABASE_URL is the app role
npm run migrate             # applies only what is pending, records it in schema_migration
npm test                    # test/rls-isolation.test.ts and test/migrations.test.ts must pass
```
**On an existing database created before the runner**, the ledger is empty while the schema is
not, so the runner asks once rather than guessing which migrations are already in:
```bash
npm run migrate -- --baseline all      # a database that is fully up to date
npm run migrate -- --baseline 0022     # ...or up to a specific migration, then apply the rest
```
`--baseline` is a claim that those migrations are already in, and recording it runs nothing — so it
**verifies the claim against the schema before recording anything**, and refuses with the right
baseline in the message if the newest one it can check is not actually there. Getting this wrong by
one is how the ledger starts lying while reporting "nothing pending".
Do not apply a migration by hand with `psql -f`. `npm run e2e` and CI both run the runner, and
`test/migrations.test.ts` fails if the schema and `prisma/migrations/` disagree — which is the
gate that did not exist when `0023` was merged, applied nowhere, and surfaced as
`column "brand_color" does not exist` inside an unrelated Playwright spec.
`app_user` in `0001_init` is the copy-me pattern: every future tenant table
repeats organization_id + index + ENABLE/FORCE RLS + `tenant_isolation` policy.

## Status
Phase 0 (foundation & tenancy spine) — see the VeloExpense planning docs.
