import { describe, expect, it } from 'vitest';
import {
  type GroupCandidate,
  groupDocuments,
  normalizeVendor,
  pairReason,
  provesDistinct,
  totalsReconcile,
} from './grouping';

/**
 * The scenario this exists for: a restaurant bill + its card copy, an Uber, a hotel
 * and a flight uploaded together — five files, four expenses.
 *
 * And the scenario that makes silence dangerous: two identical purchases from the
 * same kiosk on the same day, which match every similarity signal and are two real
 * charges. The transaction-id veto is what separates the two, so most of what is
 * pinned here is the veto refusing to merge.
 */

function doc(over: Partial<GroupCandidate> = {}): GroupCandidate {
  return {
    documentId: 'd1',
    expenseId: 'e1',
    vendor: 'Joe’s Pizza',
    date: '2026-08-05',
    time: null,
    transactionId: null,
    currencyCode: 'CAD',
    total: 113,
    subtotal: 100,
    voluntaryTip: null,
    confidence: 0.95,
    kind: 'ITEMIZED_BILL',
    ...over,
  };
}

const BILL = doc({ documentId: 'bill', expenseId: 'e-bill', total: 113 });
const CARD = doc({
  documentId: 'card',
  expenseId: 'e-card',
  total: 130,
  kind: 'CARD_COPY',
  subtotal: null,
});

describe('normalizeVendor', () => {
  it('strips processor descriptors so the same merchant compares equal', () => {
    expect(normalizeVendor('SQ *BLUE BOTTLE')).toBe(normalizeVendor('Blue Bottle'));
    expect(normalizeVendor("TST-Joe's Pizza")).toBe(normalizeVendor("Joe's Pizza"));
    expect(normalizeVendor('UBER   *EATS')).toBe(normalizeVendor('Uber Eats'));
  });

  it('strips a trailing store or terminal number', () => {
    expect(normalizeVendor('STARBUCKS 04821')).toBe(normalizeVendor('Starbucks'));
    expect(normalizeVendor('SHELL #123')).toBe(normalizeVendor('Shell'));
  });

  it('keeps genuinely different merchants apart', () => {
    expect(normalizeVendor('Blue Bottle')).not.toBe(normalizeVendor('Black Bottle'));
  });

  it('is empty for a missing vendor, which never matches anything', () => {
    expect(normalizeVendor(null)).toBe('');
  });
});

describe('provesDistinct', () => {
  it('vetoes on differing transaction ids', () => {
    const a = doc({ transactionId: 'A-1001' });
    const b = doc({ transactionId: 'A-1002' });
    expect(provesDistinct(a, b)).toMatch(/different transaction ids/);
  });

  it('is silent when only one side carries an id — absence proves nothing', () => {
    expect(provesDistinct(doc({ transactionId: 'A-1001' }), doc())).toBeNull();
  });

  it('treats the same id in different case as the same charge', () => {
    expect(
      provesDistinct(doc({ transactionId: 'abc1' }), doc({ transactionId: 'ABC1' })),
    ).toBeNull();
  });

  it('vetoes on times far apart, and tolerates a card stamped minutes later', () => {
    expect(provesDistinct(doc({ time: '12:05' }), doc({ time: '19:40' }))).toMatch(/times/);
    expect(provesDistinct(doc({ time: '19:31' }), doc({ time: '19:44' }))).toBeNull();
  });

  it('ignores an unparseable time rather than treating it as a conflict', () => {
    expect(provesDistinct(doc({ time: 'evening' }), doc({ time: '19:44' }))).toBeNull();
  });
});

describe('totalsReconcile', () => {
  it('accepts a plausible tip differential', () => {
    expect(totalsReconcile(BILL, CARD)).toMatch(/17\.00 tip on 113\.00 \(15%\)/);
  });

  it('accepts identical totals', () => {
    expect(totalsReconcile(doc({ total: 42 }), doc({ total: 42 }))).toBe('identical totals');
  });

  it('rejects a difference too big to be a tip', () => {
    expect(totalsReconcile(doc({ total: 100 }), doc({ total: 200 }))).toBeNull();
  });

  it('rejects when the lower document already shows its own tip', () => {
    // A document that accounts for its own tip is a complete claim, not the pre-tip
    // half of a pair.
    const withTip = doc({ total: 113, voluntaryTip: 13 });
    expect(totalsReconcile(withTip, doc({ total: 130, kind: 'CARD_COPY' }))).toBeNull();
  });

  it('compares in cents, so float noise is not a difference', () => {
    expect(totalsReconcile(doc({ total: 113.0 }), doc({ total: 113.000000001 }))).toBe(
      'identical totals',
    );
  });

  it('is null when either total is missing', () => {
    expect(totalsReconcile(doc({ total: null }), doc({ total: 113 }))).toBeNull();
  });
});

