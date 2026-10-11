import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The step that makes an iPhone receipt work at all.
 *
 * Claude's vision API rejects HEIC outright, and HEIC is what an iPhone camera produces by
 * default — so without this transcode a large share of real receipts fail extraction with
 * an error about the format, which is not something the person who photographed it can act
 * on. Everything the API already accepts passes through, and oversized images are
 * downscaled because the API resizes anything over ~1568px anyway: sending more buys no
 * fidelity and is billed as input.
 *
 * Mocked at the sharp boundary, because what matters is WHICH pipeline gets built. The two
 * failures worth pinning are both silent: a needless transcode (a PNG re-encoded as JPEG
 * changes the mime type its consumer was promised) and a missing one (HEIC reaching the
 * API, which rejects it).
 */

const calls: string[] = [];
const sharpArgs: unknown[] = [];

vi.mock('sharp', () => {
  const pipeline = {
    rotate() {
      calls.push('rotate');
      return pipeline;
    },
    resize(opts: Record<string, unknown>) {
      calls.push(`resize ${JSON.stringify(opts)}`);
      return pipeline;
    },
    jpeg(opts: Record<string, unknown>) {
      calls.push(`jpeg ${JSON.stringify(opts)}`);
      return pipeline;
    },
    png() {
      calls.push('png');
      return pipeline;
    },
    webp(opts: Record<string, unknown>) {
      calls.push(`webp ${JSON.stringify(opts)}`);
      return pipeline;
    },
    gif() {
      calls.push('gif');
      return pipeline;
    },
    async toBuffer() {
      calls.push('toBuffer');
      return Buffer.from('encoded-bytes');
    },
  };
  return {
    default: (input: unknown, opts: unknown) => {
      sharpArgs.push({ input, opts });
      return pipeline;
    },
  };
});

const { createSharpNormalizer, sharpNormalizer } = await import('./normalizer');

const bytes = (s: string) => new Uint8Array(Buffer.from(s));
const SOURCE = bytes('original-bytes');

beforeEach(() => {
  calls.length = 0;
  sharpArgs.length = 0;
});

describe('what never enters the pipeline', () => {
  it('passes a PDF through untouched', async () => {
    /** A PDF is a supported input in its own right; rasterising it here would throw away
     *  the text layer the model reads best. */
    const out = await sharpNormalizer.normalize(SOURCE, 'application/pdf');
    expect(out).toEqual({ data: SOURCE, mimeType: 'application/pdf' });
    expect(sharpArgs).toHaveLength(0);
  });

  it('passes an unexpected type through rather than guessing', async () => {
    /** `extractReceipt` owns the supported-type gate. Refusing here would move that
     *  decision into two places and make one of them wrong eventually. */
    const out = await sharpNormalizer.normalize(SOURCE, 'text/csv');
    expect(out).toEqual({ data: SOURCE, mimeType: 'text/csv' });
    expect(sharpArgs).toHaveLength(0);
  });

  it('passes an accepted image through when downscaling is off', async () => {
    /** Nothing left to do: the API takes it as-is and there is no size to trim. Entering
     *  the pipeline would re-encode for no reason and cost fidelity. */
    const n = createSharpNormalizer({ maxEdgePx: 0 });
    const out = await n.normalize(SOURCE, 'image/jpeg');
    expect(out).toEqual({ data: SOURCE, mimeType: 'image/jpeg' });
    expect(sharpArgs).toHaveLength(0);
  });
});

