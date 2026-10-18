import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/audit-trail.
 *
 * The log is hash-chained and append-only, so this page has one job the others do not:
 * it has to be able to say the chain is INTACT, and to say plainly when it is not.
 *
 *   · **A failed verification names the entry and the reason.** "Verification failed" on
 *     its own is unactionable; the id and whether the break is an entry hash or a
 *     previous-hash link is what somebody investigates with.
 *   · **A verification that spans a purge is still a pass, and says so.** A purge
 *     deliberately removes the oldest entries, which breaks the literal chain at the
 *     boundary — reporting that as tampering would cry wolf every retention run.
 *   · **Filters resolve SERVER-side.** The log is unbounded, so filtering the page you
 *     happen to have loaded would silently answer a different question than the one
 *     asked.
 *
 * w5-06 — ported from ExpenseOS (1e682dd6). VeloExpense: the TopBar's path; the purge stat
 * names the entry the purge reached (VeloExpense's watermark has no count or run time); an
 * entry may carry no expiry; and the retention window is the tenant's own (w5-07, d82). The
 * cases are ExpenseOS's.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
  /** Every input the paged log query was called with. */
  listInputs: [] as unknown[],
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

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
      (fn as { has?: () => boolean }).has = () => false;
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
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));
vi.mock('@/lib/useDebouncedValue', () => ({ useDebouncedValue: (v: unknown) => v }));
// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));

import { AuditTrail } from './AuditTrail';

const AT = new Date('2026-08-01T12:34:56Z');

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'a-1',
  occurredAt: AT,
  actorName: 'Ada Lovelace',
  actorRoleLabel: 'Administrator',
  action: 'report.approve',
  entityType: 'ExpenseReport',
  entityId: 'rep-1',
  ipAddress: '198.51.100.7',
  userAgent: 'Mozilla/5.0',
  entryHash: 'abcdef0123456789deadbeef',
  prevHash: '0000',
  details: { note: 'ok' },
  ...over,
});

const STATS = {
  total: 12345,
  oldestAt: new Date('2024-01-01T00:00:00Z'),
  newestAt: AT,
  retentionYears: 7,
  // VeloExpense: the watermark's shape (server/routers/audit.ts `PurgeWatermark`).
  lastPurge: {
    purgedThroughSequence: '9001',
    lastPurgedEntryHash: 'f'.repeat(64),
    runAt: new Date('2026-07-01T00:00:00Z'),
    purgedCount: 400,
  },
};

function setTrpc(over: TrpcMockConfig = {}, rows = [entry()]) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'audit.stats': { data: STATS },
      'audit.facets': { data: { actions: ['report.approve'], entityTypes: ['ExpenseReport'] } },
      'audit.list': {
        data: { pages: [{ items: rows, nextCursor: null }] },
        onCall: (input: unknown) => h.listInputs.push(input),
      },
      'audit.retention': { data: { years: 7, isDefault: false } },
      ...over.queries,
    },
  });
}

type TrailProps = React.ComponentProps<typeof AuditTrail>;
const show = (props: Partial<TrailProps> = {}) =>
  render(<AuditTrail canVerify canConfigure {...props} />);
const showTopBar = () => render(<div>{h.topBar.right}</div>);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

