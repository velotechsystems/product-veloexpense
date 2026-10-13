import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/policy-violations — the exceptions register.
 *
 * The one rule this page has to hold is that **a BLOCK is not acknowledgeable**. A
 * BLOCK stopped a report from being submitted; letting a manager write a note over it
 * would turn the hard control into a soft one from a screen the report's author never
 * sees. Everything about acknowledging is therefore gated twice — the row menu and the
 * row click — because either one alone is a way in.
 *
 * The second property is that an acknowledgement is REVERSIBLE and always carries a
 * reason: a resolved violation can be reopened, and a blank note cannot be saved,
 * because "resolved by somebody, at some point, for no stated reason" is not an
 * exception record.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /**
   * Catalog keys the stubbed translator claims to have.
   *
   * The list resolves a rule kind and a violation message through `t.has(…)` before
   * falling back to the raw value, so a translator that always answers `false` exercises
   * only the fallback — which is how a screen full of `TIP_PERCENTAGE` and
   * `receiptThresholdBlock` could look tested (GA readiness report F26 / F27).
   */
  knownKeys: new Set<string>(),
}));

/** One stable `t` per namespace — the column memo lists it as a dep. */
const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: (k: string) => boolean }).has = (k: string) =>
        h.knownKeys.has(ns ? `${ns}.${k}` : k);
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
/**
 * `@/i18n/navigation` destructures next-intl's `createNavigation`, which imports
 * `next/navigation` as a bare specifier from inside node_modules — where `vi.mock`
 * does not reach. Mocking this module is what keeps the import out of the graph.
 */
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: () => undefined }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { PolicyViolationsAdmin } from './PolicyViolationsAdmin';

const violation = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  severity: 'WARNING',
  message: 'Meal exceeds the per-diem cap',
  kind: 'PER_DIEM_CAP',
  resolvedAt: null,
  resolveNote: null,
  createdAt: '2026-08-01T12:00:00.000Z',
  // The subject is a report OR a travel request now, so the row carries a neutral
  // number/title pair and keeps both ids for the link.
  subjectKind: 'REPORT',
  subjectNumber: 'EXP-1042',
  subjectTitle: 'Toronto client visit',
  reportId: 'rep-1',
  travelRequestId: null,
  submitterName: 'Dana Patel',
  lineItemId: 'li-1',
  expenseId: 'exp-1',
  travelLineId: null,
  merchant: 'Canoe',
  expenseDate: '2026-07-28T12:00:00.000Z',
  categoryLabel: { en: 'Meals' },
  ...over,
});

/** A travel-subject row — same shape, other anchor. */
const travelViolation = (over: Record<string, unknown> = {}) =>
  violation({
    id: 'tv1',
    kind: 'TRAVEL_CABIN_CLASS',
    severity: 'BLOCK',
    subjectKind: 'TRAVEL_REQUEST',
    subjectNumber: 'TRV-0007',
    subjectTitle: 'London',
    reportId: null,
    travelRequestId: 'trv-1',
    lineItemId: null,
    expenseId: null,
    travelLineId: 'tl-1',
    merchant: null,
    expenseDate: null,
    ...over,
  });

function setTrpc(rows: unknown[] = [violation()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'policies.policyRule.violations': { data: rows }, ...over.queries },
  });
}

const show = (canManage = true) => render(<PolicyViolationsAdmin canManage={canManage} />);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The register ──────────────────────────────────────────────────────────────

describe('the register', () => {
  it('reads a violation out as report, submitter, rule and message', () => {
    setTrpc();
    show();
    const row = rowTexts()[0];
    expect(row).toContain('EXP-1042');
    expect(row).toContain('Toronto client visit');
    expect(row).toContain('Dana Patel');
    expect(row).toContain('PER_DIEM_CAP');
    expect(row).toContain('Meal exceeds the per-diem cap');
  });

  it('names the rule KIND, not the instance id the row stores', () => {
    // The register is read by people; a uuid tells them nothing about what fired.
    setTrpc();
    show();
    expect(screen.getByText('PER_DIEM_CAP')).toBeInTheDocument();
  });

  it('resolves the line’s category, and dashes a violation that has no line', () => {
    setTrpc([violation(), violation({ id: 'v2', categoryLabel: null })]);
    show();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(rowTexts()[1]).toContain('—');
  });

  it('separates open from acknowledged', () => {
    setTrpc([violation(), violation({ id: 'v2', resolvedAt: '2026-08-02T12:00:00.000Z' })]);
    show();
    expect(screen.getByText('policyRules.viol.status.open')).toBeInTheDocument();
    expect(screen.getByText(/policyRules\.viol\.status\.resolved/)).toBeInTheDocument();
  });

  it('tones a BLOCK apart from a warning', () => {
    // The severity decides whether this screen can do anything about it at all.
    setTrpc([violation({ severity: 'BLOCK' })]);
    show();
    expect(screen.getByText('policyRules.severity.BLOCK').className).toContain('text-destructive');
  });

  it('says so when nothing has been flagged', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('policyRules.viol.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('policyRules.viol.emptyBody')).toBeInTheDocument();
  });

  it('lists a travel request beside a report', () => {
    /**
     * The register is the page that exists to show exceptions, and a travel BLOCK is the
     * most consequential kind there is — it stopped a trip from being requested. Keeping
     * the row shape report-shaped would have hidden exactly those.
     */
    setTrpc([violation(), travelViolation()]);
    show();
    expect(screen.getByText('EXP-1042')).toBeInTheDocument();
    expect(screen.getByText('TRV-0007')).toBeInTheDocument();
    expect(screen.getByText('London')).toBeInTheDocument();
  });

  it('narrows on the subject number or its title, whichever subject it is', async () => {
    // Whichever the person chasing it happens to have.
    const user = userEvent.setup();
    setTrpc([violation(), travelViolation({ subjectNumber: 'TRV-2001', subjectTitle: 'Yul' })]);
    show();
    const header = screen.getByText('policyRules.viol.col.subject').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), 'yul');
    await user.click(screen.getByText('table.colMenu.apply'));
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('TRV-2001')).toBeInTheDocument();
  });
});

