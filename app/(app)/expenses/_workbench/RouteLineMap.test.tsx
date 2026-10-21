import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMapsPageForTests } from '@/lib/googleMapsPage';

/**
 * The saved line's small map, with the map library stood in for. What is pinned: the path
 * is framed once, and a DIFFERENT path on the same map is framed afresh — without
 * remounting the map; the map draws the path's A and B ends and no other marker; and a
 * failure says whether the map library or this path is the cause.
 */

const h = vi.hoisted(() => ({
  decoded: {} as Record<string, unknown[]>,
  fitBounds: vi.fn(),
  mapMounts: 0,
  markers: [] as Array<{ label?: { text: string } }>,
  status: 'LOADED',
}));

vi.mock('@vis.gl/react-google-maps', async () => {
  const { useEffect } = await import('react');
  return {
    APILoadingStatus: { LOADED: 'LOADED', FAILED: 'FAILED', AUTH_FAILURE: 'AUTH_FAILURE' },
    APIProvider: (props: { children: ReactNode }) => <>{props.children}</>,
    Map: (props: { children: ReactNode }) => {
      useEffect(() => {
        h.mapMounts += 1;
      }, []);
      return <div data-testid="map">{props.children}</div>;
    },
    Polyline: () => null,
    Marker: (props: { label?: { text: string } }) => {
      h.markers.push(props);
      return null;
    },
    useApiLoadingStatus: () => h.status,
    useMap: () => ({ fitBounds: h.fitBounds }),
    useMapsLibrary: (name: string) =>
      name === 'geometry' ? { encoding: { decodePath: (s: string) => h.decoded[s] ?? [] } } : null,
  };
});

import type { RouteLineMapProps } from './RouteLine';
import RouteLineMap from './RouteLineMap';

class FakeBounds {
  points: unknown[] = [];
  extend(p: unknown) {
    this.points.push(p);
  }
}

beforeEach(() => {
  (globalThis as unknown as { google: unknown }).google = {
    maps: { SymbolPath: { CIRCLE: 0 }, LatLngBounds: FakeBounds },
  };
  h.decoded = { first: ['a1', 'a2'], second: ['b1', 'b2', 'b3'] };
  h.fitBounds = vi.fn();
  h.mapMounts = 0;
  h.markers = [];
  h.status = 'LOADED';
  resetMapsPageForTests();
});
afterEach(() => {
  delete (globalThis as unknown as { google?: unknown }).google;
});

const props = (encodedPolyline: string): RouteLineMapProps => ({
  apiKey: 'browser-key',
  region: null,
  language: 'en',
  encodedPolyline,
  onReady: vi.fn(),
  onUnavailable: vi.fn(),
});

describe('RouteLineMap', () => {
  it('frames a path once, however often it re-renders', () => {
    const view = render(<RouteLineMap {...props('first')} />);
    view.rerender(<RouteLineMap {...props('first')} />);
    expect(h.fitBounds).toHaveBeenCalledTimes(1);
    expect((h.fitBounds.mock.calls[0]?.[0] as FakeBounds | undefined)?.points).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('frames a new path afresh on the same map', () => {
    const view = render(<RouteLineMap {...props('first')} />);
    view.rerender(<RouteLineMap {...props('second')} />);
    expect(h.fitBounds).toHaveBeenCalledTimes(2);
    expect((h.fitBounds.mock.calls[1]?.[0] as FakeBounds | undefined)?.points).toEqual([
      'b1',
      'b2',
      'b3',
    ]);
    expect(h.mapMounts, 'the map itself is not remounted').toBe(1);
  });

  it('draws the A and B ends and no other marker — no via markers on a line map', () => {
    render(<RouteLineMap {...props('second')} />);
    // Every marker drawn is a lettered end, and there are exactly the two of them.
    expect(h.markers).toHaveLength(2);
    expect(h.markers.every((m) => m.label !== undefined)).toBe(true);
    expect([...new Set(h.markers.map((m) => m.label?.text))].sort()).toEqual(['A', 'B']);
  });

  it('a path with nothing to draw is a failure of this path', () => {
    h.decoded = { lonely: ['a1'] };
    const p = props('lonely');
    render(<RouteLineMap {...p} />);
    expect(p.onUnavailable).toHaveBeenCalledWith('path');
    expect(p.onUnavailable).not.toHaveBeenCalledWith('library');
  });

  it.each(['FAILED', 'AUTH_FAILURE'])(
    'Google’s script reporting %s is a library failure',
    (status) => {
      h.status = status;
      const p = props('first');
      render(<RouteLineMap {...p} />);
      expect(p.onUnavailable).toHaveBeenCalledWith('library');
    },
  );
});
