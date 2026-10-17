'use client';

import { Avatar, Badge, initialsFrom, RowActionsMenu } from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import {
  IconEye,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconShieldCheck,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { useTranslations } from 'next-intl';
import { ExternalIdsCell as SharedExternalIdsCell } from '@/components/admin/ExternalIds';
import type { ColumnDef } from '@/components/data-view';
import { EMPLOYEE_STATUS_VARIANT, type EmployeeStatus } from '@/lib/employeeStatus';
import type { AppRouter } from '@/server/routers/_app';

// ────────────────────────────────────────────────────────────────
//  Cell renderers + column definitions for the People directory.
//
//  Lives in its own file so EmployeeDirectory.tsx can stay focused
//  on orchestration (state, queries, drawer) instead of cell
//  markup. Each cell is a small named component so dev-tools shows
//  meaningful names in the tree.
//
//  Ported from ExpenseOS (1e682dd6), People 3. VeloExpense: no MFA column and no
//  Reset password action (Google sign-in only); access is `hasAccess`.
// ────────────────────────────────────────────────────────────────

type DirectoryRow = inferRouterOutputs<AppRouter>['users']['listDirectory']['items'][number];

export type PeopleColumnId =
  | 'name'
  | 'externalIds'
  | 'email'
  | 'entity'
  | 'businessUnit'
  | 'department'
  | 'nsClass'
  | 'manager'
  // VeloExpense: no 'mfaEnrolled' — Google sign-in only, so no second factor of our own.
  | 'access'
  | 'status';

export type PeopleRow = DirectoryRow;

// ─── Cell components ─────────────────────────────────────────────

function NameCell({
  user,
  locale,
  tActions,
  tSync,
  canSetRole,
  onSetRole,
  onSetAccess,
  canEdit,
  onEdit,
  onView,
}: {
  user: PeopleRow;
  locale: Locale;
  tActions: ReturnType<typeof useTranslations<'people.actions'>>;
  tSync: ReturnType<typeof useTranslations<'people.sync'>>;
  canSetRole: boolean;
  onSetRole: (user: PeopleRow) => void;
  /** Grants or revokes sign-in; offered under the same gate as Change role. */
  onSetAccess: (user: PeopleRow, hasAccess: boolean) => void;
  canEdit: boolean;
  onEdit: (user: PeopleRow) => void;
  /** Opens the existing detail drawer — see the 'view' action. */
  onView: (user: PeopleRow) => void;
}) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  const roleLabel = getLocalized(user.role.label, locale) ?? '';
  return (
    <div className="flex items-center gap-2.5">
      <Avatar
        imageUrl={user.avatarUrl}
        initials={initialsFrom(user.firstName, user.lastName, user.email)}
        alt={fullName}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-foreground text-sm">{fullName}</span>
          {/* Quiet, not a column: NetSuite disagrees about this person somewhere. The
              ruling lives on /netsuite/people; this only says "look". */}
          {(user.syncDiscrepancies?.length ?? 0) > 0 && (
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 py-0 text-[10px] leading-4"
              title={tSync('badgeTitle', { count: user.syncDiscrepancies.length })}
              data-testid="people-sync-badge"
            >
              {tSync('badge')}
            </Badge>
          )}
        </div>
        <div className="truncate text-muted-foreground text-xs">{roleLabel as string}</div>
      </div>
      <RowActionsMenu
        ariaLabel={tActions('menu')}
        actions={[
          {
            id: 'view',
            icon: <IconEye size={14} />,
            label: tActions('view'),
            // Opens `UserDetailDrawer`, which already existed and was reachable only by
            // clicking the row. This entry was enabled and inert (GA readiness report F40).
            onClick: () => onView(user),
          },
          ...(canEdit
            ? [
                {
                  id: 'edit',
                  icon: <IconPencil size={14} />,
                  label: tActions('edit'),
                  onClick: () => onEdit(user),
                },
              ]
            : []),
          // VeloExpense: no 'Reset password' — people sign in with Google only, so there is
          // no password of VeloExpense's to reset.
          { divider: true },
          ...(canSetRole
            ? [
                {
                  id: 'set-role',
                  icon: <IconShieldCheck size={14} />,
                  label: tActions('setRole'),
                  onClick: () => onSetRole(user),
                },
                // One entry, offering whichever way the person is not: the Access
                // column already says which state they are in.
                user.hasAccess
                  ? {
                      id: 'revoke-access',
                      icon: <IconLock size={14} />,
                      label: tActions('revokeAccess'),
                      onClick: () => onSetAccess(user, false),
                    }
                  : {
                      id: 'grant-access',
                      icon: <IconLockOpen size={14} />,
                      label: tActions('grantAccess'),
                      onClick: () => onSetAccess(user, true),
                    },
              ]
            : []),
          /**
           * NO 'Set on leave' and NO 'Deactivate' here.
           *
           * Both were enabled, clickable and did nothing — which is worse than disabled,
           * because a destructive action that silently no-ops teaches somebody it worked (GA
           * readiness report F40). The routers exist (`users.setOnLeave`, `users.deactivate`)
           * but the flows around them do not: neither has a confirmation, a reason, or an
           * effective date, and deactivating somebody is not a thing to ship half-built.
           *
           * Removed rather than disabled, on the reasoning the retired My Info page also
           * applied to its quick-add: a control that will not work is better absent than
           * explained.
           */
        ]}
      />
    </div>
  );
}