// ── What may be acknowledged ──────────────────────────────────────────────────

describe('reading a violation without knowing the enum', () => {
  /**
   * The register showed `PER_DIEM_CAP` and `receiptThresholdBlock` verbatim — the rule's
   * enum and the message KEY — in both locales. That reads as debug output, and with two
   * receipt-threshold rules configured at different amounts it made two different rules
   * indistinguishable on screen (GA readiness report F26 / F27).
   */
  it('shows the rule name and the message prose when the catalog has them', async () => {
    h.knownKeys.add('policyRules.kind.PER_DIEM_CAP');
    h.knownKeys.add('expenses.policy.labels.receiptThresholdBlock');
    setTrpc([
      violation({
        kind: 'PER_DIEM_CAP',
        message: 'receiptThresholdBlock',
        // `receiptThresholdBlock` is one of the six sentences with an ICU placeholder,
        // so it only renders in full once its payload comes with it.
        data: { thresholdMinor: '7500', policyCurrency: 'CAD' },
      }),
    ]);
    render(<PolicyViolationsAdmin canManage />);

    expect(await screen.findByText('policyRules.kind.PER_DIEM_CAP')).toBeInTheDocument();
    expect(screen.getByText(/expenses\.policy\.labels\.receiptThresholdBlock/)).toBeInTheDocument();
    // …and never the raw forms.
    expect(screen.queryByText('PER_DIEM_CAP')).not.toBeInTheDocument();
    expect(screen.queryByText('receiptThresholdBlock')).not.toBeInTheDocument();
  });

  it('falls back to what the engine stored when there is no catalog entry', async () => {
    // Prose the engine wrote itself must survive: not every message is a key.
    setTrpc([violation({ kind: 'BRAND_NEW_KIND', message: 'Meal exceeds the per-diem cap' })]);
    render(<PolicyViolationsAdmin canManage />);
    expect(await screen.findByText('BRAND_NEW_KIND')).toBeInTheDocument();
    expect(screen.getByText('Meal exceeds the per-diem cap')).toBeInTheDocument();
  });

  /**
   * Resolving the key was only half of it.
   *
   * Six `policy.labels.*` sentences carry an ICU placeholder — "Receipt expected over
   * {threshold}" and friends. Resolving the key with no VALUES prints the placeholder
   * verbatim, so the register swapped one piece of debug output for another: it stopped
   * showing `receiptThresholdBlock` and started showing "Receipt required over
   * {threshold}". Seen on dev, on both threshold rules.
   *
   * Worse, the amount is the only thing that distinguishes them. Two receipt rules
   * configured at different limits render the SAME sentence — which is the exact failure
   * F27 was raised to fix.
   *
   * `violationValues` already exists and both workbench call sites use it; this screen is
   * the third copy of the pattern and never got it. The stub renders `key:values`, so the
   * amount appearing at all is proof the values reached `t` from this call site.
   */
  it('fills a sentence’s placeholder in, rather than printing {threshold}', async () => {
    h.knownKeys.add('expenses.policy.labels.receiptThresholdWarn');
    setTrpc([
      violation({
        message: 'receiptThresholdWarn',
        data: { thresholdMinor: '2500', policyCurrency: 'CAD' },
      }),
    ]);
    render(<PolicyViolationsAdmin canManage />);

    const cell = await screen.findByText(/expenses\.policy\.labels\.receiptThresholdWarn/);
    expect(cell.textContent).toMatch(/receiptThresholdWarn:.*25/);
  });
});

