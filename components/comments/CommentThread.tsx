'use client';

/**
 * The discussion on a subject: system events and comments in one chronological stream,
 * with a box to add to it.
 *
 * ONE component for every subject that has a thread. The card-request drawer grew its own
 * first and keeps it; this exists so the expense-report and travel threads are not a second
 * and third transcription, because the interesting parts — what counts as access, whether a
 * reply that arrived by email is distinguishable from one typed here — are exactly the parts
 * that drift when copied.
 *
 * Two things it deliberately does:
 *
 *   · **Interleaves events with comments.** "Returned by Ana" and the comment explaining
 *     why are one conversation; splitting them across two panels makes the reader
 *     reconstruct the order themselves.
 *   · **Says where a comment came from.** A reply posted from somebody's inbox reads as an
 *     email reply, not as something they typed into this box. Without that, a terse
 *     one-line answer looks oddly curt rather than like what it is — a phone reply.
 *
 * VeloExpense: ported from ExpenseOS (550b2945) with w2-02a (d37). Two differences, marked:
 * the expense report is the only subject (travel arrives with travel), and an event line
 * carries its REASON — the note an approver gave when they rejected, returned or approved,
 * and a reassignment with whom it went to and why — because "the submitter and reviewer
 * need to know reasons why rejected or reassigned". ExpenseOS's line says only who did it.
 */

import { Avatar, Button, initialsFrom, Textarea } from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { displayName } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';

/** The subjects this thread serves. Mirrors the router's own list.
 *  VeloExpense: the expense report only, until travel (ExpenseOS: and 'TRAVEL_REQUEST'). */
export type CommentSubject = 'EXPENSE_REPORT';

/** Event types worth a line in the stream. Anything else — internal bookkeeping, task
 *  assignment noise — is skipped rather than rendered as a bare type name. */
const EVENT_VERBS = new Set([
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'RECALLED',
  'REIMBURSED',
  'ADJUSTED',
  // VeloExpense (d37): an approval passed to somebody else, with the reason.
  'REASSIGNED',
]);

