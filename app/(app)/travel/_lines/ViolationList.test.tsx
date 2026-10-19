import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The label-resolution path, against catalogs that actually HAVE the keys.
 *
 * `TravelRequestDrawer.test.tsx` mocks `t.has` to a hard `false`, which is a real path —
 * a rule whose label was never written renders its own identifier rather than throwing —
 * but it means the drawer's suite never exercises the resolution it is supposed to do.
 * This file supplies the other half: a catalog with the keys in it, so the sentence, its
 * interpolated figures, and the separately-localized cabin token are all checked.
 */

const CATALOG: Record<string, Record<string, string>> = {
  expenses: {
    'policy.onNLines': 'on {count} lines',
    'policy.labels.travelCabinClass': '{cabin} class is not permitted at your job level.',
    'policy.labels.travelOverrun':
      '{overrunPercent}% over, past the {tolerancePercent}% tolerance.',
  },
  travel: {
    'policy.severity.BLOCK': 'Blocked',
    'policy.severity.WARNING': 'Warning',
    'policy.severity.INFO': 'Note',
    'policy.blockHint': 'This must be changed before submitting.',
    'policy.justify': 'Explain',
    'policy.editJustification': 'Edit explanation',
    'policy.justifyPlaceholder': 'Why this is necessary…',
    'policy.saveJustification': 'Save',
    'policy.cabin.BUSINESS': 'business',
    'policy.cabin.FIRST': 'first',
  },
};

vi.mock('next-intl', () => ({
  // VeloExpense (w6-02): the registry's default (en-CA), not a literal (check:i18n).
  useLocale: () => DEFAULT_LOCALE,
  useTranslations: (ns: string) => {
    const t = (k: string, v?: Record<string, unknown>) => {
      const raw = CATALOG[ns]?.[k];
      if (raw == null) return `${ns}.${k}`;
      // Enough of ICU to render the placeholders these labels carry.
      return raw.replace(/\{(\w+)\}/g, (_m, name) => String(v?.[name] ?? `{${name}}`));
    };
    t.has = (k: string) => CATALOG[ns]?.[k] != null;
    return t;
  },
}));

import { type TravelViolation, ViolationList } from './ViolationList';

const violation = (over: Partial<TravelViolation> = {}): TravelViolation => ({
  id: 'v-1',
  travelLineId: 'bl-1',
  severity: 'BLOCK',
  message: 'travelCabinClass',
  data: { cabin: 'BUSINESS' },
  resolveNote: null,
  resolvedAt: null,
  ...over,
});

const onJustify = vi.fn();
const show = (violations: TravelViolation[], editable = true) =>
  render(
    <ViolationList
      violations={violations}
      editable={editable}
      pending={false}
      onJustify={onJustify}
    />,
  );

describe('the sentence', () => {
  it('localizes the cabin token rather than printing it raw', () => {
    /**
     * The cabin arrives in `data` as `'BUSINESS'` because the engine stores the cabin by
     * NAME — a provider's `travelClass: 3` explains nothing years later. An interpolation
     * value cannot perform its own catalog lookup, so the component resolves it, and the
     * reader must not be shown the enum.
     */
    show([violation()]);
    expect(screen.getByText(/business class is not permitted/i)).toBeInTheDocument();
    expect(screen.queryByText(/BUSINESS/)).not.toBeInTheDocument();
  });

  it('fills the overrun figures from data', () => {
    show([
      violation({
        severity: 'WARNING',
        message: 'travelOverrun',
        travelLineId: null,
        data: { overrunPercent: 38, tolerancePercent: 10 },
      }),
    ]);
    expect(screen.getByText(/38% over, past the 10% tolerance/)).toBeInTheDocument();
  });

  it('falls back to the raw key for a rule nobody wrote a label for', () => {
    // Visibly wrong rather than a crash, and rather than a blank line that hides a
    // violation which is still blocking the submit.
    show([violation({ message: 'someUnwrittenRule', data: null })]);
    expect(screen.getByText('someUnwrittenRule')).toBeInTheDocument();
  });

  it('renders one sentence with a count for a rule that fired on several lines', () => {
    // Three identical sentences read as three problems where there is one. The count is
    // kept, because three times is a different situation from once.
    show([violation(), violation({ id: 'v-2', travelLineId: 'bl-2' })]);
    expect(screen.getAllByText(/business class is not permitted/i)).toHaveLength(1);
    // "on 2 lines", not a bare "×2": the multiplier counts OCCURRENCES while the banner and
    // badge count deduped issues, and an unlabelled number reads as a competing total (GA
    // readiness report F11).
    expect(screen.getByText('on 2 lines')).toBeInTheDocument();
    // And no bare multiplier left behind.
    expect(screen.queryByText('×2')).not.toBeInTheDocument();
  });

  it('renders nothing at all when there are no violations', () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('justification', () => {
  it('offers none for a BLOCK, and says why', () => {
    show([violation()]);
    expect(screen.queryByText('Explain')).not.toBeInTheDocument();
    expect(screen.getByText('This must be changed before submitting.')).toBeInTheDocument();
  });

  it('offers none for an INFO either', () => {
    // It blocks nothing, so a justification would be a comment nobody is waiting for.
    show([violation({ severity: 'INFO' })]);
    expect(screen.queryByText('Explain')).not.toBeInTheDocument();
  });

  it('offers none once the request is no longer editable', () => {
    show([violation({ severity: 'WARNING' })], false);
    expect(screen.queryByText('Explain')).not.toBeInTheDocument();
  });

  it('sends the typed note for a WARNING', async () => {
    const user = userEvent.setup();
    onJustify.mockClear();
    show([violation({ severity: 'WARNING' })]);
    await user.click(screen.getByText('Explain'));
    await user.type(screen.getByLabelText('Explain'), 'Only flight that lands in time');
    await user.click(screen.getByText('Save'));
    expect(onJustify).toHaveBeenCalledWith('v-1', 'Only flight that lands in time');
  });

  it('shows an existing note and offers to edit it', () => {
    show([
      violation({
        severity: 'WARNING',
        resolveNote: 'Client dinner ran late',
        resolvedAt: '2026-08-20T00:00:00Z',
      }),
    ]);
    expect(screen.getByText('Client dinner ran late')).toBeInTheDocument();
    expect(screen.getByText('Edit explanation')).toBeInTheDocument();
  });
});
