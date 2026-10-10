// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Presigned receipt uploads — the half of the flow that has to exist before any bytes do.
 *
 * The properties pinned here are the ones a unit test cannot reach, because they are about
 * what is in the database and what shape an object key has:
 *
 *   · a slot per file, paired to the expense it belongs to, in the caller's order;
 *   · keys under the REPORT prefix, which is what `receiptCreate`'s guard checks — the test
 *     proves it by registering one, so the guard never has to be loosened for this path;
 *   · `addReceiptExpenses` creating N rows rather than collapsing into one, which is the
 *     `createExpense` dedup trap that would put three receipts on one expense;
 *   · nothing at all created when a file type is refused.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 *
 * VeloExpense: ExpenseOS's `receiptUploads.db.test.ts` (w2-09). The cases are ExpenseOS's; the
 * harness is VeloExpense's (`createTenantHarness`: the suite's own tenant and people, every
 * call under RLS, storage in memory with `presignUpload` spied on — ExpenseOS mocks its
 * storage package). Adaptations, each marked:
 *   · keys sit under the tenant's prefix (`receiptPrefix`), are random rather than mocked,
 *     and `receiptCreate` reads the object back (d29), so the prefix case puts it first;
 *   · VeloExpense's report link has no locale prefix (`reportLinks.ts`);
 *   · `createReportFromReceipts` is handed its number — VeloExpense mints it in the router
 *     from the tenant's sequence, where ExpenseOS's column default draws it.
 */

// VeloExpense: read per call (`appOrigin`), so this need not precede the import.
process.env.APP_URL = 'https://veloexpense.example';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const PERMS = [
  P.expense.report.createOwn,
  P.expense.report.updateOwn,
  P.expense.report.readOwn,
] as const;

const heic = (filename = 'dinner.heic') => ({
  filename,
  contentType: 'image/heic',
  sizeBytes: 2_411_004,
});

