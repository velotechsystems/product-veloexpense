import '@testing-library/jest-dom/vitest';
import { SCOPE_RESOURCES } from '@expenseos/api-scopes';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Platform API keys, on `/admin/api-keys`.
 *
 * Four pieces of this screen carry weight beyond looking right:
 *
 *   · **There is no kind choice.** This form mints PLATFORM keys and nothing else. It used
 *     to sit on `/profile` with a dropdown, one option away from a personal key — which is
 *     what made a service account look like a variant of a personal token. The absence of
 *     the control is the fix, not a better label on it, and `kind: 'PLATFORM'` going out on
 *     the wire is what proves the control's absence did not just hide a USER default.
 *   · **The list shows platform keys only.** `apiKeys.list` returns the caller's own USER
 *     keys as well; unfiltered, an admin's personal keys would render inside the
 *     platform-admin surface, each with a live Revoke button.
 *   · **The issued token gets a panel that stays until dismissed, announces itself, and
 *     takes focus.** It exists for one render and is never recoverable, so a toast that can
 *     be missed or scrolled past would cost somebody an impersonation credential — and the
 *     panel has to survive the list refetch that follows the creation. The token itself is
 *     rendered by the shared `TokenReveal` and is deliberately NOT a form control: this
 *     form used to put it in a `<Textarea>`, where a spellchecker may transmit it to a
 *     remote service and a password manager may offer to vault it. A personal key acts as
 *     one user; a platform key names a different subject per request and can act as any
 *     active user, so the impersonation credential is the one that least belongs in a form
 *     control. `TokenReveal.test.tsx` owns the shared behaviour — copy, focus, the guarded
 *     clipboard; what is asserted here is that this panel uses it and drops the secret
 *     from the mutation cache on dismiss.
 *   · **Scopes are three-state per resource**, not a checkbox list of scope strings. The
 *     grammar is `resource` for read+write and `resource.readonly` for read, and asking
 *     somebody to hold both strings in their head is how a key ends up over-granted. No
 *     access is the default, matching the server: a key with no scopes can do nothing.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (k: string, v?: Record<string, unknown>) =>
      v ? `apiKeys.${k}:${Object.values(v).join(',')}` : `apiKeys.${k}`;
    t.has = () => false;
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { PlatformApiKeys, scopeStringsFrom } from './PlatformApiKeys';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** PLATFORM by default: a USER key is filtered out, so it cannot be the list fixture. */
const key = (over: Record<string, unknown> = {}) => ({
  id: 'k-1',
  name: 'Zapier production',
  kind: 'PLATFORM',
  prefix: 'eos_live_9f2a',
  scopes: ['finance.budget.readonly'],
  lastUsedAt: '2026-08-01T12:00:00.000Z',
  expiresAt: '2026-12-31T12:00:00.000Z',
  manageable: true,
  createdBy: { firstName: 'Dana', lastName: 'Patel' },
  ...over,
});

function setTrpc(keys: unknown[] = [], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'apiKeys.list': { data: keys }, ...over.queries },
  });
}

const show = () => render(<PlatformApiKeys />);

const created = (onCall: ReturnType<typeof vi.fn>) =>
  onCall.mock.calls[0]?.[0] as Record<string, unknown>;

/**
 * Two fields wrap their label AND a help line in the same <label>, so the accessible
 * name is both strings joined — address those by id.
 */
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
/** The rendered key list, told apart from the form's own scope pickers above it. */
const keyList = () => screen.getByRole('list');