export function CommentThread({
  subjectType,
  subjectId,
  /** Rendered above the stream. Omit inside a section that already has one. */
  heading = true,
  /**
   * Render as a self-contained card that fills its container: pinned header, its own
   * scrolling stream, pinned composer — and, because it then owns a scroller, it
   * sticks to the newest message.
   *
   * The caller supplies the height. Without `enclosed` the component is a plain
   * block that grows with its content, which is what a drawer wants.
   */
  enclosed = false,
  className,
}: {
  subjectType: CommentSubject;
  subjectId: string;
  heading?: boolean;
  enclosed?: boolean;
  className?: string;
}) {
  const t = useTranslations('comments');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const thread = trpc.comments.thread.useQuery({ subjectType, subjectId });
  const [body, setBody] = useState('');
  const post = trpc.comments.post.useMutation({
    onSuccess: () => {
      setBody('');
      utils.comments.thread.invalidate({ subjectType, subjectId });
    },
  });

  const when = (d: string | Date) => new Date(d).toLocaleString(locale);
  const items = thread.data?.items ?? [];

  /**
   * Stick to the newest message — on first load and whenever one arrives.
   *
   * A transcript that opens at the TOP shows the oldest line, which on any thread
   * with history is the least useful thing on the screen: you open a discussion to
   * read what was just said. `scrollTop = scrollHeight` rather than
   * `scrollIntoView`, deliberately — the latter walks up to the nearest scrollable
   * ancestor, so in a drawer it would drag the whole panel down to reach the
   * thread. This only ever moves the thread's own scroller.
   *
   * Only in `enclosed` mode, because only then does that scroller exist. Keyed on
   * the item COUNT, so a poll returning the same messages doesn't fight somebody
   * who has scrolled up to read.
   */
  const streamRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = streamRef.current;
    // Nothing to scroll to on an empty thread — and reading the count here is what
    // makes it an honest dependency rather than one the linter reads as spurious.
    if (!el || items.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length]);

  // Same three parts either way; `enclosed` decides whether they are a card with a
  // pinned header and footer, or a plain block that grows with its content.
  const shell = enclosed
    ? `flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card ${className ?? ''}`
    : (className ?? '');

  return (
    <div className={shell}>
      {heading &&
        (enclosed ? (
          <div className="flex h-12 shrink-0 items-center border-border border-b px-3">
            <h3 className="font-semibold text-base text-foreground">{t('heading')}</h3>
          </div>
        ) : (
          <p className="mb-2 font-medium text-foreground text-sm">{t('heading')}</p>
        ))}
      <div
        ref={streamRef}
        className={enclosed ? 'min-h-0 flex-1 space-y-3 overflow-y-auto p-3' : 'space-y-3'}
      >
        {thread.isLoading ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">{t('empty')}</p>
        ) : (
          items.map((item) => {
            const who = item.author ? displayName(item.author) : '—';
            if (item.type === 'COMMENT') {
              return (
                <div key={item.id} className="flex gap-2.5">
                  {/* Initials from the name PARTS, with email as the fallback — deriving
                      them from the composed display name would take the first two letters
                      of a single-word name instead of first+last. */}
                  <Avatar
                    initials={
                      item.author
                        ? initialsFrom(
                            item.author.firstName,
                            item.author.lastName,
                            item.author.email,
                          )
                        : '?'
                    }
                    alt={who}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1 rounded-md border border-border bg-card p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground text-xs">{who}</span>
                      <span className="text-muted-foreground text-xs">
                        {/* The channel, only when it is not the obvious one. Labelling an
                            in-app comment "in the app" is noise; labelling an emailed one
                            is the difference between a curt reply and a phone reply. */}
                        {item.via && item.via !== 'app' && (
                          <span className="mr-1.5">{t(`via.${item.via}` as 'via.email')}</span>
                        )}
                        {when(item.createdAt)}
                      </span>
                    </div>
                    {/* `break-words` alongside `whitespace-pre-wrap`: pre-wrap honours the
                        author's newlines and wraps at spaces, but it will not break a
                        single long token — one pasted URL or reference number stretched
                        the bubble past the column and took the layout with it. */}
                    <p className="mt-1 whitespace-pre-wrap break-words text-foreground text-sm">
                      {item.body}
                    </p>
                  </div>
                </div>
              );
            }
            if (!EVENT_VERBS.has(item.type)) return null;
            return (
              <div key={item.id} className="flex items-baseline gap-2.5 pl-1 text-xs">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                <div className="min-w-0 text-muted-foreground">
                  <span className="font-medium text-foreground">{who}</span>{' '}
                  {/* VeloExpense: a reassignment names who it went to. */}
                  {item.type === 'REASSIGNED'
                    ? t('event.REASSIGNED', { assignee: item.assignee ?? '—' })
                    : t(`event.${item.type}` as 'event.SUBMITTED')}{' '}
                  · {when(item.createdAt)}
                  {/* VeloExpense (d37): the reason, as the approver wrote it — the line a
                      submitter opens the thread to read. `break-words` for the same reason
                      the comment bubble has it. */}
                  {item.note && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                      {item.note}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div
        className={
          enclosed
            ? 'flex shrink-0 items-start gap-2 border-border border-t p-3'
            : 'mt-3 flex items-start gap-2'
        }
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          className="flex-1"
        />
        <Button
          size="sm"
          disabled={!body.trim() || post.isPending}
          onClick={() => post.mutate({ subjectType, subjectId, body: body.trim() })}
        >
          {post.isPending ? t('posting') : t('post')}
        </Button>
      </div>
      {/* The server's refusal, shown in place. A comment that silently fails to post is
          indistinguishable from one that posted and did not refresh. */}
      {post.isError && (
        <p
          role="alert"
          className={
            enclosed
              ? 'shrink-0 px-3 pb-2 text-destructive text-xs'
              : 'mt-1 text-destructive text-xs'
          }
        >
          {post.error.message}
        </p>
      )}
    </div>
  );
}
