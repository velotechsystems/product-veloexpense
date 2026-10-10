import { describe, expect, it } from 'vitest';
import { receiptKey } from './keys';

/**
 * S3 object-key construction.
 *
 * These take caller-controlled strings and turn them into object keys, which makes them a
 * boundary rather than a formatting detail. Two things go wrong here:
 *
 *   · **Path traversal.** A `reportId` of `../../other` would write outside its prefix.
 *     Receipts are tenant data behind presigned URLs, so a key that escapes its prefix is
 *     a cross-report read.
 *   · **A key that is merely wrong.** An extension of `pdf?x-amz=…` or an embedded slash
 *     produces an object nobody can find again, and the receipt is silently lost — the
 *     upload succeeds, so nothing reports a failure.
 *
 * The validation is therefore tested as a security boundary: every rejection is asserted
 * to THROW, not to sanitise-and-continue, because a silently-rewritten key still stores
 * the object somewhere unexpected.
 *
 * VeloExpense: ExpenseOS's `keys.test.ts`, its `receiptKey` block, on VeloExpense's key
 * (`org/{organizationId}/receipts/{reportId}/{uuid}.{ext}`, see `keys.ts`). The organization
 * id is validated the same way as the report id, so it gains one case.
 */

const ORG = '019f8000-0000-7000-8000-000000000001';
const UUID = '019f851b-1738-77a9-80ce-657e28ed2b41';
/** VeloExpense: a random UUID in the generated segment (ExpenseOS: uuidv7). */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('receiptKey', () => {
  it('nests the receipt under its report id', () => {
    expect(receiptKey(ORG, UUID, 'pdf')).toMatch(new RegExp(`^org/${ORG}/receipts/${UUID}/${UUID_RE}\\.pdf$`));
  });

  it('generates a fresh name each call, so two uploads never collide', () => {
    // Same report, same extension — a shared name would have the second upload silently
    // overwrite the first.
    expect(receiptKey(ORG, UUID, 'pdf')).not.toBe(receiptKey(ORG, UUID, 'pdf'));
  });

  it('accepts a leading dot on the extension', () => {
    expect(receiptKey(ORG, UUID, '.PDF')).toMatch(/\.pdf$/);
  });

  it('lowercases the extension', () => {
    expect(receiptKey(ORG, UUID, 'JPEG')).toMatch(/\.jpeg$/);
  });

  it('refuses a report id that is not a UUID', () => {
    for (const bad of ['', 'abc', '../../etc/passwd', `${UUID}/x`, `${UUID} `]) {
      expect(() => receiptKey(ORG, bad, 'pdf'), bad).toThrow(TypeError);
    }
  });

  it('VeloExpense: refuses an organization id that is not a UUID', () => {
    for (const bad of ['', 'abc', '../../etc/passwd', `${ORG}/x`]) {
      expect(() => receiptKey(bad, UUID, 'pdf'), bad).toThrow(TypeError);
    }
  });

  it('refuses an extension carrying a slash, dot or query', () => {
    // Each of these would produce a reachable-but-wrong key rather than an error.
    for (const bad of ['pd/f', 'p.df', 'pdf?x=1', 'pdf ', '', '..', 'pdf#frag']) {
      expect(() => receiptKey(ORG, UUID, bad), bad).toThrow(TypeError);
    }
  });

  it('names the offending value in the error, since these surface in logs', () => {
    expect(() => receiptKey(ORG, 'not-a-uuid', 'pdf')).toThrow(/not-a-uuid/);
    expect(() => receiptKey(ORG, UUID, 'pd/f')).toThrow(/pd\/f/);
  });
});
