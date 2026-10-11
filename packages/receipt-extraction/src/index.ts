/**
 * Public surface of `@expenseos/receipt-extraction`.
 *
 * A Claude-vision extractor that turns an uploaded receipt/invoice into
 * structured fields (vendor, date, total, tax split, tip vs mandatory gratuity,
 * line items, derived category). The worker composes an AV scan + HEIC
 * normalize ahead of `extractReceipt`; the resolved values feed the tax engine
 * and prefill honoring MANUAL > EXTRACTED > CALCULATED.
 */

// The JOINT determination — several documents, one expense, one answer (rule 2).
export {
  isReceiptContentType,
  RECEIPT_ACCEPT,
  RECEIPT_CONTENT_TYPES,
  type ReceiptContentType,
  receiptExtension,
} from './contentTypes';
export {
  buildDeterminationParams,
  buildDeterminationSchema,
  type DeterminationDocument,
  type DeterminationLineItem,
  type DetermineInput,
  type DetermineResult,
  DOCUMENT_KINDS,
  type DocumentKind,
  type DocumentVerdict,
  determineExpense,
  type ExpenseDeterminationResult,
  type PriorOverride,
  parseDeterminationMessage,
} from './determination';
export {
  type BatchItem,
  type BatchItemResult,
  buildRequestParams,
  type CategoryHint,
  collectReceiptBatch,
  DEFAULT_MODEL,
  type ExtractInput,
  ExtractionRefusedError,
  ExtractionUnavailableError,
  type ExtractResult,
  extractReceipt,
  type ImageNormalizer,
  isTransientExtractionFailure,
  type NormalizedImage,
  parseExtractionMessage,
  passthroughNormalizer,
  retrieveReceiptBatch,
  submitReceiptBatch,
} from './extract';
export {
  type DocumentGroup,
  type GroupCandidate,
  groupDocuments,
  normalizeVendor,
  pairReason,
  provesDistinct,
  totalsReconcile,
} from './grouping';
// Whether a document's line items are purchases or purchases-plus-tax — the gate
// on trusting per-line categories. See lineReconcile.ts for why it is arithmetic.
export { type LineReconciliation, reconcileLineItems } from './lineReconcile';
export {
  createSharpNormalizer,
  type SharpNormalizerOptions,
  sharpNormalizer,
} from './normalizer';
export { buildExtractionSchema, type ReceiptExtraction, type ReceiptLineItem } from './schema';
export {
  type MatchableExpense,
  matchStatementToExpenses,
  type StatementLine,
  type StatementMatch,
  statementCharges,
} from './statementMatch';
