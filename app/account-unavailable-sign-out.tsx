'use client';

/** f04 — the refusal page's one action. next-auth's client sign-out, as ProfilePopover's. */
import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export function SignOutButton({ label }: { label: string }) {
  return (
    <Button type="button" onClick={() => void signOut({ callbackUrl: '/login' })}>
      {label}
    </Button>
  );
}
