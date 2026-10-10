/**
 * ExpenseOS's expenses router (`apps/web/src/server/routers/expenses.ts` at 550b2945),
 * ported in slices (Wave 2). This file holds the slices ported so far:
 *
 *   · w2-07 — the report-level procedures: `list`, `summaryOwn`, `create`,
 *     `updateReport`, `deleteReport`, and the `currencies` / `categories` pickers;
 *   · w2-08b — the expense, line and tax procedures: `createExpense`, `updateExpense`,
 *     `deleteExpense`, `deleteExpenses`, `totalsPreview`, `mileagePreview`,
 *     `lineItemCreate`, `lineItemUpdate`, `lineItemRemove`, `expenseTaxUpdate` and
 *     `explainTax`;
 *   · w2-08c — the `report` query, with `serializeExpense` and `EXPENSE_DETAIL_INCLUDE`;
 *   · w2-03 — cost allocation: `dimensionOptions` and `allocationSet`;
 *   · w2-04 — the attendee picker's search, `attendeeDirectory` (the roster itself is
 *     written by `updateExpense`, w2-08b);
 *   · w2-09 — receipts: `startFromReceipts`, `addReceiptExpenses`, `receiptUploadUrl`,
 *     `receiptCreate`, `receiptList`, `receiptMove`, `receiptRemove`;
 *   · w2-11 — the report's lifecycle: `validate`, `justifyViolation`, `submit`, `recall`.
 *
 * The rest of ExpenseOS's router (`startExtraction`, `markExtractionReviewed`, the grouping
 * and statement procedures — extraction, Wave 3 — and `explainPerDiem`) arrives with the
 * slices after, in ExpenseOS's order and words.
 *
 * VeloExpense adaptations are marked `VeloExpense:` where they are made. The shared ones:
 *   · a currency is keyed by its ISO code (`currencyId` holds the code, as `homeCurrencyId`
 *     does since 0048), and its symbol comes from the platform (`currencySymbol`);
 *   · who a submitted report is "sitting with" is read from VeloExpense's own approval
 *     tables until Wave 4 ports ExpenseOS's engine (`pendingApproverByReport`);
 *   · a report's number is minted from the organization's sequence, as VeloExpense's own
 *     writer has always done (`mintReportNumber`);
 *   · receipt objects are deleted and signed through VeloExpense's storage (`getStorage`),
 *     under the tenant's key prefix (`receiptKey`); an upload link is bound to the file's
 *     length and `receiptCreate` reads the object back before recording it (d29); only a
 *     STORED receipt is read; the extraction and determination jobs are not queued until
 *     Wave 3 (`enqueue`);
 *   · `report` reads VeloExpense's own policy violations and ledger posting
 *     (`reportViolations`, `postingStateOf`); there is no NetSuite position, so no coding
 *     gaps, classes or NetSuite business units, and no receipt has a reading until Wave 3;
 *   · an allocation may not be coded to an unknown or deactivated business unit or
 *     department, unless the expense already carries it (f09, `assertAllocationDimensionsUsable`);
 *   · a RETURNED report is editable, as in ExpenseOS (d26);
 *   · a new expense counts against the plan's yearly expense cap, checked on the same
 *     transaction (`assertExpenseAllowance` through `queryRunnerOf`);
 *   · submit and recall keep ExpenseOS's checks and hand the transition to VeloExpense's
 *     lifecycle (d23, `server/lib/reportLifecycle.ts`), and the policy pass is VeloExpense's
 *     (`runPolicy`) with ExpenseOS's justification rule (d34);
 *   · corrections are not yet recorded against a determination (`noteOverrides` is a
 *     no-op until extraction, Wave 3); a traveller's country is `app_user.country` (0055,
 *     w2-10), backfilled from their legal entity.
 */
import { auditActions, auditDiff, withAudit } from '@expenseos/audit';
import {
  allocationCreateFor,
  type BusinessUnitSource,
  type CodingDefaultsUser,
  codingDefaultsFor,
  createBlankExpensesForReceipts,
  createReportFromReceipts,
  EXPENSE_FX_SELECT,
  ExpensePaymentMethod,
  ExpenseReportStatus,
  ExpenseTaxSource,
  fxColumns,
  fxOverrideOf,
  fxParamsFrom,
  glAccountIdForCategory,
  Prisma,
  recomputeReportTotal,
  reportRollupFor,
  resolveExpenseFx,
  resolveIntakeCurrencyId,
} from '@expenseos/db';
import { tipMinorOf, tipPayload, totalTipMinor } from '@expenseos/expense-lines';
import { buildReportRollup, fxRateMapFrom, getCurrency, withFxOverride } from '@expenseos/money';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assertExpenseAllowance, CapReachedError } from '@/lib/billing/caps';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { getStorage } from '@/lib/storage';
import { receiptKey, receiptPrefix } from '@/lib/storage/keys';
import { RECEIPT_CAP_BYTES } from '@/lib/storage/limits';
import {
  acknowledgeViolation,
  clearAcknowledgement,
  type ValidationSummary,
  validateReport as validateReportPolicy,
} from '@/lib/policy/service';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { explainExpenseTax, resolveExpenseTax } from '@/server/lib/expenseTax';
import { summarizeExtractionProgress } from '@/server/lib/extractionInFlight';
import {
  convertScaled,
  distanceToScaled,
  priceMileage,
  resolveMileageRule,
  ytdDistanceScaled,
} from '@/server/lib/mileage';
import {
  buildHomeRollup,
  type CurrencyGroup,
  homeConverterFor,
  readerCurrencyCode,
  readerTotalsFor,
} from '@/server/lib/readerCurrency';
import { callerCanDecideReport } from '@/server/lib/reportApproval';
import { reportUrl } from '@/server/lib/reportLinks';
import { recallThroughLifecycle, submitThroughLifecycle } from '@/server/lib/reportLifecycle';
import { REFUSAL_KEYS, type RefusalKey, refusal } from '@/server/refusal';
import { renderViolation } from '@/lib/i18n/catalog/policy-messages';
import { loadReaderPrefs } from '@/lib/i18n/service';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

/** 10 MiB cap per receipt/invoice — the shared cap the worker also reads against. */
const MAX_RECEIPT_BYTES = RECEIPT_CAP_BYTES;

/** Bulk uploads larger than this go through the Batch API (async, ~50% cheaper);
 *  at or below it, each receipt extracts synchronously. Mirrors the worker. */
const BATCH_THRESHOLD_FILES = 5;

/**
 * VeloExpense: one `receiptGroupingSuggestions` item, in the shape ExpenseOS's procedure
 * returns — written out because ExpenseOS's is inferred from `groupDocuments`, which
 * arrives with extraction (Wave 3).
 */
/**
 * VeloExpense: a receipt's extraction as ExpenseOS's `report` maps it for the client — its
 * `DocumentExtraction` row's statuses (`DocScanStatus`, `DocExtractStatus`), confidence,
 * data, error, model and review stamp. Written out because the table arrives with extraction
 * (Wave 3); until then every receipt's is null.
 */
interface ReceiptReading {
  scanStatus: 'PENDING' | 'SCANNING' | 'CLEAN' | 'INFECTED' | 'FAILED';
  status: 'PENDING' | 'EXTRACTING' | 'EXTRACTED' | 'FAILED';
  confidence: number | null;
  data: Prisma.JsonValue | null;
  error: string | null;
  model: string | null;
  reviewedAt: Date | null;
}

interface GroupingSuggestion {
  reason: string;
  /** True when the evidence positively agrees; the UI recommends merging. */
  confident: boolean;
  suggestedExpenseId: string;
  documents: Array<{
    receiptId: string;
    expenseId: string;
    filename: string;
    vendor: string | null;
    date: string | null;
    time: string | null;
    transactionId: string | null;
    total: number | null;
    currencyCode: string | null;
    kind: string;
    expenseMerchant: string | null;
    expenseDate: Date | null;
  }>;
}

/** Content types accepted for expense receipts/invoices. Enforced server-side
 *  (the storage layer itself does not filter). */
const RECEIPT_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/**
 * Seconds a receipt upload URL stays valid.
 *
 * Longer than the storage default of 300. These URLs are handed to a caller that may be a
 * phone on hotel wifi pushing 10MB, or an MCP client on a slow link — and an upload that
 * expires mid-PUT leaves a blank expense whose cause is invisible to the person filing it.
 */
const RECEIPT_UPLOAD_TTL_SECONDS = 900;

/** One file about to be uploaded, as the caller describes it before it exists in S3. */
const receiptFileSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  /** The file's EXACT byte length. Its upload link is signed for this length, so storage
   *  refuses a PUT of any other size (see `UploadUrlInput.contentLength`), and a file over
   *  the cap is refused here before any link or expense exists. */
  sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES),
});

type ReceiptFile = z.infer<typeof receiptFileSchema>;

/** The extension for an object key, from a filename that may not have one. */
function extOf(filename: string): string {
  return filename.includes('.') ? filename.split('.').pop() || 'bin' : 'bin';
}

/**
 * Presign one PUT per file, pairing each with the expense it belongs to.
 *
 * Every key is built under the REPORT's prefix, which is what `receiptCreate`'s key-prefix
 * guard checks — so a caller can register only what was presigned for them here, and the
 * guard needs no loosening to let this path through.
 *
 * Content types are validated before anything is created, not per file as we go: half a
 * report's worth of expenses created and then a rejection is a mess somebody has to clean up
 * by hand.
 */
async function presignReceiptUploads(
  // VeloExpense: the tenant, for the key's tenant prefix (`receiptKey`).
  organizationId: string,
  reportId: string,
  pairs: readonly { expenseId: string; file: ReceiptFile }[],
) {
  return Promise.all(
    pairs.map(async ({ expenseId, file }) => {
      const key = receiptKey(organizationId, reportId, extOf(file.filename));
      // VeloExpense: VeloExpense's storage, length-bound as ExpenseOS's (d29).
      const upload = await getStorage().presignUpload(key, file.contentType, {
        // This file's own declared length — never the cap, or every real upload would fail
        // its signature.
        contentLength: file.sizeBytes,
        expiresInSeconds: RECEIPT_UPLOAD_TTL_SECONDS,
      });
      return {
        expenseId,
        key,
        filename: file.filename,
        contentType: file.contentType,
        url: upload.url,
        method: 'PUT' as const,
        headers: upload.headers,
        expiresIn: upload.expiresInSeconds,
      };
    }),
  );
}