function ExternalIdsCell({ user }: { user: PeopleRow }) {
  return <SharedExternalIdsCell value={user.externalIds} />;
}

function EmailCell({ email }: { email: string }) {
  if (!email) return <>—</>;
  return (
    <a href={`mailto:${email}`} className="text-accent-foreground text-sm hover:underline">
      {email}
    </a>
  );
}

function TextCell({ value }: { value: string | null | undefined }) {
  return <span className="text-foreground text-sm">{value ?? '—'}</span>;
}

function ManagerCell({ user }: { user: PeopleRow }) {
  if (!user.manager) return <TextCell value={null} />;
  const name = [user.manager.firstName, user.manager.lastName].filter(Boolean).join(' ');
  return <TextCell value={name || '—'} />;
}

function StatusCell({
  status,
  tStatus,
}: {
  status: EmployeeStatus;
  tStatus: ReturnType<typeof useTranslations<'people.status'>>;
}) {
  return <Badge variant={EMPLOYEE_STATUS_VARIANT[status]}>{tStatus(status)}</Badge>;
}

/**
 * Whether this person can sign in.
 *
 * Its own column rather than folded into status, because the two are independent and the
 * distinction is the whole point: somebody ACTIVE may have no access, and somebody on leave
 * may keep theirs. Off is the state worth noticing, so it carries the warning colour — the
 * flag shipped invisible once and production ran a release with every real person locked out.
 */
function AccessCell({
  hasAccess,
  tAccess,
}: {
  hasAccess: boolean;
  tAccess: ReturnType<typeof useTranslations<'people.access'>>;
}) {
  return (
    <Badge variant={hasAccess ? 'success' : 'warning'}>
      {hasAccess ? tAccess('granted') : tAccess('denied')}
    </Badge>
  );
}

// ─── Column definitions ──────────────────────────────────────────

export interface BuildColumnsArgs {
  locale: Locale;
  tCols: ReturnType<typeof useTranslations<'people.columns'>>;
  tActions: ReturnType<typeof useTranslations<'people.actions'>>;
  tSync: ReturnType<typeof useTranslations<'people.sync'>>;
  tStatus: ReturnType<typeof useTranslations<'people.status'>>;
  tAccess: ReturnType<typeof useTranslations<'people.access'>>;
  statusOptions: Array<{ value: string; label: string }>;
  businessUnitOptions: Array<{ value: string; label: string }>;
  departmentOptions: Array<{ value: string; label: string }>;
  accessOptions: Array<{ value: string; label: string }>;
  canSetRole: boolean;
  onSetRole: (user: PeopleRow) => void;
  onSetAccess: (user: PeopleRow, hasAccess: boolean) => void;
  canEdit: boolean;
  onEdit: (user: PeopleRow) => void;
  /** Opens the existing detail drawer from the row kebab's 'View'. */
  onView: (user: PeopleRow) => void;
  /** NetSuite integration active — gates the NetSuite Class column. */
  netsuiteActive: boolean;
}

