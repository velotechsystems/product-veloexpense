/**
 * Which of these uploaded documents are the same charge?
 *
 * A bulk upload creates one expense per file, before anything has been read. So a
 * restaurant bill and its card copy become two expenses, each carrying the full
 * total, and the meal is claimed TWICE — both expenses individually well-formed,
 * nothing in the pipeline objecting. Grouping is what stops that.
 *
 * Two kinds of signal, and keeping them apart is the whole design:
 *
 *   · A DISTINCTNESS PROOF vetoes a group. A transaction id or a printed time can
 *     show two documents are different charges. Two waters from the same conference
 *     kiosk on the same day match vendor, date, currency AND total — every
 *     similarity signal fires and they are two real purchases. Their ids differ.
 *
 *   · SETTLEMENT EVIDENCE licenses one. Same vendor, same day, and totals that
 *     reconcile: equal, or one exceeding the other by a plausible tip the lower
 *     document doesn't itself show.
 *
 * Absence is never evidence. Plenty of receipts print no id and no time, so the
 * veto only fires when BOTH documents carry the field and they disagree.
 *
 * Deliberately not keyed on the document KIND. A restaurant bill with the tip
 * written on it is settlement evidence whether the classifier called it CARD_COPY
 * ("INCLUDING any tip written on it") or ITEMIZED_BILL ("usually WITHOUT the tip") —
 * keying the rule to the label would make a correct merge depend on a model
 * judgement landing the right way.
 *
 * Pure: no DB, no clock, no model call. It reads extractions that already happened.
 */

/** What grouping needs from one extracted document. A subset of `ReceiptExtraction`
 *  plus the ids the caller wants results keyed by. */
export interface GroupCandidate {
  documentId: string;
  expenseId: string;
  vendor: string | null;
  /** YYYY-MM-DD. */
  date: string | null;
  /** HH:MM, 24-hour. */
  time: string | null;
  transactionId: string | null;
  currencyCode: string | null;
  /** Major units, as extracted. */
  total: number | null;
  subtotal: number | null;
  /** A tip this document itself shows. A document that already accounts for its own
   *  tip is not the "lower" half of a tip differential. */
  voluntaryTip: number | null;
  /** 0–1. Silence requires confidence on BOTH sides. */
  confidence: number;
  /** RECEIPT · ITEMIZED_BILL · CARD_COPY · BANK_STATEMENT · OTHER. Used to pick the
   *  survivor and to exclude statements — never to license a merge. */
  kind: string;
}

export interface DocumentGroup {
  /** The document whose total is the charged amount — the expense to keep. */
  survivorExpenseId: string;
  /** Documents to move onto the survivor, and the expenses they vacate. */
  members: GroupCandidate[];
  /** Why, in a reviewer's words. Shown beside a merge and recorded on it. */
  reason: string;
  /** True when the evidence positively agrees and the merge can be silent. */
  confident: boolean;
}

/** A tip above this share of the bill is not a tip — it is a different charge that
 *  happens to be bigger. 30% is generous enough for a 25% tip on a rounded total. */
const MAX_TIP_RATIO = 0.3;
/** Times this far apart are different visits. Generous: a card copy is often stamped
 *  a few minutes after the bill is printed. */
const TIME_TOLERANCE_MINUTES = 20;
/** A card frequently settles the day after the meal. */
const DATE_TOLERANCE_DAYS = 1;

/**
 * Vendor names as they can actually be compared.
 *
 * Card descriptors are the same merchant wearing processor noise: `SQ *BLUE BOTTLE`,
 * `TST-Joe's Pizza`, `AMZN Mktp CA*1A2B3`, `UBER   *EATS`, a trailing store number.
 * Comparing raw strings would call those different vendors and miss the merge that
 * matters most.
 */