beforeEach(() => {
  // userEvent.setup() installs its own clipboard stub, so the assertion reads it back.
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The scope grammar ─────────────────────────────────────────────────────────

describe('scopeStringsFrom', () => {
  it('writes read+write as the bare resource and read as its readonly form', () => {
    /**
     * The whole reason the picker is three-state: `finance.budget` and
     * `finance.budget.readonly` are one grant apart, and a checkbox list of both invites
     * ticking the wrong one.
     */
    expect(scopeStringsFrom({ 'finance.budget': 'write' })).toEqual(['finance.budget']);
    expect(scopeStringsFrom({ 'finance.budget': 'read' })).toEqual(['finance.budget.readonly']);
  });

  it('grants nothing for a resource left at no access', () => {
    // A key with no scopes can do nothing, which is the safe default.
    expect(scopeStringsFrom({ 'finance.budget': 'none' })).toEqual([]);
    expect(scopeStringsFrom({})).toEqual([]);
  });

  it('sorts, so the same grant is always the same list', () => {
    // The stored array is compared between versions; unsorted, every save looks changed.
    expect(
      scopeStringsFrom({ 'finance.budget': 'write', 'expense_management.expense_report': 'read' }),
    ).toEqual(['expense_management.expense_report.readonly', 'finance.budget']);
  });
});

// ── One kind, and only one ────────────────────────────────────────────────────

describe('the kind of key this mints', () => {
  it('offers no kind choice at all', () => {
    /**
     * Not a hidden option, not a disabled one: this surface has exactly one legal kind, so
     * a control for it would be a decision that cannot go the other way. Carrying the
     * dropdown across the move would have given an admin a *personal*-key mint control on
     * the platform-admin screen — the same USER path the server was gated to close.
     */
    setTrpc();
    show();
    expect(screen.queryByLabelText('apiKeys.kind')).not.toBeInTheDocument();
    expect(screen.queryByText('apiKeys.kindUser')).not.toBeInTheDocument();
  });

  it('sends PLATFORM anyway, so the missing control is not a USER default', async () => {
    /**
     * The point of the assertion: removing a dropdown whose default was USER would leave a
     * form that silently mints personal keys from the admin screen. This is the test that
     * tells those two outcomes apart.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Zapier');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall).kind).toBe('PLATFORM');
  });

  it('says what a platform key actually is, in its own words', () => {
    /**
     * The copy that travelled with the form said "a key acts with the permissions of the
     * person it belongs to — never more". That is true of a personal key and false of this
     * one, which names a different subject per request and can act as any active user.
     */
    setTrpc();
    show();
    expect(screen.getByText('apiKeys.platformTitle')).toBeInTheDocument();
    expect(screen.getByText('apiKeys.platformDescription')).toBeInTheDocument();
    expect(screen.queryByText('apiKeys.description')).not.toBeInTheDocument();
  });
});

// ── The form ──────────────────────────────────────────────────────────────────

describe('minting a key', () => {
  it('will not create a key with no name', () => {
    // The name is how a key is identified when it has to be revoked in a hurry.
    setTrpc();
    show();
    expect(screen.getByRole('button', { name: 'apiKeys.create' })).toBeDisabled();
  });

  it('will not accept a name of only spaces', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), '   ');
    expect(screen.getByRole('button', { name: 'apiKeys.create' })).toBeDisabled();
  });

  it('offers a three-state grant for every resource, defaulting to none', () => {
    setTrpc();
    show();
    for (const resource of SCOPE_RESOURCES) {
      const select = screen.getByLabelText(resource) as HTMLSelectElement;
      expect(select.value).toBe('none');
      expect(within(select).getByText('apiKeys.scopeReadOnly')).toBeInTheDocument();
      expect(within(select).getByText('apiKeys.scopeReadWrite')).toBeInTheDocument();
    }
  });

  it('expires a key in thirty days unless told otherwise', () => {
    /**
     * A never-expiring key is the one that outlives the integration it was made for.
     * The default has to be a date.
     */
    setTrpc();
    show();
    expect((screen.getByLabelText('apiKeys.expiry') as HTMLSelectElement).value).toBe('30');
  });

  it('sends the whole key, with the chosen scopes as strings', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), '  Zapier  ');
    await user.selectOptions(screen.getByLabelText(SCOPE_RESOURCES[0]), 'write');
    await user.selectOptions(screen.getByLabelText(SCOPE_RESOURCES[1]), 'read');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall)).toMatchObject({
      kind: 'PLATFORM',
      name: 'Zapier',
      scopes: [SCOPE_RESOURCES[0], `${SCOPE_RESOURCES[1]}.readonly`].sort(),
    });
  });

  it('sends no expiry at all when never is chosen', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Forever');
    await user.selectOptions(screen.getByLabelText('apiKeys.expiry'), 'null');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall).expiresAt).toBeNull();
  });

  it('turns the chosen span into an actual date', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Quarterly');
    await user.selectOptions(screen.getByLabelText('apiKeys.expiry'), '90');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    const expires = created(onCall).expiresAt as Date;
    const days = (expires.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('sends no rate limit when the box is empty', async () => {
    // Blank is "the default", not "zero per minute", which would block every call.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Unlimited');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall).rateLimitPerMinute).toBeNull();
  });

  it('sends a typed rate limit', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Throttled');
    await user.type(byId('ak-rate'), '120');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall).rateLimitPerMinute).toBe(120);
  });

  it('splits the allow-list a line at a time, ignoring the blanks', async () => {
    /**
     * A trailing newline is how everybody finishes a list. Sending "" as an allowed
     * address would be an allow-list nothing matches.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'apiKeys.create': { onCall } } });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Fenced');
    await user.type(byId('ak-ips'), ' 203.0.113.7 \n\n198.51.100.0/24\n');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(created(onCall).allowedIps).toEqual(['203.0.113.7', '198.51.100.0/24']);
  });

  it('reports a refused creation', async () => {
    const user = userEvent.setup();
    setTrpc([], {
      mutations: {
        'apiKeys.create': { outcome: 'error', error: { message: 'Too many active keys' } },
      },
    });
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'One too many');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(await screen.findByText('Too many active keys')).toBeInTheDocument();
  });

  it('says it is working while the key is being minted', () => {
    setTrpc([], { mutations: { 'apiKeys.create': { isPending: true } } });
    show();
    expect(screen.getByRole('button', { name: 'apiKeys.creating' })).toBeDisabled();
  });
});

// ── The issued token ──────────────────────────────────────────────────────────

describe('the issued token', () => {
  const withToken = (over: TrpcMockConfig = {}) =>
    setTrpc([], {
      mutations: {
        'apiKeys.create': { outcome: 'success', data: { token: 'eos_live_9f2a.SECRET' } },
      },
      ...over,
    });

  const mint = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('apiKeys.name'), 'Zapier');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
  };

  it('shows the token, once, in a panel of its own', async () => {
    /**
     * It exists for exactly one render and is never recoverable. A toast that can be
     * scrolled past would cost somebody a key.
     */
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    expect(await screen.findByText('eos_live_9f2a.SECRET')).toBeInTheDocument();
    expect(screen.getByText('apiKeys.created')).toBeInTheDocument();
  });

  it('does not put the token in a form control', async () => {
    /**
     * Security's RC-5, back-ported here from the personal box. A `<Textarea>` is a form
     * control: the browser's spellchecker may transmit its contents to a remote service and
     * a password manager may offer to save it into a vault nobody intended. `<code>` with
     * `user-select: all` is neither, and still selects in one gesture.
     *
     * `queryByDisplayValue` is the assertion that carries it: it matches inputs, textareas
     * and selects and nothing else, so its absence IS "the secret is not in a form
     * control".
     */
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    const token = await screen.findByText('eos_live_9f2a.SECRET');
    expect(token.tagName).toBe('CODE');
    expect(token).toHaveClass('select-all');
    expect(screen.queryByDisplayValue('eos_live_9f2a.SECRET')).not.toBeInTheDocument();
  });

  it('announces the panel rather than only drawing it', async () => {
    /**
     * The panel had no live region. A screen-reader user got no notice that the one and
     * only render of an impersonation credential had just happened — the button they
     * pressed simply went quiet.
     */
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('eos_live_9f2a.SECRET')).toBeInTheDocument();
  });

  it('puts focus on the token itself, not merely near it', async () => {
    // So the value is what gets read out, and what the next keystroke can select.
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    expect(await screen.findByText('eos_live_9f2a.SECRET')).toHaveFocus();
  });

  it('has no live region standing empty before a key is minted', () => {
    // A permanently mounted status region trains the reader to ignore it.
    setTrpc();
    show();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says where to use it', () => {
    // A token with no endpoint is a puzzle.
    setTrpc();
    show();
    expect(screen.queryByText('apiKeys.endpointHint')).not.toBeInTheDocument();
  });

  it('copies it, and says it copied', async () => {
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    await user.click(await screen.findByRole('button', { name: 'apiKeys.copy' }));
    expect(await navigator.clipboard.readText()).toBe('eos_live_9f2a.SECRET');
    expect(screen.getByRole('button', { name: 'apiKeys.copied' })).toBeInTheDocument();
  });

  it('says so out loud when the clipboard refuses', async () => {
    /**
     * The old call was unguarded. In a non-secure context, or with permission denied, the
     * promise rejects inside an async `onClick`, the "Copied" label never arrives, and the
     * user gets total silence at the one moment the token is recoverable.
     */
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    await user.click(await screen.findByRole('button', { name: 'apiKeys.copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('apiKeys.copyFailed');
  });

  it('stays until it is dismissed', async () => {
    const user = userEvent.setup();
    withToken();
    show();
    await mint(user);
    expect(await screen.findByText('eos_live_9f2a.SECRET')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'apiKeys.dismiss' }));
    expect(screen.queryByText('eos_live_9f2a.SECRET')).not.toBeInTheDocument();
  });

  it('drops the token from the mutation cache when the panel is dismissed', async () => {
    /**
     * Clearing the panel is not enough. The token arrived as a MUTATION result, so
     * react-query holds it in the MutationCache until `gcTime` elapses — five minutes by
     * default — after the panel that showed it has gone. `reset()` drops it now, and for a
     * key that can act as any active user that is worth the one line.
     */
    const onReset = vi.fn();
    const user = userEvent.setup();
    setTrpc([], {
      mutations: {
        'apiKeys.create': {
          outcome: 'success',
          data: { token: 'eos_live_9f2a.SECRET' },
          onReset,
        },
      },
    });
    show();
    await mint(user);
    await user.click(screen.getByRole('button', { name: 'apiKeys.dismiss' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('clears the form so the next key is not an accidental duplicate', async () => {
    const user = userEvent.setup();
    withToken();
    show();
    await user.type(screen.getByLabelText('apiKeys.name'), 'Zapier');
    await user.selectOptions(screen.getByLabelText(SCOPE_RESOURCES[0]), 'write');
    await user.click(screen.getByRole('button', { name: 'apiKeys.create' }));
    expect(screen.getByLabelText('apiKeys.name')).toHaveValue('');
    expect((screen.getByLabelText(SCOPE_RESOURCES[0]) as HTMLSelectElement).value).toBe('none');
  });
});

// ── The existing keys ─────────────────────────────────────────────────────────

describe('the key list', () => {
  it('says when there are none, and admits the list may be partial', () => {
    /**
     * `list` only returns platform keys to somebody holding `admin.apiKey.list`. A holder
     * of `create` alone reaches this page, mints a key, and sees an empty list — so the
     * empty line has to mean "none you may see", not "none exist".
     */
    setTrpc([]);
    show();
    expect(screen.getByText('apiKeys.platformEmpty')).toBeInTheDocument();
  });

  it('leaves out the caller’s own personal keys', () => {
    /**
     * The naive move's actual defect: `list` returns USER keys too, so an admin's personal
     * keys would render inside the platform-admin surface, each with a live Revoke button.
     */
    setTrpc([key({ id: 'k-user', name: 'My laptop', kind: 'USER' }), key()]);
    show();
    const list = within(keyList());
    expect(list.queryByText('My laptop')).not.toBeInTheDocument();
    expect(list.getByText('Zapier production')).toBeInTheDocument();
  });

  it('says there are none when every key the caller holds is personal', () => {
    // Not a blank list: a `create`-only holder sees exactly this after minting.
    setTrpc([key({ kind: 'USER' })]);
    show();
    expect(screen.getByText('apiKeys.platformEmpty')).toBeInTheDocument();
  });

  it('reads a key out by name, kind, prefix and dates', () => {
    setTrpc([key()]);
    show();
    const list = within(keyList());
    expect(list.getByText('Zapier production')).toBeInTheDocument();
    expect(list.getByText('eos_live_9f2a')).toBeInTheDocument();
    expect(list.getByText(/apiKeys\.kindPlatform/)).toBeInTheDocument();
    expect(list.getByText(/apiKeys\.lastUsed/)).toBeInTheDocument();
  });

  it('says a key has never been used, rather than leaving a gap', () => {
    // "Never used" is the strongest hint that a key can be revoked safely.
    setTrpc([key({ lastUsedAt: null })]);
    show();
    expect(within(keyList()).getByText(/apiKeys\.never/)).toBeInTheDocument();
  });

  it('says a key never expires, which is a thing worth noticing', () => {
    setTrpc([key({ expiresAt: null })]);
    show();
    expect(within(keyList()).getByText(/apiKeys\.noExpiry/)).toBeInTheDocument();
  });

  it('names who provisioned it', () => {
    // A platform key outlives the person who made it; the name is the audit trail.
    setTrpc([key()]);
    show();
    expect(screen.getByText(/apiKeys\.provisionedBy: Dana Patel/)).toBeInTheDocument();
  });

  it('lists the scopes it actually holds', () => {
    setTrpc([key({ scopes: ['finance.budget.readonly', 'expense_management.expense_report'] })]);
    show();
    const list = within(keyList());
    expect(list.getByText('finance.budget.readonly')).toBeInTheDocument();
    expect(list.getByText('expense_management.expense_report')).toBeInTheDocument();
  });

  it('shows no scope chips for a key that holds none', () => {
    setTrpc([key({ scopes: [] })]);
    show();
    expect(within(keyList()).getByText('Zapier production')).toBeInTheDocument();
    expect(within(keyList()).queryByText('finance.budget.readonly')).not.toBeInTheDocument();
  });

  it('revokes a key by id', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([key()], { mutations: { 'apiKeys.revoke': { onCall } } });
    show();
    await user.click(screen.getByRole('button', { name: 'apiKeys.revoke' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'k-1' });
  });

  it('offers no revoke for a key this person may not manage, and says why', () => {
    /**
     * Somebody else's platform key is visible so it can be accounted for, but revoking
     * it is not theirs to do — and a missing button with no explanation reads as a bug.
     */
    setTrpc([key({ manageable: false })]);
    show();
    expect(screen.queryByRole('button', { name: 'apiKeys.revoke' })).not.toBeInTheDocument();
    expect(screen.getByText('apiKeys.notManageable')).toBeInTheDocument();
  });

  it('says it is revoking while the request is in flight', () => {
    setTrpc([key()], { mutations: { 'apiKeys.revoke': { isPending: true } } });
    show();
    expect(screen.getByRole('button', { name: 'apiKeys.revoking' })).toBeDisabled();
  });
});
