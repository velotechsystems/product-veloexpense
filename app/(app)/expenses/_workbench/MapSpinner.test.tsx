import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The spinner over a loading map (spec NFR-10; UX U1). What is pinned: in both modes the
 * icon is hidden from assistive technology and turns only when motion is allowed; the
 * line mode has no live region (the line's map box speaks for it), and the modal mode is
 * one `role="status"` whose visible text is "Loading the map…".
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { MapSpinner } from './MapSpinner';

describe('MapSpinner', () => {
  it.each(['line', 'modal'] as const)(
    '%s: the icon is hidden and turns only with motion allowed',
    (mode) => {
      const { container } = render(<MapSpinner mode={mode} />);
      const icon = container.querySelector('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon?.getAttribute('class')).toContain('motion-safe:animate-spin');
      expect(icon?.getAttribute('class')).not.toMatch(/(^|\s)animate-spin/);
      // An overlay centred in the map's box, which never takes a click.
      const overlay = container.firstElementChild;
      expect(overlay?.className).toContain('absolute inset-0');
      expect(overlay?.className).toContain('pointer-events-none');
    },
  );

  it('line: no live region and no text', () => {
    const { container } = render(<MapSpinner mode="line" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container).toHaveTextContent('');
  });

  it('modal: one status, whose visible text is the loading text', () => {
    render(<MapSpinner mode="modal" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('route.picker.mapLoading');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(status.querySelector('.sr-only')).toBeNull();
  });
});
