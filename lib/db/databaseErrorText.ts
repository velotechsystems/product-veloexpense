/**
 * f69 — the text a database refusal carries, whichever shape Prisma hands it over in.
 *
 * Routers turn some Postgres refusals into 4xx answers by the constraint they name
 * (`fiscal_year_dates`, `policy_rule_effective_range`, …). Up to Prisma 7.8 a CHECK
 * violation surfaced as the driver adapter's own `DriverAdapterError`, whose `message`
 * is Postgres's ("new row … violates check constraint "x""). From 7.10 some arrive
 * wrapped as a `PrismaClientKnownRequestError` (P2039) with an EMPTY `message` and
 * Postgres's text only in `meta.driverAdapterError.cause.originalMessage`. Matching on
 * `message` alone then misses them and the refusal becomes a 500.
 *
 * This joins every place the text can be, so a router matches on one string.
 */
export function databaseErrorText(cause: unknown): string {
  const err = cause as {
    message?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown; message?: unknown } } };
    cause?: { originalMessage?: unknown };
  } | null;
  if (!err || typeof err !== 'object') return '';
  const parts = [
    err.message,
    err.meta?.driverAdapterError?.cause?.originalMessage,
    err.meta?.driverAdapterError?.cause?.message,
    err.cause?.originalMessage,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.join('\n');
}
