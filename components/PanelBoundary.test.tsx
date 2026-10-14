import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Containment. The claim this component makes is that one panel throwing costs you that
 * panel and nothing else — which is exactly what a route-level `error.tsx` cannot give
 * you, and the reason there is no `dashboard/error.tsx`.
 */

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (k: string) => `${ns}.${k}`,
}));

import { PanelBoundary } from './PanelBoundary';

function Boom(): never {
  throw new Error('panel exploded');
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs the caught error itself; the boundary logs it again on purpose. Neither is
  // a test failure, and both are noise in the report.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('PanelBoundary', () => {
  it('renders its child when nothing goes wrong', () => {
    render(
      <PanelBoundary>
        <p>the panel</p>
      </PanelBoundary>,
    );
    expect(screen.getByText('the panel')).toBeInTheDocument();
  });

  it('replaces only the throwing panel, leaving its siblings alone', () => {
    render(
      <div>
        <PanelBoundary>
          <Boom />
        </PanelBoundary>
        <PanelBoundary>
          <p>the surviving panel</p>
        </PanelBoundary>
      </div>,
    );
    expect(screen.getByText('common.panelUnavailable')).toBeInTheDocument();
    expect(screen.getByText('the surviving panel')).toBeInTheDocument();
  });

  it('announces the failure politely rather than as an alert', () => {
    /** A missing panel is not an emergency. `role="alert"` on a landing page interrupts
     *  whatever the reader is already being told. */
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not put the thrown message on screen', () => {
    /** An error that reaches here has not been sanitized the way a tRPC error has, and may
     *  carry anything the throw site put in it. */
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );
    expect(screen.queryByText(/panel exploded/)).not.toBeInTheDocument();
  });

  it('offers exactly one action, and it is the retry', () => {
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('common.retry');
  });

  it('draws nothing at all for a caller that passed fallback={null}', () => {
    /**
     * `null` AND `undefined` ARE DIFFERENT REQUESTS, and this is the test that keeps them
     * different. `fallback ?? <PanelFallback />` would treat `null` as "not supplied" and
     * paint the standard face — silently ignoring the one caller the prop exists for, the
     * dashboard's identity chips inside a navy band.
     *
     * Why that caller wants nothing rather than the standard face, in `ux-ui-designer`'s
     * words: "`PanelFallback` is a bordered muted box with a Retry button that reloads the
     * page. Dropping that into a navy band is wrong visually, and worse than wrong
     * semantically — it offers a full page reload to recover a DEPARTMENT LABEL.
     * Affordances like that teach readers to ignore error affordances that matter."
     */
    const { container } = render(
      <PanelBoundary fallback={null}>
        <Boom />
      </PanelBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('common.panelUnavailable')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Contained, not swallowed: the boundary still caught it and still logged.
    expect(consoleError).toHaveBeenCalled();
  });

  it('still contains the throw when it draws nothing', () => {
    /** The reason `fallback={null}` is not "no boundary": a sibling on the same page keeps
     *  rendering, which is the whole claim this component makes. */
    render(
      <div>
        <PanelBoundary fallback={null}>
          <Boom />
        </PanelBoundary>
        <p>the surviving panel</p>
      </div>,
    );
    expect(screen.getByText('the surviving panel')).toBeInTheDocument();
  });

  it('keeps the standard face for every caller that omits the prop', () => {
    /** Four call sites in `dashboard/page.tsx` omit it and must be unaffected by the prop's
     *  existence — this is the regression test for adding it. */
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );
    expect(screen.getByText('common.panelUnavailable')).toBeInTheDocument();
  });
});
