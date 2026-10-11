/**
 * The JOINT determination: several documents, one expense, one answer.
 *
 * One document rarely proves a whole claim. A restaurant bill has the
 * itemization and the tax but not what was actually charged; the cardholder copy
 * has the tip and the final total but no line detail; a card or bank statement
 * has the settled amount in the employee's own currency, and therefore the FX
 * rate that was really applied. None of them is "primary".
 *
 * So the pass reads the WHOLE set at once and returns a single flat
 * determination for the expense, plus a classification of what each document
 * turned out to be. Reading them one at a time and merging afterwards is what
 * produces double-counted totals — the bill's $113 and the card copy's $113 are
 * the same money, and only a reader that sees both can know that.
 *
 * Two things make this safe to re-run, which it must be, because a second upload
 * changes the answer:
 *
 *   1. It is a REBUILD, not a merge. The caller wipes the derived state and
 *      applies this result, so the third upload doesn't inherit the second
 *      upload's mistakes.
 *   2. Human edits are sent IN. A person who corrected the total is telling us
 *      something the documents didn't, and that correction has to inform the new
 *      determination rather than be silently overwritten by it — and then be
 *      re-applied on top, because a rebuild that discards it is a rebuild that
 *      loses work.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type CategoryHint,
  DEFAULT_MODEL,
  ExtractionRefusedError,
  ExtractionUnavailableError,
  type NormalizedImage,
} from './extract';

/** Mirrors `ReceiptKind` in the schema. Kept as a literal union so this package
 *  stays free of a Prisma dependency. */
export const DOCUMENT_KINDS = [
  'RECEIPT',
  'ITEMIZED_BILL',
  'CARD_COPY',
  'BANK_STATEMENT',
  'OTHER',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** One document in the set, with the id the caller wants results keyed by. */
export interface DeterminationDocument extends NormalizedImage {
  /** The `Receipt.id`. Echoed back on the classification. */
  documentId: string;
  filename: string;
}

/** What the pass decided each document IS. */
export interface DocumentVerdict {
  documentId: string;
  kind: DocumentKind;
  /** One line on what this document contributed — shown in the UI beside the
   *  file, and the reason a reviewer can tell why a tip came from one file and
   *  the tax from another. */
  contributed: string | null;
}

export interface DeterminationLineItem {
  description: string;
  amount: number | null;
  quantity: number | null;
  categoryCode: string | null;
  /** The discretionary tip inside THIS line's `amount`, if the set shows one.
   *  Not an addition to it — the line total already includes it. */
  tip: number | null;
}

export interface ExpenseDeterminationResult {
  documents: DocumentVerdict[];
  vendor: string | null;
  address: string | null;
  date: string | null;
  currencyCode: string | null;
  /** The amount actually charged, as evidenced by the strongest document in the
   *  set (a card copy or statement beats a pre-tip bill). */
  total: number | null;
  subtotal: number | null;
  taxGstHst: number | null;
  taxQst: number | null;
  taxPst: number | null;
  lineItems: DeterminationLineItem[];
  derivedCategoryCode: string | null;
  /** Implied FX rate when a statement shows the same charge settled in another
   *  currency — `fxRate` converts `currencyCode` → `fxToCurrency`. */
  fxRate: number | null;
  fxToCurrency: string | null;
  /** What the set could NOT settle, in a reviewer's words. Surfaced rather than
   *  guessed around. */
  unresolved: string | null;
  confidence: number;
}

/**
 * A human's correction, as the determination is told about it. `value` is
 * rendered text rather than a typed union because it is going into a prompt, and
 * because the set of correctable fields is the UI's business, not this module's.
 */
export interface PriorOverride {
  field: string;
  value: string;
}

export interface DetermineInput {
  documents: DeterminationDocument[];
  categoryHints?: CategoryHint[];
  /** Edits a person already made to this expense. */
  overrides?: PriorOverride[];
  model?: string;
  apiKey?: string;
}

export interface DetermineResult {
  model: string;
  data: ExpenseDeterminationResult;
  confidence: number | null;
  rawResponse: unknown;
}

const TOOL_NAME = 'record_determination';

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

export function buildDeterminationSchema(
  documentIds: readonly string[],
  categoryCodes?: readonly string[],
): Record<string, unknown> {
  const categoryField =
    categoryCodes && categoryCodes.length > 0
      ? { type: ['string', 'null'], enum: [...categoryCodes, null] }
      : nullableString;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      documents: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Constrained to the ids actually sent, so a verdict can always be
            // matched back to a row.
            documentId: { type: 'string', enum: [...documentIds] },
            kind: { type: 'string', enum: [...DOCUMENT_KINDS] },
            contributed: nullableString,
          },
          required: ['documentId', 'kind', 'contributed'],
        },
      },
      vendor: nullableString,
      address: nullableString,
      date: nullableString,
      currencyCode: nullableString,
      total: nullableNumber,
      subtotal: nullableNumber,
      taxGstHst: nullableNumber,
      taxQst: nullableNumber,
      taxPst: nullableNumber,
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            amount: nullableNumber,
            quantity: nullableNumber,
            categoryCode: categoryField,
            tip: nullableNumber,
          },
          required: ['description', 'amount', 'quantity', 'categoryCode', 'tip'],
        },
      },
      derivedCategoryCode: categoryField,
      fxRate: nullableNumber,
      fxToCurrency: nullableString,
      unresolved: nullableString,
      confidence: { type: 'number' },
    },
    required: [
      'documents',
      'vendor',
      'address',
      'date',
      'currencyCode',
      'total',
      'subtotal',
      'taxGstHst',
      'taxQst',
      'taxPst',
      'lineItems',
      'derivedCategoryCode',
      'fxRate',
      'fxToCurrency',
      'unresolved',
      'confidence',
    ],
  };
}

