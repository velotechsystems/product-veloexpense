'use client';

/**
 * The personal API key box, at the bottom of `/profile`.
 *
 * Ported from ExpenseOS `app/[locale]/(app)/profile/PersonalApiKey.tsx` (1e682dd6), w6-04
 * (d88). VeloExpense: ExpenseOS's `/profile` is VeloExpense's `/preferences`, so the box sits
 * at the bottom of that page; the key it mints reads `vxe_u_…` and works against this
 * tenant's `/api/mcp`.
 *
 * ## What replaced what
 *
 * This is the successor to the form that used to sit second on this page: a name field, a
 * kind dropdown, a nine-resource scope picker, a CIDR allowlist, an expiry menu and a
 * per-key rate limit. Somebody who wants an assistant to file an expense had five security
 * decisions to make and no basis for any of them. Every one of those parameters is now
 * fixed by the server (`server/lib/personalApiKey.ts`), and the mutations behind this box
 * declare no `.input()` at all, so there is nothing here to configure and nothing a client
 * could override if it tried.
 *
 * Removing the CHOICE is not the same as removing the INFORMATION, though, so the box
 * spells out in plain language what a key from here can and cannot do. A user who never
 * picked the scopes still has every right to know them.
 *
 * ## Four states, and the fourth is the one that is easy to get wrong
 *
 * `apiKeys.personal` returns `state`, and this component switches on it rather than on
 * `keys.length` or `liveCount` — either of those alone collapses two states into one:
 *
 *   · `NONE`        — the disclosure and one button. Nothing else.
 *   · `LIVE`        — metadata only, never the token: the server keeps a SHA-256 hash and
 *                     the plaintext exists for exactly one response.
 *   · `ALL_EXPIRED` — an explicit statement that the key expired, with the date. NOT the
 *                     empty state: at 180 days this is the routine end of every key this
 *                     feature issues, and the empty state is visually identical to never
 *                     having had one. Somebody whose integration broke this morning would
 *                     be shown a "Request API key" button and no explanation.
 *   · the reveal    — the plaintext, once, above whichever of the three is showing.
 *
 * `ALL_EXPIRED` is wired to `regeneratePersonal`, not `requestPersonal`. The expired rows
 * still exist and are still unrevoked, so `requestPersonal` would answer `CONFLICT`.
 *
 * ## Every key gets a row — and not every row gets a Revoke
 *
 * Not "the newest, plus a count". A key you cannot see is a key you cannot revoke, so each
 * unrevoked key ACTING AS the caller renders individually. `inPolicy: false` marks one
 * issued under settings this page no longer uses; it is reported and never silently
 * repaired, because narrowing a credential somebody's automation depends on with no
 * notification attached is a breakage, not a fix.
 *
 * The list is now WIDER than what this page can destroy, deliberately. `apiKeys.personal`
 * used to filter on `createdById = caller`, which hid the one key nobody should be able to
 * hide: an admin holding `admin.apiKey.revoke` rotates somebody's personal key, and the
 * replacement is written `userId: <them>, createdById: <admin>`. The subject saw
 * `state: 'NONE'`, minted a second key, and held two live credentials acting as them — one
 * of which was invisible here. So the predicate is split the way
 * `docs/design/api-keys.md` § "Visibility vs management" already describes: you SEE a key
 * if it acts as you, and you MANAGE it only if you minted it or hold `admin.apiKey.revoke`.
 *
 * A row with `revocable: false` therefore renders `apiKeys.notManageable` — the note the
 * pre-simplification page showed for exactly this case, already translated and already used
 * by `PlatformApiKeys.tsx` — IN PLACE OF the button, not a disabled button beside it. The
 * server answers `NOT_FOUND` for that id, so a control whose only reachable outcome is an
 * error the user can do nothing about is worse than no control at all.
 *
 * ## Two destructive actions, both of which say what they destroy first
 *
 * Regenerate revokes every unrevoked personal key it is ALLOWED to revoke — expired ones
 * included — and mints one replacement, so the confirmation names `revocableCount`, not
 * `keys.length`. With a list wider than the manageable set those two differ, and naming the
 * list length would promise to destroy a key this page cannot touch. It also says what the
 * replacement will NOT be able to do, which is the sentence that matters to anyone holding
 * a key issued under wider settings: for them Regenerate is a narrowing, and they should
 * find that out here rather than from a script that stopped working.
 *
 * `revocableCount` can be 0 — the caller whose only key was provisioned for them — so
 * `confirmRegenCount` has a `=0` arm. Without it the plural falls to `other` and says "All
 * 0 keys you hold now stop working immediately", which is false and frightening at the same
 * time. `confirmRegenNarrow` and `expiredHint` are handed the same count for the same
 * reason: in the zero case the old key SURVIVES with whatever access it was given, so
 * "anything relying on the difference will stop working" and "the expired key is revoked at
 * the same time" are both untrue, and each needs its own zero arm.
 *
 * ## A failure names itself from the CODE, never from the server's message
 *
 * `setError(e.message)` used to put the server's literal English sentence next to a
 * translated label, so an FR-CA user who double-clicked Request got a French heading
 * followed by an English apology. What is stored is the tRPC error CODE; the sentence
 * beside `actionFailed` comes from the catalog. `CONFLICT` and `NOT_FOUND` are the two
 * genuinely reachable from this box — a second tab that raced a mint, a stale row already
 * revoked or never the caller's to revoke — and every other code renders `actionFailed`
 * ALONE. A generic second sentence would add nothing to "That did not work, and nothing was
 * changed" except one more string to keep in two languages. `error.data` may be absent
 * entirely, and that falls through to the same bare branch rather than throwing.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## TWO FACES, ONE CARD, AND `lg` DECIDES WHICH — CSS IS THE GATE
 *
 * Below `lg` the full panel is not a usable surface and never was. Four cards of disclosure,
 * a key list, two destructive controls and a one-shot secret reveal do not fit a 360px
 * screen, and the section claimed `ready` for `/profile` while being the one part of the
 * page a phone could not honestly show. So this component renders TWO faces and lets the
 * viewport pick:
 *
 *   · `ApiKeyDesktopNotice` — `lg:hidden`. The small-screen face.
 *   · `PersonalApiKeyPanel` — inside `hidden lg:contents`. Everything above.
 *
 * THE AXIS IS VIEWPORT WIDTH, NOT POINTER TYPE. `pointer: coarse` hides the panel on a
 * touchscreen laptop at 1440px and shows it on an iPad driven by a trackpad, which is the
 * wrong answer in both directions: what makes the panel unusable is that it does not FIT,
 * not how the reader touches it. (Tap slop stays `pointer: coarse`, because that one
 * genuinely is about modality.) `lib/breakpoints.ts` holds the one copy of the number.
 *
 * CSS IS THE GATE AND JS MAY ONLY HIDE FURTHER, NEVER REVEAL — the same rule
 * `DesktopOnlyNotice` follows, for the same measured reason (ADR-0005): a `matchMedia`
 * branch cannot resolve until hydration, so a JS-decided face means the phone paints the
 * desktop panel first and swaps it a frame later. `lg:hidden` and `hidden lg:contents`
 * resolve before the first paint. The one JS condition below — dropping the notice from the
 * tree once the viewport is measured as `lg` — only removes a face CSS has ALREADY hidden,
 * so nothing a reader can see is ever taken away by hydration.
 *
 * `contents`, NOT `block`, on the panel wrapper: `/profile` lays its sections out with
 * `flex flex-col gap-6`, and a wrapper that generated a box would put the card's own
 * `mx-auto w-full max-w-2xl` one level away from the gap that spaces it.
 *
 * ## BELOW `lg`: REQUEST AND REGENERATE GO. REVOCATION STAYS.
 *
 * This is the deliberate part, and it is not the obvious one. The whole justification for
 * shrinking this surface on a phone is the ONE-SHOT REVEAL: a new key is shown exactly
 * once, it has to be pasted somewhere before it is gone, and a phone is the worst possible
 * place to be handed it. That argument covers REQUEST and REGENERATE completely.
 *
 * It does not touch REVOKE. The moment a person most needs to revoke a key is precisely the
 * moment they are not at a desk — a key pasted into the wrong window, a laptop left
 * somewhere, a message they regretted the second they sent it. Sending that person to find
 * a computer first is the failure this section would be shipping, so below `lg`:
 *
 *   · `NONE` / `ALL_EXPIRED` → the notice alone. There is nothing live to act on.
 *   · `LIVE`                 → the notice's live body, a compact list of the keys, and the
 *                              SAME revoke control and the SAME confirmation dialog the
 *                              panel uses. Not a second one: `pending` and the dialog live
 *                              on the shared box below, so there is one revoke path in this
 *                              file and both faces drive it.
 *
 * ## THE FETCH GATE, AND WHY IT IS NOT A PERMISSION CHECK
 *
 * `apiKeys.personal` is gated `enabled` on the viewport having been MEASURED, and the
 * pre-mount / SSR default is `unmeasured`, so the query does not fire from a render that
 * has not yet read the media query.
 *
 * THIS IS OUTSIDE ADR-0005'S "CSS IS THE GATE" PRINCIPLE RATHER THAN AN EXCEPTION TO IT,
 * and the distinction is worth spelling out because the `enabled` line below looks like the
 * thing that rule forbids. Every sentence of that reasoning is about WHAT IS PAINTED: a
 * JS-decided face flashes, because the first paint happens before JS can decide. A
 * suppressed network request paints nothing, swaps nothing, and cannot flash. It is also
 * not a permission check of any kind — the server stays authoritative, the procedure is
 * unchanged, and nothing here narrows what anyone may read. Do not read the `enabled` gate
 * as UI gating.
 *
 * WHY IT IS NOT GATED ON `lg` ITSELF, which is what a reader coming from `breakpoints.ts`
 * will expect: the small-screen face needs the answer too. It has to know `LIVE` from
 * `NONE` to choose its body, and it has to have the key ids to revoke them. Keeping the
 * request off the wire on a phone and keeping revocation reachable on a phone are in direct
 * conflict, and revocation wins — the payload is metadata only (`prefix` is the token's
 * PUBLIC half, per the schema comment on `ApiKey.prefix`; the plaintext is returned once,
 * by `requestPersonal` / `regeneratePersonal`, never by `personal`), so there is no secret
 * being withheld or spent either way.
 *
 * ## DRIFT FAILS LOUD, NOT EMPTY
 *
 * The failure mode that matters: the CSS says the panel is showing and the JS gate says do
 * not fetch — Tailwind's `lg` overridden in the theme without `breakpoints.ts` following,
 * `matchMedia` unavailable, an effect that never ran. The symptom must be a PERMANENT
 * SKELETON, visible and obviously unfinished, which a reader reports. It must never be the
 * empty state, which says "you do not have an API key yet" — indistinguishable from the
 * truth, and one Request click away from a `CONFLICT` for somebody who holds a key they can
 * no longer see.
 *
 * So the panel's data-driven content requires `data`, and "no answer yet" renders the
 * skeleton rather than falling through to `NONE`. `query.isLoading` (a fetch in flight) and
 * `query.isError` are checked first and keep their own copy, so the three are distinct on
 * screen: a fetch in progress, a fetch that failed, and a fetch that never started.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useSyncExternalStore } from 'react';
import { AssistantPrompt } from '@/components/api-keys/AssistantPrompt';
import { TokenReveal } from '@/components/api-keys/TokenReveal';
import { LG_MEDIA_QUERY } from '@/lib/breakpointsLg';
import { trpc } from '@/lib/trpc/client';

/** What the reveal panel is showing: the secret, and the date it stops working. */
type Revealed = { token: string; expiresAt: string | Date | null };

