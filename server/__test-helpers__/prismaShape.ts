import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Validate a Prisma write payload's field names against `schema.prisma`.
 *
 * Exists because a stubbed `db` accepts anything, and that is how a renamed column
 * shipped three times over. `Expense.location` became `Expense.placeText` (the old
 * name collided with the NetSuite Location dimension), and three write sites kept the
 * old key: the receipt prefill, the multi-document determination, and travel →
 * report generation.
 *
 * Nothing caught it:
 *
 *   · **`tsc` passed.** Each payload contains conditional spreads
 *     (`...(x ? { date } : {})`), which widen the object literal enough to defeat
 *     excess-property checking.
 *   · **Unit tests passed.** They assert on a `vi.fn()` stub, which has no idea what
 *     an `Expense` is.
 *   · **It failed silently in the common case, loudly in the rare one.** Prisma DROPS
 *     an unknown key whose value is `undefined`, so a receipt with no address worked
 *     fine. A receipt WITH an address threw `Unknown argument \`location\``, the
 *     best-effort extraction handler swallowed it, and the user saw an uploaded
 *     receipt that produced no expense line items.
 *
 * Reading the schema text keeps this hermetic — no Prisma client, no DATABASE_URL —
 * so it runs in the unit project alongside the tests it protects.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// VeloExpense: one schema at the repository root (`prisma/schema.prisma`), not ExpenseOS's
// `packages/db/prisma/schema.prisma`. Ported with People 2 (users.mutations.test.ts).
const SCHEMA_PATH = join(HERE, '..', '..', 'prisma', 'schema.prisma');

let schemaText: string | null = null;
const fieldCache = new Map<string, Set<string>>();
const enumCache = new Map<string, Set<string>>();

function schema(): string {
  if (schemaText == null) schemaText = readFileSync(SCHEMA_PATH, 'utf8');
  return schemaText;
}

/**
 * Field + relation names declared on a model, plus the `<relation>Id` scalar Prisma
 * accepts alongside a relation. Comment and attribute lines are skipped.
 */
export function modelFields(model: string): Set<string> {
  const cached = fieldCache.get(model);
  if (cached) return cached;
  const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema());
  if (!block) throw new Error(`prismaShape: model ${model} not found in schema.prisma`);
  const names = new Set<string>();
  for (const raw of block[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue;
    const name = /^(\w+)\s+\S/.exec(line)?.[1];
    if (name) names.add(name);
  }
  fieldCache.set(model, names);
  return names;
}

/**
 * The member names of an enum declared in `schema.prisma`.
 *
 * For the same reason `modelFields` exists: a zod enum that hand-copies a Prisma enum
 * is a copy that can fall behind, and nothing else notices. `ApprovalSubjectType` grew
 * to four members while the router's copy stayed at two, which made travel and
 * limit-increase workflows unreachable through the admin API for as long as it took an
 * auditor to click Run and see nothing happen.
 *
 * Read from the schema text rather than the generated client, so this stays hermetic
 * and runs in the unit project — `@expenseos/db` re-exports enums as types only, so
 * there is no runtime object to read even if we wanted one.
 */
export function enumValues(name: string): Set<string> {
  const cached = enumCache.get(name);
  if (cached) return cached;
  const block = new RegExp(`^enum ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema());
  if (!block) throw new Error(`prismaShape: enum ${name} not found in schema.prisma`);
  const values = new Set<string>();
  for (const raw of block[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue;
    const value = /^(\w+)\s*$/.exec(line)?.[1];
    if (value) values.add(value);
  }
  enumCache.set(name, values);
  return values;
}

/**
 * Assert every key of `payload` is a real field on `model`.
 *
 * Nested writes are followed via `{ create: … }` / `{ createMany: { data } }` when a
 * `relations` map names the child model — that is where the travel bug lived, inside
 * `expenses: { create: [...] }` rather than at the top level.
 */
export function assertPrismaFields(
  model: string,
  payload: unknown,
  relations: Record<string, string> = {},
): void {
  if (payload == null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const entry of payload) assertPrismaFields(model, entry, relations);
    return;
  }
  const fields = modelFields(model);
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!fields.has(key)) {
      unknown.push(key);
      continue;
    }
    const childModel = relations[key];
    if (!childModel || value == null || typeof value !== 'object') continue;
    const nested = value as { create?: unknown; createMany?: { data?: unknown } };
    if (nested.create !== undefined) assertPrismaFields(childModel, nested.create, relations);
    if (nested.createMany?.data !== undefined) {
      assertPrismaFields(childModel, nested.createMany.data, relations);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Prisma write to ${model} names ${unknown.length} field(s) that do not exist: ` +
        `${unknown.join(', ')}.\n` +
        'Prisma silently DROPS an unknown key whose value is undefined and throws when it ' +
        'has a value, so this fails only for some inputs. Check schema.prisma for the ' +
        'current column name.',
    );
  }
}
