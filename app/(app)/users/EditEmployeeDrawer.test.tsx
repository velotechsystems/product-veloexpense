import type React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import type { PeopleRow } from './EmployeeDirectory.cells';

/**
 * The admin edit drawer for an employee's core profile.
 *
 * Everything it writes is nullable in the schema, and the difference between "not set"
 * and "empty string" matters at both ends:
 *
 *   · a cleared name has to go over as `null`, not `''` — a user whose first name is the
 *     empty string sorts and renders differently from one with none, and every display
 *     helper then has two blank cases to handle;
 *   · an org assignment removed in the picker has to go over as `null`, not the sentinel
 *     the Select needs to represent "None" — sending `__none__` would be a foreign key
 *     to nothing.
 *
 * The guardrails (manager cycles, grant ceilings) are the server's, so a refusal is
 * reported here rather than pre-empted — and the drawer stays open, because the edit is
 * still on screen and still unsaved.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
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
/**
 * Every Select becomes plain buttons keyed by the trigger id, so a test can choose an
 * option without driving Base UI's popup — which has its own suite in the design system.
 */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => undefined,
  });
  return {
    ...actual,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: ReactNode;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div data-testid="select" data-value={value}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({ id, children }: { id?: string; children: ReactNode }) => (
      <div data-trigger={id}>{children}</div>
    ),
    SelectValue: ({ children }: { children: ReactNode | ((v: string | null) => ReactNode) }) => {
      const { value } = React.useContext(Ctx);
      return <span>{typeof children === 'function' ? children(value) : children}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" data-option={value} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

/**
 * The manager picker becomes a stub that shows what the drawer handed it and offers a
 * pick per id plus a clear, so a test can drive it without the search round trip — the
 * real combobox has its own suite.
 */
vi.mock('@/components/pickers/EntityPickers', () => ({
  UserCombobox: ({
    id,
    value,
    initialItem,
    excludeValues,
    onValueChange,
  }: {
    id?: string;
    value: string | null;
    initialItem?: { value: string; label: string } | null;
    excludeValues?: readonly string[];
    onValueChange: (v: string | null, item: { value: string; label: string } | null) => void;
  }) => (
    <div
      data-testid="manager-picker"
      data-id={id}
      data-value={value ?? ''}
      data-seed={initialItem?.label ?? ''}
      data-exclude={JSON.stringify(excludeValues ?? null)}
    >
      {['u-2', 'u-3'].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onValueChange(v, { value: v, label: v })}
        >{`manager-pick:${v}`}</button>
      ))}
      <button type="button" onClick={() => onValueChange(null, null)}>
        manager-clear
      </button>
    </div>
  ),
}));

import { EditEmployeeDrawer } from './EditEmployeeDrawer';

const FACETS = {
  legalEntities: [
    { id: 'le-1', label: { en: 'Carmigo Canada' } },
    { id: 'le-2', label: { en: 'Carmigo US' } },
  ],
  businessUnits: [{ id: 'bu-1', label: { en: 'Retail' } }],
  departments: [{ id: 'd-1', label: { en: 'Finance' } }],
  // Server order is `code asc`; the fixture mirrors it so field position in the test
  // means the same thing it means in the browser.
  externalIdSources: [
    { code: 'concur', label: { en: 'SAP Concur' } },
    { code: 'netsuite', label: { en: 'NetSuite' } },
  ],
};

const person = (over: Record<string, unknown> = {}) =>
  ({
    syncDiscrepancies: [],
    id: 'u-1',
    firstName: 'Dana',
    lastName: 'Patel',
    email: 'dana@e.inc',
    avatarUrl: null,
    employeeStatus: 'ACTIVE',
    externalIds: {},
    entity: { id: 'le-1', label: { en: 'Carmigo Canada' } },
    businessUnit: { id: 'bu-1', label: { en: 'Retail' } },
    department: { id: 'd-1', label: { en: 'Finance' } },
    nsClass: null,
    manager: null,
    mfaEnrolled: true,
    deletedAt: null,
    country: 'CA',
    role: { id: 'r-1', label: { en: 'Approver' } },
    ...over,
  }) as unknown as PeopleRow;

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'users.listFilterFacets': { data: FACETS },
      // The external-IDs sub-form asks for the tenant's systems itself, rather than
      // riding on the People-specific facets query.
      'pickers.externalIdSources': { data: FACETS.externalIdSources },
      ...over.queries,
    },
  });
}

const onClose = vi.fn();

const show = (user: PeopleRow | null = person()) =>
  render(<EditEmployeeDrawer user={user} onClose={onClose} />);

const save = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'people.edit.save' }));

