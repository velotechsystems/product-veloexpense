/**
 * Structured-output schema for receipt/invoice extraction. Amounts are captured
 * as decimal numbers in the document's currency (e.g. 12.34) — the caller
 * converts to minor units. Every field is nullable so a partial/blurry document
 * still yields a valid object. `additionalProperties: false` + full `required`
 * lists satisfy the strict structured-outputs contract.
 */

export interface ReceiptLineItem {
  description: string;
  amount: number | null;
  quantity: number | null;
  /** One of the provided category codes for THIS line, or null when the model
   *  can't confidently map it (the prefill then falls back to the receipt-level
   *  `derivedCategoryCode`). Enum-constrained — never a guessed/invented code. */
  categoryCode: string | null;
}

export interface ReceiptExtraction {
  vendor: string | null;
  address: string | null;
  /** ISO date (YYYY-MM-DD) or null. */
  date: string | null;
  /**
   * Printed time of the transaction, 24-hour `HH:MM`, or null.
   *
   * Read for one purpose: telling two similar charges apart. Two coffees from the
   * same kiosk on the same day match vendor, date and total exactly and are two
   * real purchases; the times differ.
   */
  time: string | null;
  /**
   * The document's own transaction / reference / authorisation number, verbatim.
   *
   * The strongest evidence that two documents are NOT the same charge. Never
   * invented: a receipt that prints none yields null, and null proves nothing
   * either way.
   */
  transactionId: string | null;
  /** ISO-4217 code (e.g. "CAD") or null. */
  currencyCode: string | null;
  total: number | null;
  subtotal: number | null;
  taxGstHst: number | null;
  taxQst: number | null;
  taxPst: number | null;
  /** Auto-added service charge on large parties — taxable (CRA). */
  mandatoryGratuity: number | null;
  /** Discretionary tip — NOT taxed (CRA). */
  voluntaryTip: number | null;
  lineItems: ReceiptLineItem[];
  /** One of the provided category codes, or null if none fit. */
  derivedCategoryCode: string | null;
  /** Model's self-assessed confidence, 0–1. */
  confidence: number;
}

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

/**
 * JSON Schema for the extraction tool's `input_schema`. When `categoryCodes` is
 * provided, `derivedCategoryCode` is constrained to a finite `enum` of the real
 * `ExpenseCategory` codes (plus `null`) so the model cannot invent a category —
 * the returned fields drop straight into the Expense prefill. Other finite sets
 * with too-large domains (currency) stay free strings.
 */
export function buildExtractionSchema(categoryCodes?: readonly string[]): Record<string, unknown> {
  // A category field constrained to the real ExpenseCategory codes (+ null) so
  // the model can't invent one. Shared by the receipt-level `derivedCategoryCode`
  // and each line item's `categoryCode`.
  const categoryField =
    categoryCodes && categoryCodes.length > 0
      ? { type: ['string', 'null'], enum: [...categoryCodes, null] }
      : nullableString;

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      vendor: nullableString,
      address: nullableString,
      date: nullableString,
      time: nullableString,
      transactionId: nullableString,
      currencyCode: nullableString,
      total: nullableNumber,
      subtotal: nullableNumber,
      taxGstHst: nullableNumber,
      taxQst: nullableNumber,
      taxPst: nullableNumber,
      mandatoryGratuity: nullableNumber,
      voluntaryTip: nullableNumber,
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
          },
          required: ['description', 'amount', 'quantity', 'categoryCode'],
        },
      },
      derivedCategoryCode: categoryField,
      confidence: { type: 'number' },
    },
    required: [
      'vendor',
      'address',
      'date',
      'time',
      'transactionId',
      'currencyCode',
      'total',
      'subtotal',
      'taxGstHst',
      'taxQst',
      'taxPst',
      'mandatoryGratuity',
      'voluntaryTip',
      'lineItems',
      'derivedCategoryCode',
      'confidence',
    ],
  };
}