export function normalizeVendor(vendor: string | null): string {
  if (!vendor) return '';
  let v = vendor.toLowerCase();
  // Processor prefixes, then any leftover `xx*` descriptor marker.
  v = v.replace(/^(sq|tst|amzn|sp|pp|pay|wl)[\s*-]+/i, '');
  v = v.replace(/\*/g, ' ');
  // Trailing store / terminal numbers: "starbucks 04821", "shell #123".
  v = v.replace(/[\s#-]+\d{2,}\s*$/, '');
  v = v.replace(/[^a-z0-9]+/g, ' ').trim();
  return v;
}

function daysApart(a: string, b: string): number | null {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.abs(x - y) / 86_400_000;
}

function minutesOf(time: string | null): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Do these two documents PROVE they are different charges?
 *
 * Only ever a veto. Both sides must carry the field for a disagreement to mean
 * anything — one receipt printing an id and the other not is silence, not conflict.
 */
export function provesDistinct(a: GroupCandidate, b: GroupCandidate): string | null {
  const idA = a.transactionId?.trim();
  const idB = b.transactionId?.trim();
  if (idA && idB && idA.toLowerCase() !== idB.toLowerCase()) {
    return `different transaction ids (${idA} vs ${idB})`;
  }
  const tA = minutesOf(a.time);
  const tB = minutesOf(b.time);
  if (tA !== null && tB !== null && Math.abs(tA - tB) > TIME_TOLERANCE_MINUTES) {
    return `printed times ${a.time} and ${b.time} are too far apart`;
  }
  return null;
}

/**
 * Do the totals reconcile as one charge?
 *
 * Either equal, or the higher one is the lower plus a plausible tip — and the LOWER
 * document must not already show a tip of its own, because a document that accounts
 * for its own tip is a complete claim rather than the pre-tip half of a pair.
 */
export function totalsReconcile(a: GroupCandidate, b: GroupCandidate): string | null {
  if (a.total == null || b.total == null) return null;
  // Compared in cents: 113.00 and 113.0000001 are the same charge, and float
  // subtraction on major units invents differences. Converted BEFORE choosing which
  // side is lower, so neither total needs re-reading through a non-null assertion.
  const aC = Math.round(a.total * 100);
  const bC = Math.round(b.total * 100);
  const lo = aC <= bC ? a : b;
  const loC = Math.min(aC, bC);
  const hiC = Math.max(aC, bC);
  if (loC === hiC) return 'identical totals';
  if (loC <= 0) return null;
  if (lo.voluntaryTip != null && lo.voluntaryTip > 0) return null;
  const diff = hiC - loC;
  if (diff > loC * MAX_TIP_RATIO) return null;
  const pct = Math.round((diff / loC) * 100);
  return `${(diff / 100).toFixed(2)} tip on ${(loC / 100).toFixed(2)} (${pct}%)`;
}

/** Strength of a document as evidence of the amount CHARGED. The survivor is the
 *  strongest, so the kept expense already holds the charged total. */
const KIND_RANK: Record<string, number> = {
  BANK_STATEMENT: 4,
  CARD_COPY: 3,
  RECEIPT: 2,
  ITEMIZED_BILL: 1,
  OTHER: 0,
};

/** Could these two be the same charge? Returns the reason, or null. */
export function pairReason(a: GroupCandidate, b: GroupCandidate): string | null {
  // A statement evidences MANY charges. It joins the expenses it covers by being
  // copied onto each (see docs/design/receipt-grouping.md §6.2), never by pulling
  // them into one.
  if (a.kind === 'BANK_STATEMENT' || b.kind === 'BANK_STATEMENT') return null;
  if (provesDistinct(a, b)) return null;
  if (!a.currencyCode || a.currencyCode !== b.currencyCode) return null;
  const vendor = normalizeVendor(a.vendor);
  if (!vendor || vendor !== normalizeVendor(b.vendor)) return null;
  if (!a.date || !b.date) return null;
  const gap = daysApart(a.date, b.date);
  if (gap === null || gap > DATE_TOLERANCE_DAYS) return null;
  const reconciled = totalsReconcile(a, b);
  if (!reconciled) return null;
  // Two itemized bills for the same vendor and day are two meals, not a pair — a
  // pair is a bill and its settlement.
  if (a.kind === 'ITEMIZED_BILL' && b.kind === 'ITEMIZED_BILL') return null;
  return `same vendor and date, ${reconciled}`;
}

/**
 * Group an upload's documents.
 *
 * Single-linkage: A joins B's group when it pairs with ANY current member, so a
 * bill + merchant copy + customer copy land together rather than as two pairs. The
 * distinctness veto is re-checked against every member, so one conflicting id keeps
 * a document out of a group it would otherwise reach transitively.
 */
export function groupDocuments(
  candidates: readonly GroupCandidate[],
  confidenceThreshold = 0.7,
): DocumentGroup[] {
  const groups: GroupCandidate[][] = [];
  const reasons: string[][] = [];

  for (const doc of candidates) {
    let placed = false;
    for (const [i, group] of groups.entries()) {
      // Every member must be reachable AND none may prove distinctness.
      if (group.some((m) => provesDistinct(m, doc))) continue;
      const hit = group.map((m) => pairReason(m, doc)).find((r): r is string => r != null);
      if (!hit) continue;
      group.push(doc);
      reasons[i].push(hit);
      placed = true;
      break;
    }
    if (!placed) {
      groups.push([doc]);
      reasons.push([]);
    }
  }

  return groups
    .map((members, i) => ({ members, reason: reasons[i] }))
    .filter((g) => g.members.length > 1)
    .map((g) => {
      const survivor = [...g.members].sort(
        (x, y) => (KIND_RANK[y.kind] ?? 0) - (KIND_RANK[x.kind] ?? 0),
      )[0];
      return {
        survivorExpenseId: survivor.expenseId,
        members: g.members,
        reason: g.reason[0] ?? 'same charge',
        // Silence requires confidence on EVERY member. One shaky read is enough to
        // make a merge somebody should look at rather than one that just happens.
        confident: g.members.every((m) => m.confidence >= confidenceThreshold),
      };
    });
}
