/**
 * Receipt/invoice extraction via Claude vision + structured outputs.
 *
 * `extractReceipt` assumes the bytes are already AV-scanned CLEAN (the worker's
 * scan gate reads the object's GuardDuty Malware Protection tag before any bytes
 * are downloaded) and HEIC-normalized (`ImageNormalizer`). Degrades loudly when
 * no API key is configured (throws `ExtractionUnavailableError`) so the worker
 * can leave the extraction PENDING rather than crash.
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildExtractionSchema, type ReceiptExtraction } from './schema';

/** No API key configured — extraction can't run; leave the row PENDING. */
export class ExtractionUnavailableError extends Error {}
/** The model declined to process the document (safety refusal). */
export class ExtractionRefusedError extends Error {}

/**
 * Is this failure worth trying again, or is the document simply unreadable?
 *
 * The distinction decides whether a receipt self-heals or needs a person. It exists
 * because of a real outage: on 31 August two receipts in production came back
 * "Extraction failed", the cause was the AI provider's DAILY CAP, and the fix was to raise
 * the cap and re-run them by hand. Nothing retried, because the extraction handler is
 * best-effort and never throws — so a capacity blip and a corrupt PDF were recorded
 * identically and both waited for a human.
 *
 * TRANSIENT is deliberately narrow: rate limits, quota and credit exhaustion, provider
 * overload, gateway and timeout errors. Everything else — a refusal, an unreadable file, a
 * missing key, a model that returned nothing — is terminal, and retrying it five times
 * over an hour would just spend money to reach the same answer more slowly.
 *
 * Matched on BOTH the status code and the message. The SDK surfaces `status` for an API
 * error, but a socket that dies mid-request never gets one, and a 400 whose body says
 * "credit balance is too low" is a billing state that clears rather than a bad request.
 */
export function isTransientExtractionFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    // 429 rate limit · 529 overloaded (Anthropic) · 5xx gateway/server.
    if (status === 429 || status === 529 || (status >= 500 && status < 600)) return true;
  }
  const text = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return [
    'rate limit',
    'rate_limit',
    'overloaded',
    'quota',
    'credit balance',
    'daily limit',
    'too many requests',
    'timeout',
    'timed out',
    'etimedout',
    'econnreset',
    'socket hang up',
    'service unavailable',
  ].some((needle) => text.includes(needle));
}

export interface NormalizedImage {
  data: Uint8Array;
  mimeType: string;
}
/** Normalizes an upload to a model-supported image (HEIC→JPEG, etc.). The
 *  default is a passthrough; wire sharp/heic-convert at the worker. */
export interface ImageNormalizer {
  normalize(data: Uint8Array, mimeType: string): Promise<NormalizedImage>;
}
export const passthroughNormalizer: ImageNormalizer = {
  async normalize(data, mimeType) {
    return { data, mimeType };
  },
};

const SUPPORTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

export interface CategoryHint {
  code: string;
  label: string;
}

export interface ExtractInput {
  /** CLEAN, normalized document bytes. */
  data: Uint8Array;
  mimeType: string;
  /** Expense-category vocabulary the model may map `derivedCategoryCode` to. */
  categoryHints?: CategoryHint[];
  model?: string;
  apiKey?: string;
}

export interface ExtractResult {
  model: string;
  data: ReceiptExtraction;
  confidence: number | null;
  rawResponse: unknown;
}

/** Default extraction model. Sonnet balances quality and cost for high receipt
 *  volume; override per-deployment via the `RECEIPT_EXTRACTION_MODEL` env var
 *  (e.g. a Haiku tier for cheaper bulk, or an Opus tier for hard documents). */
export const DEFAULT_MODEL = 'claude-sonnet-5';

const TOOL_NAME = 'record_receipt';