/**
 * Which destructive action is waiting on a confirmation.
 *
 * `count` is `revocableCount` — how many keys Regenerate would actually revoke — and not
 * the length of the list, which is wider. See the docblock.
 */
type Pending = { kind: 'regenerate'; count: number } | { kind: 'revoke'; id: string; name: string };

/**
 * Where the viewport is relative to `lg` — and `unmeasured` is a real third answer, not a
 * placeholder for `below`.
 *
 * It is what the server renders and what the first client render sees, and it is the only
 * state in which the fetch gate is shut. Collapsing it into `below` would make "the phone"
 * and "we have not looked yet" the same value, and the skeleton that has to appear when the
 * gate is stuck would be unreachable.
 */
type Viewport = 'unmeasured' | 'lg' | 'below';

function subscribeToLg(onStoreChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(LG_MEDIA_QUERY);
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

function readViewport(): Viewport {
  // An environment with no `matchMedia` stays `unmeasured` rather than guessing `below`:
  // guessing would hand a desktop reader the small-screen answer with no way to notice.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'unmeasured';
  return window.matchMedia(LG_MEDIA_QUERY).matches ? 'lg' : 'below';
}

function serverViewport(): Viewport {
  return 'unmeasured';
}

/**
 * `useSyncExternalStore` rather than `useState` + `useEffect`, for the hydration reason:
 * React uses the server snapshot for the hydrating render and the live one immediately
 * after, so the first client render matches the server's byte for byte without an extra
 * render pass and without a mismatch on the console. A resize across `lg` re-renders through
 * the `change` subscription, which is how a desktop window dragged narrow picks up the
 * small-screen face.
 */
function useViewport(): Viewport {
  return useSyncExternalStore(subscribeToLg, readViewport, serverViewport);
}

/**
 * The query, the mutations and the state both faces share.
 *
 * Hoisted out of the panel so that the small-screen face drives the SAME revoke mutation and
 * the SAME confirmation dialog rather than carrying a second copy of either. One `pending`,
 * one `Dialog`, one `revoke.mutate`.
 */
function usePersonalApiKeyBox() {
  const locale = useLocale();
  const utils = trpc.useUtils();
  const viewport = useViewport();

  const query = trpc.apiKeys.personal.useQuery(undefined, {
    // See "THE FETCH GATE" in the docblock. Not a permission check, and not gated on `lg`
    // itself — the small-screen face consumes this answer too.
    enabled: viewport !== 'unmeasured',
  });

  const [revealed, setRevealed] = useState<Revealed | null>(null);
  /** The reveal cannot be dismissed until this is ticked — see `dismiss` below. */
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  /** The tRPC error CODE of the last failed action, never its message. See the docblock. */
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * Both mutations refresh the query on FAILURE as well as success. `requestPersonal`
   * answers `CONFLICT` when the caller already holds a key, and the only way to be looking
   * at a request button while holding one is for this tab's copy of the answer to be
   * stale — a second tab, or a mint that raced. Refetching turns a dead-end error into the
   * correct state on the next render.
   */
  const onMinted = (out: { token: string; key: { expiresAt: string | Date | null } }) => {
    setRevealed({ token: out.token, expiresAt: out.key.expiresAt });
    setAcknowledged(false);
    setFailed(null);
    setPending(null);
    void utils.apiKeys.personal.invalidate();
  };
  /**
   * `data` is optional on purpose: a transport-level failure never reaches the tRPC error
   * formatter, so there is no `data` to read a code out of. `?? 'UNKNOWN'` keeps the alert
   * on screen (the user still needs telling that nothing happened) while selecting no
   * detail sentence.
   */
  const onFailed = (e: { data?: { code?: string } | null }) => {
    setFailed(e.data?.code ?? 'UNKNOWN');
    setPending(null);
    void utils.apiKeys.personal.invalidate();
  };

  const request = trpc.apiKeys.requestPersonal.useMutation({
    onSuccess: onMinted,
    onError: onFailed,
  });
  const regenerate = trpc.apiKeys.regeneratePersonal.useMutation({
    onSuccess: onMinted,
    onError: onFailed,
  });
  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      setFailed(null);
      setPending(null);
      void utils.apiKeys.personal.invalidate();
    },
    onError: onFailed,
  });

  /**
   * Clearing the panel is not enough. The token arrived as a MUTATION result, so react-query
   * keeps it in the MutationCache until `gcTime` elapses — five minutes by default — and it
   * would sit in memory long after the panel it was drawn in had gone. `reset()` drops it
   * now. Both mutations are reset because either one could have produced what is on screen.
   */
  const dismiss = () => {
    setRevealed(null);
    setAcknowledged(false);
    request.reset();
    regenerate.reset();
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === 'regenerate') regenerate.mutate();
    else revoke.mutate({ id: pending.id });
  };

  const data = query.data;

  return {
    viewport,
    query,
    data,
    keys: data?.keys ?? [],
    busy: request.isPending || regenerate.isPending || revoke.isPending,
    day: (value: string | Date) => new Date(value).toLocaleDateString(locale),
    revealed,
    acknowledged,
    setAcknowledged,
    pending,
    setPending,
    failed,
    request,
    regenerate,
    dismiss,
    confirmPending,
  };
}

