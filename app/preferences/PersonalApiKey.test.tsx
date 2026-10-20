import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LG_MEDIA_QUERY } from '@/lib/breakpointsLg';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The personal API-key box on `/profile`.
 *
 * What the suite is actually defending, in the order the cases appear:
 *
 *   · **The empty state offers exactly one control.** Not "no scope picker" as a spot
 *     check — one button, counted. The whole point of the rewrite is that a user makes no
 *     security decisions here, and the way that regresses is one field at a time.
 *   · **Removing the choice did not remove the disclosure.** They no longer pick the
 *     scopes; they still get told what the key can and cannot do, in words.
 *   · **The token is shown once, cannot be clicked past, and is dropped from the mutation
 *     cache on dismiss.** It exists for one render and the server keeps only a SHA-256.
 *   · **Every key gets a row.** A key you cannot see is a key you cannot revoke.
 *   · **`ALL_EXPIRED` is its own state and it regenerates.** It must not fall back to the
 *     empty state — that reads as "you never had a key" to somebody whose integration
 *     broke this morning — and it must not call `requestPersonal`, which answers CONFLICT
 *     while the expired row still exists.
 *   · **Both destructive actions name what they destroy first**, and Regenerate names the
 *     count including expired rows, because those are revoked too — `revocableCount`, not
 *     the length of the list, because the list is wider than what this page can destroy.
 *   · **A key that acts as you but is not yours to revoke is SHOWN, with no button.** The
 *     bug this closes: `personal` filtered on `createdById`, so an admin-minted replacement
 *     acting as the subject was invisible on their own profile and they minted a second one.
 *     Seeing it and managing it are separate predicates, and the row says which it is.
 *   · **No server message reaches the screen.** The detail sentence is selected from the
 *     tRPC CODE and comes out of the catalog, so an FR-CA user never gets a French label
 *     followed by an English apology.
 *   · **Below `lg`, revocation survives and nothing else does.** Request and Regenerate end
 *     in a secret shown once that has to be pasted somewhere; Revoke is the one action whose
 *     moment of need is precisely when the reader is not at a desk.
 *   · **A fetch that never started renders a skeleton, never the empty state.** "You do not
 *     have an API key yet" is indistinguishable from the truth, and one click from a
 *     CONFLICT, for somebody who holds a key the page has stopped being able to see.
 *
 * ## THE VIEWPORT IS SET PER TEST, AND THE DEFAULT IS A DESKTOP ONE
 *
 * Everything above the "which face" block is about the FULL PANEL, which is the `lg` face, so
 * `beforeEach` puts every test at `lg` unless it says otherwise. Without that default the
 * suite would inherit jsdom's stock `matchMedia` — which answers `matches: false` to every
 * query, i.e. "below `lg`" — and would silently be asserting the panel against a viewport the
 * panel is hidden on.
 *
 * ## WHAT THIS FILE DOES NOT AND CANNOT TEST
 *
 * WHICH FACE IS PAINTED. That is `lg:hidden` and `hidden lg:contents`, and jsdom loads no
 * stylesheet: every element here is "visible" to `toBeVisible()` whatever Tailwind would have
 * done with it, so an assertion shaped like coverage of that branch would be a lie. Below
 * `lg` BOTH faces are in this DOM and the queries below are scoped accordingly. What is
 * testable here is the JavaScript: which face is in the tree at all, the `enabled` gate, the
 * state machine behind each body, and the skeleton-versus-empty distinction. The paint is
 * measured in a real engine by the browser suite.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns: string) => {
    const t = (k: string, v?: Record<string, unknown>) =>
      v ? `${ns}.${k}:${Object.values(v).join(',')}` : `${ns}.${k}`;
    t.has = () => false;
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { PersonalApiKey } from './PersonalApiKey';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** In policy and live by default: the shape `requestPersonal` mints today. */
const key = (over: Record<string, unknown> = {}) => ({
  id: 'k-1',
  name: 'Jose Neto — personal key',
  prefix: 'eos_user_9f2a',
  scopes: [
    'expense_management.expense_report',
    'travel.travel_request',
    'collaboration.discussion',
  ],
  rateLimitPerMinute: 60,
  allowedIps: [],
  lastUsedAt: '2026-08-20T12:00:00.000Z',
  expiresAt: '2027-02-27T12:00:00.000Z',
  createdAt: '2026-08-31T12:00:00.000Z',
  expired: false,
  inPolicy: true,
  /** The caller minted it, so it is theirs to revoke. `false` is the admin-minted case. */
  revocable: true,
  ...over,
});

/**
 * `state` is derived here exactly as the server derives it, so a fixture can never describe
 * a combination `apiKeys.personal` could not return — an ALL_EXPIRED payload with a live
 * key in it would make a passing test meaningless. `revocableCount` is derived from the rows
 * for the same reason: a payload claiming to revoke three of two rows is not a thing the
 * server can say, and a test built on one would be asserting fiction.
 */
function payload(keys: ReturnType<typeof key>[]) {
  const liveCount = keys.filter((k) => !k.expired).length;
  return {
    keys,
    liveCount,
    expiredCount: keys.length - liveCount,
    revocableCount: keys.filter((k) => k.revocable).length,
    state: keys.length === 0 ? 'NONE' : liveCount > 0 ? 'LIVE' : 'ALL_EXPIRED',
  };
}

/**
 * A tRPC client error as the component actually receives one: the CODE lives on `data`, and
 * `message` is the server's own English sentence, which must never reach the screen.
 *
 * Cast because the harness types a mutation error as `{ message: string }` and `data` is an
 * excess property on a literal. Widening `TrpcMockConfig` would mean editing
 * `test-utils/trpc.ts`, which is outside this change.
 */
const failure = (over: { message?: string; code?: string }) =>
  ({
    message: over.message ?? 'Server-side English nobody translated.',
    ...(over.code === undefined ? {} : { data: { code: over.code } }),
  }) as { message: string };

function setTrpc(data: unknown, over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'apiKeys.personal': { data }, ...over.queries },
  });
}