/** Reject unsupported types up front, naming the offender rather than the batch. */
function assertReceiptTypes(files: readonly ReceiptFile[]): void {
  for (const file of files) {
    if (!RECEIPT_CONTENT_TYPES.has(file.contentType)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Unsupported file type for ${file.filename}: ${file.contentType}`,
      });
    }
  }
}

/** A report is editable (and (re)submittable) by its submitter while DRAFT or
 *  RETURNED — an approver can return a submitted report for fixes (Phase 3),
 *  after which it behaves like a draft again until resubmitted. */
const EDITABLE_REPORT_STATUSES: ExpenseReportStatus[] = [
  ExpenseReportStatus.DRAFT,
  ExpenseReportStatus.RETURNED,
];

/**
 * Where a document may still be ADDED: the editable statuses, plus SUBMITTED.
 *
 * Attaching evidence is not editing the claim — an approver asking for a missing receipt
 * mid-review is a real flow, and the joint/single-document extraction refuses to move a
 * filed report's numbers (`prefill.ts`, `determine.ts`). The window closes with the
 * decision: once a report is APPROVED, REJECTED or REIMBURSED the evidence set is what
 * the approver signed, and NetSuite's File Cabinet push sends whatever is on the report
 * at post time. There is deliberately no post-approval attach path; a report whose
 * evidence is wrong after approval is a report to reject or reverse, not to patch.
 *
 * Removing or moving a document is narrower still — `EDITABLE_REPORT_STATUSES` only —
 * because both destroy or restate what an approver may already have looked at.
 */
const ATTACHABLE_REPORT_STATUSES: ExpenseReportStatus[] = [
  ...EDITABLE_REPORT_STATUSES,
  ExpenseReportStatus.SUBMITTED,
];

function actorOf(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email?: string | null } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

/** An expense (and its receipts) is readable/writable by its owner — the report
 *  submitter for a filed expense, or the creator for an unfiled one. Returns the
 *  reportId (null when unfiled) + ownerId; the object-key prefix is the reportId
 *  when filed, else the expenseId. */
async function assertExpenseOwned(
  ctx: {
    db: import('@expenseos/db').PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
): Promise<{ reportId: string; ownerId: string }> {
  const expense = await ctx.db.expense.findUnique({
    where: { id: expenseId },
    select: { reportId: true, ownerId: true, report: { select: { submitterId: true } } },
  });
  const uid = ctx.session.user.id;
  if (!expense || (expense.ownerId !== uid && expense.report?.submitterId !== uid)) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  return { reportId: expense.reportId, ownerId: expense.ownerId };
}

/**
 * As `assertExpenseOwned`, but also refuses edits once the expense's report leaves
 * DRAFT — a submitted report is read-only to its submitter.
 *
 * `reportId` is non-null because `Expense.reportId` is a required column: every
 * expense belongs to a report, even the blank ones a receipt batch creates. Both
 * helpers used to return `string | null` from the days when it was nullable, and the
 * `if (!reportId)` branches downstream were unreachable — an "unfiled expense" is not
 * a state the schema can hold.
 */
/**
 * Attendees, in one comparable shape.
 *
 * The roster is a full-replace set — the editor sends the whole list on save and the
 * mutation deletes and recreates it — so comparing rows would report every save as a
 * change to every attendee. Sorted by name and reduced to the three fields a person
 * would recognise, so "did the roster change" has a stable answer.
 */
function normalizeAttendees(
  list: readonly { name: string; company?: string | null; isExternal?: boolean | null }[],
): { name: string; company: string | null; isExternal: boolean }[] {
  return [...list]
    .map((a) => ({ name: a.name, company: a.company ?? null, isExternal: a.isExternal ?? false }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** The one refusal for a write to a report the submitter no longer owns the figures of. */
const NOT_EDITABLE = {
  key: REFUSAL_KEYS.reportNotEditable,
  message: 'Report is not editable.',
} as const;

async function assertExpenseDraft(
  ctx: {
    db: import('@expenseos/db').PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
): Promise<{ reportId: string; ownerId: string }> {
  return assertExpenseWritable(ctx, expenseId, EDITABLE_REPORT_STATUSES, NOT_EDITABLE);
}

/**
 * As `assertExpenseDraft`, for the document endpoints that ADD evidence: the report may
 * also be SUBMITTED (see `ATTACHABLE_REPORT_STATUSES`). Delete and move stay on the
 * draft gate.
 */
async function assertExpenseAttachable(
  ctx: {
    db: import('@expenseos/db').PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
): Promise<{ reportId: string; ownerId: string }> {
  return assertExpenseWritable(ctx, expenseId, ATTACHABLE_REPORT_STATUSES, {
    key: REFUSAL_KEYS.documentsClosed,
    message: 'Documents cannot be added once the report has been decided.',
  });
}

/** Ownership + a status allow-list, in one read. The two public gates above are the
 *  only callers, so there is exactly one notion of "may this expense be written". */
async function assertExpenseWritable(
  ctx: {
    db: import('@expenseos/db').PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
  allowed: readonly ExpenseReportStatus[],
  refused: { key: RefusalKey; message: string },
): Promise<{ reportId: string; ownerId: string }> {
  const expense = await ctx.db.expense.findUnique({
    where: { id: expenseId },
    select: {
      reportId: true,
      ownerId: true,
      report: { select: { submitterId: true, status: true } },
    },
  });
  const uid = ctx.session.user.id;
  if (!expense || (expense.ownerId !== uid && expense.report?.submitterId !== uid)) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  if (expense.report && !allowed.includes(expense.report.status)) {
    throw refusal('BAD_REQUEST', refused.key, refused.message);
  }
  return { reportId: expense.reportId, ownerId: expense.ownerId };
}

/**
 * Widest money value any expense field may carry, in minor units: 10^15, or ten
 * trillion dollars a line.
 *
 * The bound is technical rather than a business rule. `amountMinor` is a Postgres
 * `BigInt`, so it tops out at 2^63-1 ≈ 9.22 × 10^18, and the browser sends DOLLARS which
 * the client multiplies by 100 — so `99999999999999999` typed into an amount field
 * arrived as ≈ 9.99 × 10^18 cents, cleared the column's ceiling, and came back as a
 * verbatim `Invalid prisma.expenseLineItem.update() invocation: Value out of range for
 * the type: value "100000000000000000" is out of range for type bigint` on screen (GA
 * readiness report F05). Ten trillion leaves three orders of magnitude of headroom for
 * summing a report's lines and rejects nothing anybody will ever legitimately file.
 */
const MAX_MINOR = 10n ** 15n;

/** Minor units as a human figure for an error message — `11398` → `113.98 CAD`. */
function majorOf(minor: bigint, code: string): string {
  const exp = getCurrency(code).exponent;
  const neg = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  const unit = 10n ** BigInt(exp);
  const frac = exp > 0 ? `.${(abs % unit).toString().padStart(exp, '0')}` : '';
  return `${neg}${abs / unit}${frac} ${code}`;
}

/**
 * The one refusal for "paid tax exceeds the gross", used at tax entry and at submit.
 *
 * `merchant` is given at submit, where the reader is looking at the whole report and
 * needs to know WHICH expense; at entry they are looking at the field itself. The
 * amounts travel pre-formatted (`113.98 CAD`) because ICU cannot take the currency as
 * an argument, and a figure with its code is unambiguous in either language.
 */
function taxExceedsAmountRefusal(
  code: 'BAD_REQUEST' | 'PRECONDITION_FAILED',
  paidMinor: bigint,
  grossMinor: bigint,
  currency: string,
  merchant?: string | null,
): TRPCError {
  const tax = majorOf(paidMinor, currency);
  const amount = majorOf(grossMinor, currency);
  const sentence =
    `Tax of ${tax} exceeds the expense amount of ${amount}. ` +
    'Tax cannot be more than what was paid.';
  return merchant
    ? refusal(code, REFUSAL_KEYS.taxExceedsAmountAt, `${merchant}: ${sentence}`, {
        merchant,
        tax,
        amount,
      })
    : refusal(code, REFUSAL_KEYS.taxExceedsAmount, sentence, { tax, amount });
}

/**
 * Money input from the client: a bigint or a digit-string (superjson may send either).
 * `optMinor` additionally allows null (clear the column) vs undefined (leave unchanged).
 *
 * NON-NEGATIVE, and that is not cosmetic. The regex used to be `/^-?\d+$/` — the `-?`
 * admitted `-500`, which saved cleanly, produced a report total of −$500.00, and, because
 * it dragged the report under the receipt threshold, stopped the BLOCK rule firing at all
 * (F07). A negative line was therefore a POLICY BYPASS, not merely a validation gap.
 *
 * Every field this guards is an expense amount, a tip, a subtotal or a tax component, and
 * none of them is ever negative. A refund is a virtual-card transaction concept and lives
 * in `virtualCardTransactions`, which has its own signed schema — deliberately not this
 * one. `travelRequests` already validates its line amounts this way
 * (`z.bigint().positive().max(MAX_LINE_MINOR)`); this is the expense side catching up.
 */
const minorInput = z.union([z.bigint(), z.string().regex(/^\d+$/)]).refine(
  (v) => {
    const n = typeof v === 'bigint' ? v : BigInt(v);
    return n >= 0n && n <= MAX_MINOR;
  },
  { message: 'Amount must be zero or more, and no larger than 10^15 minor units.' },
);
const toMinor = (v: bigint | string): bigint => (typeof v === 'bigint' ? v : BigInt(v));
const optMinor = (v: bigint | string | null | undefined): bigint | null | undefined =>
  v === undefined ? undefined : v === null ? null : toMinor(v);

/**
 * Record a human's corrections against the expense's current determination, so a
 * later re-scan reconciles TO them instead of overwriting them (rule 2).
 *
 * A no-op when nothing has been proposed yet: somebody typing their own expense
 * into a blank form is not overriding anything, and treating it as a wall of
 * corrections would poison the first determination with "edits" to fields it never
 * guessed. The values are rendered text because they go into a prompt — see
 * `@expenseos/db`'s determination module for why that is the shared shape.
 *
 * Fire-and-forget: the write the caller just made is what matters, and losing an
 * override note is not worth failing a save the user already saw succeed.
 */
function noteOverrides(
  _db: import('@expenseos/db').PrismaClient,
  _expenseId: string,
  _patch: Record<string, string | null | undefined>,
): void {
  // VeloExpense: a no-op until receipt extraction is ported (Wave 3). ExpenseOS records
  // these against the expense's current DETERMINATION (`recordOverrides`), and VeloExpense
  // has no determinations yet — no extraction has proposed anything, so, in ExpenseOS's
  // own words above, there is nothing to override. The call sites stay as they are so the
  // extraction port only has to fill this body in.
}

/** ISO-4217 exponent for a code; 2 for anything unrecognised, because this feeds
 *  a display string and must never throw. */
function exponentOf(code: string): number {
  try {
    return getCurrency(code).exponent;
  } catch {
    return 2;
  }
}

/** A minor-unit amount as an override value: major units, so the determination
 *  prompt reads "113.00" rather than "11300". */
function overrideAmount(
  minor: bigint | string | null | undefined,
  currencyCode: string,
): string | null | undefined {
  if (minor === undefined) return undefined;
  if (minor === null) return null;
  const exponent = exponentOf(currencyCode);
  const n = typeof minor === 'bigint' ? minor : BigInt(minor);
  return (Number(n) / 10 ** exponent).toFixed(exponent);
}

/**
 * Derive an expense's totals — gross, the tax split, and the home-currency conversion —
 * from a given line set, WITHOUT writing anything.
 *
 * Extracted so the save path and the live preview share one implementation. That sharing
 * is the whole point: the preview's numbers have to be the numbers that will be saved, and
 * a second implementation in the browser would eventually disagree by a cent and be
 * believed. (This repo has already shipped one money-scale bug in `convertMoney`, #127 —
 * a parallel FX path is the last thing worth adding.)
 *
 * `lines` is passed in rather than read here so the preview can supply a DRAFT set that is
 * not in the database yet.
 */
async function deriveExpenseTotals(
  db: import('@expenseos/db').PrismaClient,
  expenseId: string,
  lines: readonly { amountMinor: bigint; categoryId: string; kind: string; payload?: unknown }[],
): Promise<{
  sum: bigint;
  tax: Awaited<ReturnType<typeof resolveExpenseTax>> | null;
  fx: Awaited<ReturnType<typeof resolveExpenseFx>> | null;
} | null> {
  const sum = lines.reduce((a, l) => a + l.amountMinor, 0n);
  // A tip is part of its line's amount but never taxable, so it leaves the base.
  // Read through the kind registry rather than off the Json.
  const tipMinor = totalTipMinor(lines);
  const exp = await db.expense.findUnique({
    where: { id: expenseId },
    select: {
      taxSource: true,
      taxJurisdictionId: true,
      taxGstHstMinor: true,
      taxQstMinor: true,
      taxPstMinor: true,
      ...EXPENSE_FX_SELECT,
      // The owner's legal entity decides whether an input tax credit arises at
      // all — a non-registrant or foreign entity reclaims neither GST/HST nor QST
      // (A6). The category ITC% only narrows a credit that exists. It also owns
      // the home currency the employee is paid in (rule 3), which is why
      // EXPENSE_FX_SELECT reaches through the same relation.
      // VeloExpense: the entity's `homeCurrencyId` is the ISO code itself (0048), as in
      // EXPENSE_FX_SELECT.
      owner: {
        select: {
          entity: { select: { itcRecoverable: true, homeCurrencyId: true } },
        },
      },
    },
  });
  if (!exp) return null;

  const tax = await resolveExpenseTax(db, {
    grossMinor: sum,
    untaxedTipMinor: tipMinor,
    taxJurisdictionId: exp.taxJurisdictionId,
    // VeloExpense: text with a CHECK (0054), so the client types it `string`.
    taxSource: exp.taxSource as ExpenseTaxSource,
    explicit: {
      gstHstMinor: exp.taxGstHstMinor ?? undefined,
      qstMinor: exp.taxQstMinor ?? undefined,
      pstMinor: exp.taxPstMinor ?? undefined,
    },
    lines: lines.map((l) => ({ categoryId: l.categoryId, amountMinor: l.amountMinor })),
    itcRecoverable: exp.owner.entity?.itcRecoverable ?? true,
  });
  // The conversion is snapshotted alongside the total it converts, so an approver
  // and the eventual NetSuite posting see the same home-currency figure the
  // employee filed — `sum`, not the stale column, since it changed just now.
  const fx = await resolveExpenseFx(db, fxParamsFrom(exp, sum));
  return { sum, tax, fx };
}

/** An Expense's amount is the sum of its line items (Concur-style itemization);
 *  the report total is the sum of its expenses. Tax lives on the expense now, so
 *  we also re-derive it here against the fresh line set — the split follows the
 *  gross (CALCULATED) or keeps the stored paid amounts (MANUAL/EXTRACTED), and
 *  the recoverable ITC re-allocates across the current line categories.
 *  Recompute after any line-item change so the derived totals never drift. */
async function recomputeTotals(
  db: import('@expenseos/db').PrismaClient,
  expenseId: string,
): Promise<void> {
  const lines = await db.expenseLineItem.findMany({
    where: { expenseId },
    select: { amountMinor: true, categoryId: true, kind: true, payload: true },
  });
  const derived = await deriveExpenseTotals(db, expenseId, lines);
  if (!derived) return;
  const { sum, tax, fx } = derived;
  const expense = await db.expense.update({
    where: { id: expenseId },
    data: { amountMinor: sum, ...(tax ?? {}), ...(fx ? fxColumns(fx) : {}) },
    select: { reportId: true },
  });
  // Unfiled expenses (no report) have no report total to recompute.
  if (expense.reportId) await recomputeReportTotal(db, expense.reportId);
}

/**
 * The `kind` + `payload` a line write should persist.
 *
 * A tip is only accepted where its category allows one — otherwise the flag on
 * `ExpenseCategory` would be decorative, and a tip on a software subscription is
 * how bad data gets in. Mileage keeps its own kind regardless.
 */
async function resolveLineKind(
  db: import('@expenseos/db').PrismaClient,
  params: { categoryId: string; tipMinor?: bigint | null },
): Promise<{
  kind: 'STANDARD' | 'STANDARD_WITH_TIP' | 'MILEAGE';
  payload: Prisma.InputJsonValue | null;
}> {
  const cat = await db.expenseCategory.findUnique({
    where: { id: params.categoryId },
    select: { isMileage: true, acceptsTip: true },
  });
  if (cat?.isMileage) return { kind: 'MILEAGE', payload: null };
  const tip = params.tipMinor ?? 0n;
  if (!cat?.acceptsTip || tip <= 0n) return { kind: 'STANDARD', payload: null };
  const built = tipPayload(tip);
  return { kind: built.kind as 'STANDARD_WITH_TIP', payload: built.payload };
}

/** Resolve a line item's financial columns for a write. For a mileage-category
 *  line (A7) the amount is COMPUTED km × MileageRate (resolved by the traveller's
 *  country + the expense date) and the km / rate are stamped; for any other
 *  category the typed amount is used and the mileage columns are cleared. */
async function computeLineFinancials(
  db: import('@expenseos/db').PrismaClient,
  params: {
    expenseId: string;
    categoryId: string;
    amountMinor?: bigint;
    /** Distance as typed, in `mileageUnit`. */
    mileageDistance?: string | null;
    mileageUnit?: 'KM' | 'MI' | null;
    /** Ordered stops + per-leg distances from the route lookup, stored verbatim. */
    mileageRoute?: unknown;
    /** Traveller's correction to the computed distance. */
    mileageDistanceOverride?: string | null;
    /** The line being repriced, so the YTD basis doesn't count it twice. */
    lineItemId?: string;
    /**
     * Allow a mileage category with no distance yet, pricing it at zero.
     *
     * Set only when a line is being SWITCHED into a mileage category: the distance
     * cannot already be there, and refusing the switch is why the category change
     * used to fail silently and leave the old amount on screen. Blanking the
     * distance on a line that is already mileage still errors — that is a claim
     * being erased, not a category being chosen.
     */
    allowMissingDistance?: boolean;
  },
): Promise<MileagePricing> {
  const category = await db.expenseCategory.findUnique({
    where: { id: params.categoryId },
    select: { isMileage: true },
  });
  if (!category?.isMileage) {
    return { amountMinor: params.amountMinor ?? 0n, mileage: CLEARED_MILEAGE };
  }
  const typed = params.mileageDistanceOverride ?? params.mileageDistance;
  const typedScaled = typed != null ? distanceToScaled(typed) : null;
  if (typedScaled == null) {
    if (params.allowMissingDistance) {
      // Zero, not the old amount: a mileage line's amount is DERIVED, and carrying
      // the previous typed figure over would show a number no rate produced.
      return { amountMinor: 0n, mileage: CLEARED_MILEAGE };
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A mileage line needs a distance.' });
  }
  const expense = await db.expense.findUnique({
    where: { id: params.expenseId },
    select: { date: true, ownerId: true, owner: { select: { country: true } } },
  });
  // VeloExpense: `app_user.country` since 0055 (w2-10), backfilled from the person's legal
  // entity and theirs to change on the employee screen.
  const country = expense?.owner.country;
  if (!expense || !country) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No country on the traveller — cannot resolve a mileage rate.',
    });
  }
  // VeloExpense: `txn_date` is nullable (a blank expense may have none yet).
  if (!expense.date) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The expense needs a date before a mileage rate can be resolved.',
    });
  }
  const rule = await resolveMileageRule(db, country, expense.ownerId, expense.date);
  if (!rule) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `No mileage rate in force for ${country} on this date.`,
    });
  }

  // The distance may have been entered in the other unit; the rule's unit is
  // what the bands and rates are denominated in.
  const enteredUnit = params.mileageUnit ?? rule.unit;
  const distanceScaled = convertScaled(typedScaled, enteredUnit, rule.unit);
  const ytdScaled = await ytdDistanceScaled(db, {
    userId: expense.ownerId,
    country,
    on: expense.date,
    unit: rule.unit,
    excludeLineItemId: params.lineItemId,
  });
  const priced = priceMileage(rule.tiers, ytdScaled, distanceScaled);

  return {
    amountMinor: priced.amountMinor,
    mileage: {
      // Stored in the RULE's unit so the snapshot and the bands agree.
      mileageDistance: scaledToDecimalString(distanceScaled),
      mileageUnit: rule.unit,
      mileageRateId: rule.id,
      mileageYtdBefore: scaledToDecimalString(ytdScaled),
      mileageBreakdown: priced.segments as unknown as Prisma.InputJsonValue,
      // JsonNull, not null: `null` on a nullable Json column is ambiguous in
      // Prisma and it refuses it outright.
      mileageRoute:
        params.mileageRoute == null
          ? Prisma.JsonNull
          : (params.mileageRoute as Prisma.InputJsonValue),
      mileageDistanceOverride:
        params.mileageDistanceOverride != null
          ? scaledToDecimalString(convertScaled(typedScaled, enteredUnit, rule.unit))
          : null,
    },
  };
}

/** What `resolveMileageForLine` hands back: the derived amount plus the FULL set of
 *  mileage columns to persist.
 *
 *  Every column, always — never a partial object and never null. `mileage: null`
 *  used to mean "not a mileage line", and the caller spread `...(fin.mileage ?? {})`,
 *  which spreads NOTHING. So switching a line out of a mileage category left its
 *  distance, unit, rate, YTD basis, breakdown and route sitting on a line that is no
 *  longer mileage — residue that the docstring above already promised was cleared.
 *  Writing an explicit set of nulls is what makes that promise true. */
interface MileageColumns {
  mileageDistance: string | null;
  mileageUnit: 'KM' | 'MI' | null;
  mileageRateId: string | null;
  mileageYtdBefore: string | null;
  /// Json columns: Prisma refuses a bare `null` as ambiguous, so clearing one is
  /// `Prisma.JsonNull`.
  mileageBreakdown: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  mileageRoute: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  mileageDistanceOverride: string | null;
}

const CLEARED_MILEAGE: MileageColumns = {
  mileageDistance: null,
  mileageUnit: null,
  mileageRateId: null,
  mileageYtdBefore: null,
  mileageBreakdown: Prisma.JsonNull,
  mileageRoute: Prisma.JsonNull,
  mileageDistanceOverride: null,
};

interface MileagePricing {
  amountMinor: bigint;
  mileage: MileageColumns;
}

const scaledToDecimalString = (v: bigint): string =>
  `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;

/**
 * VeloExpense: ExpenseOS's include, less what VeloExpense does not hold yet —
 *   · `currency` is keyed by its ISO code and has no symbol column: `code` is read, and
 *     `serializeExpense` puts back ExpenseOS's `{ id, code, symbol }` (id = the code, the
 *     symbol from `currencySymbol`);
 *   · an allocation has no class and no NetSuite business unit (no NetSuite position);
 *   · a receipt has no `extraction` row until extraction is ported (Wave 3), and only a
 *     STORED receipt is read (see `receipts` below).
 */
const EXPENSE_DETAIL_INCLUDE = {
  currency: { select: { code: true } },
  lineItems: {
    orderBy: { createdAt: 'asc' },
    include: {
      category: {
        select: {
          id: true,
          label: true,
          icon: true,
          color: true,
          requiresAttendees: true,
          isMileage: true,
          // Which line-kind strategy the row offers is decided from this, so the row that
          // renders a saved line needs it as much as the category picker does.
          acceptsTip: true,
        },
      },
    },
  },
  attendees: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, company: true, isExternal: true },
  },
  allocations: {
    orderBy: { createdAt: 'asc' },
    include: {
      businessUnit: { select: { id: true, label: true } },
      department: { select: { id: true, label: true } },
    },
  },
  receipts: {
    // VeloExpense: only a receipt whose object has been verified in storage — a PENDING row
    // from the receipt drawer's two-phase upload may name an object that was never PUT.
    where: { status: 'STORED' },
    orderBy: { uploadedAt: 'desc' },
  },
} satisfies Prisma.ExpenseInclude;

type ExpenseWithDetail = Prisma.ExpenseGetPayload<{ include: typeof EXPENSE_DETAIL_INCLUDE }>;

/** Serialize an Expense (loaded with EXPENSE_DETAIL_INCLUDE) to the wire shape
 *  the workbench + inbox panes consume — bigints stringified, receipts signed.
 *  `pickerNsBusinessUnits` is `pickerNsBusinessUnitIds`' answer for the batch;
 *  `businessUnitSource` is the switch position the caller already read for the request.
 *
 *  VeloExpense: there is no NetSuite position, so neither argument exists — the
 *  NetSuite-only fields go out as ExpenseOS sends them under EXPENSEOS (null), as do the
 *  class fields VeloExpense does not have, so the workbench reads the same shape. */
async function serializeExpense(e: ExpenseWithDetail) {
  return {
    id: e.id,
    merchant: e.merchant,
    placeText: e.placeText,
    date: e.date,
    purpose: e.purpose,
    explanation: e.explanation,
    attendees: e.attendees,
    paymentMethod: e.paymentMethod,
    amountMinor: e.amountMinor.toString(),
    subtotalMinor: e.subtotalMinor?.toString() ?? null,
    // Tax is on the expense now (a receipt = one tax total); recoverable is
    // engine-derived across the line categories.
    taxGstHstMinor: e.taxGstHstMinor?.toString() ?? null,
    taxQstMinor: e.taxQstMinor?.toString() ?? null,
    taxPstMinor: e.taxPstMinor?.toString() ?? null,
    recoverableGstHstMinor: e.recoverableGstHstMinor?.toString() ?? null,
    recoverableQstMinor: e.recoverableQstMinor?.toString() ?? null,
    taxSource: e.taxSource,
    taxJurisdictionId: e.taxJurisdictionId,
    currencyId: e.currencyId,
    // VeloExpense: ExpenseOS's `{ id, code, symbol }` (see EXPENSE_DETAIL_INCLUDE).
    currency: { id: e.currency.code, code: e.currency.code, symbol: currencySymbol(e.currency.code) },
    // Conversion as applied (rule 3). The employee is paid `homeAmountMinor` in
    // `homeCurrency`; a null rate on a foreign expense means no rate was found,
    // which the UI has to say out loud rather than showing a converted figure.
    fxRate: e.fxRate?.toString() ?? null,
    fxRateSource: e.fxRateSource,
    homeCurrency: e.homeCurrency,
    homeAmountMinor: e.homeAmountMinor?.toString() ?? null,
    // Tax lives on the expense, not the line. But the line's KIND and PAYLOAD have to travel:
    // a tip is stored in the payload of a STANDARD_WITH_TIP line, and `tipMinorOf` reads both.
    // Dropping them here is what left the tip field blank on a line the extractor had correctly
    // filled in — the value was in the database and simply never reached the browser.
    lineItems: e.lineItems.map((li) => ({
      id: li.id,
      categoryId: li.categoryId,
      category: li.category,
      kind: li.kind,
      payload: li.payload,
      amountMinor: li.amountMinor.toString(),
      mileageDistance: li.mileageDistance?.toString() ?? null,
      // VeloExpense: `mileage_unit` is text under a CHECK (KM, MI); ExpenseOS's is an enum.
      mileageUnit: li.mileageUnit as 'KM' | 'MI' | null,
      mileageYtdBefore: li.mileageYtdBefore?.toString() ?? null,
      mileageBreakdown: li.mileageBreakdown,
      mileageRoute: li.mileageRoute,
      notes: li.notes,
    })),
    // Cost allocation across BU/Department/Class (0 = unallocated, 1 = single,
    // N = split). Labels resolved for display.
    allocations: e.allocations.map((a) => ({
      id: a.id,
      percentBp: a.percentBp,
      businessUnitId: a.businessUnitId,
      businessUnit: a.businessUnit,
      // VeloExpense: always null — ExpenseOS's answer under EXPENSEOS; the lines then name
      // the admin `businessUnit`, localised on the client exactly as before.
      nsBusinessUnitLabel: null,
      // VeloExpense: always null, as under ExpenseOS's EXPENSEOS source.
      pickerNsBusinessUnitId: null,
      departmentId: a.departmentId,
      department: a.department,
      // VeloExpense: no class.
      classId: null,
      // VeloExpense: typed as ExpenseOS's class (`{ id, name }`), which the lines read.
      class: null as { id: string; name: string } | null,
    })),
    receipts: await Promise.all(
      e.receipts.map(async (r) => ({
        id: r.id,
        filename: r.filename,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        uploadedAt: r.uploadedAt,
        // What the determination decided this document IS (rule 2) — the reason a
        // reviewer can see why the tip came from one file and the tax from another.
        kind: r.kind,
        // 1-hour TTL: the workbench keeps a receipt's presigned URL for the
        // session (switching between expenses reuses it); the 5-min default
        // expired mid-session and broke the viewer on revisit.
        // VeloExpense: VeloExpense's storage, inline (no filename), at ExpenseOS's TTL (d30).
        url: await getStorage().presignDownload(r.s3Key, undefined, { expiresInSeconds: 3600 }),
        // VeloExpense: no reading until extraction is ported (Wave 3). Typed as ExpenseOS's
        // mapped reading (`ReceiptReading`), which is what the workbench reads it as.
        extraction: null as ReceiptReading | null,
      })),
    ),
  };
}

/**
 * VeloExpense: the report's policy violations, in ExpenseOS's `PolicyViolation` shape —
 * what ExpenseOS loads with `include: { violations: true }`.
 *
 * VeloExpense's `policy_violation` is its own engine's table until the policy port: it
 * anchors a finding to the report or to a line, not to an expense, so `expenseId` is the
 * line's expense (null for a report-level finding) — what the workbench groups by.
 * `resolvedBy` is VeloExpense's `resolved_by_id`. Parameterised; under the caller's RLS.
 */
async function reportViolations(db: TenantDb, reportId: string, userId?: string) {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      reportId: string;
      expenseId: string | null;
      lineItemId: string | null;
      ruleCode: string;
      severity: 'INFO' | 'WARNING' | 'BLOCK';
      message: string;
      messageCode: string | null;
      data: unknown;
      resolvedAt: Date | null;
      resolvedBy: string | null;
      resolveNote: string | null;
      createdAt: Date;
    }>
  >`
    SELECT v.id, v.report_id AS "reportId", COALESCE(li.expense_id, ex.id) AS "expenseId",
           v.line_item_id AS "lineItemId", v.rule_code AS "ruleCode",
           v.severity::text AS severity, v.message, v.message_code AS "messageCode", v.data,
           v.resolved_at AS "resolvedAt", v.resolved_by_id AS "resolvedBy",
           v.resolve_note AS "resolveNote", v.created_at AS "createdAt"
      FROM policy_violation v
      LEFT JOIN expense_line_item li ON li.id = v.line_item_id
      -- w2-02b: a finding about one EXPENSE (a missing receipt) has no line; the engine names
      -- its expense in "data.expenseId" (and "finding_key"). Without this it read as a
      -- finding about the whole report, and the workbench showed it on no expense.
      LEFT JOIN expense ex
             ON v.line_item_id IS NULL AND ex.report_id = v.report_id
            AND ex.id::text = v.data->>'expenseId'
     WHERE v.report_id = ${reportId}::uuid
     ORDER BY v.created_at, v.id`;
  // w2-02b: the sentence is the READER's (VX4-7 part 2b), as the report page before the
  // workbench rendered it — from the finding's code and numbers, in the reader's locale, and
  // the frozen English only for a row without a code. The workbench shows `message` as the
  // label when ExpenseOS's catalogue has none for it, which is every VeloExpense finding.
  const locale = userId ? (await loadReaderPrefs(queryRunnerOf(db), userId)).locale : null;
  return rows.map(({ messageCode, ...v }) => ({
    ...v,
    message: locale
      ? renderViolation(
          { message_code: messageCode, message: v.message, data: (v.data ?? {}) as never },
          locale,
        )
      : v.message,
  }));
}

