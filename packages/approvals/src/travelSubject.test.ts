import { describe, expect, it, vi } from 'vitest';
import { loadRequesterId } from './engine';

/**
 * Travel adopting the approval engine.
 *
 * The point of routing travel through the same engine as everything else is that
 * self-approval blocking, delegation, escalation and tiered routing all come along
 * for free. `loadRequesterId` is the piece that makes the first of those work — it
 * is what `canDecide` compares the actor against — and the prototype's equivalent
 * check lived in the browser, which is to say it did not exist.
 */

function stubDb(travelRequest: { submitterId: string } | null) {
  return {
    travelRequest: { findUnique: vi.fn(async () => travelRequest) },
  } as never;
}

// VeloExpense: travel requests arrive with their own wave; there is no travel table yet, so
// ExpenseOS's travel cases are skipped and the subject refuses (below) rather than answering
// "nobody" — the requester is what blocks self-approval.
describe.skip('loadRequesterId · TRAVEL_REQUEST', () => {
  it('resolves the submitter, which is who may not approve their own trip', async () => {
    const db = stubDb({ submitterId: 'u-ada' });
    expect(await loadRequesterId(db, 'TRAVEL_REQUEST', 'trv-1')).toBe('u-ada');
  });

  it('is null for a request that has gone', async () => {
    // Null means "no owner to protect", not "anyone may approve" — canDecide treats
    // an absent owner as nothing to compare against rather than as consent.
    const db = stubDb(null);
    expect(await loadRequesterId(db, 'TRAVEL_REQUEST', 'trv-gone')).toBeNull();
  });

  it('queries the travel table, not another subject’s', async () => {
    const db = stubDb({ submitterId: 'u-ada' });
    await loadRequesterId(db, 'TRAVEL_REQUEST', 'trv-1');
    expect(
      (db as unknown as { travelRequest: { findUnique: ReturnType<typeof vi.fn> } }).travelRequest
        .findUnique,
    ).toHaveBeenCalledWith({ where: { id: 'trv-1' }, select: { submitterId: true } });
  });
});

describe('loadRequesterId · TRAVEL_REQUEST (VeloExpense, before travel)', () => {
  it('refuses rather than reporting no requester', async () => {
    const db = stubDb({ submitterId: 'u-ada' });
    await expect(loadRequesterId(db, 'TRAVEL_REQUEST', 'trv-1')).rejects.toThrow(
      /travel requests are not available yet/,
    );
  });
});
