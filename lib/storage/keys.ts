import { randomUUID } from 'node:crypto';

/**
 * Object-key builders.
 *
 * VeloExpense: ExpenseOS's `@expenseos/storage` `keys.ts` (Wave 2, w2-09), its receipt key —
 * the one the ported receipt procedures write. Two differences, both VeloExpense's:
 *   · every key sits under the tenant's prefix, `org/{organizationId}/receipts/`, as every
 *     receipt key VeloExpense has written does (lib/receipts/service.ts), so a bucket listing
 *     is segmented by tenant and a key can never be mistaken for another tenant's;
 *   · the generated name is a random UUID (node:crypto), where ExpenseOS uses uuidv7 — the
 *     property that matters is that two uploads never share a name, and VeloExpense does not
 *     carry the `uuid` package.
 * The other builders (card attachments, statements, exports, audit archives) are not ported:
 * VeloExpense writes none of those keys.
 *
 * ExpenseOS's comment, for the validation:
 *
 * Inputs are validated to keep object keys clean and tamper-resistant
 * (no path traversal via "..", no embedded slashes from caller-controlled
 * data, no surprise characters in S3 keys).
 */

const ALLOWED_EXT = /^[a-z0-9]+$/;
const ALLOWED_UUID = /^[0-9a-f-]{36}$/i;

function sanitizeExt(ext: string): string {
  const clean = ext.toLowerCase().replace(/^\./, '');
  if (!ALLOWED_EXT.test(clean)) {
    throw new TypeError(`Invalid file extension: ${ext}`);
  }
  return clean;
}

function requireUuid(id: string, label: string): string {
  if (!ALLOWED_UUID.test(id)) {
    throw new TypeError(`${label} must be a UUID, got: ${id}`);
  }
  return id;
}

/** VeloExpense: the prefix every receipt of one report lives under, in one tenant. */
export function receiptPrefix(organizationId: string, reportId: string): string {
  return `org/${requireUuid(organizationId, 'organizationId')}/receipts/${requireUuid(reportId, 'reportId')}`;
}

/** org/{organizationId}/receipts/{reportId}/{uuid}.{ext} */
export function receiptKey(organizationId: string, reportId: string, ext: string): string {
  return `${receiptPrefix(organizationId, reportId)}/${randomUUID()}.${sanitizeExt(ext)}`;
}
