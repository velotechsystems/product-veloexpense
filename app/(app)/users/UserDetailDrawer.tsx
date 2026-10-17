'use client';

/*
 * Ported from ExpenseOS (1e682dd6), People 3. VeloExpense: access is `hasAccess`; no
 * virtual-cards section (out of scope).
 */

import {
  Avatar,
  Badge,
  Button,
  cls,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  initialsFrom,
  StatusBadge,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import {
  IconBuilding,
  IconChevronRight,
  IconExternalLink,
  IconMail,
  IconReceipt,
  IconUsers,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalIdsBlock, externalIdEntries } from '@/components/admin/ExternalIds';
import { Link as LocaleLink } from '@/i18n/navigation';
import { EMPLOYEE_STATUS_VARIANT } from '@/lib/employeeStatus';
import { displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { statusBadgeProps } from '../expenses/_shared';

type UserDetail = inferRouterOutputs<AppRouter>['users']['get'];
type DirectReport = inferRouterOutputs<AppRouter>['users']['getDirectReports']['items'][number];

interface UserDetailDrawerProps {
  /** Open when set; `null` closes the drawer. */
  userId: string | null;
  onClose: () => void;
  /** Locale for label rendering. */
  locale: Locale;
  /** Open another user's drawer (used by clickable manager / direct
   *  reports inside the drawer). */
  onOpenUser?: (id: string) => void;
  /** Virtual-cards module active — gates the Virtual cards section.
   *  VeloExpense: accepted and ignored — virtual cards are out of scope (7 Oct 2026), so the
   *  section is not ported. */
  vccActive?: boolean;
  /**
   * May the viewer grant or revoke sign-in? Passed in rather than derived here, because the
   * parent already computes it from the same permission it uses for the role action — and
   * the SERVER gates the mutation regardless. This only decides whether the button is drawn.
   */
  canSetAccess?: boolean;
  /**
   * Where the integration's People review lives (ExpenseOS: `/netsuite/people`), for a viewer
   * who may rule on a People ↔ integration disagreement; absent, there is no review link.
   * VeloExpense: a path handed in rather than a vendor route written here
   * (scripts/check-vendor-neutral.mjs) — Wave 5's integration supplies it.
   */
  syncReviewPath?: string;
}

export function UserDetailDrawer({
  userId,
  onClose,
  locale,
  onOpenUser,
  canSetAccess = false,
  syncReviewPath,
}: UserDetailDrawerProps) {
  const tStatus = useTranslations('people.status');
  const tCols = useTranslations('people.columns');
  const tDetail = useTranslations('people.detail');
  const tLast = useTranslations('people.lastLogin');
  const tAccess = useTranslations('people.access');
  const utils = trpc.useUtils();
  /**
   * Invalidates the directory as well as this profile: the listing carries an Access column
   * now, so leaving it stale would show the old answer next to the new one.
   */
  const setAccess = trpc.users.setAccess.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.users.get.invalidate(), utils.users.listDirectory.invalidate()]);
    },
  });

  const isOpen = userId !== null;

  // Two parallel queries — base profile + direct reports list. Both
  // run only when the drawer is open AND for the given userId.
  const userQuery = trpc.users.get.useQuery(
    { id: userId ?? '' },
    { enabled: isOpen, staleTime: 30_000 },
  );
  const reportsQuery = trpc.users.getDirectReports.useQuery(
    { userId: userId ?? '' },
    { enabled: isOpen, staleTime: 30_000 },
  );

  return (
    <Drawer
      open={isOpen}
      dismissible
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DrawerContent width={760} resizable storageKey="users.detail">
        {userQuery.isLoading ? (
          <DrawerBody>
            <div className="space-y-3">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-48 animate-pulse rounded bg-muted" />
              <div className="h-3 w-40 animate-pulse rounded bg-muted" />
            </div>
          </DrawerBody>
        ) : !userQuery.data ? (
          <DrawerBody>
            <p className="text-muted-foreground text-sm">{tDetail('notFound')}</p>
          </DrawerBody>
        ) : (
          <DrawerContents
            user={userQuery.data}
            directReports={reportsQuery.data?.items ?? []}
            tStatus={tStatus}
            tCols={tCols}
            tDetail={tDetail}
            tLast={tLast}
            tAccess={tAccess}
            locale={locale}
            canSetAccess={canSetAccess}
            syncReviewPath={syncReviewPath}
            settingAccess={setAccess.isPending}
            onSetAccess={(hasAccess) =>
              userQuery.data && setAccess.mutate({ id: userQuery.data.id, hasAccess })
            }
            onOpenUser={onOpenUser}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** Split out so we can render conditionally without re-mounting the
 *  Drawer's portal — the loading/empty states stay inside the same
 *  shell so the slide animation isn't interrupted. */
function DrawerContents({
  user,
  directReports,
  tStatus,
  tCols,
  tDetail,
  tLast,
  tAccess,
  locale,
  onOpenUser,
  canSetAccess,
  syncReviewPath,
  onSetAccess,
  settingAccess,
}: {
  user: UserDetail;
  directReports: DirectReport[];
  tStatus: ReturnType<typeof useTranslations<'people.status'>>;
  tCols: ReturnType<typeof useTranslations<'people.columns'>>;
  tDetail: ReturnType<typeof useTranslations<'people.detail'>>;
  tLast: ReturnType<typeof useTranslations<'people.lastLogin'>>;
  tAccess: ReturnType<typeof useTranslations<'people.access'>>;
  locale: Locale;
  canSetAccess: boolean;
  syncReviewPath?: string;
  onSetAccess: (hasAccess: boolean) => void;
  settingAccess: boolean;
  onOpenUser?: (id: string) => void;
}) {
  const tSync = useTranslations('people.sync');
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  const initials = initialsFrom(user.firstName, user.lastName, user.email);
  const roleLabel = (getLocalized(user.role.label, locale) ?? '') as string;
  const externalIds = externalIdEntries(user.externalIds);

  return (
    <>
      <DrawerHeader>
        <Avatar initials={initials} alt={fullName} size="lg" />
        <div className="min-w-0 flex-1">
          <DrawerTitle className="truncate">{fullName}</DrawerTitle>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-muted-foreground text-xs">{roleLabel}</span>
            <Badge variant={EMPLOYEE_STATUS_VARIANT[user.employeeStatus]} className="text-[10px]">
              {tStatus(user.employeeStatus)}
            </Badge>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
          {/* ═══ Left column ═══ */}
          <div className="space-y-6">
            {/* ── Identity ────────────────────────────────────────── */}
            <Section title={tDetail('identity')}>
              <Field
                label={tCols('email')}
                value={
                  <a
                    href={`mailto:${user.email}`}
                    className="text-accent-foreground hover:underline"
                  >
                    {user.email}
                  </a>
                }
              />
              <Field label={tDetail('role')} value={roleLabel} />
              <Field
                label={tCols('status')}
                value={
                  <Badge variant={EMPLOYEE_STATUS_VARIANT[user.employeeStatus]}>
                    {tStatus(user.employeeStatus)}
                  </Badge>
                }
              />
              {/**
               * Sign-in access, beside status because the two are constantly confused and
               * are not the same thing:  refuses without this flag regardless of
               * employment. Shown to everyone who can see the person, changed only by
               * whoever may change their role.
               */}
              <Field
                label={tCols('access')}
                value={
                  <div className="flex items-center gap-2">
                    <Badge variant={user.hasAccess ? 'success' : 'warning'}>
                      {user.hasAccess ? tAccess('granted') : tAccess('denied')}
                    </Badge>
                    {canSetAccess && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={settingAccess}
                        onClick={() => onSetAccess(!user.hasAccess)}
                      >
                        {user.hasAccess ? tAccess('revoke') : tAccess('grant')}
                      </Button>
                    )}
                  </div>
                }
              />
              {user.onLeaveAt && (
                <Field label={tDetail('onLeaveSince')} value={formatDate(user.onLeaveAt, locale)} />
              )}
              {user.terminationDate && (
                <Field
                  label={tDetail('termination')}
                  value={formatDate(user.terminationDate, locale)}
                />
              )}
              <Field
                label={tDetail('lastLogin')}
                value={user.lastLoginAt ? formatRelativeDate(user.lastLoginAt, locale, tLast) : '—'}
              />
            </Section>

            {/* ── Manager + Direct reports ───────────────────────── */}
            <Section title={tDetail('reporting')}>
              <Field
                label={tCols('manager')}
                value={
                  user.manager ? (
                    <button
                      type="button"
                      onClick={() => {
                        const m = user.manager;
                        if (m) onOpenUser?.(m.id);
                      }}
                      className="inline-flex items-center gap-1.5 text-accent-foreground hover:underline"
                    >
                      {[user.manager.firstName, user.manager.lastName].filter(Boolean).join(' ') ||
                        '—'}
                      <IconChevronRight size={12} />
                    </button>
                  ) : (
                    '—'
                  )
                }
              />
              <Field
                label={tDetail('directReports', { count: directReports.length })}
                value={
                  directReports.length === 0 ? (
                    <span className="text-muted-foreground">{tDetail('none')}</span>
                  ) : (
                    <div className="-mx-1.5 flex flex-col gap-0.5">
                      {directReports.slice(0, 8).map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => onOpenUser?.(r.id)}
                          className="group flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
                        >
                          <Avatar
                            initials={initialsFrom(r.firstName, r.lastName, r.email)}
                            size="sm"
                            variant="soft"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}
                          </span>
                          <IconChevronRight
                            size={12}
                            className="text-muted-foreground opacity-0 group-hover:opacity-100"
                          />
                        </button>
                      ))}
                      {directReports.length > 8 && (
                        <span className="px-1.5 pt-1 text-muted-foreground text-xs">
                          {tDetail('andMore', { count: directReports.length - 8 })}
                        </span>
                      )}
                    </div>
                  )
                }
              />
            </Section>
          </div>

          {/* ═══ Right column ═══ */}
          <div className="space-y-6">
            {/* ── Organization ────────────────────────────────────── */}
            <Section title={tDetail('organization')}>
              <Field
                label={tCols('entity')}
                value={(user.entity && getLocalized(user.entity.label, locale)) ?? '—'}
              />
              <Field
                label={tCols('businessUnit')}
                value={(user.businessUnit && getLocalized(user.businessUnit.label, locale)) ?? '—'}
              />
              {/* Read-only, whatever the business-unit source switch says: the sync writes it. */}
              <Field label={tCols('nsBusinessUnit')} value={user.nsBusinessUnit?.name ?? '—'} />
              <Field
                label={tCols('department')}
                value={(user.department && getLocalized(user.department.label, locale)) ?? '—'}
              />
              <Field
                label={tCols('jobLevel')}
                value={(user.jobLevel && getLocalized(user.jobLevel.label, locale)) ?? '—'}
              />
              <Field label={tDetail('country')} value={user.country ?? '—'} />
              <Field label={tDetail('homeCurrency')} value={user.homeCurrency ?? '—'} />
            </Section>

            {/* ── People ↔ NetSuite ───────────────────────────────── */}
            {(user.syncDiscrepancies?.length ?? 0) > 0 && (
              <Section title={tSync('section')}>
                <ul className="space-y-1 text-sm" data-testid="people-sync-section">
                  {user.syncDiscrepancies.map((d) => (
                    <li key={d.field} className="flex items-center gap-2">
                      <span>{tSync(`field.${d.field}`)}</span>
                      {d.divergesFromDirectory && (
                        <Badge variant="warning" title={tSync('hrItHelp')}>
                          {tSync('hrIt')}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-muted-foreground text-xs">{tSync('explain')}</p>
                {syncReviewPath && (
                  <LocaleLink
                    href={`${syncReviewPath}?q=${encodeURIComponent(user.email)}`}
                    className="mt-2 inline-block text-primary text-sm underline-offset-4 hover:underline"
                  >
                    {tSync('review')}
                  </LocaleLink>
                )}
              </Section>
            )}

            {/* ── External IDs ────────────────────────────────────── */}
            {externalIds.length > 0 && (
              <Section title={tDetail('externalSystems')}>
                <ExternalIdsBlock value={user.externalIds} />
              </Section>
            )}

            {/* VeloExpense: no virtual-cards section (out of scope, 7 Oct 2026). */}

            {/* ── Activity ────────────────────────────────────────── */}
            <Section title={tDetail('activity')}>
              <ActivitySection userId={user.id} locale={locale} />
            </Section>
          </div>
        </div>
      </DrawerBody>
    </>
  );
}

// ─── Activity: expense reports and delegations ───────────────────

/**
 * What this person has filed and who approves for them.
 *
 * Both of these read "coming soon" long after the features shipped, so an admin looking
 * into an account had to leave the drawer and search two other screens for the same
 * person. One round-trip serves both, and each half reports its own authorisation:
 * `null` is "you may not see this", `[]` is "there are none". Printing an empty list for
 * a reader who simply lacks the permission would say this person has filed nothing, which
 * is the false conclusion the placeholder was there to prevent.
 */
function ActivitySection({ userId, locale }: { userId: string; locale: Locale }) {
  const tDetail = useTranslations('people.detail');
  const tExpenses = useTranslations('expenses');
  const tDelegations = useTranslations('delegations');
  const query = trpc.users.activity.useQuery({ id: userId }, { staleTime: 30_000 });

  if (query.isLoading) {
    return (
      <div className="space-y-1.5">
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const reports = query.data?.reports ?? null;
  const delegations = query.data?.delegations ?? null;

  return (
    <div className="space-y-3">
      {/* ── Expense reports ─────────────────────────────────── */}
      <div>
        <SubHeading icon={<IconReceipt size={14} />} label={tDetail('expenseReports')} />
        {reports === null ? (
          <RestrictedNote text={tDetail('restricted')} />
        ) : reports.length === 0 ? (
          <EmptyNote text={tDetail('noReports')} />
        ) : (
          <div className="-mx-1.5 flex flex-col gap-0.5">
            {reports.map((r) => (
              <Link
                key={r.id}
                href={`/${locale}/expenses/${r.id}`}
                className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {r.title}
                  <span className="ml-1.5 text-muted-foreground text-xs">
                    {formatDate(r.date, locale)}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {/* `withCode` because this list can hold more than one currency and CAD
                      and USD share the `$` glyph. */}
                  {formatMinor(
                    Number(r.totalMinor),
                    { code: r.currencyCode, symbol: r.currencySymbol },
                    locale,
                    { withCode: true },
                  )}
                </span>
                <StatusBadge {...statusBadgeProps(r.status, tExpenses)} className="text-[10px]" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ── Delegations ─────────────────────────────────────── */}
      <div>
        <SubHeading icon={<IconUsers size={14} />} label={tDetail('delegations')} />
        {delegations === null ? (
          <RestrictedNote text={tDetail('restricted')} />
        ) : delegations.length === 0 ? (
          <EmptyNote text={tDetail('noDelegations')} />
        ) : (
          <div className="-mx-1.5 flex flex-col gap-0.5">
            {delegations.map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {/* Says which way it runs: this person delegates TO someone, or acts FOR
                      them. A bare name leaves the reader guessing. */}
                  <span className="text-muted-foreground text-xs">
                    {d.direction === 'OUTGOING' ? tDetail('delegatesTo') : tDetail('actsFor')}{' '}
                  </span>
                  {displayName(d.counterparty)}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {tDelegations(`scope.${d.scope}`)}
                </span>
                <Badge variant={d.active ? 'success' : 'secondary'} className="text-[10px]">
                  {d.active ? tDelegations('status.active') : tDetail('delegationEnded')}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SubHeading({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
      {icon}
      <span className="font-medium text-xs">{label}</span>
    </div>
  );
}

/** The reader lacks the permission — deliberately not an empty list. */
function RestrictedNote({ text }: { text: string }) {
  return <span className="text-muted-foreground text-sm italic">{text}</span>;
}

function EmptyNote({ text }: { text: string }) {
  return <span className="text-muted-foreground text-sm">{text}</span>;
}

// ─── Layout helpers ──────────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold text-foreground text-xs uppercase tracking-wide">{title}</h3>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-2 text-sm">
      <dt className="pt-0.5 font-medium text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{value}</dd>
    </div>
  );
}

// ─── Utilities ───────────────────────────────────────────────────

function formatDate(date: Date | string, locale: Locale): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeDate(
  date: Date | string,
  locale: Locale,
  tLast: ReturnType<typeof useTranslations<'people.lastLogin'>>,
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return tLast('today');
  if (diffDays === 1) return tLast('yesterday');
  if (diffDays < 30) return tLast('daysAgo', { days: diffDays });
  return formatDate(d, locale);
}

// Unused imports (suppress lints) — kept for the future placeholder
// section icons exported above.
void IconBuilding;
void IconExternalLink;
void IconMail;
void Button;
void cls;
