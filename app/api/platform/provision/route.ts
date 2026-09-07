/**
 * VX5-20 part 2 — POST /api/platform/provision
 *
 * The inbound service endpoint the VeloTech platform's provisioning
 * orchestrator calls to stand up a VeloExpense tenant for an Account, on
 * checkout or operator direct-provision. Ported from
 * `product-veloledger/app/api/platform/provision/route.ts`, whose shape is the
 * frozen v1 contract across the suite.
 *
 * ── THE PATH IS VeloLedger'S PATH ON PURPOSE ────────────────────────────────
 *
 * `/api/platform/provision`, not `/api/internal/…` where this product's five
 * other service routes live. `/api/internal/` would have been free (it is
 * already public in `proxy.ts`) and it is arguably the better name — but the
 * caller is one orchestrator that builds `${baseUrl}/api/platform/provision` in
 * `endpointFor()`, and a suite where every product answers the same path means a
 * new product is a base URL rather than a branch. That is worth more than a
 * tidier name here.
 *
 * The cost is that `proxy.ts` needs a fifth public prefix, in both places, and
 * that edit is the security-relevant part of this ticket rather than this file.
 *
 * ── AUTH, AND WHY IT IS 401 HERE WHEN THE INTERNAL ROUTES SAY 404 ──────────
 *
 * `x-platform-key` compared against `PLATFORM_INBOUND_TOKEN` in constant time.
 * This is the INBOUND token, distinct from the OUTBOUND `PLATFORM_SERVICE_TOKEN`
 * this product sends when it reads entitlements and pushes seats — one leaked
 * secret must not grant both directions. Fail-closed: 503 when unset.
 *
 * The five `/api/internal/` routes deliberately return 404 rather than 401,
 * because a route that says "wrong password" confirms it exists to anybody
 * scanning. That reasoning does not apply here and following it anyway would be
 * cargo-cult: the caller is a known service with a configured URL, a 404 tells
 * its operator "you have the path wrong" when the truth is "you have the token
 * wrong", and the endpoint's existence is not a secret — it is in the contract
 * VeloLedger already publishes at the same path. Hiding it from a scanner buys
 * nothing and costs an afternoon of somebody debugging the wrong thing.
 *
 * ── STATUS CODES, AND WHAT EACH ONE MEANS TO A RETRY ───────────────────────
 *
 *   503  not configured        → retryable; a deploy is missing an env var
 *   401  bad or missing key    → NOT retryable
 *   400  unparseable JSON      → NOT retryable
 *   422  schema refused it     → NOT retryable, `details` names the fields
 *   400  provisioning refused  → NOT retryable; `error.code` says which
 *   500  anything unexpected   → RETRYABLE, and a correction to the port; see below
 *   201  provisioned
 *   200  already_exists        → the idempotent answer, and NOT an error
 *
 * 200-vs-201 is the only thing that distinguishes a first call from a retry, and
 * the body carries `status` as well so a client that ignores codes still sees it.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ProvisionError } from '@/lib/onboarding/provision';
import { PlatformProvisionError, provisionTenant } from '@/lib/platform/provision';

export const dynamic = 'force-dynamic';

const ProvisionSchema = z.object({
  accountId: z.string().uuid(),
  product: z.literal('veloexpense'),
  plan: z.string().min(1),
  adminEmail: z.string().email(),
  adminName: z.string().min(1),
  companyName: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  /* Accepted and NOT persisted, exactly as VeloLedger's is: this product has no
   * per-org SSO domain allowlist store. Naming it in the schema keeps the
   * contract identical across the suite and keeps a caller from believing the
   * field was rejected. `invite`-based joining is how colleagues get in (VX5-3). */
  allowedEmailDomains: z.array(z.string()).default([]),
  /* The platform's own retry key. This product is idempotent on `accountId`
   * instead — a UNIQUE index (`0040`) rather than a stored key — so this is
   * accepted, logged by its presence in the contract, and not relied upon. Two
   * different idempotency keys for one Account must still yield one tenant. */
  idempotencyKey: z.string().min(1),
});

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch — guard first. A length is not
  // a secret; the bytes are.
  return a.length === b.length && timingSafeEqual(a, b);
}

function refuse(code: string, message: string, status: number, details?: unknown): NextResponse {
  return NextResponse.json(
    { error: details === undefined ? { code, message } : { code, message, details } },
    { status },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const expected = process.env.PLATFORM_INBOUND_TOKEN;
  if (!expected) {
    return refuse('NOT_CONFIGURED', 'platform provisioning is not configured', 503);
  }
  if (!tokenMatches(request.headers.get('x-platform-key'), expected)) {
    return refuse('UNAUTHORIZED', 'invalid platform key', 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return refuse('INVALID_INPUT', 'request body must be valid JSON', 400);
  }

  const parsed = ProvisionSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      'INVALID_INPUT',
      'invalid provision payload',
      422,
      parsed.error.flatten().fieldErrors,
    );
  }

  try {
    const result = await provisionTenant(parsed.data);
    return NextResponse.json(result, { status: result.status === 'provisioned' ? 201 : 200 });
  } catch (err) {
    // Both of these carry a `code` a caller can branch on, and a `message` meant
    // for a log rather than a screen — there is no screen here, which is why the
    // message goes out as-is. `DomainError`'s userMessage split exists for the
    // UI; a service caller wants the diagnostic.
    if (err instanceof PlatformProvisionError || err instanceof ProvisionError) {
      return refuse(err.code, err.message, 400);
    }

    /* ANYTHING ELSE IS A 500, AND THAT IS A CORRECTION TO THE PORT.
     *
     * VeloLedger's route ends every failure at 400 with the error's own message
     * in the body. Both halves of that are wrong for a service caller:
     *
     *   · 400 means "your request was bad — do not retry." A dropped database
     *     connection, a pool exhausted under load, a deploy mid-request: every
     *     one of those is transient and every one of them would tell the
     *     orchestrator to give up permanently on a tenant somebody has paid for.
     *     A 5xx is what says "ask again."
     *   · The message is a diagnostic. `DomainError` exists in this codebase
     *     precisely because a thrown message can name ids, table names and
     *     constraint names, and this is the one caller with no screen to filter
     *     it. So the detail goes to the log and the body says nothing.
     */
    console.error('[platform/provision] unexpected failure', err);
    return refuse('PROVISION_FAILED', 'provisioning failed — see server logs', 500);
  }
}