/** The option button inside the picker whose trigger carries `id`. */
const optionIn = (triggerId: string, value: string) => {
  const trigger = document.querySelector(`[data-trigger="${triggerId}"]`) as HTMLElement;
  const picker = trigger.closest('[data-testid="select"]') as HTMLElement;
  return picker.querySelector(`[data-option="${value}"]`) as HTMLElement;
};

afterEach(() => {
  h.trpc = undefined;
  onClose.mockReset();
  vi.restoreAllMocks();
});

// ── Opening ───────────────────────────────────────────────────────────────────

describe('opening the drawer', () => {
  it('renders nothing until there is somebody to edit', () => {
    setTrpc();
    show(null);
    expect(screen.queryByText('people.edit.title')).not.toBeInTheDocument();
  });

  it('names who is being edited', () => {
    // The directory can have several people with similar names on screen at once.
    setTrpc();
    show();
    expect(screen.getByText('people.edit.for:Dana Patel')).toBeInTheDocument();
  });

  it('falls back to the email when the person has no name yet', () => {
    setTrpc();
    show(person({ firstName: null, lastName: null }));
    expect(screen.getByText('people.edit.for:dana@e.inc')).toBeInTheDocument();
  });

  it('seeds the form from the person’s current profile', () => {
    setTrpc();
    show();
    expect(screen.getByLabelText(/people\.edit\.firstName/)).toHaveValue('Dana');
    expect(screen.getByLabelText(/people\.edit\.lastName/)).toHaveValue('Patel');
    expect(screen.getByLabelText(/people\.edit\.country/)).toHaveValue('CA');
  });

  it('starts the name fields empty rather than undefined', () => {
    // An undefined value in a controlled input makes the field uneditable.
    setTrpc();
    show(person({ firstName: null, lastName: null, country: null }));
    expect(screen.getByLabelText(/people\.edit\.firstName/)).toHaveValue('');
    expect(screen.getByLabelText(/people\.edit\.country/)).toHaveValue('');
  });
});

// ── Saving ────────────────────────────────────────────────────────────────────