const show = () => render(<PersonalApiKey />);

/**
 * The same formatting the component applies, so these assertions are about WHICH date is
 * shown rather than how the runtime spells it out.
 */
// VeloExpense (w6-04): the catalog's default locale by name (check:i18n refuses a bare tag).
const shown = (iso: string) => new Date(iso).toLocaleDateString(DEFAULT_LOCALE);

const button = (name: string) => screen.getByRole('button', { name });
const maybeButton = (name: string) => screen.queryByRole('button', { name });
const p = (k: string) => `apiKeys.personal.${k}`;

/** Mint a key from the empty state and land on the reveal panel. */
const TOKEN = 'eos_user_9f2a.SECRET';
const minted = (over: TrpcMockConfig = {}) =>
  setTrpc(payload([]), {
    ...over,
    mutations: {
      'apiKeys.requestPersonal': {
        outcome: 'success',
        data: { token: TOKEN, key: { expiresAt: '2027-02-27T12:00:00.000Z' } },
      },
      ...over.mutations,
    },
  });

/**
 * Put the component at a viewport.
 *
 * `unmeasured` removes `matchMedia` entirely rather than answering it, because that is the
 * honest shape of the case the permanent skeleton exists for: an environment the component
 * cannot read, where guessing "below `lg`" would hand a desktop reader the wrong face with
 * nothing on screen to say so. Assigned rather than deleted — `tests/setup.ts` defines the
 * polyfill non-configurable, so `delete` throws, while `writable: true` lets this through.
 */
