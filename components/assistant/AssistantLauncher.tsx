'use client';

import { IconSparkles } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';

/**
 * The top-bar entry point.
 *
 * The panel mounts only once opened. It is the only surface in the app that holds an open
 * HTTP stream, and a component that renders on every page ought not to be doing that before
 * anybody has asked it anything.
 *
 * Whether the button appears at all is NOT decided here: the top bar renders it only when
 * the `assistant` module is active. It used to be shown unconditionally, on the reasoning
 * that a control which says "an administrator can install this" teaches somebody who to
 * ask — but a workspace that has deliberately switched the module off is not waiting to be
 * told about it, and an entry point to a feature nobody can use reads as a broken button.
 */
export function AssistantLauncher() {
  const t = useTranslations('assistant');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={open ? t('close') : t('open')}
        aria-expanded={open}
        onClick={() => {
          setMounted(true);
          setOpen((v) => !v);
        }}
        /* `einc-tap-slop-both` (coarse pointers only) floors this 32x32 control's
           hit target at 44x44 without resizing it. It is the rightmost control in
           the top bar's right zone, whose gutter is `gap-1.5` (6px) — and 6px is
           exactly the per-side slop a 32px control gets from a 44px floor, so the
           reach meets the bell's own reach at tangency rather than overlapping it.
           Brand orange (`primary`) rather than the bell's muted grey: the sparkles mark
           the one control that answers questions, and it should read as an invitation. */
        className="einc-tap-slop-both inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-brand-orange-light hover:text-brand-orange-dark"
      >
        <IconSparkles size={20} />
      </button>
      {mounted && <AssistantPanel open={open} onOpenChange={setOpen} />}
    </>
  );
}
