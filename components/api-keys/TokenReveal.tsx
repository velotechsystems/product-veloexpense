'use client';

/**
 * The one and only render of a freshly minted API token.
 *
 * ## Why this is shared, and not two similar blocks
 *
 * Both key surfaces reveal a plaintext token exactly once: `/profile` for a personal key,
 * `/admin/api-keys` for a platform key. Security's RC-5 applies to both, and "matching"
 * was the word the ruling used — two hand-written blocks drift, and the one that drifts is
 * the one nobody looked at. So the rules live here and each surface supplies only its own
 * surrounding copy.
 *
 * ## Not a form control — this is the whole point
 *
 * The token used to render in a `<Textarea>`. A textarea is a form control, which means
 * the browser's spellchecker may transmit its contents to a remote service, and a password
 * manager may offer to save it into a vault the user did not intend. A `<code>` element is
 * neither: nothing submits it, nothing offers to remember it, and `select-all`
 * (`user-select: all`) still makes one click select the whole value.
 *
 * `<code>` rather than `<output>`, of the two RC-5 named, because `<output>` carries the
 * implicit ARIA role `status` — a live region. Every caller already wraps this in its own
 * `role="status"` panel, so an `<output>` would nest one live region inside another and
 * have the token announced twice.
 *
 * ## Focus lands on the value itself
 *
 * Not on the panel, not on the copy button. The value is then what a screen reader reads
 * out and what the next keystroke can select — and with `select-all` on it, a keyboard
 * user is one Ctrl+C from having the secret. `tabIndex={-1}` makes it focusable
 * programmatically without inserting a stop in everybody's tab order.
 *
 * ## The copy button cannot fail silently
 *
 * The wrapping lives in `useCopy`, shared with the assistant prompt that carries the same
 * token — see that file for the two distinct failure shapes. Here, a failure says so out
 * loud in a `role="alert"` and puts focus back on the token, because nothing copied it
 * for them and the token is only recoverable for as long as this panel is open.
 *
 * Ported from ExpenseOS `apps/web/src/components/api-keys/TokenReveal.tsx` (1e682dd6), w6-04 (d88).
 */

import { Button } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import { useCopy } from './useCopy';

export function TokenReveal({ token }: { token: string }) {
  const t = useTranslations('apiKeys');
  const tokenRef = useRef<HTMLElement>(null);
  // Nothing copied it for them, so put them on the thing they now have to copy by hand.
  const onCopyFailure = useCallback(() => tokenRef.current?.focus(), []);
  const { state: copy, copy: doCopy, reset } = useCopy(onCopyFailure);

  /**
   * Keyed on the token, not on mount: regenerating twice without leaving the page hands
   * this component a second secret, and the second one needs the focus move and a reset
   * "Copied" label exactly as much as the first did.
   *
   * The empty-token guard is what makes `token` a dependency the effect actually reads,
   * and it is not only there for the linter — focusing and announcing an empty box would
   * be worse than doing nothing at all.
   */
  useEffect(() => {
    if (token.length === 0) return;
    reset();
    tokenRef.current?.focus();
  }, [token, reset]);

  return (
    <div>
      <code
        ref={tokenRef}
        tabIndex={-1}
        className="mt-2 block select-all break-all rounded-md border border-border bg-muted/40 p-2 font-mono text-foreground text-xs"
      >
        {token}
      </code>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => doCopy(token)}>
          {copy === 'done' ? t('copied') : t('copy')}
        </Button>
        {copy === 'failed' && (
          <span role="alert" className="text-destructive text-xs">
            {t('copyFailed')}
          </span>
        )}
      </div>
    </div>
  );
}