describe('pairReason', () => {
  it('pairs a bill with its card copy', () => {
    expect(pairReason(BILL, CARD)).toMatch(/same vendor and date/);
  });

  it('refuses two itemized bills for the same vendor and day', () => {
    // Two dinners at the same restaurant are two dinners.
    expect(pairReason(BILL, doc({ expenseId: 'e2', total: 113 }))).toBeNull();
  });

  it('refuses across currencies', () => {
    expect(pairReason(BILL, doc({ ...CARD, currencyCode: 'USD' }))).toBeNull();
  });

  it('tolerates a next-day card settlement but not a week later', () => {
    expect(pairReason(BILL, { ...CARD, date: '2026-08-06' })).toMatch(/same vendor/);
    expect(pairReason(BILL, { ...CARD, date: '2026-08-12' })).toBeNull();
  });

  it('never pairs a bank statement — it evidences many charges', () => {
    expect(pairReason(BILL, { ...CARD, kind: 'BANK_STATEMENT' })).toBeNull();
  });

  it('lets the transaction-id veto beat every similarity signal', () => {
    const a = doc({ transactionId: 'T-1' });
    const b = doc({ ...CARD, transactionId: 'T-2' });
    expect(pairReason(a, b)).toBeNull();
  });
});

describe('groupDocuments — the reported upload', () => {
  const uber = doc({
    documentId: 'uber',
    expenseId: 'e-uber',
    vendor: 'Uber',
    total: 24.5,
    kind: 'RECEIPT',
  });
  const hotel = doc({
    documentId: 'hotel',
    expenseId: 'e-hotel',
    vendor: 'Hilton',
    total: 410,
    kind: 'RECEIPT',
  });
  const flight = doc({
    documentId: 'flight',
    expenseId: 'e-flight',
    vendor: 'Air Canada',
    total: 742,
    kind: 'RECEIPT',
  });

  it('finds exactly one group: the restaurant pair', () => {
    const groups = groupDocuments([BILL, CARD, uber, hotel, flight]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.documentId).sort()).toEqual(['bill', 'card']);
  });

  it('keeps the card copy as survivor, so the total is the charged amount', () => {
    const [group] = groupDocuments([BILL, CARD]);
    expect(group.survivorExpenseId).toBe('e-card');
    expect(group.confident).toBe(true);
  });

  it('gathers three documents for one meal rather than two pairs', () => {
    const merchantCopy = doc({
      documentId: 'merchant',
      expenseId: 'e-merch',
      total: 130,
      kind: 'CARD_COPY',
    });
    const [group] = groupDocuments([BILL, CARD, merchantCopy]);
    expect(group.members).toHaveLength(3);
  });

  it('leaves two identical kiosk purchases alone when the ids differ', () => {
    // The case that makes a silent merge dangerous, and the reason the veto exists.
    const water1 = doc({
      documentId: 'w1',
      expenseId: 'e-w1',
      vendor: 'Conference Kiosk',
      total: 4.5,
      transactionId: '000871',
      time: '09:12',
      kind: 'RECEIPT',
    });
    const water2 = doc({
      documentId: 'w2',
      expenseId: 'e-w2',
      vendor: 'Conference Kiosk',
      total: 4.5,
      transactionId: '000944',
      time: '14:37',
      kind: 'RECEIPT',
    });
    expect(groupDocuments([water1, water2])).toEqual([]);
  });

  it('withholds silence when any member was read with low confidence', () => {
    const [group] = groupDocuments([BILL, { ...CARD, confidence: 0.4 }]);
    expect(group.members).toHaveLength(2);
    expect(group.confident).toBe(false);
  });

  it('returns nothing for a single document', () => {
    expect(groupDocuments([BILL])).toEqual([]);
  });

  it('groups nothing when every document is a different charge', () => {
    expect(groupDocuments([uber, hotel, flight])).toEqual([]);
  });
});
