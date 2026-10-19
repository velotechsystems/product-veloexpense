'use client';

/**
 * Dictation for the composer, on the browser's own speech recogniser.
 *
 * No audio leaves the page through us: `SpeechRecognition` is the platform API, and the
 * assistant receives the same text somebody could have typed. That is the whole reason to
 * prefer it over recording a file and posting it — a receipt drawer that starts uploading
 * microphone audio to our servers is a different product decision, with a different
 * privacy conversation, and it is not what a dictate button implies.
 *
 * Two behaviours here are the difference between usable and infuriating:
 *
 *   · **Only FINAL results reach the draft.** The recogniser re-emits a growing guess as
 *     you speak; appending those would write "I need I need a I need a receipt". Interim
 *     text is exposed separately so the composer can show the sentence forming without it
 *     ever being committed twice.
 *   · **Silence is not an error.** `no-speech` fires whenever somebody presses the button
 *     and thinks for a moment. Reporting it would put a red banner under the box for the
 *     ordinary act of pausing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Why dictation stopped, when it stopped badly. */
export type VoiceError = 'denied' | 'failed';

export interface VoiceInput {
  /** False when the browser has no recogniser — the control is not rendered at all. */
  readonly supported: boolean;
  readonly listening: boolean;
  /** The sentence currently forming. Never committed; shown so speaking looks alive. */
  readonly interim: string;
  readonly error: VoiceError | null;
  readonly start: () => void;
  readonly stop: () => void;
}

/** The slice of the Web Speech API this uses. Declared rather than imported: it is not in
 *  the TS DOM lib, and `any` here would hide the shape from every reader. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionCtor = new () => Recognition;

/** Chromium exposes it prefixed; the unprefixed name is the standard one. */
function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The composer's locale → a recogniser tag. Getting this wrong transcribes French as
 *  English nonsense rather than failing, which is the worse outcome of the two. */
function langFor(locale: string): string {
  return locale === 'fr-CA' ? 'fr-CA' : 'en-US';
}

export function useVoiceInput(options: {
  locale: string;
  /** A completed phrase, ready to append to the draft. */
  onTranscript: (text: string) => void;
}): VoiceInput {
  const { locale } = options;
  // Held in a ref so starting does not depend on a callback identity the caller has to
  // memoise — a composer re-renders on every keystroke.
  const onTranscript = useRef(options.onTranscript);
  onTranscript.current = options.onTranscript;

  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<VoiceError | null>(null);
  const recognition = useRef<Recognition | null>(null);

  // Detected after mount: `window` does not exist during the server render, and deciding
  // this at module scope would make the button's presence depend on where it was imported.
  useEffect(() => {
    setSupported(recognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (recognition.current) return; // already listening; a second press must not stack
    const Ctor = recognitionCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = langFor(locale);
    // Continuous, because dictating an expense question is a sentence or three, and a
    // recogniser that stops at the first pause makes somebody press the button per clause.
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let finished = '';
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finished += text;
        else pending += text;
      }
      setInterim(pending);
      if (finished.trim()) onTranscript.current(finished.trim());
    };

    rec.onerror = (event) => {
      // Pausing to think is not a failure, and neither is the caller stopping it.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'denied'
          : 'failed',
      );
    };

    rec.onend = () => {
      recognition.current = null;
      setListening(false);
      setInterim('');
    };

    setError(null);
    setInterim('');
    recognition.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // Throws if start() races a still-closing session. Nothing is listening either way.
      recognition.current = null;
      setListening(false);
    }
  }, [locale]);

  // Abort rather than stop on unmount: `stop` waits for a final result and would fire
  // `onresult` into a composer that no longer exists.
  useEffect(() => {
    return () => {
      recognition.current?.abort();
      recognition.current = null;
    };
  }, []);

  return { supported, listening, interim, error, start, stop };
}