/** Everything both faces and the shared dialog read. Inferred, so it cannot drift. */
type KeyBox = ReturnType<typeof usePersonalApiKeyBox>;

/**
 * The failure line, in both faces.
 *
 * Below `lg` the panel is `display: none`, so a revoke that fails from the small-screen list
 * would report itself into a box the reader cannot see. Each face carries its own copy and
 * the viewport decides which one is on screen.
 *
 * Literal `t()` calls per branch rather than `t(keyFor(failed))`: `check-used-keys` only
 * resolves literal keys, and a computed one is invisible to the gate that would have caught
 * the typo.
 */
function ActionFailure({ failed }: { failed: string | null }) {
  const t = useTranslations('apiKeys.personal');
  if (!failed) return null;
  const detail =
    failed === 'CONFLICT' ? t('errorConflict') : failed === 'NOT_FOUND' ? t('errorNotFound') : null;
  return (
    <p role="alert" className="mt-3 text-destructive text-sm">
      {t('actionFailed')}
      {detail && (
        <>
          {' '}
          <span className="text-muted-foreground">{detail}</span>
        </>
      )}
    </p>
  );
}

/**
 * The small-screen face. `lg:hidden` is what decides whether it paints.
 *
 * It is NOT a link to a desktop and NOT a dead end: a reader holding a live key can revoke
 * it from here. What it withholds is Request and Regenerate, both of which end in a secret
 * shown once that has to be pasted somewhere — see the docblock.
 */
