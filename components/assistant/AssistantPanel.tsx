'use client';

import {
  type AttachedFile,
  MAX_ATTACHMENTS_PER_TURN,
  RECEIPT_ACCEPT,
  rejectAttachment,
} from '@expenseos/assistant';
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  MarkdownText,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '@expenseos/design-system';
import { SUPPORTED_LOCALES } from '@expenseos/i18n/locales';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconDotsVertical,
  IconHistory,
  IconMicrophone,
  IconPaperclip,
  IconPlayerStopFilled,
  IconSend,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isVisible, type MessageView, viewsOf } from '@/components/assistant/messageView';
import { runReceiptUploads, type UploadSlot } from '@/components/assistant/receiptUpload';
import { screenContextFrom } from '@/components/assistant/screenContext';
import { completePartialMarkdown } from '@/components/assistant/streamingMarkdown';
import { useAssistantChat } from '@/components/assistant/useAssistantChat';
import { useVoiceInput } from '@/components/assistant/useVoiceInput';
import { trpc } from '@/lib/trpc/client';

/**
 * The assistant panel.
 *
 * Two properties the layout is built around. **The transcript comes from the server**, not
 * from what this component has seen — a refresh, a second tab, or a turn that failed halfway
 * all have to show what was actually stored. And **a proposal is rendered in the thread**,
 * where the answer that produced it is, rather than in a modal: a confirmation torn out of
 * its context is a dialog asking somebody to approve a sentence they can no longer read.
 */

/** Past this many stored messages, replaying the thread starts to cost real money. */
const LONG_THREAD = 40;