const SYSTEM = `You extract structured data from a receipt or invoice image/PDF for an expense system.
Return only the fields defined by the schema. Rules:
- Amounts are decimal numbers in the document's own currency (e.g. 12.34); never convert currencies.
- currencyCode is the receipt's ISO-4217 currency (e.g. CAD, USD, EUR, JPY). Infer it from the currency symbol ($, €, £, ¥), an explicit code, the language, or the merchant address when it isn't printed outright — and disambiguate a bare "$" from context (e.g. a Canadian address → CAD, a US address → USD). Use null only when the currency is truly undeterminable.
- Distinguish a MANDATORY gratuity / auto service charge (labelled "gratuity"/"service charge", or "18% added for parties of N+", usually printed pre-tax) from a VOLUNTARY tip (a discretionary line, often handwritten or added after the total). This distinction is tax-relevant: mandatory gratuity is taxed, a voluntary tip is not.
- taxGstHst = GST or HST; taxQst = Quebec QST; taxPst = provincial PST/RST. Use null for any component that is absent. Report tax in these fields, never as line items.
- date is the date the charge SETTLED, as YYYY-MM-DD — the day the total became payable, not the day the service began. On a document covering a PERIOD (a hotel folio, a car rental, a subscription invoice) use the checkout / folio / invoice date, never the arrival or period-start date. When a payment or settlement row carries its own date, that row's date is the answer.
- time is the printed time as HH:MM (24-hour) that goes WITH the date above — the settlement moment, not the start of service. On a hotel folio that is the checkout / folio timestamp, never the arrival time. Null when the document prints no time; never infer one. It exists only to tell two otherwise-identical charges apart, so a time that belongs to a different event is worse than none.
- transactionId is the document's own transaction / reference / receipt / authorisation number, copied verbatim. Null when there isn't one. NEVER invent or derive it — it is used to tell two similar charges apart, so a made-up value is worse than none.
- Consolidate line items: when the document repeats the same charge across many rows or days (e.g. a multi-night hotel folio listing the same room/parking/fee each day), emit ONE line item per distinct charge type with the summed amount and its occurrence count in quantity — do NOT emit a separate line per day/row.
- confidence is your overall extraction confidence in [0,1]. Use null for any single field you cannot read.`;

function buildPrompt(hints?: CategoryHint[]): string {
  const base = 'Extract the receipt/invoice data from the attached document.';
  if (!hints?.length) return base;
  const list = hints.map((h) => `${h.code} (${h.label})`).join(', ');
  return (
    `${base}\nCategory codes (choose only from these; never invent one): ${list}.\n` +
    'Set derivedCategoryCode to the single code that best fits the whole receipt, or null if none fit.\n' +
    'For EACH line item, set its categoryCode to the code that fits that individual line if one clearly does, otherwise null — do not guess a line-level category.'
  );
}

/** Build the Messages request params for one document — the single shape shared
 *  by the synchronous `messages.create` call and each Batch API request, so
 *  sync and batch extraction are byte-identical. Forces a single tool call whose
 *  input IS the structured extraction (version-robust across SDK/API versions). */
export function buildRequestParams(input: {
  data: Uint8Array;
  mimeType: string;
  categoryHints?: CategoryHint[];
  model: string;
}): Anthropic.MessageCreateParamsNonStreaming {
  if (!SUPPORTED_MIME.has(input.mimeType)) {
    throw new Error(`Unsupported document type for extraction: ${input.mimeType}`);
  }
  const b64 = Buffer.from(input.data).toString('base64');
  const docBlock =
    input.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: b64 } };

  return {
    model: input.model,
    // Dense multi-page invoices (e.g. a multi-night hotel folio) emit many line
    // items; 4096 truncated the forced tool call mid-JSON and dropped lineItems.
    max_tokens: 16384,
    system: SYSTEM,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the structured data extracted from the receipt/invoice.',
        input_schema: buildExtractionSchema(
          input.categoryHints?.map((h) => h.code),
        ) as unknown as Anthropic.Tool['input_schema'],
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        // The SDK content-block param union is broad; the API validates the shape.
        content: [
          docBlock as Anthropic.ContentBlockParam,
          { type: 'text', text: buildPrompt(input.categoryHints) },
        ],
      },
    ],
  };
}