/**
 * VeloExpense: ExpenseOS's `validateReport` result — `{ violations, counts }`, with its
 * `unjustifiedWarning` — from VeloExpense's policy pass (`lib/policy/service.ts`), which
 * stays VeloExpense's until the policy engine is ported. Each finding in ExpenseOS's
 * `Violation` shape.
 */
function validationResultOf(summary: ValidationSummary) {
  return {
    violations: summary.violations.map((v) => ({
      ruleCode: v.rule_code as string,
      severity: v.severity,
      message: v.message,
      lineItemId: v.line_item_id,
      data: v.data,
    })),
    counts: {
      info: summary.counts.INFO,
      warning: summary.counts.WARNING,
      block: summary.counts.BLOCK,
      unjustifiedWarning: summary.unjustifiedWarning,
    },
  };
}

/** VeloExpense: ExpenseOS's `validateReport({ db, reportId, … })`, on VeloExpense's policy
 *  pass in the procedure's own transaction. */
async function runPolicy(db: TenantDb, reportId: string) {
  return validationResultOf(await validateReportPolicy(queryRunnerOf(db), reportId));
}

/**
 * VeloExpense: the report's ledger-posting state — what ExpenseOS's `netsuiteState`
 * answers off its NetSuite sync row, read off VeloExpense's vendor-neutral
 * `integration_post`, in the vocabulary of `POSTED_SYNC_STATUSES` (a claimed PENDING row
 * is PROCESSING). Null when nothing was ever queued. ExpenseOS's `payStatus`, `warnings`
 * and deep link are NetSuite's and have no VeloExpense source.
 */
async function postingStateOf(db: TenantDb, reportId: string) {
  const rows = await db.$queryRaw<
    Array<{
      status: string;
      claimed: boolean;
      attempts: number;
      lastError: string | null;
      externalId: string | null;
      postedAt: Date | null;
    }>
  >`
    SELECT status, claimed_at IS NOT NULL AS claimed, attempts, last_error AS "lastError",
           external_id AS "externalId", posted_at AS "postedAt"
      FROM integration_post WHERE report_id = ${reportId}::uuid`;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status === 'PENDING' && row.claimed ? 'PROCESSING' : row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    externalId: row.externalId,
    postedAt: row.postedAt,
  };
}

/**
 * VeloExpense (f09): refuse a business unit or department an allocation may not be coded
 * to — one that does not exist in this tenant, or that an administrator has DEACTIVATED —
 * before anything is written. ExpenseOS checks neither on this path: a missing id fails at
 * the foreign key as a server error, and a deactivated one saves.
 *
 * A deactivated one the expense ALREADY carries is kept. `allocationSet` replaces the whole
 * set on every save, so refusing it would stop the owner editing any other row of an
 * expense coded before the deactivation — the same reason ExpenseOS keeps a row coded
 * under its other business unit source as sent.
 */
async function assertAllocationDimensionsUsable(
  db: TenantDb,
  expenseId: string,
  rows: ReadonlyArray<{ businessUnitId?: string | null; departmentId?: string | null }>,
): Promise<void> {
  const ids = (key: 'businessUnitId' | 'departmentId') => [
    ...new Set(rows.flatMap((r) => (r[key] ? [r[key] as string] : []))),
  ];
  const businessUnitIds = ids('businessUnitId');
  const departmentIds = ids('departmentId');
  if (businessUnitIds.length === 0 && departmentIds.length === 0) return;
  const [current, businessUnits, departments] = await Promise.all([
    db.expenseAllocation.findMany({
      where: { expenseId },
      select: { businessUnitId: true, departmentId: true },
    }),
    db.businessUnit.findMany({
      where: { id: { in: businessUnitIds } },
      select: { id: true, active: true },
    }),
    db.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, active: true } }),
  ]);
  const usable = (
    wanted: string[],
    found: Array<{ id: string; active: boolean }>,
    kept: Set<string | null>,
  ) => {
    const byId = new Map(found.map((f) => [f.id, f.active]));
    return wanted.every((id) => byId.has(id) && (byId.get(id) || kept.has(id)));
  };
  if (
    !usable(businessUnitIds, businessUnits, new Set(current.map((a) => a.businessUnitId))) ||
    !usable(departmentIds, departments, new Set(current.map((a) => a.departmentId)))
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A Business Unit or Department on this allocation is no longer available.',
    });
  }
}

/**
 * The filer's default coding for expenses about to be created, and the business unit
 * source it was resolved for — the pair `allocationCreateFor` and the receipt-intake
 * functions take. The source is read off the stored NetSuite config (no config →
 * `EXPENSEOS`); `codingDefaultsFor` owns the rule. Shared by the three creation paths here
 * so they cannot drift; the inbound-email worker resolves the same pair itself.
 */
async function filerCodingOf(
  db: import('@expenseos/db').PrismaClient,
  filer: CodingDefaultsUser | null,
): Promise<{
  coding: Awaited<ReturnType<typeof codingDefaultsFor>>;
  businessUnitSource: BusinessUnitSource;
}> {
  // VeloExpense: always ExpenseOS's EXPENSEOS position — there is no NetSuite config to
  // read (see @expenseos/db's businessUnitSource).
  const businessUnitSource: BusinessUnitSource = 'EXPENSEOS';
  return { coding: await codingDefaultsFor(db, filer, businessUnitSource), businessUnitSource };
}

/**
 * May this caller read this report?
 *
 * The submitter (their own report), an admin, an AP reimburser, or an eligible approver with
 * a PENDING task — mirroring `expenseApprovals.report` so the workbench serves the approver
 * too. One definition, used by every read that hangs off a report: a second one would
 * eventually disagree with this one, and the disagreement would be a disclosure.
 */
async function callerCanReadReport(
  ctx: {
    db: import('@expenseos/db').PrismaClient;
    rbac: { id: string; permissions: readonly string[] };
  },
  report: { id: string; submitterId: string },
): Promise<boolean> {
  const perms = ctx.rbac.permissions;
  const isAdmin = perms.includes(P.expense.report.readAll);
  return (
    (report.submitterId === ctx.rbac.id && perms.includes(P.expense.report.readOwn)) ||
    isAdmin ||
    perms.includes(P.expense.report.reimburse) ||
    (await callerCanDecideReport(ctx.db, report.id, ctx.rbac.id, isAdmin))
  );
}


/**
 * VeloExpense: "who is this report sitting with", from VeloExpense's approval tables.
 *
 * ExpenseOS reads its own engine (`ExpenseReport.approvalInstanceId` → the first PENDING
 * `ApprovalTask`'s assignee). VeloExpense's engine is still its own until Wave 4: a report
 * out for approval has one RUNNING `approval_request`, whose tasks carry the assignee. The
 * rule is ExpenseOS's — the first pending task wins, and a pool task nobody has claimed
 * names nobody — and the shape is the one ExpenseOS's list returns, with VeloExpense's one
 * display name in `firstName` (VeloExpense has no first/last split).
 */
async function pendingApproverByReport(
  db: TenantDb,
  reportIds: readonly string[],
): Promise<Map<string, { firstName: string | null; lastName: string | null; email: string } | null>> {
  const out = new Map<string, { firstName: string | null; lastName: string | null; email: string } | null>();
  if (reportIds.length === 0) return out;
  const rows = await db.$queryRaw<
    { report_id: string; display_name: string | null; email: string | null }[]
  >`
    SELECT DISTINCT ON (r.report_id)
           r.report_id::text AS report_id,
           u.display_name,
           COALESCE(u.email, t.assignee_email) AS email
      FROM approval_request r
      JOIN approval_task t ON t.request_id = r.id AND t.status = 'PENDING'
      LEFT JOIN app_user u ON u.id = t.assignee_id
     WHERE r.status = 'RUNNING'
       AND r.report_id = ANY(${[...reportIds]}::uuid[])
     ORDER BY r.report_id, t.created_at ASC, t.step ASC`;
  for (const row of rows) {
    out.set(
      row.report_id,
      row.email ? { firstName: row.display_name, lastName: null, email: row.email } : null,
    );
  }
  return out;
}

/**
 * VeloExpense: the next report number (`EXP-000042`), from the organization's sequence.
 *
 * ExpenseOS mints it from a global Postgres sequence in the column default. VeloExpense's
 * numbers are per tenant and have always come from `organization.expense_report_seq`,
 * taken under the organization row's lock so two concurrent creates cannot draw the same
 * one (lib/expenses/service.ts `createReport`, which this mirrors).
 */
/**
 * VeloExpense: ExpenseOS's job queue (`@expenseos/jobs`) carries the receipt-reading jobs —
 * the malware scan and extraction (`expense.extractReceipt`) and the joint determination
 * (`expense.determineExpense`). Both arrive with extraction (Wave 3); until then there is no
 * worker to hand them to, so the ported calls come here and nothing is queued.
 */
async function enqueue(job: string, payload: Record<string, unknown>): Promise<void> {
  void job;
  void payload;
}

/**
 * VeloExpense: the tenant this transaction runs as — the same `app.current_org` RLS scopes
 * every row by — for a receipt key's tenant prefix (`receiptKey`, `receiptPrefix`).
 */
