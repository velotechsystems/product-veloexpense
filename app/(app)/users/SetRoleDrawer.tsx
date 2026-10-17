'use client';

/*
 * Ported from ExpenseOS (1e682dd6), People 3. VeloExpense: the kit's Select renders the
 * chosen label itself (no render-fn).
 */

import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field as FormField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { PeopleRow } from './EmployeeDirectory.cells';

/**
 * Change a user's RBAC role. Drives the audited `users.setRole` mutation
 * (server enforces the admin-demotion + self-lockout guards). The user's
 * own JWT keeps its previous roleId until their next session refresh — only
 * the stored role changes here.
 */
export function SetRoleDrawer({ user, onClose }: { user: PeopleRow | null; onClose: () => void }) {
  return (
    <Drawer open={user !== null} onOpenChange={(o) => !o && onClose()}>
      {user && <SetRoleBody user={user} onClose={onClose} />}
    </Drawer>
  );
}

function SetRoleBody({ user, onClose }: { user: PeopleRow; onClose: () => void }) {
  const t = useTranslations('people.setRole');
  const locale = useLocale() as Locale;
  const utils = trpc.useUtils();
  const rolesQuery = trpc.roles.list.useQuery({});
  const [roleId, setRoleId] = useState<string>(user.role.id);
  const [err, setErr] = useState<string | null>(null);

  const setRole = trpc.users.setRole.useMutation({
    onSuccess: () => {
      // The row's role label changed — refresh the directory.
      utils.users.invalidate();
      onClose();
    },
    onError: (e) => setErr(e.message),
  });

  const roles = rolesQuery.data?.items ?? [];
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  const labelOf = (label: unknown) => (getLocalized(label, locale) as string) ?? '';
  const unchanged = roleId === user.role.id;

  return (
    <DrawerContent width={440}>
      <DrawerHeader>
        <DrawerTitle>{t('title')}</DrawerTitle>
        <p className="mt-0.5 text-muted-foreground text-sm">{t('for', { name })}</p>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {err && <p className="text-destructive text-sm">{err}</p>}
        <FormField htmlFor="sr-role" label={t('roleLabel')} required>
          <Select value={roleId} onValueChange={(v) => setRoleId((v as string) ?? roleId)}>
            <SelectTrigger id="sr-role">
              {/* VeloExpense kit: Radix's SelectValue renders the chosen item's own label (see
                  components/forms/ColorInput.tsx); ExpenseOS's Base UI render-fn is not needed. */}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {labelOf(r.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          size="sm"
          disabled={unchanged || setRole.isPending}
          onClick={() => {
            setErr(null);
            setRole.mutate({ id: user.id, roleId });
          }}
        >
          {setRole.isPending ? t('submitting') : t('submit')}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  );
}
