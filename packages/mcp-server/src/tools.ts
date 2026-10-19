/**
 * The tool registry — the complete set of things the assistant may do.
 *
 * **Curated, not derived.** There are 29 routers and several hundred procedures; exposing
 * them all would be useless (a model cannot choose well from hundreds of near-identical
 * tools) and unsafe (every procedure added later would become assistant-reachable with
 * nobody deciding that). So each entry here is a deliberate act with a diff attached.
 *
 * Every `path` is a real tRPC procedure and every `permission` is the one that procedure
 * actually declares. The registry describes the API; it does not define a parallel one.
 */

import { permissions as P } from '@expenseos/rbac';
import { z } from 'zod';
import type { ToolSpec } from './types';

/** A report/travel id. Every id in the product is a UUIDv7. */
const uuid = z.string().uuid();

/**
 * A trip endpoint, mirroring `placeInput` in `travelRequests`.
 *
 * Inlined for the same reason as `commentSubject`: this package must not depend on the
 * web app. The router validates the real schema on every call, so a drift here is a
 * rejected call rather than a wrong write.
 *
 * `placeId` is Google's and is what makes a place resolvable to airports later — a
 * hand-built label with no id produces a request that cannot be priced, which is why
 * `search_travel_destinations` exists rather than letting the model compose one.
 */
const travelPlace = z.object({
  placeId: z.string().trim().max(400).nullish(),
  label: z.string().trim().min(1).max(300),
  city: z.string().trim().max(200).nullish(),
  country: z.string().trim().max(200).nullish(),
  airport: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'An IATA code is three uppercase letters.')
    .nullish(),
});

/**
 * The subjects that carry a discussion thread, mirroring `ACTIVITY_SUBJECT` in
 * @expenseos/notifications. Inlined rather than imported so this package stays free of
 * the notifications dependency chain; `commentsRouter` validates against the real enum on
 * every call, so a drift here is a rejected call rather than a wrong write.
 */
const commentSubject = z.enum(['EXPENSE_REPORT', 'TRAVEL_REQUEST']);

/**
 * The platform module the chat is gated on, mirroring `ASSISTANT_MODULE_SLUG` in
 * @expenseos/assistant. Inlined for the same reason as above, and here it is not optional:
 * @expenseos/assistant depends on THIS package, so importing it back would be a cycle.
 */
const ASSISTANT_MODULE_SLUG = 'assistant';

/**
 * What `sizeBytes` means on a tool whose answer is an upload link. The link is signed for
 * that exact length (`UploadUrlInput.contentLength` in @expenseos/storage), so "up to" would
 * be wrong: a model sending a cap instead of the real size would have every PUT refused.
 */
const EXACT_SIZE_BYTES =
  'The exact byte length of the file you will PUT — not an estimate, and not valid for a ' +
  'chunked/unsized body. The upload link is bound to this exact number; a different length ' +
  'is refused by storage before any bytes are stored.';

