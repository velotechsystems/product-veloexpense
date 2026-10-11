/**
 * Production `ImageNormalizer`: converts iPhone HEIC/HEIF receipts to JPEG (the
 * Claude vision API rejects HEIC) and optionally downscales oversized images to
 * the API's max edge to control input tokens. Everything the API already
 * accepts — and PDFs — passes through untouched.
 *
 * Backed by sharp (libvips + libheif). The worker container already ships
 * libheif1 and sharp's runtime image libs (see the worker Dockerfile), and
 * sharp's prebuilt `@img/sharp-linux-arm64` bundles libvips+libheif so no
 * native compilation happens at install time on the ARM64/glibc base image.
 */
import sharp from 'sharp';
import type { ImageNormalizer, NormalizedImage } from './extract';

/** MIME types the model accepts as image input — never transcode these. */
const MODEL_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** HEIC/HEIF families emitted by iOS cameras. */
const HEIC_MIME = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

/**
 * Claude vision resizes any image whose long edge exceeds ~1568px, so sending
 * larger wastes upload bandwidth and buys no quality. Pre-downscaling to this
 * edge trims tokens/bytes with no fidelity loss. Set to 0 to disable.
 */
const MAX_EDGE_PX = 1568;
/** JPEG quality for the transcode — high enough that small receipt text stays legible. */
const JPEG_QUALITY = 90;

export interface SharpNormalizerOptions {
  /** Long-edge cap in px; 0 disables downscaling. Default 1568. */
  maxEdgePx?: number;
  /** JPEG quality 1–100. Default 90. */
  jpegQuality?: number;
}

export function createSharpNormalizer(opts: SharpNormalizerOptions = {}): ImageNormalizer {
  const maxEdge = opts.maxEdgePx ?? MAX_EDGE_PX;
  const quality = opts.jpegQuality ?? JPEG_QUALITY;

  return {
    async normalize(data: Uint8Array, mimeType: string): Promise<NormalizedImage> {
      const isHeic = HEIC_MIME.has(mimeType);
      const isModelImage = MODEL_IMAGE_MIME.has(mimeType);

      // Not a raster image we handle (PDF, or anything unexpected): pass through
      // untouched. extractReceipt owns the final supported-type gate.
      if (!isHeic && !isModelImage) {
        return { data, mimeType };
      }

      // Already model-accepted AND downscaling disabled: nothing to do.
      if (isModelImage && maxEdge <= 0) {
        return { data, mimeType };
      }

      // sharp needs a Buffer; wrap without copying the bytes.
      const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      let pipeline = sharp(input, { failOn: 'error' }).rotate(); // honor EXIF orientation

      if (maxEdge > 0) {
        // withoutEnlargement: never upscale small receipts.
        pipeline = pipeline.resize({
          width: maxEdge,
          height: maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      if (isHeic) {
        // HEIC/HEIF -> JPEG (the API rejects HEIC). Always transcode.
        const out = await pipeline.jpeg({ quality }).toBuffer();
        return { data: new Uint8Array(out), mimeType: 'image/jpeg' };
      }

      // Already a supported type; we only entered the pipeline to downscale.
      // Re-encode in the SAME format to preserve mimeType (no needless transcode).
      let out: Buffer;
      switch (mimeType) {
        case 'image/png':
          out = await pipeline.png().toBuffer();
          break;
        case 'image/webp':
          out = await pipeline.webp({ quality }).toBuffer();
          break;
        case 'image/gif':
          out = await pipeline.gif().toBuffer();
          break;
        default:
          out = await pipeline.jpeg({ quality }).toBuffer(); // image/jpeg
          break;
      }
      return { data: new Uint8Array(out), mimeType };
    },
  };
}

/** Default production normalizer (1568px max edge, q90). */
export const sharpNormalizer: ImageNormalizer = createSharpNormalizer();