beforeEach(() => {
  h.topBar = {};
  h.listInputs = [];
  h.downloads = [];
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The header stats ──────────────────────────────────────────────────────────

describe('the stats', () => {
  it('counts the entries and shows the window they span', () => {
    setTrpc();
    show();
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('admin.auditTrail.statWindow')).toBeInTheDocument();
  });

  it('states the retention and the last purge', () => {
    /**
     * The purge is the only thing that ever removes an entry, so an admin reading a
     * shorter window than they expect needs to see that a purge ran.
     */
    setTrpc();
    show();
    expect(screen.getByText('admin.auditTrail.years:7')).toBeInTheDocument();
    expect(screen.getByText(/admin.auditTrail.lastPurge:400/)).toBeInTheDocument();
  });

  it('says so when nothing has ever been purged', () => {
    setTrpc({ queries: { 'audit.stats': { data: { ...STATS, lastPurge: null } } } });
    show();
    expect(screen.getByText('admin.auditTrail.neverPurged')).toBeInTheDocument();
  });

  it('renders no counts at all while the stats load', () => {
    // A "0 entries" audit log is an alarming thing to render for a loading state.
    setTrpc({ queries: { 'audit.stats': { data: undefined, isLoading: true } } });
    show();
    expect(screen.queryByText('12,345')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.auditTrail.years:7')).not.toBeInTheDocument();
  });
});

// ── The log itself ────────────────────────────────────────────────────────────

describe('the log', () => {
  it('shows who did what, to which entity, from where', () => {
    setTrpc();
    show();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    expect(screen.getByText('report.approve')).toBeInTheDocument();
    expect(screen.getByText('rep-1')).toBeInTheDocument();
    expect(screen.getByText('198.51.100.7')).toBeInTheDocument();
  });

  it('shows the role AS IT WAS, not as it is now', () => {
    /**
     * `actorRoleLabel` is a snapshot on the row. Resolving the actor's CURRENT role
     * would rewrite history every time somebody is promoted.
     */
    setTrpc({}, [entry({ actorRoleLabel: 'Accounts Payable' })]);
    show();
    expect(screen.getByText('Accounts Payable')).toBeInTheDocument();
  });

  it('truncates the hash but keeps the whole of it reachable', () => {
    // Twelve characters is enough to compare by eye; the full value is the title.
    setTrpc();
    show();
    const hash = screen.getByText('abcdef012345…');
    expect(hash).toHaveAttribute('title', 'abcdef0123456789deadbeef');
  });

  it('shows an em dash for an entry with no entity or address', () => {
    setTrpc({}, [entry({ entityType: null, entityId: null, ipAddress: null })]);
    show();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('says the log is empty rather than showing a bare table', () => {
    setTrpc({}, []);
    show();
    expect(screen.getByText('admin.auditTrail.empty')).toBeInTheDocument();
  });

  it('opens an entry’s detail on a row click', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Ada Lovelace'));
    expect(await screen.findByText('admin.auditTrail.sectionWho')).toBeInTheDocument();
    expect(screen.getByText('admin.auditTrail.roleAtTime')).toBeInTheDocument();
  });

  it('carries the whole entry into the drawer, hash chain included', async () => {
    /**
     * The chain fields are on screen because they are the EVIDENCE: an auditor
     * re-derives the hash from the fields above and compares it to what is stored. A
     * drawer that summarised instead would leave them trusting the row.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Ada Lovelace'));
    await screen.findByText('admin.auditTrail.sectionWho');
    expect(screen.getByText('Mozilla/5.0')).toBeInTheDocument();
    expect(screen.getByText('abcdef0123456789deadbeef')).toBeInTheDocument();
    expect(screen.getByText('0000')).toBeInTheDocument();
    expect(screen.getByText(/"note": "ok"/)).toBeInTheDocument();
  });

  it('dashes every field an entry never carried, rather than leaving gaps', async () => {
    /**
     * These are all nullable, and several are nullable for reasons worth reading: a job
     * that ran with no request has no IP and no user agent, and the FIRST entry in a
     * chain has no previous hash. A blank labelled field reads as a load that failed;
     * a dash reads as "this entry did not have one", which is the fact.
     */
    const user = userEvent.setup();
    setTrpc({}, [
      entry({
        actorRoleLabel: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
        entityType: null,
        entityId: null,
        prevHash: null,
        details: null,
      }),
    ]);
    show();
    await user.click(screen.getByText('Ada Lovelace'));
    await screen.findByText('admin.auditTrail.sectionWho');
    // Seven dashed fields in the drawer, plus the two the row itself renders.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(7);
    // A null details payload still renders as an object, not as the word "null".
    expect(screen.getByText('{}')).toBeInTheDocument();
  });
});

// ── Verification ──────────────────────────────────────────────────────────────

describe('verifying the chain', () => {
  const clickVerify = async (user: ReturnType<typeof userEvent.setup>, days = 90) => {
    showTopBar();
    await user.click(screen.getByRole('button', { name: `admin.auditTrail.verifyDays:${days}` }));
  };

  it('offers verification only to somebody who may run it', () => {
    setTrpc();
    show();
    showTopBar();
    // One button per verification window.
    expect(screen.getAllByRole('button', { name: /verifyDays/ }).length).toBeGreaterThan(0);

    cleanup();
    h.topBar = {};
    setTrpc();
    show({ canVerify: false });
    showTopBar();
    expect(screen.queryByRole('button', { name: /verifyDays/ })).not.toBeInTheDocument();
  });

  it('verifies the window that was asked for', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'audit.verify': { onCall } } });
    show();
    await clickVerify(user, 90);
    expect(onCall).toHaveBeenCalledWith({ lastDays: 90 });
  });

  it('reports a pass with what it scanned', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.verify': {
          outcome: 'success',
          data: { ok: true, scanned: 4210, purgeAware: false },
        },
      },
    });
    show();
    await clickVerify(user);
    expect(await screen.findByText(/admin.auditTrail.verifyOk:4210,90/)).toBeInTheDocument();
  });

  it('still passes across a purge boundary, and says so', async () => {
    /**
     * A purge deliberately removes the oldest entries, which breaks the literal chain
     * where it cut. Reporting that as tampering would cry wolf on every retention run —
     * so the pass is annotated instead.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.verify': { outcome: 'success', data: { ok: true, scanned: 10, purgeAware: true } },
      },
    });
    show();
    await clickVerify(user);
    expect(await screen.findByText(/verifyPurgeAware/)).toBeInTheDocument();
  });

  it('names the entry and the KIND of break on a failure', async () => {
    /**
     * "Verification failed" alone is unactionable. Which entry, and whether its own hash
     * or its link to the previous one is wrong, is what an investigation starts from.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.verify': {
          outcome: 'success',
          data: {
            ok: false,
            reason: 'entry-hash-mismatch',
            at: { id: 'a-99' },
            scanned: 12,
          },
        },
      },
    });
    show();
    await clickVerify(user);
    const alert = await screen.findByText(/admin.auditTrail.verifyFailed/);
    expect(alert.textContent).toContain('a-99');
    expect(alert.textContent).toContain('reasonEntryHash');
  });

  it('distinguishes a broken LINK from a broken entry', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.verify': {
          outcome: 'success',
          data: { ok: false, reason: 'prev-hash-mismatch', at: { id: 'a-7' }, scanned: 3 },
        },
      },
    });
    show();
    await clickVerify(user);
    expect((await screen.findByText(/verifyFailed/)).textContent).toContain('reasonPrevHash');
  });

  it('reports a refused verification rather than an ambiguous silence', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.verify': { outcome: 'error', error: { message: 'Verification timed out' } },
      },
    });
    show();
    await clickVerify(user);
    expect(await screen.findByText('Verification timed out')).toBeInTheDocument();
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('filtering', () => {
  const filterText = async (
    user: ReturnType<typeof userEvent.setup>,
    column: string,
    value: string,
  ) => {
    const header = screen.getByText(column).closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), value);
    await user.click(screen.getByText('table.colMenu.apply'));
  };

  it('keeps every row on screen — the filter is the server’s job', async () => {
    /**
     * The log is unbounded. A client-side filter would narrow the page that happens to
     * be loaded and silently answer a different question, so the page sends the clause
     * and re-queries instead.
     */
    const user = userEvent.setup();
    setTrpc({}, [entry(), entry({ id: 'a-2', actorName: 'Grace Hopper' })]);
    show();
    await filterText(user, 'admin.auditTrail.colActor', 'grace');
    // Both rows are still rendered: the harness returns the same page, which is the
    // point — nothing was filtered here.
    expect(rowTexts()).toHaveLength(2);
  });

  it('offers the actions and entity types the log actually contains', async () => {
    /**
     * From a facet query rather than a hardcoded list — an audit action added by a new
     * feature has to be filterable without a UI change.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    const header = screen.getByText('admin.auditTrail.colAction').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    const apply = await screen.findByText('table.colMenu.apply');
    const editor = apply.closest('div[class*="p-2"]')?.parentElement as HTMLElement;
    expect(within(editor).getByText('report.approve')).toBeInTheDocument();
  });

  it('offers a date field the column header cannot host', () => {
    /**
     * Relative presets ("last 7 days") and absolute comparisons need an editor the
     * header menu has no room for, so the field lives on the pill bar.
     */
    setTrpc();
    show();
    expect(
      screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/i }),
    ).toBeInTheDocument();
  });
});

