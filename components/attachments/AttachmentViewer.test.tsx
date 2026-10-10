import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentDocument, formatBytes, isPdfFile, ZoomControls } from './AttachmentViewer';

/**
 * This component exists to stop the two workbenches drifting, so the tests pin
 * the things that differed: 100% means fit-to-WIDTH for each file type (a
 * receipt is read across, and fitting the whole page shrank a tall one until
 * nothing was legible), and our controls are the only ones a PDF gets.
 */

const LABELS = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Reset zoom',
  fullScreen: 'Full screen',
  download: 'Download',
};

const IMG = { id: 'a1', filename: 'receipt.jpg', url: 'https://s3/receipt.jpg?sig=1' };
const PDF = {
  id: 'a2',
  filename: 'invoice.pdf',
  url: 'https://s3/invoice.pdf?sig=1',
  mimeType: 'application/pdf',
};

describe('isPdfFile', () => {
  it('trusts the mime type over the filename', () => {
    expect(isPdfFile({ filename: 'scan.jpg', mimeType: 'application/pdf' })).toBe(true);
    expect(isPdfFile({ filename: 'invoice.pdf', mimeType: 'image/jpeg' })).toBe(false);
  });
  it('falls back to the extension when there is no mime type', () => {
    expect(isPdfFile({ filename: 'invoice.PDF', mimeType: null })).toBe(true);
    expect(isPdfFile({ filename: 'photo.png', mimeType: null })).toBe(false);
  });
});

describe('formatBytes', () => {
  it('scales to the unit a human would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('<AttachmentDocument>', () => {
  it('fits an image to the pane WIDTH at 100%, letting its height follow', () => {
    render(<AttachmentDocument file={IMG} zoom={100} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('style')).toContain('width: 100%');
    // No height constraint: a tall receipt scrolls rather than shrinking to fit.
    expect(img.getAttribute('style')).not.toContain('height');
    expect(img.className).toContain('h-auto');
  });

  it('scales the contain box past 100% so the container scrolls', () => {
    render(<AttachmentDocument file={IMG} zoom={200} />);
    expect(screen.getByRole('img').getAttribute('style')).toContain('width: 200%');
  });

  it('asks a PDF for page-width at 100%, with the native toolbar suppressed', () => {
    const { container } = render(<AttachmentDocument file={PDF} zoom={100} />);
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).toContain('zoom=page-width');
    expect(src).toContain('toolbar=0');
    expect(src).toContain('navpanes=0');
  });

  it('passes a numeric zoom to a PDF once it is not at fit', () => {
    const { container } = render(<AttachmentDocument file={PDF} zoom={150} />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain('zoom=150');
  });

  it('remounts the PDF frame on a zoom change — a hash-only change would not navigate', () => {
    const { container, rerender } = render(<AttachmentDocument file={PDF} zoom={100} />);
    const first = container.querySelector('iframe');
    rerender(<AttachmentDocument file={PDF} zoom={125} />);
    expect(container.querySelector('iframe')).not.toBe(first);
  });
});

describe('<ZoomControls>', () => {
  it('steps by 25 and clamps at both ends', async () => {
    const onZoom = vi.fn();
    const user = userEvent.setup();
    render(<ZoomControls zoom={100} onZoom={onZoom} labels={LABELS} />);
    await user.click(screen.getByLabelText('Zoom in'));
    expect(onZoom).toHaveBeenLastCalledWith(125);
    await user.click(screen.getByLabelText('Zoom out'));
    expect(onZoom).toHaveBeenLastCalledWith(75);
  });

  it('cannot zoom out below 50% or in above 300%', () => {
    const { rerender } = render(<ZoomControls zoom={50} onZoom={() => {}} labels={LABELS} />);
    expect(screen.getByLabelText('Zoom out')).toBeDisabled();
    rerender(<ZoomControls zoom={300} onZoom={() => {}} labels={LABELS} />);
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();
  });

  it('returns to fit when the percentage is clicked', async () => {
    const onZoom = vi.fn();
    const user = userEvent.setup();
    render(<ZoomControls zoom={225} onZoom={onZoom} labels={LABELS} />);
    await user.click(screen.getByText('225%'));
    expect(onZoom).toHaveBeenCalledWith(100);
  });
});