export const TOOLS: readonly ToolSpec[] = [
  // ── Expense reports — reads ──────────────────────────────────────────────
  {
    name: 'list_my_expense_reports',
    description:
      "List the signed-in person's own expense reports, newest first. Call this when they " +
      'ask about their reports in general ("what have I got open?", "did my October report ' +
      'go through?") rather than naming one. Returns ids you can pass to ' +
      '`get_expense_report`.',
    input: z.object({
      /**
       * Free-form rather than an enum on purpose: the status vocabulary lives in the
       * Prisma schema, and duplicating it here would give two lists that drift. An
       * unknown value is rejected by the procedure with a clear message the model can
       * correct from, which is the cheaper failure.
       */
      status: z
        .string()
        .optional()
        .describe('Filter by report status, e.g. DRAFT, SUBMITTED, APPROVED, REJECTED.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
    }),
    path: 'expenses.list',
    kind: 'read',
    scope: 'expense_management.expense_report',
    access: 'read',
    permission: P.expense.report.readOwn,
  },
  {
    name: 'get_expense_report',
    description:
      'Read one expense report in full — its expenses, line items, totals, tax split, ' +
      'policy violations and approval state. Call this whenever the person refers to a ' +
      'specific report, and before answering any question about its contents or status. ' +
      'Visible to the submitter, their manager, anyone a task touched, and anyone eligible ' +
      'to decide it.',
    input: z.object({ reportId: uuid }),
    path: 'expenses.report',
    kind: 'read',
    scope: 'expense_management.expense_report',
    access: 'read',
  },
  {
    name: 'explain_expense_tax',
    description:
      'Explain why one expense has the tax and recoverable-ITC figures it has, by re-running ' +
      'the real tax engine and returning its trace. Call this for ANY question about why a ' +
      'tax or credit amount is what it is — especially "why is my recoverable ITC $0?" — ' +
      'instead of reasoning about the numbers yourself. The trace names the actual cause: ' +
      'a foreign jurisdiction, a legal entity that cannot reclaim, an expense with no line ' +
      'items, a category that recovers nothing, a zero somebody entered, or rounding. Those ' +
      'are different answers and only one is true for a given expense. Takes the EXPENSE id, ' +
      'not the report id — read the report first if you only have that.',
    input: z.object({ expenseId: uuid }),
    path: 'expenses.explainTax',
    kind: 'read',
    scope: 'expense_management.expense_report',
    access: 'read',
  },
  // VeloExpense (w6-03): ExpenseOS's `explain_per_diem` (expenses.explainPerDiem) is not
  // ported yet — VeloExpense's expenses router has no `explainPerDiem` until that slice of
  // ExpenseOS's router arrives (server/routers/expenses.ts). It returns with the procedure.
  {
    name: 'list_my_approval_tasks',
    description:
      'List the expense-report approvals waiting on the signed-in person. Call this for ' +
      '"what needs my approval?", "is anything waiting on me?", or before offering to ' +
      'approve anything. Returns task ids for `decide_expense_report`.',
    input: z.object({}),
    path: 'expenseApprovals.myTasks',
    kind: 'read',
    scope: 'expense_management.expense_approval',
    access: 'read',
  },

  // ── Expense reports — mutations ──────────────────────────────────────────
  {
    name: 'submit_expense_report',
    description:
      'Submit a draft expense report for approval. This starts the approval workflow and ' +
      'notifies the approver. Only the submitter can do this, and only from DRAFT or ' +
      'RETURNED. Check the report with `get_expense_report` first — submitting one with ' +
      "unresolved policy violations wastes an approver's time.",
    input: z.object({ reportId: uuid }),
    path: 'expenses.submit',
    kind: 'mutate',
    scope: 'expense_management.expense_report',
    access: 'write',
    permission: P.expense.report.createOwn,
  },
  {
    name: 'recall_expense_report',
    description:
      'Pull a submitted expense report back out of approval, returning it to the ' +
      'submitter for editing. Only the submitter can recall, and only while no decision ' +
      'has been made.',
    input: z.object({ reportId: uuid }),
    path: 'expenses.recall',
    kind: 'mutate',
    scope: 'expense_management.expense_report',
    access: 'write',
    permission: P.expense.report.createOwn,
  },
  {
    name: 'decide_expense_report',
    description:
      'Approve or reject an expense report approval task assigned to the signed-in ' +
      'person. `approve: false` REJECTS the report outright — to send it back for ' +
      'correction instead, use `return_expense_report_for_edit`, which is almost always ' +
      'what someone means by "send it back". A note is strongly recommended on a ' +
      'rejection: it is what the claimant reads.',
    input: z.object({
      taskId: uuid.describe('From `list_my_approval_tasks`.'),
      approve: z.boolean(),
      note: z.string().trim().max(2000).optional(),
    }),
    path: 'expenseApprovals.decide',
    kind: 'mutate',
    scope: 'expense_management.expense_approval',
    access: 'write',
  },
  {
    name: 'return_expense_report_for_edit',
    description:
      'Send an expense report back to its submitter for correction, keeping it alive ' +
      'rather than rejecting it. The note explains what to fix and is the whole point of ' +
      'the action — always include one.',
    input: z.object({
      reportId: uuid,
      note: z.string().trim().max(2000).optional(),
    }),
    path: 'expenseApprovals.returnForEdit',
    kind: 'mutate',
    scope: 'expense_management.expense_approval',
    access: 'write',
  },

  // ── Knowledge base ───────────────────────────────────────────────────────
  {
    name: 'search_help_articles',
    description:
      'Search the authored ExpenseOS guidance and read what matches. Call this BEFORE ' +
      'describing any ExpenseOS procedure, rule or rate — how to do something, what happens ' +
      'after an action, what a term means in this product. Explaining general background you ' +
      'already know (what an input tax credit is, in the abstract) does not need it; stating ' +
      'how THIS product behaves does. If it returns nothing, say you have no guidance on that ' +
      'rather than describing the product from memory.\n\n' +
      'The corpus is written in English. Restate the need in English yourself, however the ' +
      'person asked — `terms` and `intent` are both English even for a French question, and ' +
      'your ANSWER is in their language. Give several surface forms in `terms` ("claim", ' +
      '"claiming", "per diem", "per-diem"): the index has no stemmer and you are what stands ' +
      'in for one. Cite the articles you used by title.',
    input: z.object({
      terms: z
        .array(z.string().trim().min(1).max(80))
        .min(1)
        .max(12)
        .describe('English search terms, several surface forms of each idea.'),
      intent: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          'One sentence, in English, saying what the person needs. Each article is read ' +
            'against this, so it decides what gets quoted back.',
        ),
      limit: z.number().int().min(1).max(10).optional().describe('Default 8.'),
    }),
    path: 'assistant.searchArticles',
    kind: 'read',
    scope: 'expense_management.expense_report',
    access: 'read',
    moduleSlug: ASSISTANT_MODULE_SLUG,
  },

  // ── Receipts ─────────────────────────────────────────────────────────────
  //
  // The upload is a THREE-party dance and the model is not one of them: the caller PUTs the
  // bytes to the presigned URL, S3 holds them, and the extraction pipeline reads them behind
  // the malware gate. Nothing here ever puts a receipt in front of the model — a figure it
  // read off a photograph is exactly the invented number the system prompt forbids.
  {
    name: 'start_expense_report_from_receipts',
    description:
      'Create a new expense report with one blank expense per receipt, and get an upload ' +
      'URL for each file. Call this for "file these receipts", "start a report from this ' +
      'photo", or any receipt the person has not filed yet — but see ' +
      '`add_receipts_to_expense_report` when they mean a report that already exists. ' +
      'Give the report a real title from what they told you, not "Untitled report". ' +
      'You do NOT read the receipts: after each file is uploaded, ExpenseOS scans it and ' +
      'extracts the merchant, date, amount and tax itself. Returns `uploads`, each with a ' +
      '`url` to PUT the file to and the `headers` to send with it; a caller that cannot ' +
      'make that PUT should give the person the `reportUrl` from the response and say the ' +
      'receipts still need uploading there — the report and its blank expenses are already ' +
      'waiting. Do not paraphrase that URL or rebuild it from the report id; pass on exactly ' +
      'the one returned.',
    input: z.object({
      title: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("What the report is for, in the person's own words where they gave any."),
      currency: z
        .string()
        .min(3)
        .optional()
        .describe("ISO-4217 code. Defaults to the person's home currency."),
      files: z
        .array(
          z.object({
            filename: z.string().trim().min(1).max(255),
            contentType: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .describe(
                'image/jpeg, image/png, image/webp, image/heic, image/heif or ' +
                  'application/pdf. Anything else is rejected.',
              ),
            sizeBytes: z.number().int().positive().describe(EXACT_SIZE_BYTES),
          }),
        )
        .min(1)
        .max(50)
        .describe('One entry per receipt, in the order the person gave them.'),
    }),
    path: 'expenses.startFromReceipts',
    kind: 'mutate',
    scope: 'expense_management.expense_report',
    access: 'write',
    permission: P.expense.report.createOwn,
  },
  {
    name: 'add_receipts_to_expense_report',
    description:
      'Add one blank expense per receipt to a report that ALREADY exists, and get an ' +
      'upload URL for each. Call this when the person means a particular report — "add ' +
      'this to my October report", or a receipt dropped while they are looking at one. ' +
      'The report must be a draft or have been returned for edit; a submitted one has to ' +
      'be recalled first, which is their decision to make, not yours. Returns `uploads` to ' +
      'PUT to, and a `reportUrl` to hand over if you cannot make those requests yourself.',
    input: z.object({
      reportId: uuid.describe('From `list_my_expense_reports`, or the report on screen.'),
      files: z
        .array(
          z.object({
            filename: z.string().trim().min(1).max(255),
            contentType: z.string().trim().min(1).max(120),
            sizeBytes: z.number().int().positive().describe(EXACT_SIZE_BYTES),
          }),
        )
        .min(1)
        .max(50),
    }),
    path: 'expenses.addReceiptExpenses',
    kind: 'mutate',
    scope: 'expense_management.expense_report',
    access: 'write',
    permission: P.expense.report.updateOwn,
  },
  {
    name: 'register_uploaded_receipt',
    description:
      'File a receipt you have already PUT to its upload URL, which starts the malware ' +
      'scan and the extraction that fills in the expense. Call it once per file, with the ' +
      '`expenseId` and `key` from the same `uploads` entry whose `url` you uploaded to. ' +
      'Skip any file whose PUT failed — registering one that was never uploaded produces ' +
      'an expense with a receipt that is not there.',
    input: z.object({
      expenseId: uuid,
      key: z.string().trim().min(1).max(512).describe('The `key` from the uploads entry.'),
      filename: z.string().trim().min(1).max(255),
      contentType: z.string().trim().min(1).max(120),
      sizeBytes: z.number().int().positive(),
    }),
    path: 'expenses.receiptCreate',
    kind: 'mutate',
    scope: 'expense_management.expense_report',
    access: 'write',
    permission: P.expense.report.updateOwn,
    // MCP only. In the panel the browser does this itself over tRPC the moment the PUT
    // finishes, so offering it to the chat model would ask it to carry an S3 key across a
    // turn boundary — and a key it half-remembers is a receipt filed against nothing.
    surfaces: ['mcp'],
  },

  // ── Travel ──────────────────────────────────────────────────────────────
  {
    name: 'list_my_travel_requests',
    description:
      "List the signed-in person's own travel requests. Call this for questions about " +
      'their trips before naming a specific one.',
    input: z.object({}),
    path: 'travelRequests.listOwn',
    kind: 'read',
    scope: 'travel.travel_request',
    access: 'read',
  },
  {
    name: 'get_travel_request',
    description:
      'Read one travel request in full — itinerary, estimated cost, budget check and ' +
      'approval state.',
    input: z.object({ id: uuid }),
    path: 'travelRequests.get',
    kind: 'read',
    scope: 'travel.travel_request',
    access: 'read',
  },
  {
    name: 'submit_travel_request',
    description:
      'Submit a draft travel request for approval. Pre-trip approval is the point of the ' +
      'request, so this is the action that matters — a request left in draft approves ' +
      'nothing.',
    input: z.object({ id: uuid }),
    path: 'travelRequests.submit',
    kind: 'mutate',
    scope: 'travel.travel_request',
    access: 'write',
    permission: P.travel.request.submitOwn,
  },

  {
    name: 'search_travel_destinations',
    description:
      'Resolve a place name to the destination/origin object `create_travel_request` ' +
      'needs. Call this FIRST for both ends of the trip — the create refuses a place it ' +
      'cannot identify, and a hand-built one will not price. Returns candidates; if more ' +
      'than one could be meant, ask rather than guessing which Springfield.',
    input: z.object({
      // min(3) mirrors the procedure — a two-character query is rejected there.
      query: z.string().trim().min(3).describe('A city or airport, e.g. "Toronto" or "YYZ".'),
    }),
    path: 'travelRequests.searchDestinations',
    kind: 'read',
    scope: 'travel.travel_request',
    access: 'read',
    permission: P.travel.request.createOwn,
  },
  {
    name: 'get_travel_request_options',
    description:
      'The currencies and trip settings a travel request can be filed with, with the ' +
      "traveller's own defaults. Call this before `create_travel_request` to get a real " +
      '`currencyId` — it is a uuid, and a guessed one is rejected.',
    input: z.object({}),
    path: 'travelRequests.formOptions',
    kind: 'read',
    scope: 'travel.travel_request',
    access: 'read',
    permission: P.travel.request.createOwn,
  },
  {
    name: 'create_travel_request',
    description:
      'Create a travel request as a DRAFT. It approves nothing on its own — follow with ' +
      '`submit_travel_request` once the traveller confirms the trip is right, which is ' +
      'the step that starts approval. Resolve both `destination` and `origin` with ' +
      '`search_travel_destinations` and take `currencyId` from `get_travel_request_options`; ' +
      'a ROUND_TRIP requires `returnDate`. Budget lines are optional and can be added on ' +
      'the trip afterwards.',
    input: z.object({
      purpose: z.string().trim().min(3).max(2000).describe('Why the trip is necessary.'),
      notes: z.string().trim().max(4000).nullish(),
      destination: travelPlace.describe('From `search_travel_destinations`.'),
      origin: travelPlace.describe('Where they fly FROM. Never assumed — ask if unstated.'),
      tripType: z.enum(['ROUND_TRIP', 'ONE_WAY', 'MULTI_CITY']).default('ROUND_TRIP'),
      departDate: z.string().datetime(),
      returnDate: z.string().datetime().nullish(),
      includeCar: z.boolean().default(false),
      currencyId: uuid.describe('From `get_travel_request_options`.'),
    }),
    path: 'travelRequests.create',
    kind: 'mutate',
    scope: 'travel.travel_request',
    access: 'write',
    permission: P.travel.request.createOwn,
  },
  {
    name: 'decide_travel_request',
    description:
      'Approve or reject a TRAVEL approval task assigned to the signed-in person. ' +
      'Travel approval is pre-trip: rejecting it means the trip should not be taken, so ' +
      'a note is what the traveller reads to know why. `taskId` comes from ' +
      '`list_my_travel_approval_tasks` — an expense-report task id will be refused.',
    input: z.object({
      taskId: uuid.describe('From `list_my_travel_approval_tasks`.'),
      approve: z.boolean(),
      note: z.string().trim().max(2000).optional(),
    }),
    path: 'travelRequests.decide',
    kind: 'mutate',
    scope: 'travel.travel_approval',
    access: 'write',
  },
  {
    name: 'list_my_travel_approval_tasks',
    description:
      'List the TRAVEL approvals waiting on the signed-in person. Separate from ' +
      '`list_my_approval_tasks`, which is expense reports only — "what needs my ' +
      'approval?" may need both.',
    input: z.object({}),
    path: 'travelRequests.myTasks',
    kind: 'read',
    scope: 'travel.travel_approval',
    access: 'read',
  },

  // ── Discussion ──────────────────────────────────────────────────────────
  {
    name: 'read_discussion_thread',
    description:
      'Read the discussion on an expense report or travel request — comments and system ' +
      'events (submitted, returned, approved) interleaved in one chronological stream. ' +
      'Call this when asked why something was returned or what was said about it; the ' +
      'reason is usually in the thread rather than in the record.',
    input: z.object({ subjectType: commentSubject, subjectId: uuid }),
    path: 'comments.thread',
    kind: 'read',
    scope: 'collaboration.discussion',
    access: 'read',
  },
  {
    name: 'post_comment',
    description:
      'Post a comment to the discussion on an expense report or travel request. It ' +
      'notifies the other participants by email and Slack, so it reaches people — write ' +
      'it as a message to a colleague, not as a log line.',
    input: z.object({
      subjectType: commentSubject,
      subjectId: uuid,
      body: z.string().min(1).max(4000),
    }),
    path: 'comments.post',
    kind: 'mutate',
    scope: 'collaboration.discussion',
    access: 'write',
  },

  // ── Budgets (module-gated) ──────────────────────────────────────────────
  // VeloExpense (w6-03): ExpenseOS's `list_budgets` (budgets.list) is not ported —
  // VeloExpense's budgets screen (the `budgets` module) has no tRPC router to point it at.

  // VeloExpense (w6-03): ExpenseOS's nine virtual-card tools (list_virtual_cards,
  // set_virtual_card_status, get_virtual_card_request_options, list_my_virtual_card_requests,
  // get_virtual_card_request, request_virtual_card, cancel_virtual_card_request,
  // list_my_card_approval_tasks, decide_virtual_card_request) are not ported: VeloExpense has
  // no virtual cards (d50), so each would point at a procedure that does not exist.
  // ExpenseOS's registry has no NetSuite tool (d80), so there is nothing to remove for it.
] as const;

/** Look a tool up by the name the model called. */
export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