// ── Retention ─────────────────────────────────────────────────────────────────

describe('retention', () => {
  it('shows the configured window', () => {
    setTrpc();
    show();
    expect(screen.getByLabelText(/admin\.auditTrail\.retentionLabel/)).toHaveValue(7);
  });

  it('says when the window is the default rather than a choice', () => {
    // "7 years" chosen and "7 years because nobody chose" are different facts to an
    // auditor asking why.
    setTrpc({ queries: { 'audit.retention': { data: { years: 7, isDefault: true } } } });
    show();
    expect(screen.getByText('admin.auditTrail.retentionDefault')).toBeInTheDocument();
  });

  it('will not save the value that is already set', async () => {
    // A write that changes nothing still invalidates two queries and re-renders.
    setTrpc();
    show();
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeDisabled();
  });

  it('saves a changed window', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'audit.setRetention': { onCall } } });
    show();
    fireEvent.change(screen.getByLabelText(/admin\.auditTrail\.retentionLabel/), {
      target: { value: '10' },
    });
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(onCall).toHaveBeenCalledWith({ years: 10 });
  });

  it('refuses a non-integer window', async () => {
    // Retention is whole years; "7.5" is not a policy anybody wrote.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'audit.setRetention': { onCall } } });
    show();
    fireEvent.change(screen.getByLabelText(/admin\.auditTrail\.retentionLabel/), {
      target: { value: '7.5' },
    });
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(await screen.findByText('admin.auditTrail.retentionInvalid')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('reports a refused change', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'audit.setRetention': {
          outcome: 'error',
          error: { message: 'Retention cannot be shortened below the legal minimum' },
        },
      },
    });
    show();
    fireEvent.change(screen.getByLabelText(/admin\.auditTrail\.retentionLabel/), {
      target: { value: '8' },
    });
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(
      await screen.findByText('Retention cannot be shortened below the legal minimum'),
    ).toBeInTheDocument();
  });
});

