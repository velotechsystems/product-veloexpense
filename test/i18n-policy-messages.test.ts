/**
 * VX4-7 part 2b — the policy-violation sentences, and UD-5 requirement 3.
 *
 * No database. Every rule's `evaluate` is pure by design (that is what VX1-7's
 * split bought), so this file drives the REAL rules over hand-built contexts and
 * inspects what they actually emit.
 *
 * ── WHY THAT MATTERS MORE THAN IT SOUNDS ────────────────────────────────────
 *
 * UD-5 requirement 3 is "a static scan cannot see an interpolated key".
 * `check:i18n` can tell that `POLICY_MESSAGES.LIMIT_EXCEEDED` exists and that
 * `rules.ts` names it. What it cannot tell is whether the `data` object that
 * rule builds will CONTAIN `thresholdMinorUnit` when the sentence reaches for
 * it — that is a fact about a jsonb column, written at one time and read at
 * another, and no amount of reading source establishes it.
 *
 * So the assertions below take the rule's own output and check the catalogue's
 * declared `requires` against it. The two halves are written by different code
 * in different modules and are compared here; neither can satisfy the test by
 * agreeing with itself, which is requirement 2's lesson applied to requirement 3.
 *
 * ── AND THE COPY IS PINNED, LITERALLY ───────────────────────────────────────
 *
 * Part 2a shipped three copy regressions behind a comment claiming a verbatim
 * port — `POSTED: 'drafted in the ledger'` became "Posted", which is materially
 * wrong because VX3-4 creates a DRAFT bill, and it took an e2e to notice. Every
 * `en-CA` sentence below is therefore pinned as a literal string transcribed
 * from `lib/policy/rules.ts` as it stood at PR #86, before this ticket moved it.
 * A reworded sentence is a failing test, not a review comment somebody missed.
 */
import { describe, it, expect } from 'vitest';
import {
  POLICY_MESSAGES,
  POLICY_MESSAGE_CODES,
  MessageDataError,
  renderPolicyMessage,
  renderViolation,
  isPolicyMessageCode,
  type PolicyMessageCode,
} from '@/lib/i18n/catalog/policy-messages';
import { missingCopyMarker } from '@/lib/i18n/catalog/enums';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import {
  RULE_DEFINITIONS,
  RULE_KINDS,
  type Finding,
  type PolicyContext,
  type PolicyRow,
} from '@/lib/policy/rules';
import { buildRateLookup } from '@/lib/policy/rates';
import type { WorkbenchExpense, WorkbenchReport } from '@/lib/expenses/service';
import type { BudgetSnapshot } from '@/lib/budgets/scope';

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const NOW = new Date('2026-03-04T12:00:00Z');