/** Pull the structured extraction out of a completed message (sync or batch).
 *  Throws `ExtractionRefusedError` when the model returned no tool call. */
export function parseExtractionMessage(message: Anthropic.Message): {
  data: ReceiptExtraction;
  confidence: number | null;
} {
  const toolUse = message.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new ExtractionRefusedError('Model did not return a structured extraction');
  }
  const data = toolUse.input as ReceiptExtraction;
  const confidence = typeof data.confidence === 'number' ? data.confidence : null;
  return { data, confidence };
}

function resolveKey(apiKey?: string): string {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ExtractionUnavailableError('ANTHROPIC_API_KEY is not configured');
  return key;
}

function resolveModel(model?: string): string {
  return model ?? process.env.RECEIPT_EXTRACTION_MODEL ?? DEFAULT_MODEL;
}

export async function extractReceipt(input: ExtractInput): Promise<ExtractResult> {
  const apiKey = resolveKey(input.apiKey);
  const model = resolveModel(input.model);
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    buildRequestParams({
      data: input.data,
      mimeType: input.mimeType,
      categoryHints: input.categoryHints,
      model,
    }),
  );
  const { data, confidence } = parseExtractionMessage(response);
  return { model, data, confidence, rawResponse: response };
}

// ── Batch API — used only when multiple receipts are uploaded together ──────

/** One document to extract in a batch. `customId` matches results back to the
 *  submitter (the worker uses the receipt id). */
export interface BatchItem {
  customId: string;
  data: Uint8Array;
  mimeType: string;
  categoryHints?: CategoryHint[];
}

/** Per-item batch result, keyed by `customId`. Either a parsed extraction or an
 *  error string (model refusal, an errored/expired/canceled batch entry). */
export interface BatchItemResult {
  customId: string;
  data?: ReceiptExtraction;
  confidence?: number | null;
  rawResponse?: unknown;
  error?: string;
}

/** Submit N documents as one Message Batch (~50% cheaper, async). Returns the
 *  batch id to poll. Throws `ExtractionUnavailableError` with no API key. */
export async function submitReceiptBatch(
  items: BatchItem[],
  opts: { apiKey?: string; model?: string } = {},
): Promise<{ batchId: string; model: string }> {
  const apiKey = resolveKey(opts.apiKey);
  const model = resolveModel(opts.model);
  const client = new Anthropic({ apiKey });
  const batch = await client.messages.batches.create({
    requests: items.map((it) => ({
      custom_id: it.customId,
      params: buildRequestParams({
        data: it.data,
        mimeType: it.mimeType,
        categoryHints: it.categoryHints,
        model,
      }),
    })),
  });
  return { batchId: batch.id, model };
}

/** Poll a batch's processing status. `'ended'` means every request settled. */
export async function retrieveReceiptBatch(
  batchId: string,
  opts: { apiKey?: string } = {},
): Promise<{ status: 'in_progress' | 'canceling' | 'ended' }> {
  const client = new Anthropic({ apiKey: resolveKey(opts.apiKey) });
  const batch = await client.messages.batches.retrieve(batchId);
  return { status: batch.processing_status };
}

/** Collect a finished batch's per-item results, parsing each succeeded entry
 *  into a `ReceiptExtraction`. Call only once the status is `'ended'`. */
export async function collectReceiptBatch(
  batchId: string,
  opts: { apiKey?: string } = {},
): Promise<BatchItemResult[]> {
  const client = new Anthropic({ apiKey: resolveKey(opts.apiKey) });
  const out: BatchItemResult[] = [];
  for await (const item of await client.messages.batches.results(batchId)) {
    const result = item.result;
    if (result.type === 'succeeded') {
      try {
        const { data, confidence } = parseExtractionMessage(result.message);
        out.push({ customId: item.custom_id, data, confidence, rawResponse: result.message });
      } catch (err) {
        out.push({
          customId: item.custom_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      out.push({ customId: item.custom_id, error: result.type });
    }
  }
  return out;
}
