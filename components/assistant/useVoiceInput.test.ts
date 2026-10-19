import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInput } from './useVoiceInput';

/**
 * Dictation into the composer.
 *
 * The recogniser is a browser API with an awkward contract: it re-emits a GROWING guess as
 * somebody speaks, and only some of those results are final. Two failures follow directly
 * from that, and both are the kind a person notices immediately:
 *
 *   · appending interim results duplicates the sentence — "I need I need a receipt";
 *   · treating `no-speech` as an error puts a red banner under the box for the ordinary
 *     act of pausing to think.
 *
 * The rest is lifecycle: a second press must not stack a second recogniser, and unmounting
 * mid-sentence must not deliver a transcript into a composer that has gone.
 */

/** A stand-in for the platform recogniser, driven by the test. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  started = 0;
  stopped = 0;
  aborted = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
    this.onend?.();
  }
  abort() {
    this.aborted += 1;
  }

  /** Emit one batch of results, as the API shapes them. */
  emit(parts: Array<{ text: string; final: boolean }>) {
    const results = parts.map((p) => {
      const r = [{ transcript: p.text }] as unknown as ArrayLike<{ transcript: string }> & {
        isFinal: boolean;
      };
      (r as { isFinal: boolean }).isFinal = p.final;
      return r;
    });
    this.onresult?.({ resultIndex: 0, results });
  }
}

const latest = () => FakeRecognition.instances.at(-1) as FakeRecognition;

function install(ctor: unknown) {
  vi.stubGlobal('window', { ...globalThis.window, SpeechRecognition: ctor });
}

beforeEach(() => {
  FakeRecognition.instances = [];
  install(FakeRecognition);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = (locale = 'en') => {
  const onTranscript = vi.fn();
  const view = renderHook(() => useVoiceInput({ locale, onTranscript }));
  return { ...view, onTranscript };
};

describe('whether the control is offered at all', () => {
  it('reports support when the browser has a recogniser', () => {
    const { result } = setup();
    expect(result.current.supported).toBe(true);
  });

  it('reports no support when it has none, so the button is never rendered', () => {
    /** Firefox has no recogniser. A mic that does nothing is worse than no mic. */
    vi.stubGlobal('window', {});
    const { result } = setup();
    expect(result.current.supported).toBe(false);
  });

  it('does nothing when start is pressed without support', () => {
    vi.stubGlobal('window', {});
    const { result } = setup();
    act(() => result.current.start());
    expect(result.current.listening).toBe(false);
  });
});

describe('what reaches the draft', () => {
  it('commits a final phrase', () => {
    const { result, onTranscript } = setup();
    act(() => result.current.start());
    act(() => latest().emit([{ text: 'show me my open reports', final: true }]));
    expect(onTranscript).toHaveBeenCalledWith('show me my open reports');
  });

  it('never commits an interim guess', () => {
    /**
     * The recogniser re-emits a growing guess. Committing those writes the sentence into
     * the box several times over, each a prefix of the last.
     */
    const { result, onTranscript } = setup();
    act(() => result.current.start());
    act(() => latest().emit([{ text: 'show me', final: false }]));
    act(() => latest().emit([{ text: 'show me my open', final: false }]));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('exposes the interim text so speaking looks alive', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().emit([{ text: 'show me my', final: false }]));
    expect(result.current.interim).toBe('show me my');
  });

  it('clears the interim once the phrase lands', () => {
    /** Otherwise the forming sentence is still on screen underneath the committed one. */
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().emit([{ text: 'show me my', final: false }]));
    act(() => latest().emit([{ text: 'show me my reports', final: true }]));
    expect(result.current.interim).toBe('');
  });

  it('commits only the final half of a mixed batch', () => {
    const { result, onTranscript } = setup();
    act(() => result.current.start());
    act(() =>
      latest().emit([
        { text: 'first sentence. ', final: true },
        { text: 'second one forming', final: false },
      ]),
    );
    expect(onTranscript).toHaveBeenCalledWith('first sentence.');
    expect(result.current.interim).toBe('second one forming');
  });

  it('ignores a final result that is only whitespace', () => {
    const { result, onTranscript } = setup();
    act(() => result.current.start());
    act(() => latest().emit([{ text: '   ', final: true }]));
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe('the recogniser it asks for', () => {
  it('dictates in French for a French composer', () => {
    /** Wrong language transcribes to English nonsense rather than failing, which is the
     *  worse of the two outcomes — it looks like the recogniser is broken. */
    const { result } = setup('fr-CA');
    act(() => result.current.start());
    expect(latest().lang).toBe('fr-CA');
  });

  it('dictates in English otherwise', () => {
    const { result } = setup('en');
    act(() => result.current.start());
    expect(latest().lang).toBe('en-US');
  });

  it('keeps listening across pauses', () => {
    /** A question is a sentence or three; stopping at the first pause makes somebody press
     *  the button per clause. */
    const { result } = setup();
    act(() => result.current.start());
    expect(latest().continuous).toBe(true);
    expect(latest().interimResults).toBe(true);
  });
});

describe('starting and stopping', () => {
  it('does not stack a second recogniser on a second press', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => result.current.start());
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(latest().started).toBe(1);
  });

  it('stops listening when asked', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
  });

  it('can be started again after stopping', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(result.current.listening).toBe(true);
  });

  it('survives a start that throws because the last session is still closing', () => {
    class Throwing extends FakeRecognition {
      override start() {
        throw new Error('InvalidStateError');
      }
    }
    install(Throwing);
    const { result } = setup();
    act(() => result.current.start());
    expect(result.current.listening).toBe(false);
  });

  it('aborts rather than stops on unmount', () => {
    /**
     * `stop()` waits for a final result and would fire `onresult` into a composer that no
     * longer exists — a state update on an unmounted component, and a transcript nobody
     * can see.
     */
    const { result, unmount } = setup();
    act(() => result.current.start());
    const rec = latest();
    unmount();
    expect(rec.aborted).toBe(1);
    expect(rec.stopped).toBe(0);
  });
});

describe('when it goes wrong', () => {
  it('reports a refused microphone', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'not-allowed' }));
    expect(result.current.error).toBe('denied');
  });

  it('reports a blocked service the same way', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'service-not-allowed' }));
    expect(result.current.error).toBe('denied');
  });

  it('reports anything else as a plain failure', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'network' }));
    expect(result.current.error).toBe('failed');
  });

  it('says nothing about silence', () => {
    /** `no-speech` fires whenever somebody presses the button and thinks for a moment. */
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'no-speech' }));
    expect(result.current.error).toBeNull();
  });

  it('says nothing when the caller aborted it', () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'aborted' }));
    expect(result.current.error).toBeNull();
  });

  it('clears a previous error on the next attempt', () => {
    /** A denial the person has since granted must not keep the banner up forever. */
    const { result } = setup();
    act(() => result.current.start());
    act(() => latest().onerror?.({ error: 'network' }));
    act(() => result.current.stop());
    act(() => result.current.start());
    expect(result.current.error).toBeNull();
  });
});
