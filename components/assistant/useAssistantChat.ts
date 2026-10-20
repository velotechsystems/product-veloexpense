'use client';

import type { AttachedFile } from '@expenseos/assistant';
import { useCallback, useRef, useState } from 'react';
import type { UploadSlot } from '@/components/assistant/receiptUpload';
import type { ScreenContext } from '@/components/assistant/screenContext';

/**
 * The client half of a turn.
 *
 * The server owns the transcript, so this holds only what is needed to RENDER the turn in
 * progress: the text as it streams, whether a tool is running, and whether the turn ended on
 * a proposal waiting for a press. Everything durable is reloaded from the server rather than
 * mirrored here — two copies of a conversation is how a refresh starts showing something
 * different from what was stored.
 */

/** Mirrors `TurnFailureReason` on the server. Declared rather than imported: this is a
 *  client module, and the server file it comes from pulls in the route's world. */
export type TurnFailureReason =
  | 'overloaded'
  | 'rateLimited'
  | 'credential'
  | 'tooLong'
  | 'upstream'
  | 'network'
  | 'unknown';

export interface ChatTurnState {
  /** Text streamed so far for the answer being written. */
  streaming: string;
  /** True between sending and the stream closing. */
  busy: boolean;
  /** A tool is running — worth showing, because it is the slow part. */
  working: boolean;
  /** Set when the turn ended on a proposal the person has to press. */
  proposal: { toolUseId: string; toolName: string; input: unknown } | null;
  /** A transport or model failure. */
  failed: boolean;
  /**
   * What the server actually said, when it said anything.
   *
   * The route distinguishes seven refusals — not configured (503), module inactive
   * (404), signed out (401), no role (403), malformed (400), stale confirmation (409)
   * — each with a sentence written for a person. All of it used to be thrown away and
   * rendered as "Something went wrong. Try asking again.", which is advice that cannot
   * work for six of the seven: asking again does not install a module or fund an
   * account. Null means there was genuinely nothing to read (network drop, or a crash
   * with no JSON body), which is the only case the generic message fits.
   */
  failureMessage: string | null;
  /**
   * Why a turn that had already started streaming died.
   *
   * Distinct from `failureMessage`, which is a sentence the ROUTE wrote for a refusal it
   * could answer with a status code. Once the stream is open the route cannot send a
   * status, so it sends a reason from a closed set and the panel writes the sentence —
   * which is also what keeps it in the reader's language.
   */
  failureReason: TurnFailureReason | null;
  /** Set when the hourly ceiling is reached. */
  rateLimited: boolean;
  conversationId: string | null;
  title: string | null;
}

const IDLE: ChatTurnState = {
  streaming: '',
  busy: false,
  working: false,
  proposal: null,
  failed: false,
  failureMessage: null,
  failureReason: null,
  rateLimited: false,
  conversationId: null,
  title: null,
};

interface SendInput {
  message?: string;
  confirm?: string;
  decline?: string;
  /** Described, not sent: the bytes go to S3 after the press. */
  attachments?: readonly AttachedFile[];
}

/** What a confirmed mutation returned, for the caller that has to act on it. */
export interface ConfirmedOutcome {
  readonly toolName: string;
  readonly uploads: readonly UploadSlot[];
  /** The report the proposal created or added to, for the "go see it" link. */
  readonly reportId: string | null;
}

export function useAssistantChat(options: {
  conversationId: string | null;
  locale: 'en' | 'fr-CA';
  screen: ScreenContext | null;
  /** Called when the turn is over, so the caller can reload the stored transcript. */
  onSettled: (conversationId: string | null) => void;
  /**
   * A pressed proposal executed and came back with upload slots.
   *
   * Fired from inside the stream and deliberately not awaited: the upload takes seconds, and
   * blocking the reader would stall the model's own narration of what it just did.
   */
  onConfirmed?: (outcome: ConfirmedOutcome) => void;
}) {
  const [state, setState] = useState<ChatTurnState>(IDLE);
  // A ref rather than state: an in-flight turn must be cancellable from a handler that was
  // created before the turn started.
  const abort = useRef<AbortController | null>(null);

  const send = useCallback(
    async (input: SendInput) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setState((s) => ({
        ...s,
        streaming: '',
        busy: true,
        working: false,
        proposal: null,
        failed: false,
        failureMessage: null,
        failureReason: null,
        rateLimited: false,
      }));

      let conversationId = options.conversationId;
      try {
        const response = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            conversationId: options.conversationId ?? undefined,
            locale: options.locale,
            screen: options.screen ?? undefined,
            ...input,
          }),
        });

        if (response.status === 429) {
          setState((s) => ({ ...s, busy: false, rateLimited: true }));
          return;
        }
        if (!response.ok || !response.body) {
          // The route answers `{ message }` for every refusal it authors. Read it, and
          // fall back to the generic notice only when there is nothing to read.
          let failureMessage: string | null = null;
          try {
            const body = (await response.json()) as { message?: unknown };
            if (typeof body.message === 'string' && body.message.trim()) {
              failureMessage = body.message.trim();
            }
          } catch {
            // No JSON body — a crash or a proxy error page. Generic notice it is.
          }
          setState((s) => ({ ...s, busy: false, failed: true, failureMessage }));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line; a partial frame stays in the buffer.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            switch (event.type) {
              case 'open':
                conversationId = (event.conversationId as string) ?? null;
                setState((s) => ({
                  ...s,
                  conversationId,
                  title: (event.title as string | null) ?? s.title,
                }));
                break;
              case 'text':
                setState((s) => ({ ...s, streaming: s.streaming + (event.text as string) }));
                break;
              case 'tool_call':
                setState((s) => ({ ...s, working: true }));
                break;
              case 'tool_result':
                setState((s) => ({ ...s, working: false }));
                break;
              case 'confirmation_result': {
                // The tool result is not rendered — it is raw record content — but the panel
                // needs the upload slots out of it to file the bytes it is holding.
                const result = event.result as {
                  uploads?: readonly UploadSlot[];
                  reportId?: string;
                } | null;
                if (event.status === 'ok' && result?.uploads?.length) {
                  options.onConfirmed?.({
                    toolName: String(event.toolName ?? ''),
                    uploads: result.uploads,
                    reportId: result.reportId ?? null,
                  });
                }
                break;
              }
              case 'confirmation':
                setState((s) => ({
                  ...s,
                  proposal: {
                    toolUseId: event.id as string,
                    toolName: event.name as string,
                    input: event.input,
                  },
                }));
                break;
              case 'title':
                setState((s) => ({ ...s, title: event.title as string }));
                break;
              case 'error':
                setState((s) => ({
                  ...s,
                  failed: true,
                  failureReason: (event.reason as TurnFailureReason | undefined) ?? 'unknown',
                }));
                break;
              default:
                break;
            }
          }
        }
      } catch (error) {
        // An aborted turn is the person closing the panel or asking something else, not a
        // failure to report.
        if ((error as { name?: string }).name !== 'AbortError') {
          // The request never completed, so nothing classified it server-side. From the
          // browser's side that is always the same thing: the connection went.
          setState((s) => ({ ...s, failed: true, failureReason: 'network' }));
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        setState((s) => ({ ...s, busy: false, working: false, streaming: '' }));
        options.onSettled(conversationId);
      }
    },
    [options],
  );

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setState(IDLE);
  }, []);

  return { state, send, cancel, reset };
}
