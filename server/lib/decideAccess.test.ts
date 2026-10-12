import { beforeEach, describe, expect, it, vi } from 'vitest';

const canDecide = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock('@expenseos/approvals/engine', () => ({ canDecide: (...a: unknown[]) => canDecide(...a) }));

import { resolveDecideAccess } from './decideAccess';

const db = {} as never;

beforeEach(() => {
  canDecide.mockReset();
});

describe('resolveDecideAccess', () => {
  it('lets an eligible approver through without consulting the override', async () => {
    // The assignee, a delegatee or a pool member decides on the task's own terms. The
    // override permission is irrelevant to them, and the audit row must NOT say override.
    canDecide.mockResolvedValueOnce(true);
    await expect(resolveDecideAccess(db, 't-1', 'u-1', true)).resolves.toEqual({
      allowed: true,
      override: false,
    });
    expect(canDecide).toHaveBeenCalledTimes(1);
    expect(canDecide).toHaveBeenCalledWith(db, 't-1', 'u-1', false);
  });

  it('refuses somebody who is neither eligible nor an override holder', async () => {
    // The AP-clerk case: reads every report, holds no override, is not the assignee.
    canDecide.mockResolvedValueOnce(false);
    await expect(resolveDecideAccess(db, 't-1', 'u-1', false)).resolves.toEqual({
      allowed: false,
      override: false,
    });
    // Never asked with the override flag — the engine's admin branch is not reachable
    // for somebody who does not hold the permission.
    expect(canDecide).toHaveBeenCalledTimes(1);
    expect(canDecide).not.toHaveBeenCalledWith(db, 't-1', 'u-1', true);
  });

  it('labels an override holder deciding a task that is not theirs as an override', async () => {
    canDecide.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(resolveDecideAccess(db, 't-1', 'u-1', true)).resolves.toEqual({
      allowed: true,
      override: true,
    });
    expect(canDecide).toHaveBeenNthCalledWith(2, db, 't-1', 'u-1', true);
  });

  it('still refuses an override holder the engine turns down', async () => {
    // The engine applies the self-approval block ahead of the override: the permission
    // lets you decide anybody's task, never your own.
    canDecide.mockResolvedValue(false);
    await expect(resolveDecideAccess(db, 't-1', 'u-1', true)).resolves.toEqual({
      allowed: false,
      override: false,
    });
    expect(canDecide).toHaveBeenCalledTimes(2);
  });
});