function report(overrides: Partial<WorkbenchReport> = {}): WorkbenchReport {
  return {
    id: 'r1',
    number: 'EXP-1',
    title: 'March travel',
    purpose: null,
    status: 'DRAFT',
    total_minor: '0',
    currency_code: 'CAD',
    minor_unit: 2,
    submitter_id: 'u1',
    submitter_name: 'Dana',
    submitter_email: 'dana@example.test',
    business_unit_id: null,
    business_unit_name: null,
    submitted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function line(overrides: Partial<WorkbenchExpense['lineItems'][number]> = {}) {
  return {
    id: 'l1',
    expense_id: 'e1',
    category_id: 'c1',
    category_code: 'TRAVEL',
    category_label: 'Travel',
    category_active: true,
    amount_minor: '70000',
    tax_minor: '0',
    description: 'Flight to Calgary',
    created_at: NOW,
    ...overrides,
  };
}

function expense(overrides: Partial<WorkbenchExpense> = {}): WorkbenchExpense {
  return {
    id: 'e1',
    report_id: 'r1',
    merchant: 'Air Canada',
    txn_date: '2026-03-04',
    currency_code: 'CAD',
    notes: null,
    created_at: NOW,
    lineItems: [line()],
    receipts: [],
    subtotal_minor: '70000',
    ...overrides,
  };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    report: report(),
    expenses: [expense()],
    policyCurrency: 'CAD',
    minorUnits: { CAD: 2, USD: 2, JPY: 0 },
    // Empty by default: an IDENTITY comparison needs no rate row, and a rule
    // that needs one asks for `rates()` below.
    rates: buildRateLookup([], '2026-03-04'),
    budgets: [],
    ...overrides,
  };
}

function rates(rows: { base: string; quote: string; rate: string; as_of: string }[]) {
  return buildRateLookup(rows, '2026-03-04');
}

function policy(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: 'p1',
    kind: 'PER_TRANSACTION_LIMIT',
    severity: 'WARNING',
    enabled: true,
    category_id: null,
    category_label: null,
    currency_code: null,
    params: { thresholdMinor: '50000' },
    effective_from: null,
    effective_to: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function budget(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    budgetId: 'b1',
    budgetName: 'Travel',
    periodId: 'bp1',
    startsOn: '2026-01-01',
    endsOn: '2026-03-31',
    currencyCode: 'CAD',
    minorUnit: 2,
    amountMinor: 100000n,
    actualMinor: 40000n,
    pendingMinor: 20000n,
    unconvertibleMinor: 0n,
    reportMinor: 70000n,
    reportMissingRateFrom: [],
    ...overrides,
  };
}

/** Run one rule kind and return every finding it emits. */
function run(kind: (typeof RULE_KINDS)[number], ctx: PolicyContext, row?: PolicyRow): Finding[] {
  return RULE_DEFINITIONS[kind].evaluate(ctx, row ?? policy({ kind }));
}

/**
 * One finding of each code, produced by the REAL rules.
 *
 * Built as a map so a missing code is a `undefined` in the coverage test below
 * rather than a silently shorter list — the difference between "we cover all ten
 * codes" and "we cover the ten codes we remembered to write a fixture for".
 */
function everyFinding(): Map<PolicyMessageCode, Finding> {
  const found = new Map<PolicyMessageCode, Finding>();
  const add = (findings: Finding[]) => {
    for (const f of findings) if (!found.has(f.messageCode)) found.set(f.messageCode, f);
  };

  // LIMIT_EXCEEDED — $700 line, $500 limit, same currency.
  add(run('PER_TRANSACTION_LIMIT', context()));
  // LIMIT_EXCEEDED_CONVERTED — the limit is in USD, so the line converts.
  add(
    run(
      'PER_TRANSACTION_LIMIT',
      context({ rates: rates([{ base: 'CAD', quote: 'USD', rate: '0.75', as_of: '2026-03-01' }]) }),
      policy({ currency_code: 'USD', params: { thresholdMinor: '40000' } }),
    ),
  );
  // RATE_MISSING — a USD limit and no rate at all.
  add(
    run(
      'PER_TRANSACTION_LIMIT',
      context(),
      policy({ currency_code: 'USD', params: { thresholdMinor: '40000' } }),
    ),
  );
  // RECEIPT_MISSING — no floor, no receipt.
  add(run('RECEIPT_REQUIRED', context(), policy({ kind: 'RECEIPT_REQUIRED', params: {} })));
  // RECEIPT_MISSING_ABOVE — a floor in the report's own currency.
  add(
    run(
      'RECEIPT_REQUIRED',
      context(),
      policy({ kind: 'RECEIPT_REQUIRED', params: { thresholdMinor: '50000' } }),
    ),
  );
  // RECEIPT_MISSING_ABOVE_CONVERTED — a floor in USD.
  add(
    run(
      'RECEIPT_REQUIRED',
      context({ rates: rates([{ base: 'CAD', quote: 'USD', rate: '0.75', as_of: '2026-03-01' }]) }),
      policy({
        kind: 'RECEIPT_REQUIRED',
        currency_code: 'USD',
        params: { thresholdMinor: '40000' },
      }),
    ),
  );
  // CATEGORY_INACTIVE
  add(
    run(
      'CATEGORY_ACTIVE',
      context({ expenses: [expense({ lineItems: [line({ category_active: false })] })] }),
      policy({ kind: 'CATEGORY_ACTIVE', params: {} }),
    ),
  );
  // NEGATIVE_AMOUNT
  add(
    run(
      'NON_NEGATIVE_AMOUNT',
      context({ expenses: [expense({ lineItems: [line({ amount_minor: '-2500' })] })] }),
      policy({ kind: 'NON_NEGATIVE_AMOUNT', params: {} }),
    ),
  );
  // BUDGET_EXCEEDED — 400 + 200 + 700 = 1300 against 1000.
  add(
    run(
      'BUDGET_OVERAGE',
      context({ budgets: [budget()] }),
      policy({ kind: 'BUDGET_OVERAGE', params: {} }),
    ),
  );
  // BUDGET_FLOOR_FX — same period, with spend that could not be converted.
  add(
    run(
      'BUDGET_OVERAGE',
      context({
        budgets: [budget({ unconvertibleMinor: 5000n, reportMissingRateFrom: ['USD', 'EUR'] })],
      }),
      policy({ kind: 'BUDGET_OVERAGE', params: {} }),
    ),
  );
  return found;
}

/* ── requirement 3 ─────────────────────────────────────────────────────────── */

describe('every code the rules can emit is actually reachable', () => {
  const found = everyFinding();

  it('the fixtures produce all ten', () => {
    // Not `expect(found.size).toBe(10)` — that says a number and not WHICH one is
    // missing, and a fixture that stops triggering a branch is exactly the
    // failure worth naming.
    expect([...found.keys()].sort()).toEqual([...POLICY_MESSAGE_CODES].sort());
  });

  it.each([...POLICY_MESSAGE_CODES])('%s: the rule emits every key its sentence needs', (code) => {
    const finding = found.get(code);
    expect(finding, `no fixture produces ${code}`).toBeDefined();
    const missing = POLICY_MESSAGES[code].requires.filter(
      (key) => finding!.data[key] === undefined || finding!.data[key] === null,
    );
    expect(missing, `${code} declares keys the rule does not emit`).toEqual([]);
  });

  it.each([...POLICY_MESSAGE_CODES])('%s: renders rather than returning a marker', (code) => {
    const finding = found.get(code)!;
    for (const locale of SUPPORTED_LOCALES) {
      const rendered = renderPolicyMessage(code, finding.data, locale);
      expect(rendered, `${code} in ${locale}`).not.toBe(missingCopyMarker(code));
      expect(rendered.length).toBeGreaterThan(0);
      // The failure `Fields` exists to prevent. `String(undefined)` renders
      // cleanly and reads as a bug in the product rather than in the row.
      expect(rendered).not.toContain('undefined');
      expect(rendered).not.toContain('NaN');
    }
  });

  it('the requires check can actually fail', () => {
    // The guard on the guard, in the house pattern: delete a key the rule really
    // does emit and confirm the assertion above would have caught it. Without
    // this, `requires` listing nothing at all would pass every test in this block.
    const finding = found.get('LIMIT_EXCEEDED')!;
    const damaged = { ...finding.data };
    delete damaged.thresholdMinorUnit;
    expect(renderPolicyMessage('LIMIT_EXCEEDED', damaged, DEFAULT_LOCALE)).toBe(
      missingCopyMarker('LIMIT_EXCEEDED'),
    );
    expect(POLICY_MESSAGES.LIMIT_EXCEEDED.requires).toContain('thresholdMinorUnit');
  });

  it('the finding carries the message its own code renders', () => {
    // `finding()` builds `message` BY rendering, so this cannot fail by
    // construction — which is the point. It is here so that a later refactor
    // reintroducing a hand-written `message:` beside a `messageCode:` fails
    // immediately, instead of drifting for a release the way part 2a's three
    // sentences did.
    for (const [code, f] of found) {
      expect(f.message, code).toBe(renderPolicyMessage(code, f.data, DEFAULT_LOCALE));
    }
  });
});

/* ── the copy, pinned ──────────────────────────────────────────────────────── */

describe('the sentences, transcribed from rules.ts at PR #86', () => {
  const found = everyFinding();
  const say = (code: PolicyMessageCode) => renderPolicyMessage(code, found.get(code)!.data, 'en-CA');

  it('LIMIT_EXCEEDED', () => {
    expect(say('LIMIT_EXCEEDED')).toBe(
      'Flight to Calgary is $700.00, over the $500.00 per-transaction limit.',
    );
  });

  it('LIMIT_EXCEEDED_CONVERTED', () => {
    expect(say('LIMIT_EXCEEDED_CONVERTED')).toBe(
      'Flight to Calgary is $700.00 — US$525.00 converted — over the US$400.00 ' +
        'per-transaction limit.',
    );
  });

  it('RECEIPT_MISSING', () => {
    expect(say('RECEIPT_MISSING')).toBe('Air Canada has no receipt attached.');
  });

  it('RECEIPT_MISSING_ABOVE', () => {
    expect(say('RECEIPT_MISSING_ABOVE')).toBe(
      'Air Canada is $700.00 and has no receipt attached (receipts required above $500.00).',
    );
  });

  it('RECEIPT_MISSING_ABOVE_CONVERTED', () => {
    expect(say('RECEIPT_MISSING_ABOVE_CONVERTED')).toBe(
      'Air Canada is $700.00 — US$525.00 converted — and has no receipt attached ' +
        '(receipts required above US$400.00).',
    );
  });

  it('CATEGORY_INACTIVE', () => {
    expect(say('CATEGORY_INACTIVE')).toBe(
      'Flight to Calgary is coded to Travel, which is no longer active. Recode it.',
    );
  });

  it('NEGATIVE_AMOUNT', () => {
    expect(say('NEGATIVE_AMOUNT')).toBe(
      'Flight to Calgary is -$25.00. Line items cannot be negative.',
    );
  });

  it('BUDGET_EXCEEDED', () => {
    expect(say('BUDGET_EXCEEDED')).toBe(
      'This report takes Travel (2026-01-01 to 2026-03-31) to $1,300.00 against a budget of ' +
        '$1,000.00 — over by $300.00. $400.00 is already approved, $200.00 is awaiting a ' +
        'decision, and this report adds $700.00.',
    );
  });

  it('BUDGET_FLOOR_FX', () => {
    expect(say('BUDGET_FLOOR_FX')).toBe(
      'Some spend counted against Travel (2026-01-01 to 2026-03-31) could not be converted ' +
        'into CAD, so $1,300.00 is a floor rather than a total. This report has spend in ' +
        'USD, EUR with no exchange rate to CAD; an administrator needs to add one.',
    );
  });

  it('BUDGET_FLOOR_FX, with the unconvertible spend on EARLIER reports', () => {
    // The other branch, which no fixture above reaches because `everyFinding`
    // keeps the first finding per code. Empty `reportMissingRateFrom` is a
    // meaningful state, not a missing key — which is why `list()` returns []
    // instead of throwing and why the key is deliberately absent from `requires`.
    const data = { ...everyFinding().get('BUDGET_FLOOR_FX')!.data, reportMissingRateFrom: [] };
    expect(renderPolicyMessage('BUDGET_FLOOR_FX', data, 'en-CA')).toBe(
      'Some spend counted against Travel (2026-01-01 to 2026-03-31) could not be converted ' +
        'into CAD, so $1,300.00 is a floor rather than a total. Earlier spend on this budget ' +
        'is affected; an administrator needs to add the missing exchange rates.',
    );
  });

  it('RATE_MISSING', () => {
    expect(say('RATE_MISSING')).toBe(
      'Flight to Calgary could not be checked against the limit: there is no exchange rate ' +
        'from CAD to USD, so the two amounts are not comparable. An administrator needs to ' +
        'add one.',
    );
  });
});

/* ── the reader actually changes the sentence ──────────────────────────────── */

describe('the same row reads differently to a different reader', () => {
  const found = everyFinding();

  it('an en-US reader gets their own money format, and CAD disambiguated', () => {
    // The whole ticket in one assertion. `Intl` writes a Canadian-dollar amount
    // as `CA$700.00` for an American reader and `$700.00` for a Canadian one —
    // and the frozen `message` column could only ever have said one of them.
    const data = found.get('LIMIT_EXCEEDED')!.data;
    expect(renderPolicyMessage('LIMIT_EXCEEDED', data, 'en-CA')).toContain('$700.00');
    expect(renderPolicyMessage('LIMIT_EXCEEDED', data, 'en-CA')).not.toContain('CA$');
    expect(renderPolicyMessage('LIMIT_EXCEEDED', data, 'en-US')).toContain('CA$700.00');
  });

  it('an en-US reader gets their own date format for a budget period', () => {
    const data = found.get('BUDGET_EXCEEDED')!.data;
    expect(renderPolicyMessage('BUDGET_EXCEEDED', data, 'en-CA')).toContain(
      '(2026-01-01 to 2026-03-31)',
    );
    expect(renderPolicyMessage('BUDGET_EXCEEDED', data, 'en-US')).toContain(
      '(01/01/2026 to 03/31/2026)',
    );
  });

  it('an unsupported tag falls back rather than throwing or blanking', () => {
    const data = found.get('RECEIPT_MISSING')!.data;
    expect(renderPolicyMessage('RECEIPT_MISSING', data, 'fr-CA')).toBe(
      'Air Canada has no receipt attached.',
    );
    expect(renderPolicyMessage('RECEIPT_MISSING', data, 'nonsense')).toBe(
      'Air Canada has no receipt attached.',
    );
  });
});

/* ── renderViolation: the precedence a stored row goes through ─────────────── */

describe('renderViolation', () => {
  const found = everyFinding();
  const row = (over: Record<string, unknown> = {}) => ({
    message: 'the frozen English',
    message_code: 'LIMIT_EXCEEDED',
    data: found.get('LIMIT_EXCEEDED')!.data,
    ...over,
  });

  it('renders from the code when the row has one', () => {
    expect(renderViolation(row(), 'en-CA')).toBe(
      'Flight to Calgary is $700.00, over the $500.00 per-transaction limit.',
    );
  });

  it('shows the stored sentence for a row written before 0029', () => {
    // `''` is the pre-migration state and the ONLY signal those rows carry —
    // their `data` never held a label, so there is nothing to render from.
    expect(renderViolation(row({ message_code: '', data: {} }), 'en-US')).toBe(
      'the frozen English',
    );
    expect(renderViolation(row({ message_code: null, data: {} }), 'en-US')).toBe(
      'the frozen English',
    );
  });

  it('falls back to the stored sentence rather than showing a marker', () => {
    // A row whose data no longer satisfies its own message is a bug, and CI is
    // where it is loud. An employee looking at their own report gets stale
    // English, which is worse than correct and enormously better than
    // `{LIMIT_EXCEEDED}`.
    expect(renderViolation(row({ data: {} }), 'en-CA')).toBe('the frozen English');
    expect(renderViolation(row({ message_code: 'NO_SUCH_CODE' }), 'en-CA')).toBe(
      'the frozen English',
    );
  });
});

/* ── the mechanism's own edges ─────────────────────────────────────────────── */

describe('renderPolicyMessage never throws', () => {
  // IL-4 is a missing key blanking a page, in upstream's production, twice. A
  // renderer that can throw during a request is that defect with extra steps, so
  // the contract is checked against the shapes a jsonb column can actually hold.
  it.each([
    ['empty data', {}],
    ['nulls', { label: null, amountMinor: null }],
    ['wrong types', { label: 42, amountMinor: {}, minorUnit: 'two', currencyCode: [] }],
    ['a blank label', { label: '   ', amountMinor: '1', currencyCode: 'CAD', minorUnit: 2 }],
  ])('%s', (_name, data) => {
    for (const code of POLICY_MESSAGE_CODES) {
      expect(() => renderPolicyMessage(code, data as Record<string, unknown>, 'en-CA')).not.toThrow();
    }
  });

  it('an unknown code is a marker, not an exception', () => {
    expect(renderPolicyMessage('NOT_A_CODE', {}, 'en-CA')).toBe(missingCopyMarker('NOT_A_CODE'));
  });

  it('a blank label is refused rather than rendered as a hole', () => {
    // `'   '` trims to nothing and would produce "   is $10.00, over the …".
    // `lineLabel` already guarantees a non-empty label ('this line item'), so a
    // blank one means something upstream broke and the marker is the honest
    // answer.
    const data = {
      label: '',
      amountMinor: '1000',
      currencyCode: 'CAD',
      minorUnit: 2,
      thresholdMinor: '500',
      thresholdCurrency: 'CAD',
      thresholdMinorUnit: 2,
    };
    expect(renderPolicyMessage('LIMIT_EXCEEDED', data, 'en-CA')).toBe(
      missingCopyMarker('LIMIT_EXCEEDED'),
    );
  });
});

describe('the catalogue and the registry agree', () => {
  it('every code has copy in the default locale', () => {
    // The type already demands this (`PolicyCopy` requires `[DEFAULT_LOCALE]`).
    // Asserted anyway because the type is erased at runtime and a hand-built
    // object cast into place would satisfy the compiler and not the reader.
    for (const code of POLICY_MESSAGE_CODES) {
      expect(typeof POLICY_MESSAGES[code].copy[DEFAULT_LOCALE], code).toBe('function');
    }
  });

  it('declares no key twice, and no empty requires by accident', () => {
    for (const code of POLICY_MESSAGE_CODES) {
      const requires = POLICY_MESSAGES[code].requires;
      expect(new Set(requires).size, code).toBe(requires.length);
    }
    // RECEIPT_MISSING is the only single-key sentence; anything else claiming to
    // interpolate nothing is a `requires` somebody forgot to fill in.
    const bare = POLICY_MESSAGE_CODES.filter((c) => POLICY_MESSAGES[c].requires.length === 0);
    expect(bare).toEqual([]);
  });

  it('isPolicyMessageCode agrees with the array', () => {
    for (const code of POLICY_MESSAGE_CODES) expect(isPolicyMessageCode(code)).toBe(true);
    expect(isPolicyMessageCode('LIMIT_EXCEEDED_')).toBe(false);
    expect(isPolicyMessageCode('')).toBe(false);
  });

  it('MessageDataError names both the code and the key', () => {
    // It never reaches a user, but it is what a developer reads in a failing CI
    // run, and "cannot read property of undefined" would waste the same hour
    // every time.
    const err = new MessageDataError('LIMIT_EXCEEDED', 'thresholdMinor');
    expect(err.message).toContain('LIMIT_EXCEEDED');
    expect(err.message).toContain('thresholdMinor');
  });
});
