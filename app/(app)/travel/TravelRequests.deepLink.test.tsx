import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/travel?request=<id>` — the deep link, and the guard on the id it carries.
 *
 * The page had no deep link at all until now, and `subjectLinks.ts` said so in writing:
 * travel notifications shipped WITHOUT an id because a query string nothing reads is a
 * link that promises to open the trip and lands on the list. This file is the other half
 * of removing that note — it pins that the param is actually consumed, so the entry in
 * that map cannot quietly become a lie again.
 *
 * Three behaviours matter here and only one of them is the happy path:
 *
 *   1. A VALID id opens the drawer on the matching request, with the approval task id
 *      when the reader holds one — landing on the list and making them find their own
 *      trip is the thing this replaces.
 *   2. A MALFORMED id is treated as ABSENT (security MUST-9). The list renders, no
 *      drawer opens, nothing throws. Not an error face: the honest reply to a URL nobody
 *      meant to type is the page they asked for.
 *   3. An id this reader cannot see behaves IDENTICALLY to a malformed one (MUST-10).
 *      No 403, no "not found" — distinguishing the two would confirm the record exists
 *      to somebody who may not read it.
 */

const queries: Record<string, unknown> = {};
const search = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({ useSearchParams: () => search.current }));

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      travelRequests: {
        listOwn: { invalidate: vi.fn() },
        summaryOwn: { invalidate: vi.fn() },
        myTasks: { invalidate: vi.fn() },
        listOversight: { invalidate: vi.fn() },
      },
    }),
    travelRequests: {
      listOwn: { useQuery: () => queries.listOwn ?? { data: { items: [] }, isLoading: false } },
      summaryOwn: {
        useQuery: () => queries.summaryOwn ?? { data: { count: 0 }, isLoading: false },
      },
      myTasks: { useQuery: () => queries.myTasks ?? { data: { items: [] }, isLoading: false } },
      listOversight: {
        useQuery: () => queries.listOversight ?? { data: { items: [] }, isLoading: false },
      },
    },
  },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

vi.mock('../TopBar', () => ({ setTopBarSlot: vi.fn() }));

const opened: Array<{ id: string; taskId?: string }> = [];
vi.mock('./TravelRequestDrawer', () => ({
  TravelRequestDrawer: ({ request, taskId }: { request: { id: string }; taskId?: string }) => {
    opened.push({ id: request.id, taskId });
    return <div data-testid="detail-drawer">{request.id}</div>;
  },
}));
vi.mock('./NewTravelRequestDrawer', () => ({
  NewTravelRequestDrawer: () => <div data-testid="new-drawer" />,
}));

import { TravelRequests } from './TravelRequests';

/** Real UUIDv7s, because the guard rejects anything that is not one. */
const MINE = '01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f';
const THEIRS = '01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e10';

function request(over: Record<string, unknown> = {}) {
  return {
    id: MINE,
    number: 'TRV-000001',
    status: 'SUBMITTED',
    destinationLabel: 'Toronto, ON, Canada',
    departDate: '2026-09-01T12:00:00.000Z',
    returnDate: '2026-09-04T12:00:00.000Z',
    approvedTotalMinor: null,
    budgetLines: [{ id: 'l1', amountMinor: 30000n }],
    currency: { code: 'CAD', symbol: '$' },
    submitter: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' },
    ...over,
  };
}

const setUrl = (query: string) => {
  search.current = new URLSearchParams(query);
};

beforeEach(() => {
  opened.length = 0;
  setUrl('');
  queries.listOwn = { data: { items: [request()] }, isLoading: false };
  queries.summaryOwn = { data: { count: 1 }, isLoading: false };
});
afterEach(() => {
  queries.listOwn = undefined;
  queries.summaryOwn = undefined;
  queries.myTasks = undefined;
  queries.listOversight = undefined;
});

describe('the /travel deep link', () => {
  it('opens the trip the link names', () => {
    setUrl(`request=${MINE}&n=1`);
    render(<TravelRequests />);
    expect(screen.getByTestId('detail-drawer')).toHaveTextContent(MINE);
    expect(opened).toEqual([{ id: MINE, taskId: undefined }]);
  });

  it('carries the approval task id when the trip is one I have to decide', () => {
    /** Without it the drawer opens read-only, and an approver following a TASK_ASSIGNED
     *  notification arrives at the trip with no approve button — which is the whole
     *  reason they clicked. */
    const r = request();
    queries.listOwn = { data: { items: [] }, isLoading: false };
    queries.myTasks = { data: { items: [{ taskId: 'task-9', label: 'approve', request: r }] } };
    setUrl(`request=${MINE}&n=1`);
    render(<TravelRequests />);
    expect(opened).toEqual([{ id: MINE, taskId: 'task-9' }]);
  });

  it('opens nothing at all when there is no link', () => {
    render(<TravelRequests />);
    expect(screen.queryByTestId('detail-drawer')).toBeNull();
  });

  it('treats a malformed id as absent — list renders, no drawer, no throw', () => {
    /**
     * MUST-9. `z.string().uuid()` or the equivalent BEFORE the value is used, and an
     * unparseable one is ABSENT rather than an error: the page the reader asked for is
     * the honest reply to a URL nobody meant to type.
     */
    setUrl('request=..%2F..%2Fetc%2Fpasswd&n=1');
    render(<TravelRequests />);
    expect(screen.queryByTestId('detail-drawer')).toBeNull();
    // The positive control: the page really did render, so `queryByTestId` returning
    // null means "no drawer" and not "no page".
    expect(screen.getByText('TRV-000001')).toBeInTheDocument();
  });

  it('treats an id that is nearly a UUID as absent too', () => {
    // One character short. A guard that only checked for the dashes would let it through.
    setUrl('request=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0&n=1');
    render(<TravelRequests />);
    expect(screen.queryByTestId('detail-drawer')).toBeNull();
    expect(screen.getByText('TRV-000001')).toBeInTheDocument();
  });

  it('answers an id this reader cannot see exactly as it answers a malformed one', () => {
    /**
     * MUST-10. `THEIRS` is a well-formed id for a trip that is in none of this reader's
     * three lists. The page opens nothing and says nothing — same render as the
     * malformed case above. A distinct 403 or "no such request" here would confirm the
     * record's existence to a caller who cannot read it.
     */
    setUrl(`request=${THEIRS}&n=1`);
    render(<TravelRequests />);
    expect(screen.queryByTestId('detail-drawer')).toBeNull();
    expect(screen.getByText('TRV-000001')).toBeInTheDocument();
  });

  it('drops the params from the address bar once it has opened', () => {
    /** So a reload, or a copied link pasted back, is not a second forced open. History
     *  only — a `router.replace` would re-render the route for a cosmetic change. */
    window.history.replaceState(null, '', `/en/travel?request=${MINE}&n=4&keep=yes`);
    setUrl(`request=${MINE}&n=4&keep=yes`);
    render(<TravelRequests />);
    const after = new URL(window.location.href);
    expect(after.searchParams.get('request')).toBeNull();
    expect(after.searchParams.get('n')).toBeNull();
    expect(after.searchParams.get('keep')).toBe('yes');
  });
});
