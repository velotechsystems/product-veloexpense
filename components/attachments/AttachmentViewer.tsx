'use client';

/**
 * The document viewer, shared by the expense-report workbench and the card
 * transaction workbench.
 *
 * It exists because the two had drifted into different tools: one fit the whole
 * document to the pane and drove PDFs through `#zoom=page-fit`, the other set a
 * CSS `zoom` on a wrapper around a full-width image and a 600px-tall iframe — so
 * the same receipt opened at a readable size in one place and cropped in the
 * other. Reviewing a card transaction and reviewing an expense are the same act
 * with the same muscle memory, so the controls, the layout and the default scale
 * are now literally the same code.
 *
 * Two decisions worth keeping:
 *
 *   - **100% means fit-to-WIDTH.** A receipt is read left-to-right and top-down,
 *     so filling the pane's width is what makes the text legible; fitting the
 *     whole page instead shrank a tall receipt until nothing could be read
 *     without zooming in first. The document spans the pane at 100% and the
 *     container scrolls vertically. Above 100% it also scrolls sideways.
 *   - **Our controls are the only controls.** PDFs are rendered with the native
 *     toolbar suppressed and the scale driven through the `#zoom=` fragment,
 *     `page-width` at 100%. The iframe is keyed on (id, zoom) because a
 *     hash-only change doesn't re-navigate, so the viewer would ignore it.
 */

import { Button } from '@expenseos/design-system';
import { IconDownload, IconMaximize, IconMinus, IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

export interface ViewableFile {
  id: string;
  filename: string;
  url: string;
  mimeType?: string | null;
}

export interface AttachmentViewerLabels {
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
  fullScreen: string;
  download: string;
}

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;

/** Human file size (B / KB / MB). Lives here because every surface that lists
 *  an attachment needs it and three copies had already appeared. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isPdfFile(file: Pick<ViewableFile, 'filename' | 'mimeType'>): boolean {
  const mime = (file.mimeType ?? '').toLowerCase();
  if (mime) return mime.includes('pdf');
  return file.filename.toLowerCase().endsWith('.pdf');
}

/**
 * Zoom controls for the viewer's title bar, so a host can place them in its own
 * header (both workbenches centre them) while the viewer owns the state.
 */
export function ZoomControls({
  zoom,
  onZoom,
  labels,
}: {
  zoom: number;
  onZoom: (next: number) => void;
  labels: AttachmentViewerLabels;
}) {
  return (
    <div className="flex items-center gap-1">
      {/**
       * `pointer-coarse:min-w-11` on the pair, and a REAL width rather than
       * `.einc-tap-slop-both`.
       *
       * `size="sm"` already carries `.einc-tap-slop`, which is vertical by ruling —
       * horizontal slop on a small icon button reaches over a neighbour's own box and,
       * painting above it, wins the tap. These two have a neighbour 4px away (`gap-1`),
       * and it is the zoom READOUT, which is itself a control. So the horizontal 6px
       * short-fall is closed by growing the button rather than by an invisible ring:
       * `min-w-11` beats the variant's `px-*` the same way `min-h-11` beats its `h-9`,
       * and the box it claims is the box it occupies.
       *
       * Coarse-pointer-only. With a mouse this row is exactly what it was, which is why
       * no desktop viewer test moves.
       */}
      <Button
        size="sm"
        variant="ghost"
        className="pointer-coarse:min-w-11"
        aria-label={labels.zoomOut}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onZoom(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))}
      >
        <IconMinus size={14} />
      </Button>
      <button
        type="button"
        onClick={() => onZoom(100)}
        title={labels.zoomReset}
        /* `.einc-tap-slop` — VERTICAL ONLY, and that is the whole remedy here: the
           width is already `w-11`, so the only axis short of 44 is the ~16px of text
           height. `-both` would add nothing on the horizontal axis and would start a
           44px ring overlapping the two buttons either side of it. */
        className="einc-tap-slop w-11 text-center text-muted-foreground text-xs tabular-nums hover:text-foreground"
      >
        {zoom}%
      </button>
      <Button
        size="sm"
        variant="ghost"
        className="pointer-coarse:min-w-11"
        aria-label={labels.zoomIn}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onZoom(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))}
      >
        <IconPlus size={14} />
      </Button>
    </div>
  );
}

/** Full-screen + download links, the right-hand half of the title bar. */
export function ViewerFileActions({
  file,
  labels,
}: {
  file: ViewableFile;
  labels: AttachmentViewerLabels;
}) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
      >
        <IconMaximize size={13} />
        {labels.fullScreen}
      </a>
      <a
        href={file.url}
        download={file.filename}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={labels.download}
      >
        <IconDownload size={16} />
      </a>
    </div>
  );
}

/** The scrollable document area. `zoom` is owned by the caller so the controls
 *  can live in its title bar. */
export function AttachmentDocument({
  file,
  zoom,
  className,
}: {
  file: ViewableFile;
  zoom: number;
  className?: string;
}) {
  const pdf = isPdfFile(file);
  return (
    <div className={`min-h-0 flex-1 overflow-auto bg-muted/30 ${className ?? ''}`}>
      {pdf ? (
        <iframe
          key={`${file.id}-${zoom}`}
          title={file.filename}
          src={`${file.url}#toolbar=0&navpanes=0&zoom=${zoom === 100 ? 'page-width' : zoom}`}
          className="h-full min-h-[24rem] w-full"
        />
      ) : (
        // biome-ignore lint/performance/noImgElement: presigned S3 URL for a user upload, not a static asset
        <img
          src={file.url}
          alt={file.filename}
          // Width only: the height follows the image's own ratio, so 100% fills
          // the pane's width and a tall receipt scrolls rather than shrinking.
          style={{ width: `${zoom}%` }}
          className="mx-auto block h-auto"
        />
      )}
    </div>
  );
}

/** Zoom state that resets to fit whenever the viewed file changes — otherwise a
 *  200% zoom carries over onto the next document, which lands cropped. */
export function useViewerZoom(fileId: string | null | undefined): [number, (n: number) => void] {
  const [zoom, setZoom] = useState(100);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on file change
  useEffect(() => {
    setZoom(100);
  }, [fileId]);
  return [zoom, setZoom];
}
