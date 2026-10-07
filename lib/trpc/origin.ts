/**
 * VeloExpense: a write must come from this site's own pages.
 *
 * VeloExpense's other writes are server actions, and Next refuses a server action whose
 * `Origin` does not match the host. A tRPC mutation is a plain POST to this route and gets
 * no such check, so it is made here. The session cookie is SameSite=Lax, which stops a
 * cross-SITE POST from carrying it — but every tenant subdomain is the SAME site, so Lax
 * alone would let a page on one tenant's host post as the reader to another's.
 *
 * Queries are GETs and are left alone: a cross-origin page cannot read the answer, and
 * tRPC never runs a mutation for a GET.
 */
export function crossOriginWrite(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true; // every browser sends Origin on a POST; its absence is not ours
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