function ApiKeyDesktopNotice({ box }: { box: KeyBox }) {
  const t = useTranslations('apiKeys.personal');
  const tk = useTranslations('apiKeys');
  const live = box.data?.state === 'LIVE';

  return (
    <Card data-testid="api-key-small-screen" className="mx-auto w-full max-w-2xl lg:hidden">
      <CardHeader>
        <CardTitle>{t('smallScreenTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {live ? t('smallScreenLiveBody') : t('smallScreenBody')}
        </p>

        {box.query.isError && (
          <p role="alert" className="text-destructive">
            {t('loadFailed')}
          </p>
        )}

        {live && (
          /**
           * Only the keys that still work. An `ALL_EXPIRED` row has nothing left to revoke,
           * and the expired half of a mixed list is noise on a screen this size — the panel
           * is where the full account of every row belongs.
           */
          <ul aria-label={t('keysLabel')} className="flex flex-col gap-2">
            {box.keys
              .filter((k) => !k.expired)
              .map((k) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{k.name}</p>
                    <p className="text-muted-foreground text-xs">
                      <code>{k.prefix}</code>
                      {k.expiresAt ? (
                        <> · {t('expiresOn', { date: box.day(k.expiresAt) })}</>
                      ) : null}
                    </p>
                  </div>
                  {k.revocable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={box.busy}
                      onClick={() => box.setPending({ kind: 'revoke', id: k.id, name: k.name })}
                    >
                      {tk('revoke')}
                    </Button>
                  ) : (
                    <p className="max-w-xs text-muted-foreground text-xs italic">
                      {tk('notManageable')}
                    </p>
                  )}
                </li>
              ))}
          </ul>
        )}

        <ActionFailure failed={box.failed} />
      </CardContent>
    </Card>
  );
}

