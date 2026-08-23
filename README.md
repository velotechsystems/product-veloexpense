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
# DATABASE_URL → the VeloExpense Postgres
psql "$DATABASE_URL" -f prisma/migrations/0001_init/migration.sql
npm test                    # test/rls-isolation.test.ts must pass
```
`app_user` in `0001_init` is the copy-me pattern: every future tenant table
repeats organization_id + index + ENABLE/FORCE RLS + `tenant_isolation` policy.

## Status
Phase 0 (foundation & tenancy spine) — see the VeloExpense planning docs.