const SYSTEM = `You determine ONE expense from a SET of documents that all describe the same purchase, for an expense system.

The documents are complementary, not alternatives. Typical roles:
- ITEMIZED_BILL — the restaurant/vendor bill: line detail and the tax breakdown, usually WITHOUT the tip.
- CARD_COPY — the cardholder slip or merchant copy: the amount actually charged, INCLUDING any tip written on it.
- BANK_STATEMENT — a card or bank statement line: the settled amount, often in the employee's own currency.
- RECEIPT — a plain receipt that stands on its own.
- OTHER — anything that isn't evidence of this charge.

Hard rules:
- They describe ONE purchase. NEVER add totals across documents. If the bill says 113.00 and the card copy says 130.00, the charge is 130.00 and the difference is a tip — not 243.00.
- total is what was ACTUALLY CHARGED. A card copy or statement outranks a pre-tip bill. A bill's printed total is only the answer when nothing better is present.
- Line items come from the ITEMIZED document. Their amounts must sum to total. When a tip made the charge exceed the bill, put that difference on the line it was left for as that line's \`tip\`, INCLUDED in that line's \`amount\` — never as a line of its own.
- Distinguish a discretionary TIP (handwritten, added after the printed total) from a MANDATORY gratuity or auto service charge ("18% for parties of 6+", printed pre-tax). Mandatory gratuity is taxable, so it is simply part of a line's amount and \`tip\` stays null for it.
- taxGstHst = GST or HST; taxQst = Quebec QST; taxPst = provincial PST/RST. Take these from whichever document prints the breakdown. Never report tax as a line item.
- currencyCode is the currency the CHARGE is in (ISO-4217). Infer it from the symbol, an explicit code, the language, or the merchant address; disambiguate a bare "$" from context.
- fxRate / fxToCurrency: set these ONLY when a statement shows this same charge settled in a DIFFERENT currency, and only when you can see both amounts. fxRate converts currencyCode → fxToCurrency. Otherwise both null. Never invent or recall a market rate.
- Consolidate repetition: a multi-night folio listing the same room charge each night is ONE line item with the summed amount and the night count in quantity.
- date is the transaction date, YYYY-MM-DD.
- Classify EVERY document you were given, using the documentId it was labelled with.
- unresolved: state plainly anything the set does not settle (e.g. "no tax breakdown on any document"). Null when nothing is outstanding.
- confidence is your overall confidence in [0,1].

If a human correction is listed, it is authoritative: they saw something the documents don't show. Reconcile the rest of your determination TO it — if they set the total, make the line items sum to their figure — and never contradict it.`;