/**
 * The permanent skeleton. See "DRIFT FAILS LOUD" in the docblock.
 *
 * No `role="status"`: a live region that stands on a page indefinitely is the shape this
 * file already argues against for the reveal panel, and there is no arrival to announce
 * here — this face appears when nothing is coming. The `sr-only` line reuses `loading`
 * rather than minting a string, because that is what it honestly is: a panel still waiting.
 */
function PanelSkeleton() {
  const t = useTranslations('apiKeys.personal');
  return (
    <div data-testid="personal-api-key-skeleton" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{t('loading')}</span>
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" aria-hidden="true" />
      <div className="h-20 w-full animate-pulse rounded bg-muted" aria-hidden="true" />
      <div className="h-9 w-40 animate-pulse rounded bg-muted" aria-hidden="true" />
    </div>
  );
}

/**
 * The full panel — everything this box was before it grew a second face. Shown at `lg` and
 * above, by CSS, from inside `hidden lg:contents`.
 */
function PersonalApiKeyPanel({ box }: { box: KeyBox }) {
  const t = useTranslations('apiKeys.personal');
  /**
   * A second binding, deliberately. The verbs a button carries — copy, revoke — are the
   * same words on every key surface and are already translated; inventing `personal.revoke`
   * would be a second French sentence to keep in step with the first for no gain. What the
   * personal box does NOT reuse is `apiKeys.title` / `apiKeys.description`, whose copy is
   * about platform keys and is wrong here.
   */
  const tk = useTranslations('apiKeys');

  const { data, keys, busy, day, revealed, acknowledged, failed, query } = box;

  /**
   * When access actually ended: the LAST of the expiry dates, not the newest key's. A user
   * holding two expired keys stopped being able to do anything at the later of the two, and
   * that is the date that explains what they saw happen.
   */
  const lastExpiry = keys.reduce<Date | null>((latest, k) => {
    if (!k.expiresAt) return latest;
    const at = new Date(k.expiresAt);
    return latest === null || at > latest ? at : latest;
  }, null);

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {revealed && (
          /**
           * `role="status"` so the arrival is announced to somebody whose attention is
           * elsewhere, and it is mounted only while there is a token — a live region that
           * stands empty on every page load trains a screen-reader user to ignore it.
           */
          <div role="status" className="mb-5 rounded-md border border-warning/40 bg-warning/5 p-3">
            <p className="font-medium text-foreground text-sm">{t('revealTitle')}</p>
            <TokenReveal token={revealed.token} />
            {/**
             * Directly under the token, above the expiry and the raw header form: this is
             * the one instruction the reader of a PERSONAL key actually needs, and the
             * panel closes for good once they acknowledge it.
             */}
            <AssistantPrompt token={revealed.token} />
            {revealed.expiresAt && (
              <p className="mt-2 text-muted-foreground text-xs">
                {t('revealExpiry', { date: day(revealed.expiresAt) })}
              </p>
            )}
            <p className="mt-1 text-muted-foreground text-xs">{tk('endpointHint')}</p>
            {/**
             * An affirmative acknowledgement, not a soft "Done". This panel is the only
             * time the secret exists; a single dismiss button is one stray click away from
             * losing it, and the click that loses it looks exactly like the click that
             * closes a toast.
             */}
            <div className="mt-3 flex items-start gap-2">
              <Checkbox
                id="pak-ack"
                aria-labelledby="pak-ack-label"
                checked={acknowledged}
                onCheckedChange={(v) => box.setAcknowledged(v === true)}
              />
              <span id="pak-ack-label" className="text-foreground text-xs">
                {t('ackLabel')}
              </span>
            </div>
            <Button className="mt-3" size="sm" disabled={!acknowledged} onClick={box.dismiss}>
              {t('revealDismiss')}
            </Button>
          </div>
        )}

        {query.isLoading && <p className="text-muted-foreground text-sm">{t('loading')}</p>}
        {query.isError && (
          <p role="alert" className="text-destructive text-sm">
            {t('loadFailed')}
          </p>
        )}
        {/**
         * The loud failure. A fetch that never started leaves no answer here, and the one
         * thing this panel must never do with no answer is render the empty state — see
         * "DRIFT FAILS LOUD" in the docblock. Ordered after the two branches above so a
         * fetch in flight and a fetch that failed each keep their own, more specific, copy.
         */}
        {!data && !query.isLoading && !query.isError && <PanelSkeleton />}

        {data && (
          <>
            {data.state === 'NONE' && (
              <p className="text-muted-foreground text-sm">{t('emptyLead')}</p>
            )}

            {data.state === 'ALL_EXPIRED' && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="font-medium text-foreground text-sm">
                  {lastExpiry
                    ? t('expiredLead', { date: day(lastExpiry) })
                    : t('expiredLeadNoDate')}
                </p>
                {/**
                 * Counted, because with `revocableCount: 0` the expired key is one this
                 * page cannot revoke and "revoked at the same time" would be a promise it
                 * cannot keep.
                 */}
                <p className="mt-1 text-muted-foreground text-xs">
                  {t('expiredHint', { count: data.revocableCount })}
                </p>
              </div>
            )}

            {/**
             * The key list is NAMED, because it is not the only list in this card — the
             * disclosure below it is two more. A list of credentials a screen-reader user
             * may be about to revoke is the one that has to be identifiable.
             */}
            {keys.length > 0 && (
              <ul aria-label={t('keysLabel')} className="mt-3 flex flex-col gap-2">
                {keys.map((k) => (
                  <li key={k.id} className="rounded-md border border-border p-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground text-sm">{k.name}</p>
                        <p className="text-muted-foreground text-xs">
                          <code>{k.prefix}</code> · {t('createdOn', { date: day(k.createdAt) })} ·{' '}
                          {k.lastUsedAt
                            ? t('lastUsedOn', { date: day(k.lastUsedAt) })
                            : t('neverUsed')}
                        </p>
                        {/**
                         * Criterion 13's second half: the expiry, as a date, in the metadata
                         * view. Past tense once it has passed — "Expires 2 March" about a day
                         * that has been and gone reads as a key that still works.
                         */}
                        <p className="text-muted-foreground text-xs">
                          {k.expiresAt
                            ? k.expired
                              ? t('expiredOn', { date: day(k.expiresAt) })
                              : t('expiresOn', { date: day(k.expiresAt) })
                            : t('noEndDate')}
                        </p>
                        {!k.inPolicy && (
                          <p className="mt-1 text-muted-foreground text-xs italic">
                            <span className="rounded bg-muted px-1.5 py-0.5 not-italic">
                              {t('legacyBadge')}
                            </span>{' '}
                            {t('legacyHelp')}
                          </p>
                        )}
                      </div>
                      {/**
                       * No button at all when the key is not the caller's to revoke — see
                       * the docblock. The note goes where the button was, so the row still
                       * accounts for itself: this credential acts as you, and here is why
                       * you cannot do anything about it.
                       *
                       * When the button IS there its label stays "Revoke" while the call is
                       * in flight rather than flipping to "Revoking…": one mutation hook
                       * backs every row, so a per-row pending label would say it on all of
                       * them at once. The confirmation dialog is still open over the top
                       * during the call and its own button carries the disabled state.
                       */}
                      {k.revocable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => box.setPending({ kind: 'revoke', id: k.id, name: k.name })}
                        >
                          {tk('revoke')}
                        </Button>
                      ) : (
                        <p className="max-w-xs text-muted-foreground text-xs italic">
                          {tk('notManageable')}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/**
             * The disclosure describes what a key ISSUED FROM HERE can do, which is why it
             * stays on screen in every state rather than only in the empty one: it is the
             * thing the Request and Regenerate buttons below it are about. A key already
             * held under older settings may do more, and its own row says so.
             */}
            <div className="mt-4 border-border/60 border-t pt-4">
              <h3 className="font-medium text-foreground text-sm">{t('canTitle')}</h3>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground text-xs">
                <li>{t('canExpenses')}</li>
                <li>{t('canTravel')}</li>
                <li>{t('canDiscussions')}</li>
              </ul>
              <h3 className="mt-3 font-medium text-foreground text-sm">{t('cannotTitle')}</h3>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground text-xs">
                <li>{t('cannotApprove')}</li>
                <li>{t('cannotBudgets')}</li>
                {/* VeloExpense (w6-04): no `cannotCards` line — VeloExpense has no virtual cards
                    (out of scope, 7 Oct), so the box does not name a feature that is not here. */}
                <li>{t('cannotBeyond')}</li>
              </ul>
              <p className="mt-2 text-muted-foreground text-xs">{t('lifetime')}</p>
            </div>

            <div className="mt-4">
              {data.state === 'NONE' ? (
                <Button disabled={busy} onClick={() => box.request.mutate()}>
                  {box.request.isPending ? t('requesting') : t('request')}
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => box.setPending({ kind: 'regenerate', count: data.revocableCount })}
                >
                  {box.regenerate.isPending ? t('regenerating') : t('regenerate')}
                </Button>
              )}
            </div>
          </>
        )}

        <ActionFailure failed={failed} />
      </CardContent>
    </Card>
  );
}

/**
 * The one confirmation dialog in this file, driven by whichever face set `pending`.
 *
 * Mounted only while something is pending, so the branches below can read `pending` without
 * a null guard on every line — and so the dialog's own focus trap is not standing by on a
 * page nobody opened it from. It lives at the wrapper rather than inside either face because
 * a revoke started from the small-screen list has to confirm itself in the same words, with
 * the same control, as one started from the panel.
 */
function ConfirmPendingDialog({ box }: { box: KeyBox }) {
  const t = useTranslations('apiKeys.personal');
  const { pending } = box;
  if (!pending) return null;
  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) box.setPending(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {pending.kind === 'regenerate' ? t('confirmRegenTitle') : t('confirmRevokeTitle')}
          </DialogTitle>
          <DialogDescription>
            {pending.kind === 'regenerate'
              ? t('confirmRegenCount', { count: pending.count })
              : t('confirmRevokeBody', { name: pending.name })}
          </DialogDescription>
        </DialogHeader>
        {pending.kind === 'regenerate' && (
          <div className="text-muted-foreground text-sm">
            <p>{t('confirmRegenNarrow', { count: pending.count })}</p>
            <p className="mt-2">{t('confirmRegenInstall')}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => box.setPending(null)}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" disabled={box.busy} onClick={box.confirmPending}>
            {pending.kind === 'regenerate' ? t('confirmRegenGo') : t('confirmRevokeGo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * ONE outer element, and that is a contract rather than a style choice: `page.test.tsx`
 * pins `/profile`'s wrapper at seven children, which is what proves no eighth section crept
 * onto the page. A fragment returning two top-level nodes from here would spend one of them.
 */
export function PersonalApiKey() {
  const box = usePersonalApiKeyBox();
  return (
    <div>
      {/**
       * `lg:hidden` on the card itself is the gate. This condition only REMOVES the notice
       * once the viewport is measured as `lg` — where CSS has already hidden it — so it can
       * never take away something a reader can see, and it keeps a second list of
       * credentials and a second revoke control out of a tree that does not need them.
       */}
      {box.viewport !== 'lg' && <ApiKeyDesktopNotice box={box} />}
      <div className="hidden lg:contents">
        <PersonalApiKeyPanel box={box} />
      </div>
      <ConfirmPendingDialog box={box} />
    </div>
  );
}
