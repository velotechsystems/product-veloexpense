'use client';

/**
 * The sentence to paste into an AI assistant, shown once beside a freshly minted personal
 * key.
 *
 * ## Why this exists
 *
 * The panel already showed the token and, below it, the raw header form
 * (`Authorization: Bearer …`). Both are correct and neither tells the intended reader what
 * to DO: the consumer of a personal key is an AI assistant acting for its owner, and what
 * that owner needs is one sentence they can paste into it. Everything the assistant needs —
 * the endpoint and the credential — is in that sentence, so there is no second step to get
 * wrong.
 *
 * ## Personal keys only, deliberately
 *
 * This is not rendered on `/admin/api-keys`. A platform key names a different subject on
 * each request and can act as any active user; "connect your assistant to this" is exactly
 * the wrong instruction for a credential like that. `TokenReveal` is shared because RC-5
 * binds both surfaces; this is not, because the advice does not.
 *
 * ## Not a form control — RC-5 applies here too
 *
 * The prompt CONTAINS the token, so it is a second render of the secret and gets the same
 * treatment as the first: a `<code>`, never a `<textarea>` or `<input>`. A form control
 * invites the browser's spellchecker to transmit its contents and a password manager to
 * offer to vault them, and a sentence wrapped around a secret is still a secret. Fixing the
 * token's own render and then pasting it into a textarea next to it would have undone the
 * ruling in the same panel.
 *
 * `<code>` rather than `<output>` for the reason `TokenReveal` gives: `<output>` carries the
 * implicit ARIA role `status`, and the caller already wraps this panel in its own
 * `role="status"` — nesting live regions announces the content twice.
 *
 * ## The endpoint is derived, not stored
 *
 * `window.location.origin` + `/api/mcp`, following `SetupGuide`'s precedent for callback
 * URLs: the value differs per environment and a hardcoded one silently points somebody at
 * dev. It also cannot disagree with the address the reader is already looking at, which a
 * configured value can.
 *
 * On the server pass `origin` is `''`, so this renders nothing at all rather than a sentence
 * containing `/api/mcp` with no host — a half-built URL is worse than a late one, because it
 * is copyable. The panel only ever appears in response to a click, so there is no real
 * server render to miss.
 *
 * Ported from ExpenseOS `apps/web/src/components/api-keys/AssistantPrompt.tsx` (1e682dd6), w6-04 (d88).
 */

import { Button } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import { useCopy } from './useCopy';

export function AssistantPrompt({ token }: { token: string }) {
  const t = useTranslations('apiKeys.personal');
  const promptRef = useRef<HTMLElement>(null);
  const onCopyFailure = useCallback(() => promptRef.current?.focus(), []);
  const { state, copy, reset } = useCopy(onCopyFailure);

  /**
   * Keyed on the token for the same reason `TokenReveal` is: a second mint without leaving
   * the page needs a reset label, not the previous one's "Copied".
   *
   * The empty-token guard is what makes `token` a dependency this effect actually READS —
   * the same trick, and the same justification, as `TokenReveal`'s. It is not only there for
   * the linter: resetting a label on a panel that renders nothing is pure noise.
   */
  useEffect(() => {
    if (token.length === 0) return;
    reset();
  }, [token, reset]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  if (origin.length === 0 || token.length === 0) return null;

  const prompt = t('assistantPromptText', { url: `${origin}/api/mcp`, token });

  return (
    // mt-6 (24px) rather than mt-3: this block is a separate instruction from the token
    // above it, and at 12px the label read as a caption belonging to the Copy button.
    <div className="mt-6">
      <p className="font-medium text-foreground text-xs">{t('assistantPromptLabel')}</p>
      <code
        ref={promptRef}
        tabIndex={-1}
        className="mt-1 block select-all break-words rounded-md border border-border border-l-2 border-l-primary bg-muted/40 p-2 font-mono text-foreground text-xs"
      >
        {prompt}
      </code>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => copy(prompt)}>
          {state === 'done' ? t('assistantPromptCopied') : t('assistantPromptCopy')}
        </Button>
        {state === 'failed' && (
          <span role="alert" className="text-destructive text-xs">
            {t('assistantPromptCopyFailed')}
          </span>
        )}
      </div>
    </div>
  );
}