function setViewport(where: 'lg' | 'below' | 'unmeasured') {
  if (where === 'unmeasured') {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    return;
  }
  window.matchMedia = ((query: string) => ({
    matches: where === 'lg' && query === LG_MEDIA_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const REAL_MATCH_MEDIA = window.matchMedia;

/** The small-screen face, for the tests that are about it. */
const notice = () => within(screen.getByTestId('api-key-small-screen'));

beforeEach(() => {
  // The panel's viewport. Every case above the "which face" block is about the panel.
  setViewport('lg');
});

afterEach(() => {
  h.trpc = undefined;
  window.matchMedia = REAL_MATCH_MEDIA;
  vi.restoreAllMocks();
});

// ── Nothing to configure ──────────────────────────────────────────────────────

describe('the empty state', () => {
  it('offers exactly one control, and it is the request button', () => {
    /**
     * Counted, not spot-checked. The form this replaced had a name field, a kind dropdown,
     * a nine-resource scope picker, a CIDR box, an expiry menu and a rate limit — and the
     * way that comes back is one well-meaning field at a time. A count fails on the first.
     */
    setTrpc(payload([]));
    show();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(button(p('request'))).toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('offers no platform-key control of any kind', () => {
    /**
     * Acceptance criterion 11, at the component that replaced the form which carried the
     * dropdown. The platform form lives at `/admin/api-keys`; nothing about a `kind` may
     * reappear here, disabled or otherwise.
     */
    setTrpc(payload([]));
    show();
    expect(screen.queryByLabelText('apiKeys.kind')).not.toBeInTheDocument();
    expect(screen.queryByText('apiKeys.kindUser')).not.toBeInTheDocument();
    expect(screen.queryByText('apiKeys.kindPlatform')).not.toBeInTheDocument();
    expect(screen.queryByText('apiKeys.platformTitle')).not.toBeInTheDocument();
  });

  it('does not reuse the platform copy that says a key never has more than its owner', () => {
    /**
     * `apiKeys.description` reads "A key acts with the permissions of the person it belongs
     * to — never more". True of this key, false of a platform key, and it is being retired.
     * The personal box has its own vocabulary so that retirement cannot silently reinstate
     * the wrong sentence here.
     */
    setTrpc(payload([]));
    show();
    expect(screen.queryByText('apiKeys.description')).not.toBeInTheDocument();
    expect(screen.queryByText('apiKeys.title')).not.toBeInTheDocument();
    expect(screen.getByText(p('title'))).toBeInTheDocument();
  });

  it('says what the key can do, in words, even though nobody chose it', () => {
    // Taking away the CHOICE is not taking away the right to know the grant.
    setTrpc(payload([]));
    show();
    expect(screen.getByText(p('canExpenses'))).toBeInTheDocument();
    expect(screen.getByText(p('canTravel'))).toBeInTheDocument();
    expect(screen.getByText(p('canDiscussions'))).toBeInTheDocument();
  });

  it('says what it cannot do, including that it never exceeds the person holding it', () => {
    setTrpc(payload([]));
    show();
    expect(screen.getByText(p('cannotApprove'))).toBeInTheDocument();
    expect(screen.getByText(p('cannotBudgets'))).toBeInTheDocument();
    // VeloExpense (w6-04): no virtual cards here, so the box does not mention them.
    expect(screen.queryByText(p('cannotCards'))).not.toBeInTheDocument();
    expect(screen.getByText(p('cannotBeyond'))).toBeInTheDocument();
  });

  it('states the 180-day lifetime before anything is minted', () => {
    setTrpc(payload([]));
    show();
    expect(screen.getByText(p('lifetime'))).toBeInTheDocument();
  });

  it('sends no parameters at all', async () => {
    /**
     * `requestPersonal` declares no `.input()`, and this is the client half of that: the
     * call goes out with nothing in it. A component that sent `{}` would still pass a
     * "was it called" assertion while having reintroduced a payload for somebody to add a
     * field to later.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([]), { mutations: { 'apiKeys.requestPersonal': { onCall } } });
    show();
    await user.click(button(p('request')));
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall.mock.calls[0][0]).toBeUndefined();
  });

  it('says it is working while the key is being minted', () => {
    setTrpc(payload([]), { mutations: { 'apiKeys.requestPersonal': { isPending: true } } });
    show();
    expect(button(p('requesting'))).toBeDisabled();
  });

  it('offers nothing destructive when there is nothing to destroy', () => {
    setTrpc(payload([]));
    show();
    expect(maybeButton(p('regenerate'))).not.toBeInTheDocument();
    expect(maybeButton('apiKeys.revoke')).not.toBeInTheDocument();
  });
});

// ── The one render the secret ever gets ───────────────────────────────────────

describe('the revealed token', () => {
  const mint = (user: ReturnType<typeof userEvent.setup>) => user.click(button(p('request')));

  it('shows the plaintext once, in a panel that announces itself', async () => {
    const user = userEvent.setup();
    minted();
    show();
    await mint(user);
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText(TOKEN)).toBeInTheDocument();
    expect(within(panel).getByText(p('revealTitle'))).toBeInTheDocument();
  });

  it('has no live region standing empty before anything is minted', () => {
    // A permanently mounted status region trains a screen-reader user to ignore it.
    setTrpc(payload([]));
    show();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('states the expiry as a date, at the moment the key is handed over', async () => {
    // Acceptance criterion 13, first half.
    const user = userEvent.setup();
    minted();
    show();
    await mint(user);
    expect(
      await screen.findByText(`${p('revealExpiry')}:${shown('2027-02-27T12:00:00.000Z')}`),
    ).toBeInTheDocument();
  });

  it('cannot be clicked past before the key has been copied', async () => {
    /**
     * An affirmative acknowledgement rather than a soft "Done". This panel is the only time
     * the secret exists, and the stray click that loses it looks exactly like the click
     * that closes a toast.
     */
    const user = userEvent.setup();
    minted();
    show();
    await mint(user);
    expect(await screen.findByRole('button', { name: p('revealDismiss') })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: p('ackLabel') }));
    expect(button(p('revealDismiss'))).toBeEnabled();
    await user.click(button(p('revealDismiss')));
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('drops the token from the mutation cache when the panel is dismissed', async () => {
    /**
     * Clearing the panel is not enough: the token arrived as a MUTATION result, so
     * react-query holds it in the MutationCache until `gcTime` elapses — five minutes by
     * default — after the panel that showed it has gone. `reset()` is what drops it.
     */
    const onReset = vi.fn();
    const user = userEvent.setup();
    minted({ mutations: { 'apiKeys.regeneratePersonal': { onReset } } });
    show();
    await mint(user);
    await user.click(await screen.findByRole('checkbox', { name: p('ackLabel') }));
    await user.click(button(p('revealDismiss')));
    // Both mutations are reset, because either could have produced what was on screen.
    expect(onReset).toHaveBeenCalled();
  });

  it('never shows a token in the metadata view', async () => {
    /**
     * Acceptance criterion 3. There is nothing to show: the server stores a SHA-256 and the
     * plaintext existed only in the mint response.
     */
    setTrpc(payload([key()]));
    show();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  });
});

// ── Living with a key ─────────────────────────────────────────────────────────

describe('a key that works', () => {
  it('reads the key out by name, prefix, created date and last use', () => {
    setTrpc(payload([key()]));
    show();
    expect(screen.getByText('Jose Neto — personal key')).toBeInTheDocument();
    expect(screen.getByText('eos_user_9f2a')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${p('createdOn')}:${shown('2026-08-31T12:00:00.000Z')}`)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${p('lastUsedOn')}:${shown('2026-08-20T12:00:00.000Z')}`)),
    ).toBeInTheDocument();
  });

  it('states the expiry as a date in the metadata view', () => {
    // Acceptance criterion 13, second half.
    setTrpc(payload([key()]));
    show();
    expect(
      screen.getByText(`${p('expiresOn')}:${shown('2027-02-27T12:00:00.000Z')}`),
    ).toBeInTheDocument();
  });

  it('says a key has never been used rather than leaving a gap', () => {
    // "Never used" is the strongest hint that a key can be revoked safely.
    setTrpc(payload([key({ lastUsedAt: null })]));
    show();
    expect(screen.getByText(new RegExp(p('neverUsed')))).toBeInTheDocument();
  });

  it('gives every live key its own row and its own revoke', () => {
    /**
     * Not "the newest, plus a count of the rest". A key you cannot see is a key you cannot
     * revoke — and holding two at once is reachable, which is why `regeneratePersonal`
     * exists to converge the set.
     */
    setTrpc(payload([key(), key({ id: 'k-2', name: 'Older key', prefix: 'eos_user_0001' })]));
    show();
    // Scoped to the named key list: the capability disclosure below it is two more lists.
    const list = within(screen.getByRole('list', { name: p('keysLabel') }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getAllByRole('button', { name: 'apiKeys.revoke' })).toHaveLength(2);
    expect(list.getByText('Older key')).toBeInTheDocument();
  });

  it('shows a key it cannot revoke, and says why, in place of the button', async () => {
    /**
     * The bug this closes. `personal` used to filter on `createdById = caller`, so a key an
     * admin minted that ACTS AS the caller was invisible on the caller's own profile: they
     * saw the empty state, minted a second key, and held two live credentials acting as
     * them, one of which they could neither see nor revoke.
     *
     * Seeing and managing are separate predicates now, so both halves have to hold in the
     * SAME list — a fixture with only the non-revocable row would pass against a component
     * that had simply dropped every Revoke button. And it is the button's ABSENCE, not a
     * disabled button: the server answers NOT_FOUND for that id, so the only thing a
     * present control could do is fail at somebody who can do nothing about it.
     */
    setTrpc(payload([key(), key({ id: 'k-2', name: 'Provisioned for me', revocable: false })]));
    show();
    const list = within(screen.getByRole('list', { name: p('keysLabel') }));
    const rows = list.getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByRole('button', { name: 'apiKeys.revoke' })).toBeInTheDocument();
    expect(within(rows[0]).queryByText('apiKeys.notManageable')).not.toBeInTheDocument();

    expect(within(rows[1]).getByText('Provisioned for me')).toBeInTheDocument();
    expect(within(rows[1]).getByText('apiKeys.notManageable')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button')).not.toBeInTheDocument();

    // And nothing anywhere on the card can put that row into a revoke confirmation.
    const user = userEvent.setup();
    await user.click(list.getByRole('button', { name: 'apiKeys.revoke' }));
    expect(
      await screen.findByText(`${p('confirmRevokeBody')}:Jose Neto — personal key`),
    ).toBeInTheDocument();
  });

  it('reuses the note the platform list already shows for the same situation', () => {
    /**
     * `apiKeys.notManageable` rather than a `personal.*` variant of it: the sentence is
     * identical in meaning, already translated in both locales, and already on screen at
     * `/admin/api-keys`. A second one would be a second French sentence to keep in step
     * with the first for no gain — the same argument the component makes for `tk('revoke')`.
     */
    setTrpc(payload([key({ revocable: false })]));
    show();
    expect(screen.getByText('apiKeys.notManageable')).toBeInTheDocument();
    expect(screen.queryByText(p('notManageable'))).not.toBeInTheDocument();
  });

  it('marks a key issued under older settings, and says what that means', () => {
    /**
     * `inPolicy: false` is reported and never repaired. Silently narrowing a credential
     * somebody's automation depends on is a breakage with no notification attached, so the
     * row says so and Regenerate is the transition.
     */
    setTrpc(payload([key({ inPolicy: false })]));
    show();
    expect(screen.getByText(p('legacyBadge'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(p('legacyHelp')))).toBeInTheDocument();
  });

  it('leaves an in-policy key unmarked', () => {
    // Otherwise the marker means nothing.
    setTrpc(payload([key()]));
    show();
    expect(screen.queryByText(p('legacyBadge'))).not.toBeInTheDocument();
  });

  it('says a legacy key has no end date rather than printing nothing', () => {
    // The pre-180-day keys were minted with `expiresAt: null`, and that is worth noticing.
    setTrpc(payload([key({ expiresAt: null, inPolicy: false })]));
    show();
    expect(screen.getByText(p('noEndDate'))).toBeInTheDocument();
  });

  it('offers regenerate instead of request', () => {
    // Acceptance criterion 5: the metadata view on arrival, not the request button.
    setTrpc(payload([key()]));
    show();
    expect(button(p('regenerate'))).toBeInTheDocument();
    expect(maybeButton(p('request'))).not.toBeInTheDocument();
  });
});

// ── The expired end-state ─────────────────────────────────────────────────────

describe('a key that has expired', () => {
  const expiredKey = (over: Record<string, unknown> = {}) =>
    key({ expired: true, expiresAt: '2026-08-01T12:00:00.000Z', ...over });

  it('says the key expired, and when — it is not the empty state', () => {
    /**
     * The decision this case exists for. At 180 days this is the routine end of every key
     * the feature mints, and the bare request button is visually identical to never having
     * had one: a user whose integration broke yesterday would get no explanation at all.
     */
    setTrpc(payload([expiredKey()]));
    show();
    expect(
      screen.getByText(`${p('expiredLead')}:${shown('2026-08-01T12:00:00.000Z')}`),
    ).toBeInTheDocument();
    expect(maybeButton(p('request'))).not.toBeInTheDocument();
    expect(screen.queryByText(p('emptyLead'))).not.toBeInTheDocument();
  });

  it('names the date access actually ended, not the newest row', () => {
    /**
     * Two expired keys: the one created most recently is not necessarily the one that
     * expired last, and the date that explains what the user saw happen is the later of
     * the two.
     */
    setTrpc(
      payload([
        expiredKey({
          createdAt: '2026-03-01T12:00:00.000Z',
          expiresAt: '2026-05-01T12:00:00.000Z',
        }),
        expiredKey({
          id: 'k-2',
          createdAt: '2026-01-01T12:00:00.000Z',
          expiresAt: '2026-07-30T12:00:00.000Z',
        }),
      ]),
    );
    show();
    expect(
      screen.getByText(`${p('expiredLead')}:${shown('2026-07-30T12:00:00.000Z')}`),
    ).toBeInTheDocument();
  });

  it('does not promise to revoke an expired key it cannot revoke', () => {
    /**
     * Reachable: an admin-minted replacement is the caller's only key, and 180 days pass.
     * `expiredHint`'s unconditional wording said "The expired key is revoked at the same
     * time", which for this user is a promise the page cannot keep — Regenerate mints and
     * revokes nothing. The hint carries `revocableCount` so the `=0` arm can say so.
     */
    setTrpc(payload([expiredKey({ revocable: false })]));
    show();
    expect(screen.getByText(`${p('expiredHint')}:0`)).toBeInTheDocument();
  });

  it('says the expired key is revoked when it actually will be', () => {
    // Otherwise the zero arm above could be the only arm anything ever reaches.
    setTrpc(payload([expiredKey()]));
    show();
    expect(screen.getByText(`${p('expiredHint')}:1`)).toBeInTheDocument();
  });

  it('shows the expiry in the past tense on the row itself', () => {
    // "Expires 1 August" about a day that has been and gone reads as a key that still works.
    setTrpc(payload([expiredKey()]));
    show();
    expect(
      screen.getByText(`${p('expiredOn')}:${shown('2026-08-01T12:00:00.000Z')}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(p('expiresOn')))).not.toBeInTheDocument();
  });

  it('regenerates rather than requesting, because the old row still exists', async () => {
    /**
     * The trap this pins. `requestPersonal` refuses with CONFLICT while ANY unrevoked
     * personal key is held, expired or not — so an expired state wired to it would give the
     * user a button that can only ever fail. `regeneratePersonal` is the total function.
     */
    const request = vi.fn();
    const regenerate = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([expiredKey()]), {
      mutations: {
        'apiKeys.requestPersonal': { onCall: request },
        'apiKeys.regeneratePersonal': { onCall: regenerate },
      },
    });
    show();
    await user.click(button(p('regenerate')));
    await user.click(button(p('confirmRegenGo')));
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});

// ── Naming the damage before doing it ─────────────────────────────────────────

describe('regenerating', () => {
  const twoKeys = () => [key(), key({ id: 'k-2', name: 'Older key', expired: true })];

  it('names how many keys stop working, expired ones included', async () => {
    /**
     * `regeneratePersonal` revokes EVERY unrevoked personal key it may revoke, not just the
     * live ones — so the copy has to say the expired rows are in it. Naming only the live
     * count would understate the damage by exactly the rows a user has stopped thinking
     * about.
     */
    const user = userEvent.setup();
    setTrpc(payload(twoKeys()));
    show();
    await user.click(button(p('regenerate')));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`${p('confirmRegenCount')}:2`)).toBeInTheDocument();
  });

  it('names what it will really revoke, not how long the list is', async () => {
    /**
     * The list is wider than the manageable set: three rows act as the caller, one of them
     * provisioned by an admin. `keys.length` would promise to destroy a key this page
     * cannot touch — the user reads "all 3 stop working", reinstalls two, and the third
     * keeps working, which is the opposite of the reassurance a destructive confirmation is
     * for.
     */
    const user = userEvent.setup();
    setTrpc(
      payload([
        key(),
        key({ id: 'k-2', name: 'Older key' }),
        key({ id: 'k-3', name: 'Provisioned for me', revocable: false }),
      ]),
    );
    show();
    await user.click(button(p('regenerate')));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`${p('confirmRegenCount')}:2`)).toBeInTheDocument();
    expect(within(dialog).queryByText(`${p('confirmRegenCount')}:3`)).not.toBeInTheDocument();
  });

  it('still offers regenerate when it would revoke nothing, and says so', async () => {
    /**
     * The whole of the caller's list was provisioned for them, so Regenerate mints without
     * revoking anything. Two things have to hold at once: the button is still there —
     * minting their own key is exactly how they get one they can manage — and the
     * confirmation reaches the `=0` arm. The `other` arm would render "All 0 keys you hold
     * now stop working immediately", which is false and frightening in the same breath.
     */
    const user = userEvent.setup();
    setTrpc(payload([key({ revocable: false })]));
    show();
    await user.click(button(p('regenerate')));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`${p('confirmRegenCount')}:0`)).toBeInTheDocument();
    expect(within(dialog).getByText(`${p('confirmRegenNarrow')}:0`)).toBeInTheDocument();
  });

  it('names what the replacement will not be able to do', async () => {
    /**
     * For anybody holding a key issued under wider settings, Regenerate is a NARROWING.
     * They should learn that here rather than from a script that stopped working.
     */
    const user = userEvent.setup();
    setTrpc(payload([key({ inPolicy: false })]));
    show();
    await user.click(button(p('regenerate')));
    const dialog = await screen.findByRole('dialog');
    // Counted, because at zero the old key survives and the narrowing does not happen.
    expect(within(dialog).getByText(`${p('confirmRegenNarrow')}:1`)).toBeInTheDocument();
    expect(within(dialog).getByText(p('confirmRegenInstall'))).toBeInTheDocument();
  });

  it('does nothing at all until the confirmation is accepted', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([key()]), { mutations: { 'apiKeys.regeneratePersonal': { onCall } } });
    show();
    await user.click(button(p('regenerate')));
    expect(onCall).not.toHaveBeenCalled();
    await user.click(button(p('cancel')));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sends no parameters when it is accepted', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([key()]), { mutations: { 'apiKeys.regeneratePersonal': { onCall } } });
    show();
    await user.click(button(p('regenerate')));
    await user.click(button(p('confirmRegenGo')));
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall.mock.calls[0][0]).toBeUndefined();
  });

  it('reveals the replacement token once, like a first mint', async () => {
    const user = userEvent.setup();
    setTrpc(payload([key()]), {
      mutations: {
        'apiKeys.regeneratePersonal': {
          outcome: 'success',
          data: {
            token: 'eos_user_0002.NEXT',
            key: { expiresAt: '2027-02-27T12:00:00.000Z' },
            revokedCount: 1,
          },
        },
      },
    });
    show();
    await user.click(button(p('regenerate')));
    await user.click(button(p('confirmRegenGo')));
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('eos_user_0002.NEXT')).toBeInTheDocument();
  });
});

describe('revoking', () => {
  it('names the key before it revokes it', async () => {
    const user = userEvent.setup();
    setTrpc(payload([key()]));
    show();
    await user.click(button('apiKeys.revoke'));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(`${p('confirmRevokeBody')}:Jose Neto — personal key`),
    ).toBeInTheDocument();
  });

  it('revokes the row that was pressed, by id', async () => {
    /**
     * With two rows and one mutation hook behind them, sending the wrong id is a live
     * possibility and would revoke a key the user was not looking at.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([key(), key({ id: 'k-2', name: 'Older key' })]), {
      mutations: { 'apiKeys.revoke': { onCall } },
    });
    show();
    await user.click(screen.getAllByRole('button', { name: 'apiKeys.revoke' })[1]);
    await user.click(button(p('confirmRevokeGo')));
    expect(onCall).toHaveBeenCalledWith({ id: 'k-2' });
  });

  it('does nothing when the confirmation is dismissed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([key()]), { mutations: { 'apiKeys.revoke': { onCall } } });
    show();
    await user.click(button('apiKeys.revoke'));
    await user.click(button(p('cancel')));
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── When things go wrong ──────────────────────────────────────────────────────

describe('the unhappy paths', () => {
  it('says it is loading rather than flashing the empty state', () => {
    /**
     * Without this, every page load shows "you have no API key" and a request button for as
     * long as the query takes — to somebody who has one.
     */
    setTrpc(undefined, { queries: { 'apiKeys.personal': { isLoading: true, data: undefined } } });
    show();
    expect(screen.getByText(p('loading'))).toBeInTheDocument();
    expect(maybeButton(p('request'))).not.toBeInTheDocument();
  });

  it('says so when the key cannot be loaded, out loud', () => {
    setTrpc(undefined, {
      queries: { 'apiKeys.personal': { isError: true, error: { message: 'boom' } } },
    });
    show();
    expect(screen.getByRole('alert')).toHaveTextContent(p('loadFailed'));
    expect(maybeButton(p('request'))).not.toBeInTheDocument();
  });

  it('reports a refused mint from the code, in the catalog, and says nothing was changed', async () => {
    /**
     * The refusal that actually happens: `requestPersonal` answers CONFLICT when the caller
     * already holds a key, which is what a second tab produces. The server's own sentence
     * for it is literal English, and this component used to render `e.message` next to a
     * translated label — so an FR-CA user double-clicking Request got a French heading
     * followed by an English apology. The detail is now chosen from `data.code` and comes
     * out of the catalog; the raw message must not appear at all.
     *
     * The component also refetches on failure so the next render is the state that is
     * really true — untestable through this harness, whose query stub is fixed, but it is
     * why the message says nothing was changed rather than telling the user to try again.
     */
    const user = userEvent.setup();
    setTrpc(payload([]), {
      mutations: {
        'apiKeys.requestPersonal': {
          outcome: 'error',
          error: failure({ code: 'CONFLICT', message: 'You already have a personal API key.' }),
        },
      },
    });
    show();
    await user.click(button(p('request')));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(p('actionFailed'));
    expect(alert).toHaveTextContent(p('errorConflict'));
    expect(alert).not.toHaveTextContent('You already have a personal API key.');
  });

  it('explains a revoke that lands on a key that is no longer there', async () => {
    /**
     * Reachable two ways, and the copy has to cover both: a stale tab revoking a row that
     * has already gone, and a row the caller can see but was never theirs to revoke — the
     * predicate this page now shows without a button, reached anyway by a click that raced
     * the refetch.
     */
    const user = userEvent.setup();
    setTrpc(payload([key()]), {
      mutations: {
        'apiKeys.revoke': { outcome: 'error', error: failure({ code: 'NOT_FOUND' }) },
      },
    });
    show();
    await user.click(button('apiKeys.revoke'));
    await user.click(button(p('confirmRevokeGo')));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(p('errorNotFound'));
  });

  it('says only that nothing was changed when the code means nothing to this box', async () => {
    /**
     * `INTERNAL_SERVER_ERROR`, a rate limit, a gateway — there is nothing true and specific
     * to add, and a generic second sentence would be one more string to keep in two
     * languages while saying less than the first. So the alert is `actionFailed` and
     * nothing else: an empty detail span would read as a translation that failed to load.
     */
    const user = userEvent.setup();
    setTrpc(payload([]), {
      mutations: {
        'apiKeys.requestPersonal': {
          outcome: 'error',
          error: failure({ code: 'INTERNAL_SERVER_ERROR', message: 'connection reset' }),
        },
      },
    });
    show();
    await user.click(button(p('request')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(p('actionFailed'));
  });

  it('survives a failure that carries no code at all', async () => {
    /**
     * A transport-level failure never reaches the tRPC error formatter, so there is no
     * `data` to read a code out of. Reading `data.code` off it must not throw, and the user
     * still has to be told that nothing happened.
     */
    const user = userEvent.setup();
    setTrpc(payload([]), {
      mutations: {
        'apiKeys.requestPersonal': { outcome: 'error', error: { message: 'boom' } },
      },
    });
    show();
    await user.click(button(p('request')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(p('actionFailed'));
    expect(alert).not.toHaveTextContent('boom');
  });
});

// ── Which face the viewport gets ──────────────────────────────────────────────

describe('below lg', () => {
  beforeEach(() => setViewport('below'));

  it('is the small-screen face, and that face is gone once the viewport is lg', () => {
    /**
     * Presence in the TREE, not visibility. The paint is decided by `lg:hidden` and
     * `hidden lg:contents`, which jsdom cannot see. What JS decides — and all it decides —
     * is that the small-screen card stops being rendered at all once the viewport measures
     * `lg`, which only ever removes a face CSS has already hidden. It never reveals one.
     */
    setTrpc(payload([]));
    show();
    expect(screen.getByTestId('api-key-small-screen')).toBeInTheDocument();

    cleanup();
    setViewport('lg');
    setTrpc(payload([]));
    show();
    expect(screen.queryByTestId('api-key-small-screen')).not.toBeInTheDocument();
  });

  it('is the notice alone when there is no key to act on', () => {
    // NONE. Nothing live, so nothing to revoke, so no list and no control.
    setTrpc(payload([]));
    show();
    expect(notice().getByText(p('smallScreenBody'))).toBeInTheDocument();
    expect(notice().queryByText(p('smallScreenLiveBody'))).not.toBeInTheDocument();
    expect(notice().queryByRole('list')).not.toBeInTheDocument();
    expect(notice().queryByRole('button')).not.toBeInTheDocument();
  });

  it('is the notice alone when every key has expired', () => {
    /**
     * ALL_EXPIRED gets the same face as NONE here, and deliberately: an expired key has
     * nothing left to revoke, so the one action this face keeps has nothing to act on.
     * The full account of what expired and when is the panel's job.
     */
    setTrpc(payload([key({ expired: true, expiresAt: '2026-08-01T12:00:00.000Z' })]));
    show();
    expect(notice().getByText(p('smallScreenBody'))).toBeInTheDocument();
    expect(notice().queryByRole('list')).not.toBeInTheDocument();
    expect(notice().queryByRole('button')).not.toBeInTheDocument();
  });

  it('lists the live keys and keeps a working revoke on each', async () => {
    /**
     * THE RULING THIS PHASE EXISTS FOR. The justification for shrinking this surface on a
     * phone is the one-shot reveal, which covers Request and Regenerate and does not touch
     * Revoke — and the moment somebody most needs to revoke a key is the moment they are
     * not at a desk. A key pasted into the wrong window, a laptop left somewhere.
     *
     * The expired row is filtered out: it has nothing to revoke, and on this screen it is
     * noise between the reader and the control they came for.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(payload([key(), key({ id: 'k-2', name: 'Older key', expired: true })]), {
      mutations: { 'apiKeys.revoke': { onCall } },
    });
    show();

    expect(notice().getByText(p('smallScreenLiveBody'))).toBeInTheDocument();
    const rows = notice().getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Jose Neto — personal key')).toBeInTheDocument();
    expect(within(rows[0]).getByText('eos_user_9f2a')).toBeInTheDocument();

    await user.click(notice().getByRole('button', { name: 'apiKeys.revoke' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(`${p('confirmRevokeBody')}:Jose Neto — personal key`),
    ).toBeInTheDocument();
    // ONE dialog, not a second copy living in the small-screen face: `pending` and the
    // confirmation are shared state, so both faces drive the same revoke path.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: p('confirmRevokeGo') }));
    expect(onCall).toHaveBeenCalledWith({ id: 'k-1' });
  });

  it('offers nothing to press on a key that was never the caller to revoke', () => {
    // Same predicate as the panel: the server answers NOT_FOUND for that id, so a control
    // whose only reachable outcome is an error is worse than the sentence explaining why.
    setTrpc(payload([key({ revocable: false })]));
    show();
    const rows = notice().getAllByRole('listitem');
    expect(within(rows[0]).getByText('apiKeys.notManageable')).toBeInTheDocument();
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers no way to request or regenerate a key', () => {
    // The one-shot reveal is the whole reason this face is smaller. Both mints are absent
    // from it — the reader is told where to do that instead, in the body above.
    setTrpc(payload([key()]));
    show();
    expect(notice().queryByRole('button', { name: p('request') })).not.toBeInTheDocument();
    expect(notice().queryByRole('button', { name: p('regenerate') })).not.toBeInTheDocument();
  });

  it('reports a failed revoke in the face the reader is looking at', async () => {
    /**
     * The panel is `display: none` here, so its copy of the alert reports into a box nobody
     * can see. Each face carries its own, and this is the one on screen.
     */
    const user = userEvent.setup();
    setTrpc(payload([key()]), {
      mutations: {
        'apiKeys.revoke': { outcome: 'error', error: failure({ code: 'NOT_FOUND' }) },
      },
    });
    show();
    await user.click(notice().getByRole('button', { name: 'apiKeys.revoke' }));
    await user.click(button(p('confirmRevokeGo')));
    const alert = await notice().findByRole('alert');
    expect(alert).toHaveTextContent(p('actionFailed'));
    expect(alert).toHaveTextContent(p('errorNotFound'));
  });

  it('says so when the list could not be loaded', () => {
    // Otherwise a reader whose fetch failed gets the non-live body and reads it as "no key".
    setTrpc(undefined, {
      queries: { 'apiKeys.personal': { isError: true, error: { message: 'boom' } } },
    });
    show();
    expect(notice().getByRole('alert')).toHaveTextContent(p('loadFailed'));
  });
});

// ── The fetch gate ────────────────────────────────────────────────────────────

describe('the fetch gate', () => {
  /**
   * Typed to the harness's own `onCall` signature rather than left to `vi.fn()`'s default,
   * which infers a mock too wide to hand to `QueryStub`.
   */
  const probe = () => vi.fn<(...args: unknown[]) => void>();
  type Probe = ReturnType<typeof probe>;

  /** The options object `useQuery` was handed — the second argument. */
  const enabledOf = (onCall: Probe) => (onCall.mock.calls[0][1] as { enabled?: boolean }).enabled;

  const withGateProbe = (onCall: Probe) =>
    setTrpc(undefined, { queries: { 'apiKeys.personal': { data: payload([]), onCall } } });

  it('does not fire from a render that has not measured the viewport', () => {
    /**
     * The server's render and the first client render both land here, and so does any
     * environment with no `matchMedia`. The point is narrow: no request goes out from a
     * render that has not yet read the media query.
     *
     * THIS IS NOT A PERMISSION CHECK and must not be read as one. The server stays
     * authoritative, the procedure is untouched, and the payload is metadata only —
     * `prefix` is the token's public half and the plaintext is returned once, by
     * `requestPersonal` / `regeneratePersonal`, never by `personal`.
     */
    const onCall = probe();
    setViewport('unmeasured');
    withGateProbe(onCall);
    show();
    expect(enabledOf(onCall)).toBe(false);
  });

  it('fires at lg, where the panel is what the reader sees', () => {
    const onCall = probe();
    setViewport('lg');
    withGateProbe(onCall);
    show();
    expect(enabledOf(onCall)).toBe(true);
  });

  it('fires below lg as well, because revoking on a phone needs the list', () => {
    /**
     * PINNED BECAUSE IT IS THE DELIBERATE HALF. `breakpoints.ts` exists to keep work off the
     * wire on a small screen, and the obvious gate is `lg` itself — but the small-screen face
     * needs this exact answer to tell LIVE from NONE and to have ids to revoke. Keeping the
     * request off the wire and keeping revocation reachable are in direct conflict on a
     * phone, and revocation wins. Anyone narrowing this gate to `lg` removes the ability to
     * revoke a leaked key from the device the reader is holding.
     */
    const onCall = probe();
    setViewport('below');
    withGateProbe(onCall);
    show();
    expect(enabledOf(onCall)).toBe(true);
  });
});

// ── Drift fails loud ──────────────────────────────────────────────────────────

describe('an answer that never arrives', () => {
  it('leaves a permanent skeleton, and never the empty state', () => {
    /**
     * THE SHARPEST REQUIREMENT IN THIS PHASE. If the CSS says the panel is showing and the
     * JS gate says do not fetch — Tailwind's `lg` overridden without `breakpoints.ts`
     * following, `matchMedia` unavailable, an effect that never ran — the symptom has to be
     * something visibly unfinished that a reader reports.
     *
     * What it must NEVER be is "You do not have an API key yet" and a Request button. That
     * sentence is indistinguishable from the truth, and the button behind it answers
     * CONFLICT, so the reader is told they have no key, told again that they do, and given
     * no way to see the one they hold.
     */
    setViewport('unmeasured');
    setTrpc(undefined, { queries: { 'apiKeys.personal': { data: undefined } } });
    show();
    expect(screen.getByTestId('personal-api-key-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(p('emptyLead'))).not.toBeInTheDocument();
    expect(maybeButton(p('request'))).not.toBeInTheDocument();
    expect(maybeButton(p('regenerate'))).not.toBeInTheDocument();
  });

  it('is a different thing on screen from a fetch that is merely in flight', () => {
    // "Loading your API key…" says something is coming. The skeleton says nothing is.
    setTrpc(undefined, { queries: { 'apiKeys.personal': { isLoading: true, data: undefined } } });
    show();
    expect(screen.getByText(p('loading'))).toBeInTheDocument();
    expect(screen.queryByTestId('personal-api-key-skeleton')).not.toBeInTheDocument();
  });

  it('is a different thing on screen from a server that answered "no keys"', () => {
    // The distinction the whole branch exists for: zero rows is an ANSWER, and it gets the
    // empty state and its one button. No answer at all gets neither.
    setTrpc(payload([]));
    show();
    expect(screen.getByText(p('emptyLead'))).toBeInTheDocument();
    expect(screen.queryByTestId('personal-api-key-skeleton')).not.toBeInTheDocument();
  });
});