export function buildPeopleColumns({
  locale,
  tCols,
  tActions,
  tSync,
  tStatus,
  tAccess,
  statusOptions,
  businessUnitOptions,
  departmentOptions,
  accessOptions,
  canSetRole,
  onSetRole,
  onSetAccess,
  canEdit,
  onEdit,
  onView,
  netsuiteActive,
}: BuildColumnsArgs): ColumnDef<PeopleRow, PeopleColumnId>[] {
  return [
    {
      id: 'name',
      label: tCols('name'),
      defaultWidth: 280,
      sortable: { serverField: 'name' },
      filterable: { kind: 'text' },
      hideable: false, // primary row identification — never hide
      cell: (user) => (
        <NameCell
          user={user}
          locale={locale}
          tActions={tActions}
          tSync={tSync}
          canSetRole={canSetRole}
          onSetRole={onSetRole}
          onSetAccess={onSetAccess}
          canEdit={canEdit}
          onEdit={onEdit}
          onView={onView}
        />
      ),
    },
    {
      id: 'externalIds',
      label: tCols('externalIds'),
      defaultWidth: 220,
      filterable: { kind: 'text' },
      cell: (user) => <ExternalIdsCell user={user} />,
    },
    {
      id: 'email',
      label: tCols('email'),
      defaultWidth: 240,
      sortable: { serverField: 'email' },
      filterable: { kind: 'text' },
      cell: (user) => <EmailCell email={user.email} />,
    },
    {
      id: 'entity',
      label: tCols('entity'),
      defaultWidth: 180,
      // Org assignments are FKs to Json-label lookups — not orderable as a
      // scalar, so no server-side sort. Facet-filtered by id, label rendered.
      filterable: { kind: 'enum' },
      cell: (user) => (
        <TextCell value={user.entity ? getLocalized(user.entity.label, locale) : null} />
      ),
    },
    {
      id: 'businessUnit',
      label: tCols('businessUnit'),
      defaultWidth: 200,
      filterable: { kind: 'enum', options: businessUnitOptions },
      cell: (user) => (
        <TextCell
          value={user.businessUnit ? getLocalized(user.businessUnit.label, locale) : null}
        />
      ),
    },
    {
      id: 'department',
      label: tCols('department'),
      defaultWidth: 220,
      filterable: { kind: 'enum', options: departmentOptions },
      cell: (user) => (
        <TextCell value={user.department ? getLocalized(user.department.label, locale) : null} />
      ),
    },
    // NetSuite Class — only when the NetSuite integration is active.
    ...(netsuiteActive
      ? [
          {
            id: 'nsClass' as const,
            label: tCols('nsClass'),
            defaultWidth: 180,
            cell: (user: PeopleRow) => <TextCell value={user.nsClass?.name ?? null} />,
          },
        ]
      : []),
    {
      id: 'manager',
      label: tCols('manager'),
      defaultWidth: 200,
      cell: (user) => <ManagerCell user={user} />,
    },
    {
      id: 'access',
      label: tCols('access'),
      defaultWidth: 150,
      filterable: { kind: 'enum', options: accessOptions },
      cell: (user) => <AccessCell hasAccess={user.hasAccess} tAccess={tAccess} />,
    },
    {
      id: 'status',
      label: tCols('status'),
      defaultWidth: 140,
      sortable: { serverField: 'status' },
      filterable: { kind: 'enum', options: statusOptions },
      cell: (user) => (
        <StatusCell status={user.employeeStatus as EmployeeStatus} tStatus={tStatus} />
      ),
    },
  ];
}
