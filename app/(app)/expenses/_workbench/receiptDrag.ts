/**
 * The drag contract for moving a receipt between expenses.
 *
 * A receipt row lives in the RIGHT pane and the expenses it can move to live in the
 * LEFT one, so the gesture crosses two components that render independently. Rather
 * than thread drag state through both — or a context that exists only while a mouse
 * button is down — the payload rides on the drag event itself.
 *
 * The custom MIME type is what makes the drop target able to highlight. The browser
 * hides dataTransfer VALUES during `dragover` (any page could otherwise read what you
 * are dragging), but it exposes the TYPES. So a target can ask "is this one of ours?"
 * mid-drag without being told anything by React.
 *
 * Lowercase deliberately: browsers normalise dataTransfer type strings to lowercase,
 * so a mixed-case constant compares unequal against what `types` reports.
 */

export const RECEIPT_DRAG_TYPE = 'application/x-expenseos-receipt';

export interface ReceiptDragPayload {
  receiptId: string;
  /** Where it is now, so a drop onto the same expense can be ignored. */
  fromExpenseId: string;
  filename: string;
}

export function setReceiptDrag(dt: DataTransfer, payload: ReceiptDragPayload): void {
  dt.setData(RECEIPT_DRAG_TYPE, JSON.stringify(payload));
  // A plain-text fallback so dropping onto something outside the app (an editor, a
  // chat box) yields the filename rather than nothing.
  dt.setData('text/plain', payload.filename);
  dt.effectAllowed = 'move';
}

/** Is the thing being dragged one of our receipts? Safe during `dragover`, where
 *  values are unreadable but types are not. */
export function isReceiptDrag(dt: DataTransfer | null): boolean {
  return dt ? Array.from(dt.types).includes(RECEIPT_DRAG_TYPE) : false;
}

/** The payload, or null when this is not our drag or the JSON is unreadable —
 *  a drop is not worth throwing over. */
export function readReceiptDrag(dt: DataTransfer | null): ReceiptDragPayload | null {
  if (!dt) return null;
  const raw = dt.getData(RECEIPT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReceiptDragPayload>;
    if (!parsed.receiptId || !parsed.fromExpenseId) return null;
    return {
      receiptId: parsed.receiptId,
      fromExpenseId: parsed.fromExpenseId,
      filename: parsed.filename ?? '',
    };
  } catch {
    return null;
  }
}