describe.skipIf(!process.env.DATABASE_URL)('receipt uploads (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let userId: string;
  const reportIds: string[] = [];

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'receipt-uploads',
      name: 'Receipt Uploads',
      people: [{ email: 'other@receipt-uploads.test', name: 'Other' }],
    });
    db = h.db;
    userId = h.people[0].id;
    caller = h.makeCaller(PERMS, userId);
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  /** VeloExpense: (key, signed length) for every link the storage signed, from the spy. */
  const signedLengths = () =>
    h.storage.presignUpload.mock.calls.map((call: any[]) => [
      call[0] as string,
      (call[2] as { contentLength?: number } | undefined)?.contentLength,
    ]);

  describe('startFromReceipts with files', () => {
    it('returns one upload slot per file, paired to its expense in order', async () => {
      const res = await caller.startFromReceipts({
        title: 'Toronto client dinner',
        files: [
          heic('dinner.heic'),
          { filename: 'taxi.pdf', contentType: 'application/pdf', sizeBytes: 88_120 },
        ],
      });
      reportIds.push(res.reportId);

      expect(res.uploads).toHaveLength(2);
      expect(res.uploads.map((u: { filename: string }) => u.filename)).toEqual([
        'dinner.heic',
        'taxi.pdf',
      ]);
      // Each slot names the expense it belongs to, and they are distinct.
      expect(res.uploads.map((u: { expenseId: string }) => u.expenseId)).toEqual(res.expenseIds);
      expect(new Set(res.uploads.map((u: { key: string }) => u.key)).size).toBe(2);
      // The Content-Type is pinned on the URL, so the PUT cannot swap a PDF for a script.
      expect(res.uploads[0].headers['Content-Type']).toBe('image/heic');
      // Long enough for a 10MB PUT from a phone on bad wifi, not the 300s default.
      expect(res.uploads[0].expiresIn).toBe(900);
    });

    it("binds each link to its OWN file's declared size, matched by key", async () => {
      /**
       * Each link is signed for one exact length. Matched by the returned key rather than by
       * call order: the presigns run concurrently, so an index would pair a size with the
       * wrong file the day that order changes.
       */
      // VeloExpense: the harness's storage spy (ExpenseOS mocks its storage package).
      h.storage.presignUpload.mockClear();
      const res = await caller.startFromReceipts({
        title: 'Sizes',
        files: [
          heic('dinner.heic'),
          { filename: 'taxi.pdf', contentType: 'application/pdf', sizeBytes: 88_120 },
        ],
      });
      reportIds.push(res.reportId);

      const sizeByKey = new Map(signedLengths() as Array<[string, number]>);
      const bySlot = res.uploads.map((u: { key: string; filename: string }) => [
        u.filename,
        sizeByKey.get(u.key),
      ]);
      expect(bySlot).toEqual([
        ['dinner.heic', 2_411_004],
        ['taxi.pdf', 88_120],
      ]);
    });

    it('refuses the whole batch, creating nothing, when one file is over 10 MiB', async () => {
      const before = await db.expenseReport.count({ where: { submitterId: userId } });
      await expect(
        caller.startFromReceipts({
          title: 'Too big',
          files: [
            heic(),
            { filename: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 10_485_761 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.expenseReport.count({ where: { submitterId: userId } })).toBe(before);
    });

    it('keys every object under the report prefix, so receiptCreate accepts it unchanged', async () => {
      const res = await caller.startFromReceipts({ title: 'Prefix check', files: [heic()] });
      reportIds.push(res.reportId);
      const slot = res.uploads[0];
      // VeloExpense: under the tenant's prefix, then the report's.
      expect(slot.key.startsWith(`org/${h.orgId}/receipts/${res.reportId}/`)).toBe(true);
      // VeloExpense: the PUT the slot was for, which `receiptCreate` reads back (d29).
      h.storage.memory.put(slot.key, new Uint8Array(2_411_004), slot.contentType);

      // The guard in receiptCreate is the check that stops a row pointing at another
      // report's object. This path must satisfy it as it stands.
      const receipt = await caller.receiptCreate({
        expenseId: slot.expenseId,
        key: slot.key,
        filename: slot.filename,
        contentType: slot.contentType,
        sizeBytes: 2_411_004,
        deferExtraction: true,
      });
      expect(receipt.id).toBeTruthy();
    });

    it('creates nothing when a file type is refused', async () => {
      const before = await db.expenseReport.count({ where: { submitterId: userId } });
      await expect(
        caller.startFromReceipts({
          title: 'Spreadsheet',
          files: [{ filename: 'ledger.csv', contentType: 'text/csv', sizeBytes: 12 }],
        }),
      ).rejects.toThrow();
      // Validation happens before the report exists: half a batch created and then a
      // rejection is a mess somebody has to clean up by hand.
      expect(await db.expenseReport.count({ where: { submitterId: userId } })).toBe(before);
    });

    it('refuses both count and files, and refuses neither', async () => {
      await expect(
        caller.startFromReceipts({ title: 'Both', count: 2, files: [heic()] }),
      ).rejects.toThrow();
      await expect(caller.startFromReceipts({ title: 'Neither' })).rejects.toThrow();
    });

    it('still answers the original count form without upload slots', async () => {
      // The reports list calls this and presigns per file itself. Its response must not move.
      const res = await caller.startFromReceipts({ count: 2, title: 'Untitled report' });
      reportIds.push(res.reportId);
      expect(res.expenseIds).toHaveLength(2);
      expect(res.uploads).toBeUndefined();
    });
  });

  describe('the shared intake helpers', () => {
    it('writes the email body as the business reason on every expense it creates', async () => {
      // The ruling for receipts-by-email: the message body becomes each expense's `purpose`.
      // Exercised here because the email path has no tRPC procedure to test through, and a
      // Prisma `select`/field-name mistake typechecks fine and only fails against a database.
      const { createReportFromReceipts, resolveIntakeCurrencyId } = await import('@expenseos/db');
      const currencyId = await resolveIntakeCurrencyId(db, { userId });
      expect(currencyId).toBeTruthy();

      const created = await db.$transaction((tx: any) =>
        createReportFromReceipts(tx, {
          submitterId: userId,
          title: 'Emailed receipts',
          currencyId: currencyId as string,
          count: 2,
          purpose: 'Dinner with Acme after the Q3 review.',
          businessUnitSource: 'EXPENSEOS',
          // VeloExpense: handed in — the router mints it from the tenant's sequence.
          number: 'EXP-900001',
        }),
      );
      reportIds.push(created.id);

      expect(created.expenseIds).toHaveLength(2);
      // `number` is the generated EXP-000123 string, not an integer.
      // VeloExpense: the one handed in, returned as the report's.
      expect(created.number).toMatch(/^EXP-\d{6}$/);
      const expenses = await db.expense.findMany({
        where: { reportId: created.id },
        select: { purpose: true, amountMinor: true },
      });
      expect(expenses).toHaveLength(2);
      expect(
        expenses.every(
          (e: { purpose: string | null }) => e.purpose === 'Dinner with Acme after the Q3 review.',
        ),
      ).toBe(true);
      expect(expenses.every((e: { amountMinor: bigint }) => e.amountMinor === 0n)).toBe(true);
    });

    it('leaves purpose null when there is no body to record', async () => {
      const { createReportFromReceipts, resolveIntakeCurrencyId } = await import('@expenseos/db');
      const currencyId = await resolveIntakeCurrencyId(db, { userId });
      const created = await db.$transaction((tx: any) =>
        createReportFromReceipts(tx, {
          submitterId: userId,
          title: 'No body',
          currencyId: currencyId as string,
          count: 1,
          businessUnitSource: 'EXPENSEOS',
          // Whitespace only — the browser paths pass nothing at all, and both must land as
          // null rather than an empty string somebody has to look at.
          purpose: '   ',
          // VeloExpense: handed in — the router mints it from the tenant's sequence.
          number: 'EXP-900002',
        }),
      );
      reportIds.push(created.id);
      const expense = await db.expense.findFirstOrThrow({
        where: { reportId: created.id },
        select: { purpose: true },
      });
      expect(expense.purpose).toBeNull();
    });
  });

  describe('addReceiptExpenses', () => {
    it('adds one expense per file instead of collapsing them onto one', async () => {
      // The trap: `createExpense` reuses an empty expense, so three calls return the same id
      // and three receipts land on one expense — where determineExpense reads them as one
      // charge with a tip.
      const report = await caller.startFromReceipts({ count: 1, title: 'October' });
      reportIds.push(report.reportId);

      const res = await caller.addReceiptExpenses({
        reportId: report.reportId,
        files: [heic('a.heic'), heic('b.heic'), heic('c.heic')],
      });

      expect(res.expenseIds).toHaveLength(3);
      expect(new Set(res.expenseIds).size).toBe(3);
      // The blank one that was already there is untouched, not recycled.
      expect(res.expenseIds).not.toContain(report.expenseIds[0]);
      const count = await db.expense.count({ where: { reportId: report.reportId } });
      expect(count).toBe(4);
      expect(res.uploads).toHaveLength(3);
    });

    it("binds each added link to its own file's declared size, matched by key", async () => {
      const report = await caller.startFromReceipts({ count: 1, title: 'Sizes on add' });
      reportIds.push(report.reportId);
      // VeloExpense: the harness's storage spy (ExpenseOS mocks its storage package).
      h.storage.presignUpload.mockClear();

      const res = await caller.addReceiptExpenses({
        reportId: report.reportId,
        files: [
          { filename: 'taxi.pdf', contentType: 'application/pdf', sizeBytes: 88_120 },
          heic('dinner.heic'),
        ],
      });

      const sizeByKey = new Map(signedLengths() as Array<[string, number]>);
      expect(
        res.uploads.map((u: { key: string; filename: string }) => [
          u.filename,
          sizeByKey.get(u.key),
        ]),
      ).toEqual([
        ['taxi.pdf', 88_120],
        ['dinner.heic', 2_411_004],
      ]);
    });

    it('inherits the report currency rather than the submitter default', async () => {
      const report = await caller.startFromReceipts({ count: 1, title: 'Currency' });
      reportIds.push(report.reportId);
      const res = await caller.addReceiptExpenses({ reportId: report.reportId, files: [heic()] });
      const [added, parent] = await Promise.all([
        db.expense.findUniqueOrThrow({
          where: { id: res.expenseIds[0] },
          select: { currencyId: true, amountMinor: true },
        }),
        db.expenseReport.findUniqueOrThrow({
          where: { id: report.reportId },
          select: { currencyId: true },
        }),
      ]);
      expect(added.currencyId).toBe(parent.currencyId);
      expect(added.amountMinor).toBe(0n);
    });

    it('returns the handoff link when adding to an existing report', async () => {
      const report = await caller.startFromReceipts({ count: 1, title: 'Link' });
      reportIds.push(report.reportId);
      const res = await caller.addReceiptExpenses({ reportId: report.reportId, files: [heic()] });
      // VeloExpense: no locale prefix (`reportLinks.ts`).
      expect(res.reportUrl).toBe(`https://veloexpense.example/expenses/${report.reportId}?upload=1`);
    });

    it('refuses a report that is not editable', async () => {
      const report = await caller.startFromReceipts({ count: 1, title: 'Submitted' });
      reportIds.push(report.reportId);
      await db.expenseReport.update({
        where: { id: report.reportId },
        data: { status: 'SUBMITTED' },
      });
      // Recalling it is the person's decision, not something the assistant does for them.
      await expect(
        caller.addReceiptExpenses({ reportId: report.reportId, files: [heic()] }),
      ).rejects.toThrow();
    });

    it("refuses somebody else's report the same way as a missing one", async () => {
      /**
       * The other user's report is CREATED here, not looked up.
       *
       * It used to pick an arbitrary other user with an unordered `findFirst` and then
       * look for a report that user happened to submit — and returned early, silently,
       * when either lookup came up empty. Both guards were reachable: the seed owns 864
       * employees but only the ones named in `concur-history.json` submit anything, so
       * whether the arbitrary pick owned a report was luck, and unordered means the luck
       * could differ between two runs of the same suite on the same database.
       *
       * A `return` before any `expect` is a PASSING test that asserted nothing, so the
       * skip was invisible in the test count — and it left the `throw` on the NOT_FOUND
       * guard uncovered. That single branch is what put `apps/web/server/routers` at
       * 79.98% branches in CI while the same commit measured 80.01% locally, failing a
       * floor that prints both as `80.0%`. Own the fixture and the assertion always runs.
       */
      const other = await db.user.findFirstOrThrow({
        where: { deletedAt: null, id: { not: userId } },
        select: { id: true },
      });
      // VeloExpense: a currency is keyed by its code.
      const currency = await db.currency.findFirstOrThrow({ select: { code: true } });
      const theirs = await db.expenseReport.create({
        data: { title: "Somebody else's report", submitterId: other.id, currencyId: currency.code },
        select: { id: true },
      });
      reportIds.push(theirs.id);

      // Same answer for both, so an id cannot be probed for existence.
      await expect(
        caller.addReceiptExpenses({ reportId: theirs.id, files: [heic()] }),
      ).rejects.toThrow(/NOT_FOUND|not found/i);
    });
  });
});