async function tenantIdOf(db: TenantDb): Promise<string> {
  const [org] = await db.$queryRaw<{ id: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_org', true), '') AS id`;
  if (!org?.id) throw new TRPCError({ code: 'FORBIDDEN', message: 'No tenant context' });
  return org.id;
}

/** VeloExpense: the tenant's slug, for a link on the tenant's own origin (`reportUrl`). */
async function tenantSlugOf(db: TenantDb): Promise<string | null> {
  const [org] = await db.$queryRaw<{ slug: string }[]>`
    SELECT slug FROM organization
     WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`;
  return org?.slug ?? null;
}

/**
 * VeloExpense: the plan's yearly expense cap, checked on the procedure's own transaction
 * (`queryRunnerOf`) as VeloExpense's own writer checks it, for `adding` new expenses — and a
 * cap reached is a translatable refusal (`refusals.billing.expenseLimitReached`).
 */
async function assertExpenseCap(db: TenantDb, adding = 1): Promise<void> {
  await assertExpenseAllowance(queryRunnerOf(db), adding).catch((err: unknown) => {
    if (err instanceof CapReachedError) {
      throw refusal(
        'FORBIDDEN',
        REFUSAL_KEYS.expenseLimitReached,
        `This organization's plan allows ${err.limit} expenses a year, and that many have been added in the last twelve months.`,
        { limit: err.limit },
      );
    }
    throw err;
  });
}

async function mintReportNumber(db: TenantDb): Promise<string> {
  const [org] = await db.$queryRaw<{ id: string; seq: bigint }[]>`
    SELECT id::text AS id, expense_report_seq AS seq
      FROM organization
     WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid
       FOR UPDATE`;
  if (!org) throw new TRPCError({ code: 'FORBIDDEN', message: 'No tenant context' });
  const next = BigInt(org.seq) + 1n;
  await db.$executeRaw`UPDATE organization SET expense_report_seq = ${next} WHERE id = ${org.id}::uuid`;
  return `EXP-${next.toString().padStart(6, '0')}`;
}

export const expensesRouter = router({
  /** List expense reports visible to the current user. */
  list: withPermission(P.expense.report.readOwn)
    .input(
      z
        .object({
          status: z.enum(ExpenseReportStatus).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        submitterId: ctx.session.user.id,
        ...(input?.status ? { status: input.status } : {}),
      };
      const rows = await ctx.db.expenseReport.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: input?.limit ?? 50,
        include: {
          currency: { select: { code: true } },
          _count: { select: { expenses: true } },
        },
      });

      // "Who is my report sitting with?" — a submitted report shows only
      // "Submitted", which tells the submitter nothing about whether it's
      // stuck or with whom. Resolve the current pending approver per report in
      // one query rather than N.
      // VeloExpense: from VeloExpense's approval tables (`pendingApproverByReport`); first
      // pending task wins, as below in ExpenseOS.
      const pendingByReport = await pendingApproverByReport(
        ctx.db,
        rows.filter((r) => r.status === 'SUBMITTED').map((r) => r.id),
      );

      /**
       * Each report's total, also expressed in the READER's own currency.
       *
       * The list used to add these up raw: "Total open" summed `totalMinor` across every
       * submitted and approved report and printed one `$` in front of it. Adding USD cents
       * to CAD cents is the same error `reportTotal.ts` warns about ("¥1,000 is not
       * $10.00") — and because CAD and USD share the `$` glyph, nothing on screen gave the
       * reader a hint that two different currencies had been added together (GA readiness
       * report F54, and the list half of F52).
       *
       * `null` when no rate connects the pair in either direction. The client leaves those
       * reports OUT of the summed balance and says how many it left out, rather than
       * quietly understating it — the same rule `buildReportRollup` follows for a report.
       */
      const homeCurrency = await readerCurrencyCode(ctx.db, ctx.session.user.id);
      /**
       * Built from each report's OWN expenses, not from its stored total converted once.
       * The row and the report it links to have to be the same number, and the report now
       * rolls up at the reader's currency so that each expense keeps the rate it was filed
       * at (GA-3). Converting the stored total here would put the old disagreement back,
       * one screen over.
       */
      const readerTotals = await readerTotalsFor(
        ctx.db,
        homeCurrency,
        rows.map((r) => ({ id: r.id, totalMinor: r.totalMinor, currencyCode: r.currency.code })),
      );

      return rows.map((r) => ({
        ...r,
        // VeloExpense: ExpenseOS's `currency` row carries its symbol; this one is the
        // platform's (`currencySymbol`).
        currency: { code: r.currency.code, symbol: currencySymbol(r.currency.code) },
        totalMinor: r.totalMinor.toString(),
        /** The reader's own currency, so the client can label what it is summing. */
        homeCurrency,
        /** `totalMinor` converted into `homeCurrency`, or null when no rate connects them. */
        homeTotalMinor: readerTotals.get(r.id)?.totalMinor ?? null,
        /** Expenses this currency cannot value, disclosed rather than dropped. */
        homeExcluded: readerTotals.get(r.id)?.excluded ?? 0,
        expenseCount: r._count.expenses,
        /** Current approver while the report is out for approval. Null when it
         *  isn't pending, or when the task is an unclaimed filter-pool one. */
        pendingWith: pendingByReport.get(r.id) ?? null,
      }));
    }),

  /**
   * "My reports" as an AGGREGATE — the count and the money for the whole set, not rows.
   *
   * `list` is capped (50 by default, 100 at most), so a count derived from what it
   * returned is a count of what fit, not a count of what exists: a header reading "50"
   * over a person with 63 reports is wrong by construction and no client-side arithmetic
   * recovers the missing 13. That is the whole reason this procedure exists. It is
   * deliberately NOT a paginated `list` variant — it reads three numbers out of Postgres
   * and never materialises a row.
   *
   * Same gate as `list` — `withPermission(P.expense.report.readOwn)` — and the same
   * `submitterId` filter. The wrapper is the capability check ("may this role read
   * expense reports at all"); scoping to MINE belongs in the `where` clause, and the two
   * are not interchangeable.
   *
   * `status` mirrors `list`'s filter so a caller that renders a filtered list can ask for
   * the matching header without a second contract to keep in step.
   */
  summaryOwn: withPermission(P.expense.report.readOwn)
    .input(z.object({ status: z.enum(ExpenseReportStatus).optional() }).optional())
    .query(async ({ ctx, input }) => {
      /**
       * `groupBy` takes SCALARS, so it groups on `currencyId` and the ISO code is looked
       * up after — `currency.code` is a relation field and would not compile.
       */
      const groups = await ctx.db.expenseReport.groupBy({
        by: ['currencyId'],
        where: {
          submitterId: ctx.session.user.id,
          ...(input?.status ? { status: input.status } : {}),
        },
        _count: { _all: true },
        _sum: { totalMinor: true },
      });
      // VeloExpense: `currencyId` IS the ISO code, and the symbol is the platform's.
      const currencies = groups.length
        ? (
            await ctx.db.currency.findMany({
              where: { code: { in: groups.map((g) => g.currencyId) } },
              select: { code: true },
            })
          ).map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) }))
        : [];
      const currencyById = new Map(currencies.map((c) => [c.id, c]));

      const homeCurrency = await readerCurrencyCode(ctx.db, ctx.session.user.id);
      const inHomeCurrency = await homeConverterFor(
        ctx.db,
        homeCurrency,
        currencies.map((c) => c.code),
      );
      const rollup = buildHomeRollup(
        groups.flatMap<CurrencyGroup>((g) => {
          const currency = currencyById.get(g.currencyId);
          // `currencyId` is a Restrict FK, so the lookup cannot miss. Dropping the group
          // rather than inventing a code keeps `count` and `byCurrency` agreeing if it
          // ever does.
          return currency
            ? [
                {
                  code: currency.code,
                  symbol: currency.symbol,
                  count: g._count._all,
                  // `?? 0n` is SUM over an empty set, not the forbidden "an amount we
                  // could not convert is zero" — a group exists only because it has rows.
                  totalMinor: g._sum.totalMinor ?? 0n,
                },
              ]
            : [];
        }),
        inHomeCurrency,
      );

      return {
        homeCurrency,
        /** Every report matching the filter. Derived from the same groups the money is,
         *  so the header count and the currency breakdown can never disagree. */
        count: rollup.byCurrency.reduce((n, c) => n + c.count, 0),
        ...rollup,
      };
    }),

  /** Create a new draft expense report. */
  create: withPermission(P.expense.report.createOwn)
    .input(
      z.object({
        title: z.string().min(1).max(200),
        /** Either a Currency UUID or an ISO-4217 code. The router
         *  resolves to the FK so the client can keep using "USD"
         *  while we move callers off the legacy String column. */
        currency: z.string().min(3).default('USD'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Accept both the new FK shape (UUID) and the legacy code.
      // VeloExpense: a currency's key IS its code, so there is no uuid to accept — a uuid
      // names nothing and is refused as an unknown currency, as ExpenseOS refuses one that
      // does not exist.
      const currencyRow = await ctx.db.currency.findUnique({
        where: { code: input.currency.toUpperCase() },
        select: { code: true },
      });
      if (!currencyRow) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown currency' });
      }
      const row = await ctx.db.expenseReport.create({
        data: {
          // VeloExpense: the number is minted here (`mintReportNumber`), not by a column default.
          number: await mintReportNumber(ctx.db),
          title: input.title,
          currencyId: currencyRow.code,
          submitterId: ctx.session.user.id,
        },
      });
      return { ...row, totalMinor: row.totalMinor.toString() };
    }),

  /** Active BU / Department / Class options for the allocation pickers. Any
   *  expense editor may read them (not the admin-gated lookup lists).
   *
   *  The business unit list depends on the business unit source, read from the stored
   *  NetSuite config on EVERY call and returned beside the list — this is the only way the
   *  client learns the switch position (NFR-16). `EXPENSEOS`: the admin business units,
   *  exactly as before. `NETSUITE`: the active NetSuite business unit mirror rows. Their
   *  `parentId` is a NetSuite internal id, so `netsuiteId` travels too for the client to
   *  resolve it against.
   *
   *  VeloExpense: always ExpenseOS's EXPENSEOS answer — there is no NetSuite position — and
   *  no classes (VeloExpense has none), sent as an empty list so the client's shape holds. */
  dimensionOptions: withPermission(P.expense.report.readOwn).query(async ({ ctx }) => {
    const businessUnitSource: BusinessUnitSource = 'EXPENSEOS';
    const departments = await ctx.db.department.findMany({
      where: { active: true },
      select: { id: true, label: true },
    });
    const classes: Array<{ id: string; name: string }> = [];
    const businessUnits = await ctx.db.businessUnit.findMany({
      where: { active: true },
      select: { id: true, label: true },
    });
    return { businessUnitSource, businessUnits, departments, classes };
  }),

  /** Replace an expense's cost-allocation rows. 0 rows = unallocated; otherwise
   *  the rows' percentBp must total exactly 10000 (100%). Draft/unfiled + owner
   *  gated; audited.
   *
   *  VeloExpense: no NetSuite business unit and no class — a row is a business unit and a
   *  department (`nsBusinessUnitId` and `classId` are not accepted). And a business unit or
   *  department must exist and be ACTIVE, unless the expense already carries it (f09):
   *  ExpenseOS checks neither here. */
  allocationSet: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        allocations: z
          .array(
            z.object({
              percentBp: z.number().int().min(1).max(10000),
              businessUnitId: z.string().uuid().nullish(),
              departmentId: z.string().uuid().nullish(),
            }),
          )
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertExpenseDraft(ctx, input.expenseId);
      const sum = input.allocations.reduce((a, r) => a + r.percentBp, 0);
      if (input.allocations.length > 0 && sum !== 10000) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Allocation percentages must total 100%.',
        });
      }
      // Business Unit + Department are required per row.
      // VeloExpense: "has a business unit" is the admin column — ExpenseOS's rule under its
      // EXPENSEOS source; there is no class to leave nullable.
      if (input.allocations.some((r) => !r.businessUnitId || !r.departmentId)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Each allocation needs a Business Unit and Department.',
        });
      }
      await assertAllocationDimensionsUsable(ctx.db, input.expenseId, input.allocations);
      const businessUnitSource: BusinessUnitSource = 'EXPENSEOS';
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'Expense',
          entityId: input.expenseId,
          actor: actorOf(ctx),
          details: { allocations: input.allocations.length, businessUnitSource },
        },
        async (tx) => {
          await tx.expenseAllocation.deleteMany({ where: { expenseId: input.expenseId } });
          if (input.allocations.length > 0) {
            await tx.expenseAllocation.createMany({
              data: input.allocations.map((r) => ({
                expenseId: input.expenseId,
                percentBp: r.percentBp,
                businessUnitId: r.businessUnitId ?? null,
                departmentId: r.departmentId ?? null,
              })),
            });
          }
        },
      );
      return { ok: true as const };
    }),

  /** Delete a DRAFT report (cascades expenses → line items → receipts).
   *  Best-effort deletes the receipts' S3 objects. Owner-guarded, DRAFT-only. */
  deleteReport: withPermission(P.expense.report.deleteDraft)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { submitterId: true, status: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (report.status !== 'DRAFT') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only DRAFT reports can be deleted.' });
      }
      // Collect the S3 keys before the cascade removes the Receipt rows.
      const receipts = await ctx.db.receipt.findMany({
        where: { expense: { reportId: input.reportId } },
        select: { s3Key: true },
      });
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.delete,
          entityType: 'ExpenseReport',
          entityId: input.reportId,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => tx.expenseReport.delete({ where: { id: input.reportId } }),
      );
      // VeloExpense: VeloExpense's storage (`getStorage`), ExpenseOS's best-effort rule.
      const storage = getStorage();
      await Promise.all(receipts.map((r) => storage.delete(r.s3Key).catch(() => undefined)));
      return { ok: true as const };
    }),

  /** Run the policy engine for the given report. Idempotent —
   *  rewrites the `PolicyViolation` rows for the report wholesale
   *  on each call. Front-end calls this on debounced edits to
   *  power the inline warnings panel.
   *
   *  VeloExpense: VeloExpense's policy pass (`runPolicy`), which reconciles the stored
   *  findings rather than rewriting them, until the policy engine is ported. */
  validate: withPermission(P.expense.report.readOwn)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Guard: only the submitter (or an approver, but Phase 2 has
      // no approver-side editor yet) can validate their report.
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { submitterId: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      return runPolicy(ctx.db, input.reportId);
    }),

  /** Attach a justification comment to a WARNING/INFO policy violation on the
   *  submitter's own report — the "exception comment" that unblocks submit. A
   *  BLOCK is never justifiable (it must be fixed); a blank note clears the
   *  justification. Owner-gated (the submitter, mirroring `validate`).
   *
   *  VeloExpense: written through VeloExpense's acknowledgement (`acknowledgeViolation` /
   *  `clearAcknowledgement`), which records who and when as ExpenseOS's update does; the
   *  row comes back in the shape `report` lists violations in. */
  justifyViolation: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({ violationId: z.string().uuid(), note: z.string().trim().max(2000).nullish() }),
    )
    .mutation(async ({ ctx, input }) => {
      // VeloExpense: no Prisma model for `policy_violation`; read with SQL.
      const rows = await ctx.db.$queryRaw<
        Array<{ id: string; severity: string; reportId: string | null; submitterId: string | null }>
      >`
        SELECT v.id, v.severity::text AS severity, v.report_id AS "reportId",
               r.submitter_id AS "submitterId"
          FROM policy_violation v
          LEFT JOIN expense_report r ON r.id = v.report_id
         WHERE v.id = ${input.violationId}::uuid`;
      const v = rows[0];
      // `report` is null on a TRAVEL violation — those go through
      // `travelRequests.justifyViolation`, which gates on the travel submitter. Reading
      // it as not-found rather than crashing is what keeps the two subjects from
      // reaching into each other's justification flow.
      if (!v?.reportId || v.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (v.severity === 'BLOCK') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A blocking violation must be fixed, not justified.',
        });
      }
      const note = input.note?.trim() ? input.note.trim() : null;
      const tx = queryRunnerOf(ctx.db);
      if (note) await acknowledgeViolation(tx, input.violationId, ctx.session.user.id, note);
      else await clearAcknowledgement(tx, input.violationId);
      const after = await reportViolations(ctx.db, v.reportId);
      return after.find((row) => row.id === input.violationId) ?? null;
    }),

  // VeloExpense: ExpenseOS's `markExtractionReviewed` signs off a receipt's reading, which
  // arrives with extraction (Wave 3).

  /** Sign off on a low-confidence receipt extraction — the reviewer confirms the
   *  extracted details on the expense, clearing the verification nudge. Toggles:
   *  a second call un-reviews. Owner-gated (the report's submitter).
   *
   *  VeloExpense (w2-02b): the ownership check is ExpenseOS's; the write to the receipt's
   *  `documentExtraction` row arrives with that table (extraction, Wave 3). Until then no
   *  receipt has a reading, so the workbench never offers the sign-off this answers. */
  markExtractionReviewed: withPermission(P.expense.report.updateOwn)
    .input(z.object({ receiptId: z.string().uuid(), reviewed: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        select: {
          id: true,
          expense: { select: { ownerId: true, report: { select: { submitterId: true } } } },
        },
      });
      const uid = ctx.session.user.id;
      if (
        !receipt ||
        (receipt.expense?.ownerId !== uid && receipt.expense?.report?.submitterId !== uid)
      ) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      // VeloExpense: `documentExtraction.updateMany({ reviewedAt, reviewedBy })` — Wave 3.
      return { ok: true as const };
    }),

  /** Submit a draft report. Always re-runs validation server-side
   *  and refuses on any BLOCK violation. The submit-gate decision
   *  is intentionally server-only — FE checks are advisory.
   *
   *  VeloExpense: ExpenseOS's checks, in its order and words, then the TRANSITION through
   *  VeloExpense's lifecycle (d23, `submitThroughLifecycle`) in place of `startInstance` and
   *  the hooks after it — the lifecycle re-runs the policy pass under a lock, routes the
   *  report on VeloExpense's approval engine, notifies the approvers and writes the audit
   *  chain. Its own gates stand behind these: a lapsed subscription, and an expense with no
   *  date (VX4-11). */
  submit: withPermission(P.expense.report.createOwn)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { submitterId: true, status: true, totalMinor: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (!EDITABLE_REPORT_STATUSES.includes(report.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only DRAFT or returned reports can be submitted.',
        });
      }
      // A report can't be submitted with no expenses on it — there's nothing
      // to approve or reimburse. The FE also disables submit, but enforce it
      // here so a crafted call can't bypass it.
      const expenseCount = await ctx.db.expense.count({
        where: { reportId: input.reportId },
      });
      if (expenseCount === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Add at least one expense before submitting.',
        });
      }
      // VeloExpense: ExpenseOS waits here for every receipt still being read
      // (`reportExtractionProgress`). Nothing is read until extraction arrives (Wave 3), which
      // brings the wait with it.
      /**
       * Refuse a report carrying a line that cannot be valued in the report currency.
       *
       * `buildReportRollup` deliberately EXCLUDES an unconvertible currency rather than
       * adding it in the wrong units, which is the right arithmetic and was the wrong
       * outcome: nothing stopped the report being submitted, so an approver saw a total
       * that silently omitted the excluded lines. On EXP-000009 that was CAD 911.66 of
       * a USD 2,871.46 claim — roughly 23% — disclosed only in a hover tooltip.
       *
       * Derived reciprocals (`fxRateMapFrom`) mean this now fires only when a pair is
       * quoted in NEITHER direction, which is a genuine data gap an admin must fill.
       * The check sits before the policy pass so the blocking reason is the honest one.
       *
       * FIRST, and ahead of the zero-total check below, because it explains a total that
       * only LOOKS like zero: a report whose every line is unconvertible rolls up to a
       * home total of 0, and "this report totals zero" would be a true sentence about a
       * misleading number. The missing rate is the reason, so it is what gets said.
       */
      const rollup = await reportRollupFor(ctx.db, input.reportId);
      if (rollup && rollup.missingRates.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            `No exchange rate to ${rollup.homeCurrency} for ` +
            `${rollup.missingRates.join(', ')}. Those amounts would be left out of the ` +
            `report total, so it cannot be submitted until a rate exists.`,
        });
      }
      /**
       * No expense may carry more paid tax than its gross. `expenseTaxUpdate` refuses
       * the entry itself; this catches the other order — tax entered first, the line
       * lowered afterwards — because a submitted figure is the one that posts, and a
       * negative net line is not something an approver can see in the total.
       */
      const overTaxed = await ctx.db.expense.findMany({
        where: { reportId: input.reportId, taxSource: { not: ExpenseTaxSource.CALCULATED } },
        select: {
          merchant: true,
          amountMinor: true,
          taxGstHstMinor: true,
          taxQstMinor: true,
          taxPstMinor: true,
          currency: { select: { code: true } },
        },
      });
      for (const e of overTaxed) {
        const paid = (e.taxGstHstMinor ?? 0n) + (e.taxQstMinor ?? 0n) + (e.taxPstMinor ?? 0n);
        if (paid > e.amountMinor) {
          throw taxExceedsAmountRefusal(
            'PRECONDITION_FAILED',
            paid,
            e.amountMinor,
            e.currency.code,
            e.merchant,
          );
        }
      }
      /**
       * …and it can't be submitted for nothing either.
       *
       * The count check above passes on a report holding ONE blank expense, which is all
       * it takes: adding an expense and typing nothing enabled Submit at $0.00, and the
       * report went the whole way. EXP-000006 "test 2" sits on DEV at $0.00 with status
       * Approved — a workflow ran and somebody signed off a claim for nothing (GA
       * readiness report F08 / blocker B10).
       *
       * `totalMinor` is maintained by `recomputeReportTotal` after every line-item write,
       * so it is current here without recomputing. Reading it costs one extra column on a
       * query that was already being made.
       */
      if (report.totalMinor <= 0n) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This report totals zero. Add an amount to an expense before submitting.',
        });
      }
      // VeloExpense: ExpenseOS refuses here a report NetSuite could never accept
      // (`reportMissingCoding`, only when NetSuite is installed). VeloExpense's equivalent is
      // the lifecycle's own coding gate (UD-2): only when a ledger is connected, it refuses a
      // category with no GL account, before its policy pass.
      const result = await runPolicy(ctx.db, input.reportId);
      if (result.counts.block > 0 || result.counts.unjustifiedWarning > 0) {
        // Blocked by either a hard BLOCK or a WARNING the submitter hasn't
        // justified yet. Surface the violation list + counts so the FE can
        // render the specific blockers / warnings-needing-a-comment — the
        // TRPCError carries it via `cause`.
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Report has unresolved policy violations.',
          cause: result,
        });
      }
      // VeloExpense: the transition, on VeloExpense's lifecycle (d23) — see the doc comment.
      await submitThroughLifecycle(ctx.db, input.reportId, ctx.rbac.id);
      const row = await ctx.db.expenseReport.findUniqueOrThrow({ where: { id: input.reportId } });
      return {
        report: { ...row, totalMinor: row.totalMinor.toString() },
        violations: result.violations,
        counts: result.counts,
      };
    }),

  /**
   * Recall (withdraw) a submitted report before any decision. Submitter-only;
   * cancels the in-flight approval instance + its pending tasks and puts the report
   * back to DRAFT.
   *
   * DRAFT, not RETURNED — which is what this did, and it made the button lie. The
   * control is labelled "Recall to draft" and the report came back saying
   * "Returned", a word that in this product means an APPROVER sent it back for
   * fixes. A submitter who withdrew their own report was told somebody had
   * rejected it, and the two cases need different words because they call for
   * different reactions.
   *
   * Nothing is lost by the change: `EDITABLE_STATUSES` treats DRAFT and RETURNED
   * identically, so the report is editable and resubmittable either way, and the
   * distinct `RECALLED` activity type already records who did it.
   *
   * VeloExpense: the cancel goes through VeloExpense's lifecycle (d23,
   * `recallThroughLifecycle`), which cancels the running approval and its pending tasks,
   * notifies those approvers (RECALLED), recomputes the budgets and writes the audit chain.
   */
  recall: withPermission(P.expense.report.createOwn)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { id: true, submitterId: true, status: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (report.status !== ExpenseReportStatus.SUBMITTED) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a submitted report can be recalled.',
        });
      }
      // VeloExpense: the transition, on VeloExpense's lifecycle (d23) — see the doc comment.
      const updated = await recallThroughLifecycle(ctx.db, report.id, ctx.rbac.id);
      return { id: updated.id as string, status: updated.status as ExpenseReportStatus };
    }),

  categories: withPermission(P.expense.report.readOwn).query(async ({ ctx }) => {
    return ctx.db.expenseCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      // `acceptsTip` rides along with `isMileage`: together they are what selects a
      // line row's kind STRATEGY (see _workbench/lineKinds.tsx).
      select: {
        id: true,
        label: true,
        icon: true,
        color: true,
        isMileage: true,
        acceptsTip: true,
      },
    });
  }),

  /** Employee search for the attendee picker — any report editor may call it.
   *  Returns a small matching set with id + display name + email only (no
   *  sensitive fields); external attendees are entered free-text client-side.
   *
   *  VeloExpense: a person has one display name (`name`), not a first and last name, so the
   *  search and the ordering read it where ExpenseOS reads the two. */
  attendeeDirectory: withPermission(P.expense.report.updateOwn)
    .input(z.object({ query: z.string().trim().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const q = input.query;
      const users = await ctx.db.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        take: 10,
        select: { id: true, name: true, email: true },
      });
      return users.map((u) => ({
        id: u.id,
        name: u.name || u.email,
        email: u.email,
      }));
    }),

  /** Active currencies for the report-create picker. */
  currencies: withPermission(P.expense.report.readOwn).query(async ({ ctx }) => {
    // VeloExpense: the shared `currency` table has no `active` flag, symbol or localized
    // label — every row is offered, the id is the code, the symbol is the platform's and
    // the label is the English name in ExpenseOS's `{ en }` shape.
    const rows = await ctx.db.currency.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true },
    });
    return rows.map((c) => ({
      id: c.code,
      code: c.code,
      symbol: currencySymbol(c.code),
      label: { en: c.name },
    }));
  }),

  /** Patch a DRAFT report's header fields (title / purpose). */
  updateReport: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        reportId: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        purpose: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        // `title` and `purpose` are read for the audit diff as well as the guard: the
        // row as it stood is the only place the "from" side of an edit exists, and it
        // is gone the instant the update lands.
        select: { submitterId: true, status: true, title: true, purpose: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (!EDITABLE_REPORT_STATUSES.includes(report.status)) {
        throw refusal('BAD_REQUEST', NOT_EDITABLE.key, NOT_EDITABLE.message);
      }
      const { reportId: _reportId, ...reportPatch } = input;
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'ExpenseReport',
          entityId: input.reportId,
          actor: actorOf(ctx),
          details: auditDiff(report, reportPatch),
        },
        async (tx) =>
          tx.expenseReport.update({
            where: { id: input.reportId },
            data: {
              title: input.title,
              purpose: input.purpose,
            },
            select: { id: true },
          }),
      );
      return { ok: true as const };
    }),

  createExpense: withPermission(P.expense.report.updateOwn)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: {
          submitterId: true,
          currencyId: true,
          status: true,
          // The filer's own coding, copied onto the expense below. Read from the SUBMITTER
          // rather than the caller because they are the same person here (the ownership
          // check two lines down enforces it) and the submitter is who the claim is for.
          // VeloExpense: a person carries business unit and department (no class, and no
          // NetSuite business unit).
          submitter: {
            select: {
              businessUnitId: true,
              departmentId: true,
            },
          },
        },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (!EDITABLE_REPORT_STATUSES.includes(report.status)) {
        throw refusal('BAD_REQUEST', NOT_EDITABLE.key, NOT_EDITABLE.message);
      }

      // Don't pile up blank entries: reuse an empty expense already on this
      // report (no merchant, zero amount, no receipt, no line items).
      const existingEmpty = await ctx.db.expense.findFirst({
        where: {
          reportId: input.reportId,
          merchant: null,
          amountMinor: 0n,
          receipts: { none: {} },
          lineItems: { none: {} },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reportId: true },
      });
      if (existingEmpty) return existingEmpty;

      // VeloExpense: the plan's yearly expense cap (lib/billing/caps.ts), checked in this
      // transaction (`queryRunnerOf`) as VeloExpense's own writer checks it — every path
      // that creates an expense counts against it. Not reached by the reuse above, which
      // creates nothing.
      await assertExpenseCap(ctx.db);
      const { coding, businessUnitSource } = await filerCodingOf(ctx.db, report.submitter);
      const expense = await ctx.db.expense.create({
        // Placeholder date/amount for a blank entry; extraction or the user fills them.
        data: {
          reportId: input.reportId,
          ownerId: ctx.session.user.id,
          currencyId: report.currencyId,
          date: new Date(),
          amountMinor: 0n,
          // Coded to the filer by default, in the same statement. `allocationSet` replaces
          // allocations wholesale, so anything they choose instead simply wins.
          ...allocationCreateFor(coding, businessUnitSource),
        },
        select: { id: true, reportId: true },
      });
      return expense;
    }),

  /**
   * Why this expense's tax figures are what they are.
   *
   * The question that motivated the assistant work — "why do I have $0 recoverable ITC?" —
   * and the reason it needs a procedure rather than a prompt: asked with only the numbers in
   * context, a model produces a fluent tax rationale and has no way to know whether the cause
   * was a foreign jurisdiction, a non-registrant entity, a category that recovers nothing, or
   * an extraction that read no tax off the receipt. Those are four different answers and one
   * of them is true.
   *
   * So this re-runs the real pipeline — the same one the write path uses, not a copy — and
   * returns its trace. The narration is somebody else's job.
   */
  /**
   * Receipt-first entry: create one report holding one blank expense per receipt
   * the user is about to upload.
   *
   * This is what "quick expense" means in finance — you start from the receipts,
   * and the report is created around them. (The old QuickExpense pool, a personal
   * staging area you later attached to a report, was the opposite motion and is
   * gone.)
   *
   * ONE upload batch → ONE report. Uploading again makes another report, so a
   * user can keep them separate by uploading separately, rather than the system
   * guessing which receipts belong together.
   *
   * Returns the report id and an expense id per file, in the caller's order. The
   * client then drives the existing `receiptUploadUrl` → `receiptCreate` →
   * `startExtraction` path against those ids: same upload, same AV scan, same
   * batching rules. Extraction fills merchant/date/amount, so the expenses aren't
   * blank for long.
   *
   * The report is created even if every upload then fails — a DRAFT with empty
   * expenses is visible and fixable, whereas a silent no-op leaves the user
   * wondering where their receipts went.
   */
  startFromReceipts: withPermission(P.expense.report.createOwn)
    .input(
      z
        .object({
          /** How many blank expenses to create, when the caller will presign its own
           *  uploads (the original web flow). Mutually exclusive with `files`. */
          count: z.number().int().min(1).max(50).optional(),
          /**
           * The files themselves, described but not yet uploaded.
           *
           * Supplying these returns a presigned PUT per file alongside the ids, which is
           * what lets a caller with no tRPC client — the assistant panel after a press, or
           * an MCP client — file receipts without a second round trip per file.
           */
          files: z.array(receiptFileSchema).min(1).max(50).optional(),
          /** Localized "Untitled report" from the client, so the default title
           *  isn't English for a French user. Renamed from the workbench later. */
          title: z.string().trim().min(1).max(200),
          /** Currency UUID or ISO-4217 code; defaults to the submitter's home
           *  currency, else USD. */
          currency: z.string().min(3).optional(),
        })
        // One or the other, never both and never neither: `count` with `files` is two
        // answers to "how many expenses", and a caller that sent both would have no way to
        // know which one we honoured.
        .refine((v) => Boolean(v.count) !== Boolean(v.files), {
          message: 'Provide either count or files, not both.',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const files = input.files;
      if (files) assertReceiptTypes(files);
      const count = files?.length ?? input.count ?? 1;
      const currencyId = await resolveIntakeCurrencyId(ctx.db, {
        userId,
        requested: input.currency,
      });
      if (!currencyId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown currency' });
      // For the link in the response: the report opens in the person's own language. The
      // coding columns ride along on the same read — the expenses created below are
      // coded to the filer, and a second query for it would be a round trip for nothing.
      // VeloExpense: a person carries business unit and department (no class, no NetSuite
      // business unit), and no language preference — VeloExpense's links carry no locale.
      const owner = await ctx.db.user.findUnique({
        where: { id: userId },
        select: {
          businessUnitId: true,
          departmentId: true,
        },
      });
      const filer = await filerCodingOf(ctx.db, owner);
      // VeloExpense: every expense created here counts against the plan's yearly cap, all
      // of them checked before any is written.
      await assertExpenseCap(ctx.db, count);

      // Creation itself lives in @expenseos/db, because the inbound-email worker creates the
      // same rows and cannot call a tRPC procedure. The audit envelope stays here: the row
      // records WHICH action filed them, and only this layer knows that.
      const report = await withAudit(
        ctx.db,
        {
          action: auditActions.report.create,
          entityType: 'ExpenseReport',
          actor: actorOf(ctx),
          details: { via: 'receipts', receipts: count },
        },
        async (tx) =>
          createReportFromReceipts(tx, {
            // VeloExpense: minted from the tenant's sequence (`mintReportNumber`).
            number: await mintReportNumber(tx),
            submitterId: userId,
            title: input.title,
            currencyId,
            // Coded to the filer, the same as an expense added by hand.
            coding: filer.coding,
            businessUnitSource: filer.businessUnitSource,
            count,
          }),
        (created) => created.id,
      );

      const expenseIds = report.expenseIds;
      return {
        reportId: report.id,
        number: report.number,
        expenseIds,
        // Absent for the `count` form, so the existing caller's response is unchanged.
        uploads: files
          ? await presignReceiptUploads(
              await tenantIdOf(ctx.db),
              report.id,
              files.map((file, i) => ({ expenseId: expenseIds[i] as string, file })),
            )
          : undefined,
        /**
         * Where to finish the job in a browser.
         *
         * For an MCP client that cannot PUT a local file — Claude Desktop with no filesystem
         * access — this is the whole difference between a dead end and one click. `upload=1`
         * asks the report page to say why the person arrived, since a report full of blank
         * expenses explains nothing on its own.
         */
        // VeloExpense: on the tenant's own origin (`reportUrl`).
        reportUrl: reportUrl(report.id, {
          tenantSlug: await tenantSlugOf(ctx.db),
          promptUpload: Boolean(files),
        }),
      };
    }),

  /**
   * Add one blank expense per receipt to a report that already exists, and presign an
   * upload for each.
   *
   * The append counterpart to `startFromReceipts`: "put these three receipts on the report
   * I am looking at" rather than "make me a report from these three receipts".
   *
   * **Why this is not `createExpense` in a loop.** That procedure deliberately reuses an
   * empty expense already on the report rather than piling up blanks — so N calls return the
   * SAME id until a receipt is attached to it. `ExpenseReportWorkbench.uploadReceipts` gets
   * away with it only because each upload completes before the next call. A caller filing a
   * batch at once would put every receipt on one expense, and `determineExpense` reads
   * several documents on one expense as ONE charge with a tip — so three dinners would
   * become one dinner with two tips. This creates exactly as many rows as there are files.
   */
  addReceiptExpenses: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        reportId: z.string().uuid(),
        files: z.array(receiptFileSchema).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertReceiptTypes(input.files);
      const userId = ctx.session.user.id;
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: {
          id: true,
          number: true,
          submitterId: true,
          currencyId: true,
          status: true,
          // Coded to the filer, the same as an expense added by hand.
          // VeloExpense: business unit and department (no class, no NetSuite business unit).
          submitter: {
            select: {
              businessUnitId: true,
              departmentId: true,
            },
          },
        },
      });
      // Somebody else's report and a missing one are the same answer, so an id cannot be
      // probed for existence.
      if (!report || report.submitterId !== userId) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!EDITABLE_REPORT_STATUSES.includes(report.status)) {
        throw refusal('BAD_REQUEST', NOT_EDITABLE.key, NOT_EDITABLE.message);
      }

      const filer = await filerCodingOf(ctx.db, report.submitter);
      // VeloExpense: the plan's yearly expense cap, for every expense about to be created.
      await assertExpenseCap(ctx.db, input.files.length);
      const expenseIds = await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'ExpenseReport',
          entityId: report.id,
          actor: actorOf(ctx),
          details: { via: 'receipts', receipts: input.files.length },
        },
        (tx) =>
          createBlankExpensesForReceipts(tx, {
            reportId: report.id,
            ownerId: userId,
            currencyId: report.currencyId,
            coding: filer.coding,
            businessUnitSource: filer.businessUnitSource,
            count: input.files.length,
          }),
      );

      // VeloExpense: no language preference to read — the link is the tenant's (`reportUrl`).
      return {
        reportId: report.id,
        number: report.number,
        expenseIds,
        uploads: await presignReceiptUploads(
          await tenantIdOf(ctx.db),
          report.id,
          input.files.map((file, i) => ({ expenseId: expenseIds[i] as string, file })),
        ),
        reportUrl: reportUrl(report.id, { tenantSlug: await tenantSlugOf(ctx.db), promptUpload: true }),
      };
    }),

  /** Presigned PUT URL for uploading a receipt/invoice onto an expense entry.
   *  The client PUTs the file directly to S3, then calls `receiptCreate`.
   *  `sizeBytes` is the exact byte length the client will PUT; the link is bound to it. */
  receiptUploadUrl: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(120),
        sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!RECEIPT_CONTENT_TYPES.has(input.contentType)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported file type.' });
      }
      const { reportId } = await assertExpenseAttachable(ctx, input.expenseId);
      // Object-key prefix: the report for a filed expense, else the expense id
      // (both UUIDs) so an unfiled receipt still has a stable, scoped prefix.
      // VeloExpense: under the tenant's prefix as well (`receiptKey`).
      const keyPrefix = reportId;
      const ext = input.filename.includes('.') ? input.filename.split('.').pop() || 'bin' : 'bin';
      const key = receiptKey(await tenantIdOf(ctx.db), keyPrefix, ext);
      // VeloExpense: VeloExpense's storage, length-bound (d29), at ExpenseOS's 300 seconds.
      const upload = await getStorage().presignUpload(key, input.contentType, {
        contentLength: input.sizeBytes,
        expiresInSeconds: 300,
      });
      return {
        url: upload.url,
        method: 'PUT' as const,
        headers: upload.headers,
        expiresIn: upload.expiresInSeconds,
        key,
      };
    }),

  /** Persist the receipt row after the client has PUT the object to S3. */
  receiptCreate: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        key: z.string().trim().min(1).max(512),
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(120),
        sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES),
        // When true, don't auto-enqueue extraction — the caller uploaded several
        // files together and will call `startExtraction` once with all ids so
        // they can be batched. Omitted/false keeps the single-file behavior.
        deferExtraction: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!RECEIPT_CONTENT_TYPES.has(input.contentType)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported file type.' });
      }
      const { reportId } = await assertExpenseAttachable(ctx, input.expenseId);
      // Key-prefix guard: the object must live under this expense's prefix (the
      // report id when filed, else the expense id), so a caller can't point the
      // row at another report's (or user's) upload.
      // VeloExpense: the prefix is the tenant's and the report's (`receiptPrefix`).
      const keyPrefix = receiptPrefix(await tenantIdOf(ctx.db), reportId);
      if (!input.key.startsWith(`${keyPrefix}/`) || input.key.includes('..')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid receipt key' });
      }
      // VeloExpense (d29): what storage actually holds, not what the client says it sent.
      // The link was bound to the declared length, so a body of another size never landed;
      // this also refuses a key nobody uploaded to, and records the size storage reports.
      const stored = await getStorage().head(input.key);
      if (!stored) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No file was uploaded for this receipt.' });
      }
      if (stored.sizeBytes > MAX_RECEIPT_BYTES) {
        await getStorage()
          .delete(input.key)
          .catch(() => undefined);
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This file is larger than a receipt may be.' });
      }
      const created = await withAudit(
        ctx.db,
        {
          action: auditActions.report.receiptAttach,
          entityType: 'Expense',
          entityId: input.expenseId,
          actor: actorOf(ctx),
          details: { filename: input.filename },
        },
        async (tx) =>
          tx.receipt.create({
            data: {
              expenseId: input.expenseId,
              s3Key: input.key,
              filename: input.filename,
              contentType: input.contentType,
              // VeloExpense: the size storage reports, and verified (above), so STORED.
              sizeBytes: stored.sizeBytes,
              status: 'STORED',
              uploadedById: ctx.session.user.id,
            },
            select: { id: true },
          }),
      );

      // Kick off AV-scan → AI extraction asynchronously. Best-effort: the
      // receipt + Expense are already persisted, so a Redis/enqueue hiccup (or
      // no worker) must not fail the upload — the file stays visible and the
      // Expense is filled manually. Skipped when the caller defers to a single
      // `startExtraction` call (multi-file upload → one batch).
      if (!input.deferExtraction) {
        try {
          await enqueue('expense.extractReceipt', { receiptId: created.id });
        } catch (err) {
          console.warn(
            `[expenses.receiptCreate] extraction enqueue failed for receipt ${created.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return created;
    }),

  /** Start extraction for one or more just-uploaded receipts. A selection of up
   *  to `BATCH_THRESHOLD_FILES` extracts synchronously — one message per receipt,
   *  near-instant; a larger bulk upload goes through the Anthropic Batch API
   *  (~50% cheaper, minutes async). Owner-gated: every receipt must belong to an
   *  expense on a report the caller submitted.
   *
   *  VeloExpense (w2-02b): ported whole for the workbench's uploads, which call it after
   *  every file. The jobs go to `enqueue`, which queues nothing until extraction (Wave 3),
   *  so a receipt stays as uploaded and the figures are typed in — ExpenseOS's own
   *  extraction-off contract (`_workbench/extractionOff.test.ts`). */
  startExtraction: withPermission(P.expense.report.updateOwn)
    .input(z.object({ receiptIds: z.array(z.string().uuid()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const receipts = await ctx.db.receipt.findMany({
        where: { id: { in: input.receiptIds } },
        select: {
          id: true,
          expense: {
            select: { ownerId: true, report: { select: { submitterId: true, status: true } } },
          },
        },
      });
      const uid = ctx.session.user.id;
      if (
        receipts.length !== input.receiptIds.length ||
        receipts.some((r) => r.expense?.ownerId !== uid && r.expense?.report?.submitterId !== uid)
      ) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      // Same window as attaching: the worker will not rewrite a decided report anyway,
      // but a re-extraction on one is a model call for nothing.
      if (
        receipts.some(
          (r) => r.expense?.report && !ATTACHABLE_REPORT_STATUSES.includes(r.expense.report.status),
        )
      ) {
        throw refusal(
          'BAD_REQUEST',
          REFUSAL_KEYS.documentsRereadClosed,
          'Documents cannot be re-read once the report has been decided.',
        );
      }
      const ids = receipts.map((r) => r.id);
      try {
        if (ids.length > BATCH_THRESHOLD_FILES) {
          await enqueue('expense.extractReceipt.batch', { receiptIds: ids });
        } else {
          // One synchronous job per receipt (≤ threshold).
          await Promise.all(ids.map((id) => enqueue('expense.extractReceipt', { receiptId: id })));
        }
      } catch (err) {
        // Best-effort (same contract as receiptCreate): a queue hiccup must not
        // fail the upload — the files stand and can be re-extracted.
        console.warn(
          `[expenses.startExtraction] enqueue failed for ${ids.length} receipt(s): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return { ok: true as const, count: ids.length };
    }),

  /** List an expense's receipts, each with a short-lived presigned view URL. */
  receiptList: withPermission(P.expense.report.readOwn)
    .input(z.object({ expenseId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertExpenseOwned(ctx, input.expenseId);
      const rows = await ctx.db.receipt.findMany({
        // VeloExpense: only a receipt verified in storage (see EXPENSE_DETAIL_INCLUDE).
        where: { expenseId: input.expenseId, status: 'STORED' },
        orderBy: { uploadedAt: 'desc' },
        select: {
          id: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          s3Key: true,
          uploadedAt: true,
        },
      });
      const items = await Promise.all(
        rows.map(async ({ s3Key, ...r }) => ({
          ...r,
          // VeloExpense: VeloExpense's storage, inline, at its default TTL (ExpenseOS's 300s).
          url: await getStorage().presignDownload(s3Key),
        })),
      );
      return { items };
    }),

  /**
   * Pairs of documents on DIFFERENT expenses that look like one charge.
   *
   * Derived, never stored. `groupDocuments` is pure and reads extractions that are
   * already in the database — no model call — so recomputing on demand costs a query
   * and can never go stale. There is nothing to persist and nothing to invalidate:
   * merge the pair and it stops being a cross-expense group by itself.
   *
   * This exists because the automatic pass deliberately declines to merge when the
   * evidence is not conclusive, and an unresolved pair is an OVER-claim — the same
   * charge sitting on two expenses. It also catches what the pass never sees:
   * receipts uploaded one at a time skip the batch entirely.
   *
   * VeloExpense (w2-02b): the access check is ExpenseOS's. The grouping reads each
   * receipt's extraction through `groupDocuments` (`@expenseos/receipt-extraction`), and
   * both arrive with extraction (Wave 3). With no reading there is no candidate — ExpenseOS
   * skips a receipt without one — so the answer is the empty list ExpenseOS gives a report
   * none of whose documents has been read, in ExpenseOS's item shape.
   */
  receiptGroupingSuggestions: withPermission(P.expense.report.readOwn)
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { submitterId: true },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      const isAdmin = ctx.rbac.permissions.includes(P.expense.report.readAll);
      if (report.submitterId !== ctx.session.user.id && !isAdmin) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return { items: [] as GroupingSuggestion[] };
    }),

  // VeloExpense: `statementTargets` and `statementApply` match a statement's EXTRACTED
  // lines to expenses, and arrive with extraction (Wave 3).

  /**
   * Move a receipt to a different expense on the same report.
   *
   * The manual counterpart to automatic grouping (`worker/lib/group-receipts.ts`):
   * grouping folds a bill and its card copy together silently, and this is how
   * somebody corrects it — or does the merge themselves when the evidence was not
   * conclusive enough for the pass to act.
   *
   * Both expenses re-derive afterwards. The one gaining a document gets the joint
   * determination that knows a card copy outranks a pre-tip bill; the one losing its
   * last document is deleted, because an expense with no evidence and no amount is
   * not a claim.
   */
  receiptMove: withPermission(P.expense.report.updateOwn)
    .input(z.object({ id: z.string().uuid(), toExpenseId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.id },
        select: { id: true, expenseId: true, filename: true },
      });
      if (!receipt?.expenseId) throw new TRPCError({ code: 'NOT_FOUND' });
      if (receipt.expenseId === input.toExpenseId) return { ok: true as const, removed: false };
      // Captured so the null check narrows inside the transaction closure too.
      const fromExpenseId = receipt.expenseId;
      // Both ends checked: moving a document is a write to each — and a DRAFT-only
      // write, because it can delete the vacated expense and restate the total.
      const from = await assertExpenseDraft(ctx, fromExpenseId);
      const to = await assertExpenseDraft(ctx, input.toExpenseId);
      // Across reports it would move money between two totals and, if one is already
      // submitted, past an approver. A receipt belongs to the report it was filed on.
      if (from.reportId !== to.reportId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A receipt can only move between expenses on the same report.',
        });
      }

      const removed = await withAudit(
        ctx.db,
        {
          action: auditActions.report.receiptAttach,
          entityType: 'Expense',
          entityId: input.toExpenseId,
          actor: actorOf(ctx),
          details: { filename: receipt.filename, from: fromExpenseId },
        },
        async (tx) => {
          await tx.receipt.update({
            where: { id: receipt.id },
            data: { expenseId: input.toExpenseId },
          });
          const left = await tx.receipt.count({ where: { expenseId: fromExpenseId } });
          if (left === 0) {
            await tx.expense.delete({ where: { id: fromExpenseId } });
            return true;
          }
          return false;
        },
      );

      await recomputeTotals(ctx.db, input.toExpenseId);
      if (!removed) await recomputeTotals(ctx.db, fromExpenseId);
      if (from.reportId) await recomputeReportTotal(ctx.db, from.reportId);
      // The receiving expense now holds a different document SET, so its joint
      // determination is re-derived rather than merged into.
      await enqueue('expense.determineExpense', { expenseId: input.toExpenseId }).catch(() => {});
      return { ok: true as const, removed };
    }),

  receiptRemove: withPermission(P.expense.report.updateOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.id },
        select: { id: true, s3Key: true, expenseId: true, filename: true },
      });
      if (!receipt?.expenseId) throw new TRPCError({ code: 'NOT_FOUND' });
      // Evidence on a filed report is what the approver looked at; it comes off only
      // while the report is the submitter's to edit (DRAFT / RETURNED).
      await assertExpenseDraft(ctx, receipt.expenseId);
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.receiptDetach,
          entityType: 'Expense',
          entityId: receipt.expenseId,
          actor: actorOf(ctx),
          details: { filename: receipt.filename },
        },
        async (tx) => tx.receipt.delete({ where: { id: receipt.id } }),
      );
      // VeloExpense: VeloExpense's storage.
      await getStorage()
        .delete(receipt.s3Key)
        .catch(() => undefined);
      // Removing a document changes the determination as surely as adding one: an
      // expense that was $130 because of a card copy is $113 again once that copy
      // is gone. Only worth a joint pass while more than one document remains —
      // and a queue hiccup must not fail the delete, which already happened.
      const remaining = await ctx.db.receipt.count({ where: { expenseId: receipt.expenseId } });
      if (remaining > 1) {
        try {
          await enqueue('expense.determineExpense', { expenseId: receipt.expenseId });
        } catch (err) {
          console.warn(
            `[expenses.receiptRemove] determination enqueue failed for expense ${receipt.expenseId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return { ok: true as const };
    }),

  explainTax: protectedProcedure
    .input(z.object({ expenseId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const expense = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        select: {
          id: true,
          merchant: true,
          date: true,
          amountMinor: true,
          taxSource: true,
          currency: { select: { code: true } },
          report: { select: { id: true, submitterId: true } },
          taxJurisdictionId: true,
          taxJurisdiction: {
            select: { countryCode: true, code: true, label: true, taxType: true },
          },
          taxGstHstMinor: true,
          taxQstMinor: true,
          taxPstMinor: true,
          owner: { select: { entity: { select: { label: true, itcRecoverable: true } } } },
          lineItems: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              kind: true,
              payload: true,
              amountMinor: true,
              categoryId: true,
              category: { select: { label: true, itcGstHstRate: true, itcQstRate: true } },
            },
          },
        },
      });
      if (!expense || !(await callerCanReadReport(ctx, expense.report))) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const lines = expense.lineItems;
      const explained = await explainExpenseTax(ctx.db, {
        grossMinor: lines.reduce((a, l) => a + l.amountMinor, 0n),
        untaxedTipMinor: totalTipMinor(lines),
        taxJurisdictionId: expense.taxJurisdictionId,
        // VeloExpense: text with a CHECK (0054), so the client types it `string`.
        taxSource: expense.taxSource as ExpenseTaxSource,
        explicit: {
          gstHstMinor: expense.taxGstHstMinor ?? undefined,
          qstMinor: expense.taxQstMinor ?? undefined,
          pstMinor: expense.taxPstMinor ?? undefined,
        },
        lines: lines.map((l) => ({ categoryId: l.categoryId, amountMinor: l.amountMinor })),
        itcRecoverable: expense.owner.entity?.itcRecoverable ?? true,
      });

      const { taxTrace, recoverableTrace } = explained;
      const credit = (
        side: (typeof recoverableTrace)['gstHst'],
        split: (typeof taxTrace)['gstHst'],
      ) => ({
        recoverableMinor: side.amountMinor.toString(),
        taxChargedMinor: side.taxBaseMinor.toString(),
        /** Why the credit is zero, if it is — the allocator's answer. */
        zeroReason: side.zeroReason,
        /** Why no tax was charged, when that is the cause — the engine's answer. */
        noTaxReason: side.zeroReason === 'NO_TAX_CHARGED' ? split.zeroReason : null,
      });

      return {
        expenseId: expense.id,
        merchant: expense.merchant,
        date: expense.date,
        currency: expense.currency.code,
        totalMinor: expense.amountMinor.toString(),
        taxSource: expense.taxSource,
        jurisdiction: expense.taxJurisdiction
          ? {
              countryCode: expense.taxJurisdiction.countryCode,
              code: expense.taxJurisdiction.code,
              label: expense.taxJurisdiction.label,
              taxType: expense.taxJurisdiction.taxType,
            }
          : null,
        entity: {
          label: expense.owner.entity?.label ?? null,
          // False means every recoverable figure is zero by definition, whatever the
          // categories say. It is the cause a tax-split trace cannot see.
          itcRecoverable: recoverableTrace.entityRecovers,
        },
        branch: taxTrace.branch,
        taxCharged: {
          gstHstMinor: explained.taxGstHstMinor.toString(),
          qstMinor: explained.taxQstMinor.toString(),
          pstMinor: explained.taxPstMinor.toString(),
        },
        gstHst: credit(recoverableTrace.gstHst, taxTrace.gstHst),
        qst: credit(recoverableTrace.qst, taxTrace.qst),
        lines: lines.map((l) => ({
          label: l.category.label,
          amountMinor: l.amountMinor.toString(),
          itcGstHstRate: l.category.itcGstHstRate,
          itcQstRate: l.category.itcQstRate,
        })),
      };
    }),

  report: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        include: {
          // VeloExpense: keyed by its ISO code; the symbol is `currencySymbol`'s (below).
          currency: { select: { code: true } },
          // VeloExpense: violations, external ids and the posting state are read below —
          // VeloExpense's own tables, not relations of this model.
          // The submitter's entity settles two questions the whole report is
          // rendered against: what currency they are paid in, and whether an
          // input tax credit arises at all (rules 3 and 6).
          submitter: {
            select: {
              entity: {
                // VeloExpense: the home currency's code is the column itself.
                select: { homeCurrencyId: true, itcRecoverable: true },
              },
            },
          },
          expenses: { orderBy: { createdAt: 'asc' }, include: EXPENSE_DETAIL_INCLUDE },
        },
      });
      // A non-owner without one of the four ways in sees NOT_FOUND.
      if (!report || !(await callerCanReadReport(ctx, report))) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Confidence threshold below which an extraction is flagged for human
      // verification in the FE (Platform Settings; default 0.7).
      // VeloExpense: no platform setting yet — ExpenseOS's default, until extraction (Wave 3).
      const [fxRows, readerCurrency, violations, posting] = await Promise.all([
        ctx.db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }),
        // Folded into the same Promise.all so reading it costs no extra round trip.
        readerCurrencyCode(ctx.db, ctx.session.user.id),
        reportViolations(ctx.db, report.id, ctx.session.user.id),
        postingStateOf(ctx.db, report.id),
      ]);
      const extractionReviewThreshold = 0.7;

      // Live FX/VAT preview: converts every expense into the report's currency
      // (the stored totalMinor is this same home total), rolls up recoverable
      // VAT/ITC, and surfaces the per-currency breakdown + any missing rates.
      const rollup = buildReportRollup(
        report.currency.code,
        report.expenses.map((e) => ({
          amountMinor: e.amountMinor,
          currencyCode: e.currency.code,
          recoverableGstHstMinor: e.recoverableGstHstMinor,
          recoverableQstMinor: e.recoverableQstMinor,
          fxRate: e.fxRate,
          fxHomeCurrency: e.homeCurrency,
        })),
        withFxOverride(fxRateMapFrom(fxRows), report.currency.code, fxOverrideOf(report)),
      );

      /**
       * The SAME report total, also expressed in the reader's own currency (GA readiness
       * report F52): "read a historical USD report in CAD".
       *
       * A SECOND ROLL-UP at the reader's currency — not one rate over the answer.
       *
       * It was the other way round, and the reasoning was exactly inverted. The old
       * comment argued a second roll-up "would discard every expense's SNAPSHOTTED
       * fxRate". It is the single conversion that discards them: it takes a total already
       * rolled into the REPORT's currency and re-values it at today's table. Rolling up at
       * the reader's currency is what HONOURS a snapshot, because `buildReportRollup`
       * prefers one whenever its home currency matches the currency being rolled into.
       *
       * The cost of getting it backwards, from the GA v2 audit (GA-3): one expense of
       * USD 125.50 read as CAD 174.29 in the header and CAD 174.14 on the only line
       * composing it. Two rates for one amount on one date — 15 cents here, and it scales
       * with the amount.
       *
       * A filed claim is worth what it was worth when it was incurred. Re-valuing it daily
       * means an approved report's total moves on its own, and an employee reconciling a
       * reimbursement line by line never ties out.
       *
       * The old note's second worry stands and is answered rather than dismissed:
       * `missingRates` IS computed against the target, so a report with a line this
       * currency cannot reach would exclude a different set. That is why `excluded` is
       * returned alongside — the toggle discloses what it left out instead of quietly
       * showing a smaller number.
       *
       * `null` when nothing could be valued at all: the toggle is then not offered,
       * rather than offered and wrong.
       */
      const viewInReaderCurrency =
        readerCurrency === report.currency.code
          ? null
          : (() => {
              try {
                const readerRollup = buildReportRollup(
                  readerCurrency,
                  report.expenses.map((e) => ({
                    amountMinor: e.amountMinor,
                    currencyCode: e.currency.code,
                    recoverableGstHstMinor: e.recoverableGstHstMinor,
                    recoverableQstMinor: e.recoverableQstMinor,
                    fxRate: e.fxRate,
                    fxHomeCurrency: e.homeCurrency,
                  })),
                  withFxOverride(fxRateMapFrom(fxRows), readerCurrency, fxOverrideOf(report)),
                );
                // Nothing convertible at all — every line excluded — is not a total of
                // zero, it is no answer. Offering "CAD 0.00" would be a lie with a
                // currency symbol on it.
                if (readerRollup.missingRates.length === report.expenses.length) return null;
                return {
                  currency: readerCurrency,
                  totalMinor: readerRollup.homeTotalMinor,
                  /**
                   * No single rate is disclosed any more, and that is honest: the total is
                   * the sum of per-expense conversions, each at the rate ITS claim was
                   * filed at. One number here would name a rate that produced only part of
                   * the figure. A single-currency report still has exactly one, so the
                   * common case loses nothing.
                   */
                  rate:
                    readerRollup.byCurrency.length === 1
                      ? (readerRollup.byCurrency[0].rate ?? null)
                      : null,
                  /** Lines this currency cannot value, disclosed rather than dropped. */
                  excluded: readerRollup.missingRates.length,
                };
              } catch {
                // An unknown ISO code. Not offered rather than offered and wrong.
                return null;
              }
            })();

      // VeloExpense: no NetSuite position, so no business unit source to read and no picker
      // pre-select to resolve (see `serializeExpense`).
      const expenses = await Promise.all(report.expenses.map((e) => serializeExpense(e)));

      /**
       * Which expenses NetSuite would refuse, told to the screen BEFORE the press.
       *
       * VeloExpense: ExpenseOS's answer where NetSuite is not installed — nothing is
       * required, so nothing is uncoded, and no category is checked (`codingGaps` and
       * `categoryGaps` both switch off on an absent integration). VeloExpense posts through
       * its own integrations, which have no required-dimension rule to surface here.
       */
      const coding = {
        required: [] as string[],
        missing: [] as string[],
        uncodedExpenseIds: [] as string[],
        categoryProblems: [] as Array<{
          categoryId: string;
          categoryLabel: string;
          kind: string;
          count?: number;
          expenseIds: string[];
        }>,
        categoryAffectedExpenseIds: [] as string[],
      };

      /**
       * Receipts still being read, told to the screen BEFORE the press — the same rule
       * `submit` refuses on, read from the extraction rows this query already loaded. The
       * workbench disables Submit on `inFlight` and discloses `stale`: a reading the worker
       * abandoned no longer holds the report, but its amounts were never read.
       */
      // VeloExpense: no receipt has a reading until extraction is ported (Wave 3).
      const extraction = summarizeExtractionProgress(
        report.expenses.flatMap((e) => e.receipts.map(() => null)),
      );

      return {
        id: report.id,
        number: report.number,
        title: report.title,
        purpose: report.purpose,
        status: report.status,
        totalMinor: report.totalMinor.toString(),
        // VeloExpense: ExpenseOS's `{ code, symbol }`.
        currency: { code: report.currency.code, symbol: currencySymbol(report.currency.code) },
        rollup,
        /**
         * Coding gaps NetSuite would reject. `required` is empty when it is not installed.
         * `categoryProblems` / `categoryAffectedExpenseIds` are the category rule's; the
         * affected ids are never in `uncodedExpenseIds`, which stays dimensions-only.
         */
        coding,
        /** Receipts still being read (hold the submit) and readings the worker abandoned. */
        extraction,
        /** The same total in the reader's own currency, or null when no rate connects them. */
        viewInReaderCurrency,
        // The submitter's entity, as the UI needs it. `itcRecoverable: false`
        // (a US entity, or any non-registrant) means every recoverable figure is
        // $0.00 by definition, so the UI hides the whole notion rather than
        // showing a column of zeros (rule 6).
        entity: {
          // VeloExpense: ExpenseOS's `{ code }`, from the code column.
          homeCurrency: report.submitter.entity?.homeCurrencyId
            ? { code: report.submitter.entity.homeCurrencyId }
            : null,
          itcRecoverable: report.submitter.entity?.itcRecoverable ?? true,
        },
        // VeloExpense: `posting` (VeloExpense's integration_post) where ExpenseOS has
        // `netsuite` — see `postingStateOf`.
        posting,
        // AP FX override (A4) — surfaced so the workbench can show/edit it.
        fxOverride: report.fxRateOverride
          ? {
              rate: report.fxRateOverride.toString(),
              fromCurrency: report.fxRateOverrideCurrency,
              at: report.fxRateOverrideAt,
              byId: report.fxRateOverrideById,
            }
          : null,
        submittedAt: report.submittedAt,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        violations,
        // External ids stamped by integrations (e.g. NetSuite) — shown by the
        // header when present.
        // VeloExpense: a report carries none — an integration's id for it is the posting
        // row's `externalId` (`posting` above).
        externalIds: [] as Array<{ source: string; sourceLabel: unknown; value: string }>,
        extractionReviewThreshold,
        expenses,
      };
    }),

  updateExpense: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        merchant: z.string().max(200).nullish(),
        placeText: z.string().max(200).nullish(),
        /** Currency FK — the expense's own currency (defaults on create). */
        // VeloExpense: a currency is keyed by its ISO code (`currency_code`).
        currencyId: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        date: z.coerce.date().optional(),
        purpose: z.string().max(2000).nullish(),
        explanation: z.string().max(2000).nullish(),
        paymentMethod: z.enum(ExpensePaymentMethod).optional(),
        subtotalMinor: minorInput.nullish(),
        // Full-replace set when provided; omit to leave attendees untouched.
        attendees: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              company: z.string().trim().max(200).nullish(),
              isExternal: z.boolean().optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertExpenseDraft(ctx, input.expenseId);
      /**
       * The row as it stands, read for the audit diff. It has to happen before the write
       * and it has to cover exactly the fields this mutation can change — the "from" side
       * of an edit exists nowhere else once the update lands.
       *
       * Attendees are a full-replace SET, so they are read as their comparable shape
       * rather than as rows: what a reviewer wants to know is that the roster changed and
       * who was on it, not which primary keys were deleted and recreated.
       */
      const { expenseId: _expenseId, ...expensePatch } = input;
      const before = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        select: {
          merchant: true,
          placeText: true,
          currencyId: true,
          date: true,
          purpose: true,
          explanation: true,
          paymentMethod: true,
          subtotalMinor: true,
          ...(input.attendees !== undefined
            ? {
                attendees: {
                  select: { name: true, company: true, isExternal: true },
                  orderBy: { name: 'asc' as const },
                },
              }
            : {}),
        },
      });
      const diff = auditDiff(
        {
          ...(before ?? {}),
          // Compare the roster the client sent against the roster on file, in the same
          // normalised shape and order, so re-sending an unchanged list is not an edit.
          ...(before && 'attendees' in before
            ? { attendees: normalizeAttendees(before.attendees) }
            : {}),
        },
        {
          ...expensePatch,
          ...(input.attendees !== undefined
            ? { attendees: normalizeAttendees(input.attendees) }
            : {}),
        },
      );
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'Expense',
          entityId: input.expenseId,
          actor: actorOf(ctx),
          details: diff,
        },
        async (tx) => {
          await tx.expense.update({
            where: { id: input.expenseId },
            data: {
              merchant: input.merchant,
              placeText: input.placeText,
              ...(input.currencyId ? { currencyId: input.currencyId } : {}),
              ...(input.date ? { date: input.date } : {}),
              purpose: input.purpose,
              explanation: input.explanation,
              paymentMethod: input.paymentMethod,
              subtotalMinor: optMinor(input.subtotalMinor),
            },
            select: { id: true },
          });
          // Attendees are a full-replace set (small list; the editor sends the
          // whole roster on save).
          if (input.attendees !== undefined) {
            await tx.expenseAttendee.deleteMany({ where: { expenseId: input.expenseId } });
            if (input.attendees.length > 0) {
              await tx.expenseAttendee.createMany({
                data: input.attendees.map((a) => ({
                  expenseId: input.expenseId,
                  name: a.name,
                  company: a.company ?? null,
                  isExternal: a.isExternal ?? false,
                })),
              });
            }
          }
          return { id: input.expenseId };
        },
      );
      // Header corrections the next determination has to honour (rule 2). Only the
      // fields a determination actually proposes — `purpose` and `explanation` are
      // the human's own words, never the model's, so they are not disagreements.
      const cur = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        select: { currency: { select: { code: true } } },
      });
      noteOverrides(ctx.db, input.expenseId, {
        merchant: input.merchant ?? undefined,
        placeText: input.placeText ?? undefined,
        date: input.date ? input.date.toISOString().slice(0, 10) : undefined,
        subtotal: overrideAmount(input.subtotalMinor, cur?.currency.code ?? 'CAD'),
        ...(input.currencyId ? { currency: cur?.currency.code } : {}),
      });
      return { ok: true as const };
    }),

  /** Remove an expense from a DRAFT report (cascades its line items + receipts).
   *  Best-effort deletes the receipts' S3 objects, then recomputes the total. */
  deleteExpense: withPermission(P.expense.report.updateOwn)
    .input(z.object({ expenseId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { reportId } = await assertExpenseDraft(ctx, input.expenseId);
      const receipts = await ctx.db.receipt.findMany({
        where: { expenseId: input.expenseId },
        select: { s3Key: true },
      });
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          // Anchored to the REPORT, which is the thing somebody audits — an entry
          // pointing at a deleted expense id is one nobody can navigate to.
          entityType: 'ExpenseReport',
          entityId: reportId,
          actor: actorOf(ctx),
          details: { removedExpenseId: input.expenseId },
        },
        async (tx) => tx.expense.delete({ where: { id: input.expenseId } }),
      );
      // VeloExpense: VeloExpense's storage (`getStorage`), ExpenseOS's best-effort rule.
      await Promise.all(
        receipts.map((r) => getStorage().delete(r.s3Key).catch(() => undefined)),
      );
      await recomputeReportTotal(ctx.db, reportId);
      return { ok: true as const };
    }),

  /** Bulk-delete expenses (the expense list's group action). Every id must be
   *  owned by the caller and sit on a DRAFT/RETURNED report. Their receipts'
   *  S3 objects are best-effort removed; line items + policy violations cascade
   *  via FK; the affected report total is recomputed. */
  deleteExpenses: withPermission(P.expense.report.updateOwn)
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const uid = ctx.session.user.id;
      const expenses = await ctx.db.expense.findMany({
        where: { id: { in: input.ids } },
        select: {
          id: true,
          reportId: true,
          ownerId: true,
          report: { select: { submitterId: true, status: true } },
        },
      });
      const ok = (e: (typeof expenses)[number]) =>
        (e.ownerId === uid || e.report.submitterId === uid) &&
        EDITABLE_REPORT_STATUSES.includes(e.report.status);
      if (expenses.length !== input.ids.length || expenses.some((e) => !ok(e))) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      const receipts = await ctx.db.receipt.findMany({
        where: { expenseId: { in: input.ids } },
        select: { s3Key: true },
      });
      // The expense list is cross-report, so a group delete routinely spans two.
      const reportIds = [...new Set(expenses.map((e) => e.reportId))];
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'ExpenseReport',
          entityId: reportIds[0],
          actor: actorOf(ctx),
          details: { removedExpenseIds: input.ids.length },
        },
        async (tx) => tx.expense.deleteMany({ where: { id: { in: input.ids } } }),
      );
      // VeloExpense: VeloExpense's storage (`getStorage`), ExpenseOS's best-effort rule.
      await Promise.all(
        receipts.map((r) => getStorage().delete(r.s3Key).catch(() => undefined)),
      );
      for (const rid of reportIds) await recomputeReportTotal(ctx.db, rid);
      return { ok: true as const, deleted: input.ids.length };
    }),

  /**
   * What a mileage distance is worth, without writing anything — the live figure
   * beside the distance box.
   *
   * Prices through `computeLineFinancials`, the same function the write uses, so the
   * preview and the saved amount cannot disagree. A second implementation "just for
   * display" is how a preview starts lying: it would miss the YTD tier bands, the
   * unit conversion, and the per-person allowance rules, and every one of those
   * changes the number.
   *
   * `lineItemId` excludes the line being repriced from its own YTD basis, or a line
   * already counted would push itself into the next band and preview a figure the
   * save then contradicts.
   *
   * Returns a reason instead of throwing when a rate cannot be resolved. A query
   * that fires as someone types must not raise errors mid-word — and saying "no
   * rate in force for US" beside the field is better than saying it after they
   * press Add line.
   */
  /**
   * The tax split and home-currency conversion an expense WOULD have, for a draft line
   * set — computed but never written.
   *
   * The numbers already existed and were only visible after saving: type $847.32 USD, save,
   * wait, and then learn it is CA$1,164.18 with $41.20 recoverable. This makes the same
   * figures visible while the decision is still being made.
   *
   * It runs `deriveExpenseTotals` — the exact function the save path uses — rather than
   * estimating. A browser-side approximation would eventually disagree with the saved value
   * by a cent, and a preview that is nearly right is worse than none, because it will be
   * believed. Everything that decides the answer (jurisdiction, taxSource, the entity's ITC
   * eligibility, the FX rate table) lives server-side anyway.
   *
   * A query, not a mutation, and gated on `readOwn` + `assertExpenseOwned`: it reads the
   * owner's legal entity and the FX table, so it must not be a way to probe another
   * person's expense.
   */
  totalsPreview: withPermission(P.expense.report.readOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        /**
         * The lines about to be ADDED — the rows a person has typed but not saved.
         *
         * Only the additions cross the wire; the already-saved lines are read here. That
         * is not an optimisation. The tax split is a function of ALL the lines (the
         * recoverable ITC re-allocates across their categories), so the whole set has to
         * be assembled somewhere — and assembling it server-side means a saved line's tip
         * comes from its stored payload. The drawer's wire shape carries category and
         * amount only, so a client-supplied set would silently drop every tip and
         * overstate the tax on exactly the tipped meals where it matters.
         */
        addLines: z
          .array(
            z.object({
              categoryId: z.string().uuid(),
              amountMinor: minorInput,
              tipMinor: minorInput.nullish(),
            }),
          )
          .max(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertExpenseOwned(ctx, input.expenseId);
      const savedLines = await ctx.db.expenseLineItem.findMany({
        where: { expenseId: input.expenseId },
        select: { amountMinor: true, categoryId: true, kind: true, payload: true },
      });
      const derived = await deriveExpenseTotals(ctx.db, input.expenseId, [
        ...savedLines,
        ...input.addLines.map((l) => {
          const tip = l.tipMinor == null ? 0n : BigInt(l.tipMinor);
          // Rebuild the kind + payload the same way a write would, so the tip leaves the
          // taxable base here exactly as it will on save.
          const built = tip > 0n ? tipPayload(tip) : null;
          return {
            categoryId: l.categoryId,
            amountMinor: BigInt(l.amountMinor),
            kind: built?.kind ?? 'STANDARD',
            payload: built?.payload ?? null,
          };
        }),
      ]);
      if (!derived) return null;
      const { sum, tax, fx } = derived;
      return {
        grossMinor: sum.toString(),
        taxGstHstMinor: tax?.taxGstHstMinor?.toString() ?? null,
        taxQstMinor: tax?.taxQstMinor?.toString() ?? null,
        taxPstMinor: tax?.taxPstMinor?.toString() ?? null,
        recoverableGstHstMinor: tax?.recoverableGstHstMinor?.toString() ?? null,
        recoverableQstMinor: tax?.recoverableQstMinor?.toString() ?? null,
        /** Null when no conversion applies (already in the home currency) or no rate
         *  exists — the caller must distinguish "no conversion" from "unknown". */
        homeCurrency: fx?.homeCurrency ?? null,
        homeAmountMinor: fx?.homeAmountMinor?.toString() ?? null,
        fxRate: fx?.fxRate?.toString() ?? null,
      };
    }),

  mileagePreview: withPermission(P.expense.report.readOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        categoryId: z.string().uuid(),
        mileageDistance: z.string().regex(/^\d+(\.\d{1,2})?$/),
        mileageUnit: z.enum(['KM', 'MI']),
        /** The line being repriced, so the YTD basis doesn't count it twice. */
        lineItemId: z.string().uuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertExpenseOwned(ctx, input.expenseId);
      try {
        const fin = await computeLineFinancials(ctx.db, {
          expenseId: input.expenseId,
          categoryId: input.categoryId,
          mileageDistance: input.mileageDistance,
          mileageUnit: input.mileageUnit,
          lineItemId: input.lineItemId,
        });
        // A non-mileage category prices to whatever amount was passed — here, none.
        // Nothing to preview, and no error either: the caller simply asked about a
        // category that doesn't derive its amount.
        if (fin.mileage.mileageRateId == null) return { ok: false as const, reason: null };
        return {
          ok: true as const,
          amountMinor: fin.amountMinor.toString(),
          /** The rule's unit, which is what the bands are denominated in — it may
           *  differ from the unit the distance was typed in. */
          unit: fin.mileage.mileageUnit,
          /** Distance as priced (converted into the rule's unit). */
          distance: fin.mileage.mileageDistance,
          /** Distance already claimed this year before this line, for the bands. */
          ytdBefore: fin.mileage.mileageYtdBefore,
        };
      } catch (e) {
        // Only the "cannot price this" refusals become a reason. Anything else — a
        // missing expense, a permission problem, a bug — still throws.
        if (e instanceof TRPCError && e.code === 'PRECONDITION_FAILED') {
          return { ok: false as const, reason: e.message };
        }
        throw e;
      }
    }),

  /** Add a line item to an expense (itemization). Recomputes the expense +
   *  report totals. Tax defaults to MANUAL provenance (a user-entered line). */
  lineItemCreate: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        categoryId: z.string().uuid(),
        // Optional — a mileage-category line derives its amount from the
        // distance, which may be entered in either unit.
        amountMinor: minorInput.optional(),
        mileageDistance: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .optional(),
        mileageUnit: z.enum(['KM', 'MI']).optional(),
        /** Ordered stops + per-leg distances from the route lookup. */
        mileageRoute: z.unknown().optional(),
        /** Traveller's correction to the computed distance. */
        mileageDistanceOverride: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .optional(),
        /**
         * Voluntary tip inside this line's amount (minor units). Only meaningful
         * for a category with `acceptsTip`; null clears it, which returns the
         * line to STANDARD. Reimbursed but never taxed, so it leaves the taxable
         * base of the parent expense.
         */
        tipMinor: minorInput.nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertExpenseDraft(ctx, input.expenseId);
      const fin = await computeLineFinancials(ctx.db, {
        expenseId: input.expenseId,
        categoryId: input.categoryId,
        amountMinor: input.amountMinor === undefined ? undefined : toMinor(input.amountMinor),
        mileageDistance: input.mileageDistance,
        mileageUnit: input.mileageUnit,
        mileageRoute: input.mileageRoute,
        mileageDistanceOverride: input.mileageDistanceOverride,
      });
      const lineKind = await resolveLineKind(ctx.db, {
        categoryId: input.categoryId,
        tipMinor: optMinor(input.tipMinor) ?? null,
      });
      const created = await withAudit(
        ctx.db,
        {
          action: auditActions.report.lineItemAdd,
          entityType: 'Expense',
          entityId: input.expenseId,
          actor: actorOf(ctx),
          details: { categoryId: input.categoryId },
        },
        async (tx) =>
          tx.expenseLineItem.create({
            data: {
              expenseId: input.expenseId,
              categoryId: input.categoryId,
              // Snapshotted from the category NOW. Re-pointing the category later
              // must not restate a line that has already been filed.
              glAccountId: await glAccountIdForCategory(ctx.db, input.categoryId),
              amountMinor: fin.amountMinor,
              kind: lineKind.kind,
              payload: lineKind.payload ?? undefined,
              ...fin.mileage,
              notes: input.notes,
            },
            select: { id: true },
          }),
      );
      // recomputeTotals re-derives the expense total + tax (recoverable
      // re-allocates across the new category set).
      await recomputeTotals(ctx.db, input.expenseId);
      // Any hand-edit of the itemization makes the human its author, and a rebuild
      // must stop replacing it wholesale. One marker rather than per-line diffing:
      // the question the rebuild asks is "may I touch these lines", and that has a
      // single answer.
      noteOverrides(ctx.db, input.expenseId, { lineItems: 'edited by hand' });
      return created;
    }),

  /** Patch a line item (category, amount, notes). Recomputes totals + tax. */
  lineItemUpdate: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        id: z.string().uuid(),
        categoryId: z.string().uuid().optional(),
        // Optional — a mileage-category line derives its amount from the
        // distance, which may be entered in either unit.
        amountMinor: minorInput.optional(),
        mileageDistance: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .optional(),
        mileageUnit: z.enum(['KM', 'MI']).optional(),
        /** Ordered stops + per-leg distances from the route lookup. */
        mileageRoute: z.unknown().optional(),
        /** Traveller's correction to the computed distance. */
        mileageDistanceOverride: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .optional(),
        /** Voluntary tip inside this line's amount; null clears it. Omitted
         *  leaves whatever the line already carries. */
        tipMinor: minorInput.nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const line = await ctx.db.expenseLineItem.findUnique({
        where: { id: input.id },
        select: {
          expenseId: true,
          categoryId: true,
          amountMinor: true,
          mileageDistance: true,
          mileageUnit: true,
          // Read so an edit that says nothing about the route can preserve it rather
          // than blank it — see the `mileageRoute` note below.
          mileageRoute: true,
          kind: true,
          payload: true,
        },
      });
      if (!line) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertExpenseDraft(ctx, line.expenseId);
      // Re-derive the amount + mileage columns against the effective category
      // (an edit may switch a line into or out of a mileage category). When the
      // amount isn't being changed, keep the existing one (non-mileage) so a
      // notes-only edit doesn't zero it.
      const effectiveCategoryId = input.categoryId ?? line.categoryId;
      const fin = await computeLineFinancials(ctx.db, {
        expenseId: line.expenseId,
        categoryId: effectiveCategoryId,
        amountMinor:
          input.amountMinor === undefined ? line.amountMinor : toMinor(input.amountMinor),
        mileageDistance: input.mileageDistance ?? line.mileageDistance?.toString() ?? null,
        // VeloExpense: text with a CHECK (KM | MI, 0054), so the client types it `string`.
        mileageUnit: input.mileageUnit ?? (line.mileageUnit as 'KM' | 'MI' | null) ?? undefined,
        /**
         * ABSENT means "leave the route alone"; an explicit null means "clear it".
         *
         * `computeLineFinancials` writes the full mileage column set every time, so a
         * route it wasn't given became JsonNull — and the edit row never sent one.
         * Entering From/To saved the stops, then the very next distance edit, unit
         * switch or blur silently wiped them. `undefined` is the only value that means
         * "not mentioned", which is why this is not a `??`.
         */
        mileageRoute: input.mileageRoute !== undefined ? input.mileageRoute : line.mileageRoute,
        mileageDistanceOverride: input.mileageDistanceOverride,
        // Exclude this line from its own year-to-date basis.
        lineItemId: input.id,
        // Only when the category actually CHANGES. A switch into mileage cannot
        // carry a distance yet; an edit that blanks the distance on a line that is
        // already mileage still has to fail.
        allowMissingDistance: input.categoryId != null && input.categoryId !== line.categoryId,
      });
      // An omitted tip keeps the line's existing one; an explicit null clears it.
      // Switching category can also strip a tip the new category won't accept.
      const lineKind = await resolveLineKind(ctx.db, {
        categoryId: effectiveCategoryId,
        tipMinor: input.tipMinor === undefined ? tipMinorOf(line) : optMinor(input.tipMinor),
      });
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.lineItemUpdate,
          entityType: 'ExpenseLineItem',
          entityId: input.id,
          actor: actorOf(ctx),
          details: { fields: Object.keys(input).filter((k) => k !== 'id') },
        },
        async (tx) =>
          tx.expenseLineItem.update({
            where: { id: input.id },
            data: {
              categoryId: input.categoryId,
              // A category change re-stamps; leaving the old account would post the
              // line to the account of a category it is no longer in. `undefined`
              // when the category was not touched, so an unrelated edit does not
              // silently refresh a snapshot.
              ...(input.categoryId
                ? { glAccountId: await glAccountIdForCategory(ctx.db, input.categoryId) }
                : {}),
              amountMinor: fin.amountMinor,
              kind: lineKind.kind,
              payload: lineKind.payload ?? Prisma.DbNull,
              ...fin.mileage,
              notes: input.notes,
            },
            select: { id: true },
          }),
      );
      // Category/amount change → the expense tax + recoverable re-derive.
      await recomputeTotals(ctx.db, line.expenseId);
      noteOverrides(ctx.db, line.expenseId, { lineItems: 'edited by hand' });
      return { ok: true as const };
    }),

  /** Delete a line item. Recomputes totals. */
  lineItemRemove: withPermission(P.expense.report.updateOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const line = await ctx.db.expenseLineItem.findUnique({
        where: { id: input.id },
        select: { expenseId: true },
      });
      if (!line) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertExpenseDraft(ctx, line.expenseId);
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.lineItemDelete,
          entityType: 'ExpenseLineItem',
          entityId: input.id,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => tx.expenseLineItem.delete({ where: { id: input.id } }),
      );
      await recomputeTotals(ctx.db, line.expenseId);
      // Any hand-edit of the itemization makes the human its author, and a rebuild
      // must stop replacing it wholesale. One marker rather than per-line diffing:
      // the question the rebuild asks is "may I touch these lines", and that has a
      // single answer.
      noteOverrides(ctx.db, line.expenseId, { lineItems: 'edited by hand' });
      return { ok: true as const };
    }),

  /** Set the expense-level tax: source + jurisdiction, and (for MANUAL/EXTRACTED)
   *  the paid GST/HST·QST·PST. The split + the recoverable ITC are then re-derived
   *  server-side across the expense's line categories (recomputeTotals). */
  expenseTaxUpdate: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        expenseId: z.string().uuid(),
        taxSource: z.enum(ExpenseTaxSource),
        taxJurisdictionId: z.string().uuid().nullish(),
        // Trusted only for MANUAL/EXTRACTED; ignored (reverse-calc'd) for CALCULATED.
        taxGstHstMinor: minorInput.nullish(),
        taxQstMinor: minorInput.nullish(),
        taxPstMinor: minorInput.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { reportId } = await assertExpenseDraft(ctx, input.expenseId);
      /**
       * Paid tax is bounded by the gross it was paid on.
       *
       * MANUAL / EXTRACTED figures are trusted verbatim from here to the ledger: the
       * engine takes them as the split, `allocateRecoverable` multiplies them by the
       * category ITC%, and the poster carves the recoverable out as its own GL line
       * with `net = gross − recoverable`. Nothing downstream compared them to the
       * gross, so $5,000.00 of GST typed against a $113.98 lunch posted a $2,500 ITC
       * receivable the company never paid and a NEGATIVE meals line — and the report
       * total, which is what the approver sees, stayed $113.98. The card-transaction
       * poster has had this guard ("tax is greater than or equal to the total") from
       * the start; the expense path did not.
       *
       * Checked against the RESULTING stored figures, since `undefined` here means
       * "leave that component as it is".
       */
      if (input.taxSource !== ExpenseTaxSource.CALCULATED) {
        const current = await ctx.db.expense.findUniqueOrThrow({
          where: { id: input.expenseId },
          select: {
            amountMinor: true,
            taxGstHstMinor: true,
            taxQstMinor: true,
            taxPstMinor: true,
            currency: { select: { code: true } },
          },
        });
        const next = (given: bigint | string | null | undefined, stored: bigint | null) =>
          given === undefined ? (stored ?? 0n) : given === null ? 0n : toMinor(given);
        const paid =
          next(input.taxGstHstMinor, current.taxGstHstMinor) +
          next(input.taxQstMinor, current.taxQstMinor) +
          next(input.taxPstMinor, current.taxPstMinor);
        if (paid > current.amountMinor) {
          throw taxExceedsAmountRefusal(
            'BAD_REQUEST',
            paid,
            current.amountMinor,
            current.currency.code,
          );
        }
      }
      // Persist the source/jurisdiction/paid amounts, then recomputeTotals
      // re-derives the split (CALCULATED) or keeps them (MANUAL/EXTRACTED) and
      // re-allocates the recoverable across the line categories.
      await ctx.db.expense.update({
        where: { id: input.expenseId },
        data: {
          taxSource: input.taxSource,
          taxJurisdictionId:
            input.taxJurisdictionId === undefined ? undefined : input.taxJurisdictionId,
          taxGstHstMinor: optMinor(input.taxGstHstMinor),
          taxQstMinor: optMinor(input.taxQstMinor),
          taxPstMinor: optMinor(input.taxPstMinor),
        },
      });
      await recomputeTotals(ctx.db, input.expenseId);
      const taxCurrency = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        select: { currency: { select: { code: true } } },
      });
      const code = taxCurrency?.currency.code ?? 'CAD';
      // MANUAL tax is the human disagreeing with the document. CALCULATED is them
      // handing the figure back to the engine, which is not an override at all —
      // hence the nulls, which clear any previous disagreement.
      const manual = input.taxSource === 'MANUAL';
      noteOverrides(ctx.db, input.expenseId, {
        taxGstHst: manual ? overrideAmount(input.taxGstHstMinor, code) : null,
        taxQst: manual ? overrideAmount(input.taxQstMinor, code) : null,
        taxPst: manual ? overrideAmount(input.taxPstMinor, code) : null,
      });
      return { ok: true as const, reportId };
    }),});