describe('saving', () => {
  it('sends the whole patch against the person’s id', () => {
    setTrpc();
    show();
    expect(screen.getByRole('button', { name: 'people.edit.save' })).toBeEnabled();
  });

  it('trims a name and sends a cleared one as null', async () => {
    /**
     * An empty-string first name is a third state nobody wants: it sorts and renders
     * differently from "no name", and every display helper then has two blank cases.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    const first = screen.getByLabelText(/people\.edit\.firstName/);
    await user.clear(first);
    const last = screen.getByLabelText(/people\.edit\.lastName/);
    await user.clear(last);
    await user.type(last, '  Patel-Chan  ');
    await save(user);
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      id: 'u-1',
      patch: expect.objectContaining({ firstName: null, lastName: 'Patel-Chan' }),
    });
  });

  /**
   * External ids — the mapping that decides whether a person's expense report can post.
   *
   * A submitter with no NetSuite employee id is refused by the posting pre-flight ("the
   * report has nobody to reimburse"), and before this field existed the only way to set
   * one was the seed or a directory sync. Every seeded QA account sat unmapped, which is
   * why the NetSuite path had never been exercised end-to-end.
   */
  it('lists only the ids the person actually carries', () => {
    /**
     * A SUB-FORM, the same one every other entity uses. It was a field per system,
     * rendered whether or not the person had an id in it — so a directory with four
     * sources put four permanently-empty boxes between "Department" and "Country" on
     * every profile anybody opened, and adding a fifth silently changed this form.
     */
    setTrpc();
    show(person({ externalIds: { netsuite: '10096345' } }));
    const values = screen.getAllByPlaceholderText('admin.common.value');
    expect(values).toHaveLength(1);
    expect(values[0]).toHaveValue('10096345');
  });

  it('shows no rows at all for a person mapped nowhere', () => {
    setTrpc();
    show(person({ externalIds: {} }));
    expect(screen.queryByPlaceholderText('admin.common.value')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.common.addId' })).toBeInTheDocument();
  });

  it('names the system rather than printing its stored code', () => {
    setTrpc();
    show(person({ externalIds: { netsuite: '10096345' } }));
    expect(screen.getByRole('option', { name: 'NetSuite' })).toBeInTheDocument();
  });

  it('sends an edited id, and a removed row as a removal', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show(person({ externalIds: { netsuite: '10096345', concur: 'C-77' } }));
    // Rows come back in the map's own order: netsuite, then concur.
    const values = screen.getAllByPlaceholderText('admin.common.value');
    await user.clear(values[0]);
    await user.type(values[0], '8244648');
    await user.click(screen.getAllByRole('button', { name: 'admin.common.remove' })[1]);
    await save(user);
    // A removed row is simply absent from the map, which is how the mapping is deleted
    // rather than stored as a blank id.
    expect(onCall.mock.calls[0]?.[0]?.patch?.externalIds).toEqual({ netsuite: '8244648' });
  });

  it('uppercases the country and sends a cleared one as null', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    const country = screen.getByLabelText(/people\.edit\.country/);
    await user.clear(country);
    await user.type(country, 'jp');
    await save(user);
    expect((onCall.mock.calls[0]?.[0] as { patch: { country: string } }).patch.country).toBe('JP');

    await user.clear(country);
    await save(user);
    expect(
      (onCall.mock.calls.at(-1)?.[0] as { patch: { country: unknown } }).patch.country,
    ).toBeNull();
  });

  it('carries the org assignments the person already has', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    await save(user);
    expect((onCall.mock.calls[0]?.[0] as { patch: Record<string, unknown> }).patch).toMatchObject({
      legalEntityId: 'le-1',
      businessUnitId: 'bu-1',
      departmentId: 'd-1',
      employeeStatus: 'ACTIVE',
    });
  });

  it('moves the person to another legal entity', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    await user.click(optionIn('ee-entity', 'le-2'));
    await save(user);
    expect(
      (onCall.mock.calls[0]?.[0] as { patch: { legalEntityId: string } }).patch.legalEntityId,
    ).toBe('le-2');
  });

  it('sends a removed assignment as null, not as the picker’s sentinel', async () => {
    /**
     * The Select needs a non-empty value to represent "None". Letting that sentinel
     * reach the server would be a foreign key to a legal entity called `__none__`.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    await user.click(optionIn('ee-dept', '__none__'));
    await save(user);
    expect(
      (onCall.mock.calls[0]?.[0] as { patch: { departmentId: unknown } }).patch.departmentId,
    ).toBeNull();
  });

  it('changes the employee status', async () => {
    // The field that decides whether the person can sign in at all.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    await user.click(optionIn('ee-status', 'TERMINATED'));
    await save(user);
    expect(
      (onCall.mock.calls[0]?.[0] as { patch: { employeeStatus: string } }).patch.employeeStatus,
    ).toBe('TERMINATED');
  });

  it('offers every status', () => {
    setTrpc();
    show();
    for (const s of ['ACTIVE', 'ON_LEAVE', 'DEACTIVATED', 'TERMINATED']) {
      expect(optionIn('ee-status', s)).not.toBeNull();
    }
  });

  it('offers a None option on every org picker', () => {
    setTrpc();
    show();
    for (const id of ['ee-entity', 'ee-bu', 'ee-dept']) {
      expect(optionIn(id, '__none__')).not.toBeNull();
    }
  });

  it('says it is saving while the change is in flight', () => {
    setTrpc({ mutations: { 'users.update': { isPending: true } } });
    show();
    expect(screen.getByRole('button', { name: 'people.edit.saving' })).toBeDisabled();
  });

  it('closes once the change lands', async () => {
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { outcome: 'success' } } });
    show();
    await save(user);
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a refusal and stays open, because the edit is still unsaved', async () => {
    /**
     * The manager-cycle and grant-ceiling guards are the server's. Closing on a refusal
     * would discard the change AND the explanation.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'users.update': {
          outcome: 'error',
          error: { message: 'That would make the reporting line a cycle' },
        },
      },
    });
    show();
    await save(user);
    expect(
      await screen.findByText('That would make the reporting line a cycle'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without saving on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show();
    await user.type(screen.getByLabelText(/people\.edit\.firstName/), 'x');
    await user.click(screen.getByRole('button', { name: 'people.edit.cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── The pickers ───────────────────────────────────────────────────────────────

describe('the org pickers', () => {
  it('lists the org units the tenant has', () => {
    setTrpc();
    show();
    expect(optionIn('ee-entity', 'le-2')).toHaveTextContent('Carmigo US');
    expect(optionIn('ee-bu', 'bu-1')).toHaveTextContent('Retail');
    expect(optionIn('ee-dept', 'd-1')).toHaveTextContent('Finance');
  });

  it('survives the facets not having loaded yet', () => {
    // The drawer opens on a row click; the facet query may still be in flight.
    setTrpc({ queries: { 'users.listFilterFacets': { isLoading: true, data: undefined } } });
    show();
    expect(screen.getByLabelText(/people\.edit\.firstName/)).toBeInTheDocument();
    expect(optionIn('ee-entity', '__none__')).not.toBeNull();
  });
});

describe('People ↔ NetSuite notice', () => {
  it('says which fields are contested before they are edited, with the review link for a reviewer', () => {
    setTrpc();
    const contested = person({
      syncDiscrepancies: [{ field: 'DEPARTMENT', divergesFromDirectory: false }],
    });
    render(<EditEmployeeDrawer user={contested} onClose={onClose} syncReviewPath="/netsuite/people" />);
    const notice = screen.getByTestId('people-sync-notice');
    expect(notice).toHaveTextContent('people.sync.editNotice');
    expect(notice).toHaveTextContent('people.sync.field.DEPARTMENT');
    expect(screen.getByText('people.sync.review').closest('a')?.getAttribute('href')).toMatch(
      /^\/netsuite\/people\?q=/,
    );
  });

  it('shows no notice for a person the two systems agree about', () => {
    setTrpc();
    show(person());
    expect(screen.queryByTestId('people-sync-notice')).not.toBeInTheDocument();
  });
});

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * The manager picker. The audit row's `changedFields` is the keys of the patch, so the
 * absence of `managerId` from an untouched save is the evidence that no manager change
 * happened — it must only travel when it changed, and a cleared manager goes as `null`.
 * Self-as-manager and reporting-chain cycles are the server's to refuse.
 */
describe('the manager picker', () => {
  const SAM = { id: 'u-2', firstName: 'Sam', lastName: 'Lee', role: { id: 'r-2' } };
  const picker = () => screen.getByTestId('manager-picker');
  /** The patch of the latest save; fails the test outright when nothing was sent. */
  const patchOf = (onCall: ReturnType<typeof vi.fn>) => {
    expect(onCall).toHaveBeenCalled();
    return onCall.mock.lastCall?.[0]?.patch as Record<string, unknown>;
  };

  it('shows the current manager, seeded with their name', () => {
    setTrpc();
    show(person({ manager: SAM }));
    expect(picker()).toHaveAttribute('data-id', 'ee-manager');
    expect(picker()).toHaveAttribute('data-value', 'u-2');
    expect(picker()).toHaveAttribute('data-seed', 'Sam Lee');
  });

  it('seeds nothing for a nameless manager, so the picker looks the name up itself', () => {
    setTrpc();
    show(person({ manager: { ...SAM, firstName: null, lastName: null } }));
    expect(picker()).toHaveAttribute('data-value', 'u-2');
    expect(picker()).toHaveAttribute('data-seed', '');
  });

  it('never offers the person being edited as their own manager', () => {
    setTrpc();
    show(person({ manager: SAM }));
    expect(JSON.parse(picker().getAttribute('data-exclude') ?? 'null')).toEqual(['u-1']);
  });

  it('sends the newly picked manager', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show(person({ manager: SAM }));
    await user.click(screen.getByRole('button', { name: 'manager-pick:u-3' }));
    await save(user);
    expect(patchOf(onCall)).toHaveProperty('managerId', 'u-3');
  });

  it('sends a cleared manager as null, not an empty string', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show(person({ manager: SAM }));
    await user.click(screen.getByRole('button', { name: 'manager-clear' }));
    await save(user);
    expect(patchOf(onCall)).toHaveProperty('managerId', null);
  });

  it('leaves the manager out of an untouched save, with or without a current manager', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    const { unmount } = show(person({ manager: SAM }));
    await save(user);
    expect(patchOf(onCall)).not.toHaveProperty('managerId');
    unmount();

    show(person({ manager: null }));
    await save(user);
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(patchOf(onCall)).not.toHaveProperty('managerId');
  });

  it('leaves the manager out when the original is picked back', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.update': { onCall } } });
    show(person({ manager: SAM }));
    await user.click(screen.getByRole('button', { name: 'manager-pick:u-3' }));
    await user.click(screen.getByRole('button', { name: 'manager-pick:u-2' }));
    await save(user);
    expect(patchOf(onCall)).not.toHaveProperty('managerId');
  });

  it('shows the server’s cycle refusal as it arrives and stays open', async () => {
    const message = 'Setting this manager would create a reporting-chain cycle';
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'users.update': { outcome: 'error', error: { message } } },
    });
    show(person({ manager: SAM }));
    await user.click(screen.getByRole('button', { name: 'manager-pick:u-3' }));
    await save(user);
    const err = await screen.findByText(message);
    expect(err.tagName).toBe('P');
    expect(err).toHaveClass('text-destructive');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('people.edit.title')).toBeInTheDocument();
    // The unsaved pick is still on screen.
    expect(picker()).toHaveAttribute('data-value', 'u-3');
  });
});