describe('a purge recorded before 0075 (VeloExpense)', () => {
  it('names the entry it purged through, having no count or date to give', () => {
    setTrpc({
      queries: {
        'audit.stats': {
          data: {
            ...STATS,
            lastPurge: { ...STATS.lastPurge, runAt: null, purgedCount: null },
          },
        },
      },
    });
    show();
    expect(screen.getByText(/admin.auditTrail.purgedThrough:9001/)).toBeInTheDocument();
  });
});

// ── What the server is asked to filter ────────────────────────────────────────

/**
 * The log is unbounded, so every filter is the server's job — filtering the page you
 * happen to have loaded silently answers a different question. Which makes the
 * TRANSLATION from pill to query the interesting part, and the date one is where it bites:
 * a relative preset ("last 7 days") only means something in the browser's timezone, so it
 * resolves here and the server sees absolute bounds.
 */
describe('the query the log sends', () => {
  const lastInput = () => h.listInputs.at(-1) as { filters?: Array<Record<string, unknown>> };

  const addFilter = async (
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    op: string,
    value: string,
    kind: 'text' | 'enum' = 'text',
  ) => {
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    const combos = screen.getAllByRole('combobox');
    await user.selectOptions(combos[0], field);
    await user.selectOptions(combos[1], op);
    if (kind === 'enum') {
      await user.selectOptions(screen.getAllByRole('combobox')[2], value);
    } else {
      // The placeholder differs by operator ("Type a value…" for `contains`, "Type or
      // pick…" for the rest), so the control is found by its label instead.
      await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), value);
    }
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  it('sends no filters at all when nobody set one', async () => {
    /** `undefined` rather than an empty array: one asks for the whole log, the other for
     *  entries matching nothing. */
    setTrpc();
    show();
    expect(lastInput().filters).toBeUndefined();
  });

  it('passes a text clause through with its operator', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'actor', 'contains', 'ada');
    await vi.waitFor(() =>
      expect(lastInput().filters).toEqual([{ field: 'actor', op: 'contains', value: 'ada' }]),
    );
  });

  it('passes an exclusion through rather than dropping it', async () => {
    /** "everything except the nightly job" is how somebody reads a day's real activity. */
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'action', 'doesNotEqual', 'report.approve', 'enum');
    await vi.waitFor(() =>
      expect(lastInput().filters).toEqual([
        { field: 'action', op: 'doesNotEqual', value: 'report.approve' },
      ]),
    );
  });

  it('passes an exact match through, distinct from a substring', async () => {
    /** `equals` and `contains` answer different questions about an entity id, and a page
     *  that silently sent one for the other would show the wrong entries as the answer. */
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'entityId', 'equals', 'rep-1');
    await vi.waitFor(() =>
      expect(lastInput().filters).toEqual([{ field: 'entityId', op: 'equals', value: 'rep-1' }]),
    );
  });

  it('passes a prefix through, which is how an id namespace is chased', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'entityId', 'startsWith', 'rep-');
    await vi.waitFor(() =>
      expect(lastInput().filters).toEqual([{ field: 'entityId', op: 'startsWith', value: 'rep-' }]),
    );
  });

  it('drops an operator the server has no column semantics for', async () => {
    /**
     * The pill bar offers `doesNotContain`; the audit query does not implement it. Sending
     * it anyway would be a filter the server ignores — the reader would see the pill, see
     * an unnarrowed list, and conclude the log is wrong rather than the filter.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'actor', 'doesNotContain', 'ada');
    await vi.waitFor(() => expect(lastInput().filters).toBeUndefined());
  });

  it('resolves a relative date preset into absolute bounds', async () => {
    /**
     * "Last 7 days" is a different instant in Halifax than in Vancouver, and the server
     * has no idea which browser asked. Resolving here is what makes the answer match the
     * question.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    const combos = screen.getAllByRole('combobox');
    await user.selectOptions(combos[0], 'date');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    await vi.waitFor(() => {
      const filters = lastInput().filters ?? [];
      expect(filters.length).toBeGreaterThan(0);
      for (const f of filters) {
        expect(f.field).toBe('date');
        expect(['after', 'before']).toContain(f.op);
        // Absolute, ISO, and parseable — not a preset token the server would have to guess at.
        expect(Number.isNaN(Date.parse(String(f.value)))).toBe(false);
      }
    });
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('exporting the log', () => {
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('writes the timestamp as ISO, not as the reader’s locale', async () => {
    /**
     * An audit export is evidence, and "01/08/2026" is two different days depending on who
     * opens it. The screen shows the local rendering; the file carries the instant.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('2026-08-01T12:34:56');
  });

  it('writes the WHOLE hash, not the truncation the column shows', async () => {
    /** The table truncates to keep the column narrow. A truncated hash in a file is not a
     *  hash — it cannot be checked against anything. */
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('abcdef0123456789deadbeef');
  });

  it('leaves an absent entity or address empty rather than exporting the dash', async () => {
    /** The em dash is a rendering for a person; in a spreadsheet it is a value that
     *  sorts and filters as text. */
    const user = userEvent.setup();
    setTrpc({}, [entry({ entityType: null, entityId: null, ipAddress: null })]);
    show();
    const csv = await exportCsv(user);
    expect(csv).not.toContain('—');
  });
});
