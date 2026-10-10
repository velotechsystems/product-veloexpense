'use server';
/**
 * VX2-7 — the recipient's own actions: read their inbox, mark things read, and
 * set their channel preferences.
 *
 * Gated as a MEMBER and scoped to the acting user throughout. There is no admin
 * override here and there should not be: an inbox is addressed to a person, and
 * "read somebody else's notifications" is not a permission this product has a
 * use for. Every service call takes `actor.id` as the recipient, so the scoping
 * is structural rather than a filter somebody could forget.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { requireActor } from '@/lib/auth/actor';
import { loadReaderPrefs } from '@/lib/i18n/service';
import type { EmployeeRow } from '@/lib/employees/service';
import { append as auditAppend } from '@/lib/audit/service';
import {
  CHANNELS,
  EVENT_TYPES,
  TEMPLATE_KEY_BY_KEY,
  channelDefault,
  channelEnabled,
  isChannel,
  templateKeyFor,
  type Channel,
} from '@/lib/notifications/catalog';
import {
  listInbox,
  markAllRead,
  markRead,
  preferencesFor,
  setPreference,
  unreadCount,
} from '@/lib/notifications/service';

const PAGE = '/notifications';

async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function getInboxPage(unreadOnly: boolean) {
  return asActor(async (tx, actor) => ({
    // VX4-7 part 1b. `listInbox` has accepted a locale since VX2-7 and nobody
    // passed one, so every bell rendered in the default. The reader IS the
    // recipient here, unlike an email, so `loadReaderPrefs` is the right source
    // — and it resolves through the same user -> company -> constant chain.
    rows: await listInbox(tx, actor.id, {
      unreadOnly,
      locale: (await loadReaderPrefs(tx, actor.id)).locale,
    }),
    unread: await unreadCount(tx, actor.id),
    actor: { id: actor.id, name: actor.display_name ?? actor.email },
  }));
}

/**
 * The preferences grid: every event type x every channel, with what the user
 * would get today and whether that is their choice or the default.
 *
 * `overridden` is a separate fact from `enabled` and the screen shows both,
 * because "off because I turned it off" and "off because it ships off" behave
 * differently later: if the product changes a default, only the second moves.
 * That is the whole point of storing overrides rather than values (NT-3), and a
 * screen that hid the distinction would make the behaviour look like a bug.
 */
export async function getPreferencesPage() {
  return asActor(async (tx, actor) => {
    const overrides = await preferencesFor(tx, actor.id);
    const grid = EVENT_TYPES.map((eventType) => {
      const key = templateKeyFor(eventType, 'EXPENSE_REPORT');
      const def = key ? TEMPLATE_KEY_BY_KEY.get(key) : undefined;
      return {
        eventType,
        name: def?.name ?? eventType,
        description: def?.description ?? '',
        channels: CHANNELS.map((channel) => ({
          channel,
          enabled: channelEnabled(eventType, channel, overrides),
          overridden: overrides.has(`${eventType}:${channel}`),
          shipsOn: channelDefault(channel, eventType),
          // EMAIL and SLACK have no delivery until VX2-8. Offering a live
          // toggle for a channel that cannot deliver is exactly the dead
          // control GAP-AUDIT NT-2 found in ExpenseOS, so they are shown and
          // visibly disabled rather than hidden — hiding them would make the
          // roadmap invisible and the screen look finished.
          deliverable: channel === 'IN_APP',
        })),
      };
    });
    return { grid, actor: { id: actor.id, name: actor.display_name ?? actor.email } };
  });
}

/* ── mutations ─────────────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function guard(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const message = errorParam(err, 'notifications');
    return `${PAGE}?error=${encodeURIComponent(message)}`;
  }
}

export async function markReadFromForm(form: FormData) {
  const failure = await guard(async () => {
    const id = text(form, 'notificationId');
    if (!id) throw new Error('notificationId is required');
    await asActor((tx, actor) => markRead(tx, id, actor.id));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function markAllReadFromForm() {
  const failure = await guard(async () => {
    await asActor((tx, actor) => markAllRead(tx, actor.id));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

/**
 * Set or clear one override.
 *
 * A preference CHANGE goes on the hash-chained audit trail; the suppression
 * itself writes nothing. That split is the mitigation the NT-2 decision
 * accepted: a person can mute an event and therefore miss a returned report, and
 * "I was never told" has to be answerable afterwards. One row per change answers
 * it; one row per suppressed notification would be noise proportional to
 * traffic.
 */
export async function setPreferenceFromForm(form: FormData) {
  const back = `${PAGE}/preferences`;
  try {
    const eventType = text(form, 'eventType');
    const channel = text(form, 'channel');
    if (!eventType || !channel) throw new Error('eventType and channel are required');
    if (!isChannel(channel)) throw new Error(`unknown channel: ${channel}`);
    // Three states, not two: on, off, and "no opinion" (which follows the
    // default wherever it goes). The form's third button is what makes the
    // difference reachable rather than only representable.
    const raw = text(form, 'enabled');
    const enabled: boolean | null = raw === 'default' ? null : raw === 'true';
    await asActor(async (tx, actor) => {
      await setPreference(tx, actor.id, eventType, channel, enabled);
      await auditAppend(
        tx,
        { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
        {
          action: 'NOTIFICATION_PREFERENCE_CHANGED',
          entityType: 'app_user',
          entityId: actor.id,
          details: {
            eventType,
            channel: channel as Channel,
            enabled: enabled === null ? 'default' : enabled,
          },
        },
      );
    });
  } catch (err) {
    const message = errorParam(err, 'notifications');
    redirect(`${back}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(back);
  revalidatePath(PAGE);
  redirect(back);
}
