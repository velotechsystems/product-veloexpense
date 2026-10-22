# Production — first-time setup and releasing

How VeloExpense production (`app.veloexpense.ai`, every tenant at `<slug>.veloexpense.ai`) is
stood up the first time, how a release reaches it, and how to roll one back.

> **w5-08, decided 18 Oct 2026 (d86).** Production runs on the shared `velotech-prod`
> infrastructure (VeloCRM's VPC, cluster and ALB), in the one Velotech AWS account, as
> stage `prod` (`infrastructure/cdk/lib/config.ts`). It is **released, not deployed on
> merge**: `.github/workflows/cd-prod.yml` runs when **Cut Release** completes, copies the
> image dev already built and ran, deploys, migrates, and checks `/api/health`. No image is
> ever built for prod, and prod is never seeded.
>
> **Not in production yet (d86):** receipts by email. SES allows one active receiving rule
> set per account and region, and dev's holds it. Everything else is on.

| What | Where |
|---|---|
| Prod's committed settings (hosts, sizes, schedules) | `infrastructure/cdk/lib/config.ts`, `prod` |
| The release pipeline | `.github/workflows/cd-prod.yml` |
| Who may deploy | `infrastructure/cdk/lib/deploy-role-stack.ts` (trusts the `prod` GitHub Environment only) |
| What prod is sized at | about US$130/month on top of the shared ALB/NAT — an estimate, not a quote |

## 1. Once, before the first release

In order. Each step says what proves it is done.

1. **velotech-prod publishes the shared parameters.** VeloExpense reads
   `/velotech/prod/shared/*` (VeloCRM's `shared-contract.ts`). If the list is empty, VeloCRM's
   prod shared stacks need a deploy first.
2. **One certificate for both hosts.** ACM in `ca-central-1`, for `app.veloexpense.ai` and
   `*.veloexpense.ai`, DNS-validated. Its validation CNAME goes in Cloudflare as **DNS only**
   (keep it; renewal uses it). Its ARN is committed in `config.ts` `prod.albCertificateArn`
   (requested 18 Oct 2026, `…/6cddefb8-7f13-4ffb-82af-d185f56a8488`). A release before it is
   ISSUED fails at the listener certificate, so check its status first.
3. **DNS.** In Cloudflare, `app` and `*` as CNAMEs to the velotech-prod ALB's DNS name
   (`/velotech/prod/shared/alb-dns-name`), **proxied**, SSL mode Full (strict). Cloudflare's
   free certificate covers one level of subdomain, which is exactly `*.veloexpense.ai`.
   **And `mcp` as a CNAME to the same ALB, DNS ONLY (grey cloud)** — the Claude connector's
   host (lib/mcpOauth/host.ts). VeloCRM found Cloudflare's bot protection silently dropping
   Anthropic's authenticated MCP calls through the proxy (its `MCP-Subdomain-Spec-Issue.md`);
   a DNS-only `mcp.` host keeps the app proxied and the connector working. The ALB's
   `*.veloexpense.ai` certificate and listener rule already cover it.
   **Who can reach `mcp.`:** only Anthropic's servers. The shared ALB's security group admits
   Cloudflare's ranges plus Anthropic's outbound ranges on 443 (VeloCRM #309, its
   `network-stack.ts`, list in `cdk.context.json` `velocrm:mcp:anthropicIpList`); a person's
   browser going direct times out. That is why the **sign-in and consent screen is on
   `app.veloexpense.ai`**: the discovery document's `authorization_endpoint` names the app
   origin (`lib/mcpOauth/host.ts` `authorizeBaseUrl`, overridable with
   `MCP_OAUTH_AUTHORIZE_URL`), while the issuer, token, registration, revocation and JWKS
   endpoints and `/api/mcp` stay on `mcp.`. So a `curl` to `mcp.` from a laptop timing out is
   expected; test the connector from claude.ai instead.
4. **The four secrets a person creates** (`MANUAL_SECRETS`, security-stack.ts), under
   `veloexpense/prod/`:
   - `secret-encryption-key`: 32 random bytes, base64. Generated, never typed. **Never reuse
     dev's**: everything a tenant connects (Slack, Google Workspace, ledgers) is encrypted
     under it.
   - `google-oauth`: JSON `{"clientId": …, "clientSecret": …}` for a Google OAuth client
     whose redirect URI is `https://app.veloexpense.ai/api/auth/callback/google`.
   - `anthropic-api-key`: the key receipt extraction uses.
   - `mcp-oauth-signing-key` (mcp-oauth): an RSA-2048 private key, PKCS#8 PEM, plain text —
     `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`. Signs MCP access tokens
     for Claude connectors. **Never reuse dev's.**
   - `platform-inbound-token` (18 Oct 2026): 48+ random characters, generated. The token the
     platform presents to `/api/platform/provision`. Production only (`platformProvisioning`).
   Everything else (auth, worker, database, Valkey) the stacks generate.
5. **The `prod` GitHub Environment**, restricted to the `main` branch. The deploy role
   trusts `repo:velotechsystems/product-veloexpense:environment:prod` and nothing else.
6. **The deploy role, once, from a workstation**: `VeloExpense-Prod-DeployRole`. After that
   every release deploys it with everything else.

## 2. Releasing

1. Merge to main as usual. Dev deploys, as always.
2. When dev is the release you want: Actions → **Cut Release** → Run workflow.
3. **CD (production)** starts when Cut Release completes. It first deploys the Security and
   Storage stacks on their own, because prod's image repository lives in Storage and the copy
   needs it (on a first release it does not exist yet). Then it:
   - copies dev's image for that commit into `veloexpense-prod/web`;
   - checks the copy has the same digest dev ran;
   - `cdk deploy`s the prod stacks;
   - runs the database task (bootstrap + migrations — never a seed);
   - rolls the web and worker services and waits for both;
   - checks `https://app.veloexpense.ai/api/health`.

   It refuses to deploy a commit dev never built. Dev's repository keeps the last 20 images,
   so release within about 20 merges of the commit.

## 2a. Creating a tenant

Production has **no self-serve sign-up** (decided 18 Oct 2026): `/signup` says sign-up is by
invitation, and a verification link mailed elsewhere creates nothing. `SIGNUP_ENABLED` is
unset there; dev sets it (`config.ts` `selfServeSignup`).

A tenant is created by the platform, through `POST https://app.veloexpense.ai/api/platform/provision`
with the `x-platform-key` header set to `veloexpense/prod/platform-inbound-token`. The body is
the suite's provision contract (`accountId`, `product: "veloexpense"`, `plan`, `adminEmail`,
`adminName`, `companyName`, `slug`, `idempotencyKey`). It is idempotent on `accountId`: asking
twice returns the first tenant. The admin it names signs in with Google at
`https://<slug>.veloexpense.ai` and invites everybody else.

Until VeloCRM's platform calls it, a person calls it with the same body — that is how
Velotech's own tenant (the first) is created.

## 3. Rolling back

Actions → **CD (production)** → Run workflow from `main`, with `git_sha` set to the
previous release's full SHA (the run summary of every release prints it). Its image is
already in prod's repository and is redeployed as it was, infrastructure included.

Migrations only go forward: rolling back the code does not roll back the schema, so the
older release runs against the newer schema. That is safe only when the migrations in between
are additive (new tables, new nullable columns). Read them before rolling back across one.

## 4. What is different from dev

- Two web tasks, so a deploy or a restart is not an outage.
- Aurora 0.5–4 ACU, deletion protection on, 14 days of backups.
- Valkey snapshots kept 7 days.
- Tenant subdomains on (`AUTH_COOKIE_DOMAIN=veloexpense.ai`). Slack's Events URL and links
  in email name the tenant's own address. The receipts bucket accepts uploads from
  `https://*.veloexpense.ai`.
- No receipts by email (see the top).