describe('HEIC, which the API rejects', () => {
  it('transcodes to JPEG and says so', async () => {
    const out = await sharpNormalizer.normalize(SOURCE, 'image/heic');
    expect(out.mimeType).toBe('image/jpeg');
    expect(Buffer.from(out.data).toString()).toBe('encoded-bytes');
    expect(calls).toContain('jpeg {"quality":90}');
  });

  it('transcodes every family an iOS camera emits', async () => {
    for (const mime of ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']) {
      calls.length = 0;
      const out = await sharpNormalizer.normalize(SOURCE, mime);
      expect(out.mimeType, mime).toBe('image/jpeg');
    }
  });

  it('transcodes even with downscaling disabled', async () => {
    /** The pass-through above is for images the API ACCEPTS. HEIC is not one, so turning
     *  off resizing must not turn off the conversion. */
    const n = createSharpNormalizer({ maxEdgePx: 0 });
    const out = await n.normalize(SOURCE, 'image/heic');
    expect(out.mimeType).toBe('image/jpeg');
    expect(calls.some((c) => c.startsWith('resize'))).toBe(false);
  });
});

describe('downscaling an accepted image', () => {
  it('keeps the format it was given, rather than converting to JPEG', async () => {
    /**
     * The silent failure: a PNG that comes back as a JPEG still has `image/png` on the
     * envelope, or vice versa — and the consumer sends the API a mime type that does not
     * match the bytes. Re-encoding in the same format is what keeps the promise.
     */
    const cases: Array<[string, string]> = [
      ['image/png', 'png'],
      ['image/webp', 'webp {"quality":90}'],
      ['image/gif', 'gif'],
      ['image/jpeg', 'jpeg {"quality":90}'],
    ];
    for (const [mime, encoder] of cases) {
      calls.length = 0;
      const out = await sharpNormalizer.normalize(SOURCE, mime);
      expect(out.mimeType, mime).toBe(mime);
      expect(calls, mime).toContain(encoder);
    }
  });

  it('fits inside the long edge and never upscales a small receipt', async () => {
    /** A till receipt photographed close up is already small; enlarging it invents
     *  detail and costs tokens for pixels that carry none. */
    await sharpNormalizer.normalize(SOURCE, 'image/jpeg');
    expect(calls).toContain(
      'resize {"width":1568,"height":1568,"fit":"inside","withoutEnlargement":true}',
    );
  });

  it('honours EXIF orientation before anything else', async () => {
    /** A phone photo carries its rotation in EXIF. Un-rotated, the model reads a receipt
     *  sideways — which it does badly, and silently. */
    await sharpNormalizer.normalize(SOURCE, 'image/jpeg');
    expect(calls[0]).toBe('rotate');
    expect(calls.indexOf('rotate')).toBeLessThan(calls.findIndex((c) => c.startsWith('resize')));
  });

  it('fails on a corrupt image rather than shipping a half-decoded one', async () => {
    expect(sharpArgs).toHaveLength(0);
    await sharpNormalizer.normalize(SOURCE, 'image/jpeg');
    expect((sharpArgs[0] as { opts: unknown }).opts).toEqual({ failOn: 'error' });
  });

  it('wraps the bytes without copying them', async () => {
    /** Receipts run to several MB and the worker fans out over a batch; a copy per image
     *  is memory the container does not have to spend. */
    await sharpNormalizer.normalize(SOURCE, 'image/jpeg');
    const { input } = sharpArgs[0] as { input: Buffer };
    expect(Buffer.isBuffer(input)).toBe(true);
    expect(input.buffer).toBe(SOURCE.buffer);
  });
});

describe('the configurable knobs', () => {
  it('takes a caller’s long edge', async () => {
    const n = createSharpNormalizer({ maxEdgePx: 800 });
    await n.normalize(SOURCE, 'image/jpeg');
    expect(calls.find((c) => c.startsWith('resize'))).toContain('"width":800');
  });

  it('takes a caller’s JPEG quality', async () => {
    const n = createSharpNormalizer({ jpegQuality: 60 });
    await n.normalize(SOURCE, 'image/heic');
    expect(calls).toContain('jpeg {"quality":60}');
  });

  it('defaults both when given an empty options object', async () => {
    const n = createSharpNormalizer({});
    await n.normalize(SOURCE, 'image/heic');
    expect(calls).toContain('jpeg {"quality":90}');
    expect(calls.find((c) => c.startsWith('resize'))).toContain('"width":1568');
  });
});