export function AssistantPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useTranslations('assistant');
  const locale = useLocale() as 'en' | 'fr-CA';
  const pathname = usePathname();
  const utils = trpc.useUtils();

  const session = trpc.assistant.session.useQuery(undefined, { enabled: open });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /**
   * The panel shows either the thread or the list of threads, never both.
   *
   * A list beside a 30rem-wide conversation would take a third of it, and the reason to open
   * one is to leave the current thread anyway. Switching picks a conversation and returns.
   */
  const [showHistory, setShowHistory] = useState(false);
  // Files chosen but not uploaded. They stay here across the press — the upload slots only
  // exist once the mutation the person confirmed has actually run.
  //
  // Each carries an id rather than being keyed by position: two files can share a name and a
  // size, and removing one of those by index removes whichever React thinks is there.
  const [staged, setStaged] = useState<{ id: string; file: File }[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /**
   * The message just sent, shown before the server has stored it.
   *
   * The transcript is the server's, and it is only re-read when the turn settles — so
   * pressing Enter used to clear the box and show nothing at all until the answer began.
   * For the seconds a tool call takes, the panel looked like it had swallowed the
   * question. This is the same text, rendered in the same bubble, and it is dropped once
   * the stored transcript that contains it has actually arrived.
   */
  const [pending, setPending] = useState<{ text: string; files: number } | null>(null);
  const [filing, setFiling] = useState<{ done: number; total: number } | null>(null);
  const [filed, setFiled] = useState<{ filed: number; failed: number; mismatched: number } | null>(
    null,
  );
  // The report the last press filed into. Held so the notice can link to it — the panel does
  // not use the server's absolute `reportUrl`, because in-app a router push beats a full
  // page load.
  const [filedReportId, setFiledReportId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  // The server decides which thread to resume; this only mirrors its answer so the composer
  // and the transcript query agree on which conversation they are in.
  useEffect(() => {
    if (session.data?.conversation) setConversationId(session.data.conversation.id);
  }, [session.data?.conversation]);

  // Only fetched while the list is open: most sessions never open it, and it is a second
  // query against a table the panel already reads.
  const history = trpc.assistant.conversations.useQuery(undefined, {
    enabled: open && showHistory,
  });

  const stored = trpc.assistant.messages.useQuery(
    { conversationId: conversationId ?? '' },
    { enabled: open && Boolean(conversationId) },
  );

  const screen = useMemo(
    () => (pathname ? screenContextFrom(pathname, SUPPORTED_LOCALES) : null),
    [pathname],
  );

  const onSettled = useCallback(
    async (id: string | null) => {
      if (id) setConversationId(id);
      // Awaited, then cleared: dropping the optimistic bubble before the stored one has
      // arrived leaves a gap where the question vanishes and comes back.
      await Promise.all([
        utils.assistant.messages.invalidate(),
        utils.assistant.session.invalidate(),
      ]);
      setPending(null);
    },
    [utils],
  );

  const receiptCreate = trpc.expenses.receiptCreate.useMutation();
  const receiptUploadUrl = trpc.expenses.receiptUploadUrl.useMutation();
  const startExtraction = trpc.expenses.startExtraction.useMutation();

  // The bytes go from here straight to S3, once the press has created somewhere to put them.
  const fileReceipts = useCallback(
    async (uploads: readonly UploadSlot[], files: readonly File[]) => {
      setFiled(null);
      setFiling({ done: 0, total: files.length });
      const report = await runReceiptUploads(uploads, files, {
        put: async (slot, file) => {
          const res = await fetch(slot.url, {
            method: slot.method,
            headers: slot.headers,
            body: file,
          });
          return res.ok;
        },
        // The retry link is sized from the File, not from what the model said it was.
        reissue: async (slot, file) => ({
          ...slot,
          ...(await receiptUploadUrl.mutateAsync({
            expenseId: slot.expenseId,
            filename: slot.filename,
            contentType: slot.contentType,
            sizeBytes: file.size,
          })),
        }),
        register: (input) => receiptCreate.mutateAsync({ ...input, deferExtraction: true }),
        extract: (receiptIds) => startExtraction.mutateAsync({ receiptIds }),
        onProgress: (done, total) => setFiling({ done, total }),
      });
      setFiling(null);
      setFiled(report);
      setStaged([]);
      // The expenses now hold receipts and are queued for extraction; anything showing them
      // is stale.
      void utils.expenses.invalidate();
    },
    [receiptCreate, receiptUploadUrl, startExtraction, utils],
  );

  const { state, send, reset } = useAssistantChat({
    conversationId,
    locale,
    screen,
    onSettled,
    onConfirmed: ({ uploads, reportId }) => {
      // Snapshot the staged list: the upload runs on after this handler returns, and the
      // person can carry on typing meanwhile.
      const files = staged.map((s) => s.file);
      if (files.length === 0) return;
      setFiledReportId(reportId);
      void fileReceipts(uploads, files);
    },
  });

  const messages = stored.data ?? [];
  const visible = messages.filter((m) => isVisible(m.content));

  // Follow the answer as it is written. `auto` rather than `smooth`: a smooth scroll that
  // restarts on every token never arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any new content
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, state.streaming, state.proposal]);

  /**
   * Move to another thread.
   *
   * `reset()` matters: the hook holds the turn in progress, and carrying a half-streamed
   * answer across a switch would render it under the wrong conversation.
   */
  const openConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      setShowHistory(false);
      reset();
      setFiled(null);
      void utils.assistant.messages.invalidate();
    },
    [reset, utils],
  );

  const create = trpc.assistant.create.useMutation({
    onSuccess: (c) => {
      setConversationId(c.id);
      setShowHistory(false);
      reset();
      void utils.assistant.messages.invalidate();
      void utils.assistant.session.invalidate();
    },
  });
  const archive = trpc.assistant.archive.useMutation({
    onSuccess: () => {
      setConversationId(null);
      setShowHistory(false);
      reset();
      void utils.assistant.session.invalidate();
      void utils.assistant.conversations.invalidate();
    },
  });

  const attachments: AttachedFile[] = useMemo(
    () =>
      staged.map(({ file }) => ({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      })),
    [staged],
  );

  /**
   * Dictation appends to whatever is already typed rather than replacing it, so somebody
   * can start a sentence, dictate the awkward middle, and finish it by hand. Committed
   * phrases arrive already trimmed; the space is ours to add.
   */
  const voice = useVoiceInput({
    locale,
    onTranscript: (text) => setDraft((d) => (d ? `${d.trimEnd()} ${text}` : text)),
  });

  const ask = (text: string) => {
    const message = text.trim();
    // Attachments alone are a turn: dropping receipts in without a word is a request.
    if ((!message && staged.length === 0) || state.busy) return;
    setDraft('');
    setFiled(null);
    setPending({ text: message, files: staged.length });
    // A live microphone over the model's answer is a surprise nobody asked for, and the
    // words would land in the NEXT question.
    voice.stop();
    void send({
      message: message || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  };

  /** Stage what we can, and say plainly what was turned away. */
  const stage = (picked: FileList) => {
    setAttachError(null);
    const accepted: { id: string; file: File }[] = [];
    let rejectedType = 0;
    let rejectedSize = 0;
    for (const file of Array.from(picked)) {
      const reason = rejectAttachment({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      if (reason === 'type') rejectedType += 1;
      else if (reason === 'size') rejectedSize += 1;
      else accepted.push({ id: crypto.randomUUID(), file });
    }
    const room = MAX_ATTACHMENTS_PER_TURN - staged.length;
    const taken = accepted.slice(0, Math.max(room, 0));
    setStaged((prev) => [...prev, ...taken]);
    if (rejectedType > 0) setAttachError(t('attachRejectedType', { count: rejectedType }));
    else if (rejectedSize > 0) setAttachError(t('attachRejectedSize', { count: rejectedSize }));
    else if (taken.length < accepted.length) {
      setAttachError(t('attachTooMany', { max: MAX_ATTACHMENTS_PER_TURN }));
    }
  };

  /**
   * What to say when a turn fails, in the order the information is worth having.
   *
   * `failureMessage` is a sentence the ROUTE wrote for a refusal it could answer with a
   * status code — "The assistant is not configured.", "No such conversation." Once the
   * stream is open it cannot send a status, so it sends a REASON instead and the sentence
   * is written here, which is also what keeps it in the reader's language.
   *
   * The generic notice is last and means what it says: nothing identified the failure.
   * It used to be shown for all of them, and "Try asking again" is wrong advice for most
   * — asking again does not fund an account or rotate a revoked key.
   */
  const failureText =
    state.failureMessage ??
    (state.failureReason && state.failureReason !== 'unknown'
      ? t(`errorReason.${state.failureReason}`)
      : t('error'));

  const title = state.title ?? session.data?.conversation?.title ?? t('title');
  const unavailable = session.data && !session.data.available;
  /**
   * Which hint to show. The panel used to have one, naming module installation — so an
   * admin whose module was already installed was told to install it, and the actual
   * problem (no API key) was never mentioned.
   */
  const unavailableHint =
    session.data && !session.data.available && session.data.reason === 'NOT_CONFIGURED'
      ? t('unavailableNotConfigured')
      : t('unavailableHint');

  return (
    <Drawer open={open} onOpenChange={onOpenChange} dismissible>
      {/**
       * 640px, and draggable.
       *
       * It was a fixed `sm:w-[30rem]` (480px) — too narrow for what this panel now
       * holds: a receipt tray, a proposal card with a diff, and answers that quote
       * policy text. And it passed a `storageKey` while never setting `resizable`,
       * so the key persisted nothing: the drawer was wired for a drag handle that
       * was never turned on. Both fixed here, so the default is roomier AND the
       * width is the reader's choice, remembered per browser.
       */}
      <DrawerContent
        className="flex w-full flex-col"
        width={640}
        resizable
        minWidth={420}
        storageKey="assistant-panel"
      >
        <DrawerHeader className="flex items-center justify-between gap-2">
          <DrawerTitle className="flex min-w-0 items-center gap-2">
            {showHistory ? (
              <button
                type="button"
                aria-label={t('backToConversation')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setShowHistory(false)}
              >
                <IconArrowLeft size={16} />
              </button>
            ) : (
              <IconSparkles size={18} className="shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{showHistory ? t('history') : title}</span>
          </DrawerTitle>
          {!unavailable && (
            <Popover>
              <PopoverTrigger
                aria-label={t('menu')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <IconDotsVertical size={18} />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-1">
                <button
                  type="button"
                  className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => create.mutate()}
                >
                  {t('newConversation')}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => setShowHistory(true)}
                >
                  <IconHistory size={14} className="text-muted-foreground" />
                  {t('history')}
                </button>
                <button
                  type="button"
                  disabled={!conversationId}
                  className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                  onClick={() => conversationId && archive.mutate({ conversationId })}
                >
                  {t('closeConversation')}
                </button>
              </PopoverContent>
            </Popover>
          )}
        </DrawerHeader>

        <DrawerBody className="flex-1 space-y-4 overflow-y-auto">
          {unavailable ? (
            <Unavailable title={t('unavailable')} hint={unavailableHint} />
          ) : showHistory ? (
            <ConversationList
              conversations={history.data ?? []}
              loading={history.isLoading}
              activeId={conversationId}
              onPick={openConversation}
            />
          ) : (
            <>
              {visible.length === 0 && !state.streaming && (
                <EmptyState
                  suggestions={session.data?.suggestions ?? []}
                  onPick={ask}
                  disabled={state.busy}
                />
              )}

              {visible.map((message) => (
                <StoredMessage
                  key={message.id}
                  role={message.role}
                  views={viewsOf(message.content)}
                  messageId={message.id}
                  rated={message.feedback?.some((f) => f.rating != null) ?? false}
                  onConfirm={(toolUseId) => void send({ confirm: toolUseId })}
                  onDecline={(toolUseId) => void send({ decline: toolUseId })}
                  busy={state.busy}
                />
              ))}

              {/* No emptiness guard: `ask` refuses a turn with neither text nor a file,
                  and the confirm/decline path never sets this at all. */}
              {pending && (
                <Bubble author="user">
                  {pending.text}
                  {pending.files > 0 && (
                    <span className="block pt-0.5 text-xs opacity-80">
                      {t('attachedCount', { count: pending.files })}
                    </span>
                  )}
                </Bubble>
              )}

              {state.streaming && (
                <Bubble author="assistant">
                  {/**
                   * Closed before rendering. Half-written markdown is not markdown —
                   * `**Total` has no closing pair, so it renders as literal asterisks
                   * and the answer types out as raw source, then snaps into formatting
                   * on the last token. Completing each frame makes it format as it
                   * arrives, which is what it looked like it should already do.
                   */}
                  <MarkdownText>{completePartialMarkdown(state.streaming)}</MarkdownText>
                </Bubble>
              )}
              {state.busy && !state.streaming && (
                <p className="text-muted-foreground text-sm">
                  {state.working ? t('usingTool') : t('thinking')}
                </p>
              )}
              {state.failed && <Notice tone="error">{failureText}</Notice>}
              {state.rateLimited && <Notice tone="error">{t('rateLimited')}</Notice>}
              {filing && (
                <Notice tone="info">
                  {t('filing', { done: filing.done, total: filing.total })}
                </Notice>
              )}
              {filed && (
                <Notice tone={filed.failed > 0 || filed.mismatched > 0 ? 'error' : 'info'}>
                  {filed.failed > 0 || filed.mismatched > 0
                    ? t('filedPartial', {
                        filed: filed.filed,
                        missing: filed.failed + filed.mismatched,
                      })
                    : t('filed', { count: filed.filed })}
                  {filedReportId && (
                    <>
                      {' '}
                      <Link
                        href={`/${locale}/expenses/${filedReportId}`}
                        className="underline underline-offset-2"
                        onClick={() => onOpenChange(false)}
                      >
                        {t('openReport')}
                      </Link>
                    </>
                  )}
                </Notice>
              )}
              {visible.length > LONG_THREAD && <Notice tone="info">{t('longThread')}</Notice>}
              <div ref={bottom} />
            </>
          )}
        </DrawerBody>

        {!unavailable && !showHistory && (
          /**
           * `flex-col items-stretch` because DrawerFooter is `flex items-center
           * justify-end` — built for a row of buttons. The composer is its only child, so
           * as a flex item it shrank to its content and sat pinned to the right edge
           * instead of spanning the drawer.
           */
          <DrawerFooter className="flex-col items-stretch gap-2">
            {attachError && <Notice tone="error">{attachError}</Notice>}
            {/**
             * The composer is ONE bounded box: the receipt tray sits inside the same
             * border as the input, above it.
             *
             * The tray used to be a separate row of chips floating above the composer,
             * which pushed the whole conversation up as files were added and read as a
             * banner about the attachments rather than as part of what you are about to
             * send. Inside the border it is what it is — the contents of this message —
             * and adding a receipt no longer reflows the transcript.
             *
             * `focus-within` moves the ring to the box, so the composer still looks
             * focused when the caret is in the textarea it now contains.
             */}
            <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
              {staged.length > 0 && (
                <ul className="flex flex-wrap gap-2 border-border border-b p-2">
                  {staged.map(({ id, file }) => (
                    <StagedFile
                      key={id}
                      file={file}
                      removeLabel={t('attachRemove', { name: file.name })}
                      disabled={state.busy || Boolean(filing)}
                      onRemove={() => setStaged((prev) => prev.filter((s) => s.id !== id))}
                    />
                  ))}
                </ul>
              )}
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('placeholder')}
                rows={2}
                disabled={state.busy}
                // The box owns the border and the focus ring now, so the textarea
                // inside it must not draw a second set.
                className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. A chat box that needs a mouse
                  // to send is a chat box people stop using.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ask(draft);
                  }
                }}
              />
              {/**
               * The sentence currently being dictated, shown under the caret and never
               * committed. Without it, speaking into a box that stays empty until you stop
               * reads as a microphone that is not working.
               */}
              {voice.listening && voice.interim && (
                <p className="px-3 pb-1 text-muted-foreground text-sm italic">{voice.interim}</p>
              )}
              {/**
               * The actions are the composer's SECOND LINE, inside its border rather than
               * under it — attach on the left, dictate and send on the right.
               *
               * They used to sit in a separate row below the box, which made the paperclip
               * read as page furniture rather than as part of the message being written.
               * Inside, the box is one object: what you are sending, and the three things
               * you can do to it.
               */}
              <div className="flex items-center justify-between gap-1 px-2 pb-2">
                <label
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t('attach')}
                  title={t('attach')}
                >
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    accept={RECEIPT_ACCEPT}
                    disabled={state.busy || Boolean(filing)}
                    onChange={(e) => {
                      if (e.target.files?.length) stage(e.target.files);
                      // Reset, or picking the same file twice in a row is a no-op event.
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <div className="flex items-center gap-1">
                  {/* Rendered only where the browser can actually dictate: a mic that does
                      nothing teaches somebody the feature is broken. */}
                  {voice.supported && (
                    <button
                      type="button"
                      aria-label={voice.listening ? t('voiceStop') : t('voice')}
                      title={voice.listening ? t('voiceStop') : t('voice')}
                      aria-pressed={voice.listening}
                      disabled={state.busy}
                      onClick={() => (voice.listening ? voice.stop() : voice.start())}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-50 ${
                        voice.listening
                          ? 'bg-destructive/10 text-destructive'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {voice.listening ? (
                        <IconPlayerStopFilled size={16} />
                      ) : (
                        <IconMicrophone size={18} />
                      )}
                    </button>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    aria-label={t('send')}
                    title={t('send')}
                    onClick={() => ask(draft)}
                    disabled={state.busy || (draft.trim().length === 0 && staged.length === 0)}
                  >
                    <IconSend size={16} />
                  </Button>
                </div>
              </div>
            </div>
            {voice.error && (
              <Notice tone="error">
                {voice.error === 'denied' ? t('voiceDenied') : t('voiceFailed')}
              </Notice>
            )}
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/**
 * One staged receipt, as a tile rather than a text chip.
 *
 * An image shows a thumbnail, because the question somebody actually has about a
 * staged receipt is "is that the right photo" — and a filename like `IMG_4821.HEIC`
 * cannot answer it. Non-images (a PDF invoice) keep the paperclip.
 *
 * The object URL is revoked on unmount. Without that, staging and clearing receipts
 * across a long conversation leaks a blob per file for the life of the tab.
 *
 * The remove button is always rendered rather than revealed on hover: hover-only
 * controls are unreachable on a touch screen, and this panel is used on tablets.
 */
function StagedFile({
  file,
  removeLabel,
  disabled,
  onRemove,
}: {
  file: File;
  removeLabel: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <li className="group relative flex w-36 items-center gap-2 rounded-md border border-border bg-muted/40 p-1.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-background">
        {preview ? (
          // Decorative: the filename beside it is the accessible name.
          // biome-ignore lint/performance/noImgElement: a local blob, never optimizable
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <IconPaperclip size={14} className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" title={file.name}>
        {file.name}
      </span>
      <button
        type="button"
        aria-label={removeLabel}
        className="absolute -top-1.5 -right-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground disabled:opacity-50"
        disabled={disabled}
        onClick={onRemove}
      >
        <IconX size={10} />
      </button>
    </li>
  );
}

/**
 * Past threads, newest first.
 *
 * Titles are model-generated after the first exchange, so a thread somebody abandoned before
 * answering has none — it is shown by date rather than hidden, because it is still the one they
 * are looking for.
 */
function ConversationList({
  conversations,
  loading,
  activeId,
  onPick,
}: {
  conversations: readonly { id: string; title: string | null; updatedAt: Date | string }[];
  loading: boolean;
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const t = useTranslations('assistant');
  if (loading) {
    return <p className="py-4 text-muted-foreground text-sm">{t('historyLoading')}</p>;
  }
  if (conversations.length === 0) {
    return <p className="py-4 text-muted-foreground text-sm">{t('historyEmpty')}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {conversations.map((c) => {
        const isActive = c.id === activeId;
        return (
          <li key={c.id}>
            <button
              type="button"
              aria-current={isActive ? 'true' : undefined}
              className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-muted ${
                isActive ? 'bg-muted' : ''
              }`}
              onClick={() => onPick(c.id)}
            >
              <span className="truncate font-medium text-sm">{c.title ?? t('untitledThread')}</span>
              <span className="text-muted-foreground text-xs">
                {new Date(c.updatedAt).toLocaleString()}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Unavailable({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-1 py-8 text-center">
      <p className="font-medium text-sm">{title}</p>
      <p className="text-muted-foreground text-sm">{hint}</p>
    </div>
  );
}

function EmptyState({
  suggestions,
  onPick,
  disabled,
}: {
  suggestions: string[];
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  const t = useTranslations('assistant');
  return (
    <div className="space-y-3 py-4">
      <div className="space-y-1">
        <p className="font-medium text-sm">{t('emptyTitle')}</p>
        <p className="text-muted-foreground text-sm">{t('emptyBody')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((name) => {
          // Localised phrasing per tool. A suggestion the caller cannot use never reaches
          // here — the server filtered the list against their permissions and modules.
          const label = t(`suggestions.${name}` as 'suggestions.list_my_expense_reports');
          return (
            <button
              key={name}
              type="button"
              disabled={disabled}
              onClick={() => onPick(label)}
              className="rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Bubble({ author, children }: { author: string; children: React.ReactNode }) {
  const mine = author === 'user';
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          mine
            ? 'max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground text-sm'
            : 'max-w-full text-foreground text-sm'
        }
      >
        {children}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'info'; children: React.ReactNode }) {
  return (
    <p
      className={
        tone === 'error'
          ? 'flex items-center gap-1.5 text-destructive text-sm'
          : 'flex items-center gap-1.5 text-muted-foreground text-sm'
      }
    >
      {tone === 'error' && <IconAlertTriangle size={14} />}
      {children}
    </p>
  );
}

function StoredMessage({
  role,
  views,
  messageId,
  rated,
  onConfirm,
  onDecline,
  busy,
}: {
  role: string;
  views: MessageView[];
  messageId: string;
  rated: boolean;
  onConfirm: (toolUseId: string) => void;
  onDecline: (toolUseId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-2">
      {views.map((view) =>
        view.kind === 'text' ? (
          <Bubble key={view.key} author={role}>
            {role === 'user' ? view.text : <MarkdownText>{view.text}</MarkdownText>}
          </Bubble>
        ) : (
          <Proposal
            key={view.toolUseId}
            view={view}
            busy={busy}
            onConfirm={() => onConfirm(view.toolUseId)}
            onDecline={() => onDecline(view.toolUseId)}
          />
        ),
      )}
      {role === 'assistant' && views.some((v) => v.kind === 'text') && (
        <Rating messageId={messageId} rated={rated} />
      )}
    </div>
  );
}

/**
 * A proposed action, in the thread.
 *
 * The wording is deliberate: nothing has happened yet, and it happens only on a press. A
 * confirmation that reads like a receipt is one people click through.
 */
function Proposal({
  view,
  busy,
  onConfirm,
  onDecline,
}: {
  view: Extract<MessageView, { kind: 'proposal' }>;
  busy: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const t = useTranslations('assistant');

  if (view.status !== 'confirmation_required') {
    const done = view.status === 'confirmed' && !view.failed;
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
        {done ? <IconCheck size={14} /> : <IconX size={14} />}
        {view.failed ? t('confirmRefused') : done ? t('confirmed') : t('declined')}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
      <p className="font-medium text-sm">{t('confirmTitle')}</p>
      <p className="font-mono text-muted-foreground text-xs">{view.toolName}</p>
      <p className="text-muted-foreground text-sm">{t('confirmBody')}</p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onConfirm} disabled={busy}>
          {t('confirm')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDecline} disabled={busy}>
          {t('decline')}
        </Button>
      </div>
    </div>
  );
}

/** 1–5, once. A rating is what the person thought, and it replaces rather than accumulates. */
function Rating({ messageId, rated }: { messageId: string; rated: boolean }) {
  const t = useTranslations('assistant');
  const utils = trpc.useUtils();
  const rate = trpc.assistant.rate.useMutation({
    onSuccess: () => void utils.assistant.messages.invalidate(),
  });

  if (rated || rate.isSuccess) {
    return <p className="text-muted-foreground text-xs">{t('rateThanks')}</p>;
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground text-xs">{t('rateTitle')}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={t('rateValue', { n })}
          disabled={rate.isPending}
          onClick={() => rate.mutate({ messageId, rating: n })}
          className="h-6 w-6 rounded text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
        >
          {n}
        </button>
      ))}
    </div>
  );
}