function buildPrompt(input: {
  documents: DeterminationDocument[];
  categoryHints?: CategoryHint[];
  overrides?: PriorOverride[];
}): string {
  const parts = [`These ${input.documents.length} document(s) describe ONE expense. Determine it.`];
  if (input.categoryHints?.length) {
    const list = input.categoryHints.map((h) => `${h.code} (${h.label})`).join(', ');
    parts.push(
      `Category codes (choose only from these; never invent one): ${list}.\n` +
        'Set derivedCategoryCode to the code that best fits the whole expense, and each line item’s categoryCode to the code that fits that line if one clearly does, otherwise null.',
    );
  }
  if (input.overrides?.length) {
    parts.push(
      'A human has already corrected this expense. These values are authoritative — reconcile your determination to them:\n' +
        input.overrides.map((o) => `- ${o.field}: ${o.value}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

const SUPPORTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/** Build the one request that carries every document, each labelled with the id
 *  its verdict must come back under. The label block is what lets the model tie
 *  a classification to a file rather than to a position. */
export function buildDeterminationParams(input: {
  documents: DeterminationDocument[];
  categoryHints?: CategoryHint[];
  overrides?: PriorOverride[];
  model: string;
}): Anthropic.MessageCreateParamsNonStreaming {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const doc of input.documents) {
    if (!SUPPORTED_MIME.has(doc.mimeType)) {
      throw new Error(`Unsupported document type for determination: ${doc.mimeType}`);
    }
    content.push({
      type: 'text',
      text: `Document ${doc.documentId} — filename "${doc.filename}":`,
    });
    const b64 = Buffer.from(doc.data).toString('base64');
    content.push(
      (doc.mimeType === 'application/pdf'
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: b64 },
          }
        : {
            type: 'image',
            source: { type: 'base64', media_type: doc.mimeType, data: b64 },
          }) as Anthropic.ContentBlockParam,
    );
  }
  content.push({ type: 'text', text: buildPrompt(input) });

  return {
    model: input.model,
    // A whole document SET, and dense folios emit many lines — the same reason
    // single-document extraction needed 16k rather than 4k.
    max_tokens: 16384,
    system: SYSTEM,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the single determination for this expense.',
        input_schema: buildDeterminationSchema(
          input.documents.map((d) => d.documentId),
          input.categoryHints?.map((h) => h.code),
        ) as unknown as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content }],
  };
}

export function parseDeterminationMessage(message: Anthropic.Message): {
  data: ExpenseDeterminationResult;
  confidence: number | null;
} {
  const toolUse = message.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new ExtractionRefusedError('Model did not return a determination');
  }
  const data = toolUse.input as ExpenseDeterminationResult;
  return { data, confidence: typeof data.confidence === 'number' ? data.confidence : null };
}

function resolveKey(apiKey?: string): string {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ExtractionUnavailableError('ANTHROPIC_API_KEY is not configured');
  return key;
}

/** Run the joint determination over a document set. Throws
 *  `ExtractionUnavailableError` with no API key (the caller leaves the expense
 *  as-is) and `ExtractionRefusedError` when the model returns no tool call. */
export async function determineExpense(input: DetermineInput): Promise<DetermineResult> {
  if (input.documents.length === 0) {
    throw new Error('determineExpense requires at least one document');
  }
  const apiKey = resolveKey(input.apiKey);
  const model = input.model ?? process.env.RECEIPT_EXTRACTION_MODEL ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    buildDeterminationParams({
      documents: input.documents,
      categoryHints: input.categoryHints,
      overrides: input.overrides,
      model,
    }),
  );
  const { data, confidence } = parseDeterminationMessage(response);
  return { model, data, confidence, rawResponse: response };
}