describe('acknowledging', () => {
  it('offers no acknowledgement for a BLOCK, from either affordance', async () => {
    /**
     * A BLOCK stopped the report from being submitted. Acknowledging it here would
     * turn a hard control into a soft one from a screen the report's author never
     * sees — so both the row menu and the row click are gated on severity.
     */
    const user = userEvent.setup();
    setTrpc([violation({ severity: 'BLOCK' })]);
    show();
    expect(
      screen.queryByRole('button', { name: 'policyRules.viol.actions' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers nothing at all to somebody who may only read', async () => {
    const user = userEvent.setup();
    setTrpc();
    show(false);
    expect(
      screen.queryByRole('button', { name: 'policyRules.viol.actions' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the acknowledgement drawer from the row menu', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByRole('button', { name: 'policyRules.viol.actions' }));
    await user.click(await screen.findByText('policyRules.viol.resolve'));
    expect(await screen.findByText('policyRules.viol.resolveTitle')).toBeInTheDocument();
  });

  it('opens it from a row click too', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    expect(await screen.findByText('policyRules.viol.resolveTitle')).toBeInTheDocument();
  });

  it('restates what is being acknowledged, so the note is written against it', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Meal exceeds the per-diem cap/)).toBeInTheDocument();
    expect(within(dialog).getByText(/policyRules\.severity\.WARNING/)).toBeInTheDocument();
  });

  it('restates the sentence, not the stored key (VeloExpense)', async () => {
    /**
     * ExpenseOS's engine stores a message KEY, and ExpenseOS's drawer printed `message`
     * as-is — so acknowledging a receipt finding read "Warning: receiptThresholdWarn". The
     * column already resolved it; the drawer now says the same sentence, with its amount.
     */
    const user = userEvent.setup();
    h.knownKeys.add('expenses.policy.labels.receiptThresholdWarn');
    setTrpc([
      violation({ message: 'receiptThresholdWarn', data: { thresholdMinor: '2500', policyCurrency: 'CAD' } }),
    ]);
    show();
    await user.click(await screen.findByText(/expenses\.policy\.labels\.receiptThresholdWarn/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/receiptThresholdWarn:.*25/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/: receiptThresholdWarn$/)).not.toBeInTheDocument();
  });

  it('refuses a blank note', async () => {
    /**
     * "Resolved by somebody, at some point, for no stated reason" is not an exception
     * record — the note is the only thing that makes the register auditable.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'policyRules.viol.resolve' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), '   ');
    expect(save).toBeDisabled();
  });

  it('acknowledges with a trimmed note', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([violation()], {
      mutations: { 'policies.policyRule.resolveViolation': { onCall } },
    });
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), '  Approved by Finance  ');
    await user.click(within(dialog).getByRole('button', { name: 'policyRules.viol.resolve' }));
    expect(onCall.mock.calls[0]?.[0]).toEqual({ id: 'v1', note: 'Approved by Finance' });
  });

  it('opens an already-acknowledged violation on its existing note', async () => {
    // So an edit amends the reason rather than replacing it with a blank box.
    const user = userEvent.setup();
    setTrpc([
      violation({ resolvedAt: '2026-08-02T12:00:00.000Z', resolveNote: 'Approved by Finance' }),
    ]);
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    expect(await screen.findByRole('textbox')).toHaveValue('Approved by Finance');
  });

  it('can reopen an acknowledged violation by clearing it', async () => {
    /**
     * An acknowledgement made in error has to be reversible, or the register records a
     * decision nobody can take back.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([violation({ resolvedAt: '2026-08-02T12:00:00.000Z', resolveNote: 'Oops' })], {
      mutations: { 'policies.policyRule.resolveViolation': { onCall } },
    });
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    await user.click(await screen.findByRole('button', { name: 'policyRules.viol.clear' }));
    expect(onCall.mock.calls[0]?.[0]).toEqual({ id: 'v1', note: null });
  });

  it('offers no way to clear one that was never acknowledged', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    await screen.findByRole('dialog');
    expect(
      screen.queryByRole('button', { name: 'policyRules.viol.clear' }),
    ).not.toBeInTheDocument();
  });

  it('holds both buttons while the acknowledgement is in flight', async () => {
    const user = userEvent.setup();
    setTrpc([violation({ resolvedAt: '2026-08-02T12:00:00.000Z', resolveNote: 'Note' })], {
      mutations: { 'policies.policyRule.resolveViolation': { isPending: true } },
    });
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'policyRules.viol.clear' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'policyRules.viol.resolve' })).toBeDisabled();
  });

  it('closes without acknowledging on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([violation()], {
      mutations: { 'policies.policyRule.resolveViolation': { onCall } },
    });
    show();
    await user.click(screen.getByText('Meal exceeds the per-diem cap'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'never mind');
    await user.click(within(dialog).getByRole('button', { name: 'policyRules.cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });
});
