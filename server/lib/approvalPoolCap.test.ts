// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_POOL_CAP, APPROVAL_POOL_CAPPED_METRIC, capApprovalPool } from './approvalPoolCap';

describe('capApprovalPool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves a pool at the cap alone, and says nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = Array.from({ length: APPROVAL_POOL_CAP }, (_, i) => i);
    const out = capApprovalPool('unassigned', 'EXPENSE_REPORT', 'actor-1', rows);
    expect(out.capped).toBe(false);
    expect(out.rows).toHaveLength(APPROVAL_POOL_CAP);
    expect(warn).not.toHaveBeenCalled();
  });

  it('SIGNALS when it truncates — the receipt AND the metric, not just a shorter array', () => {
    /**
     * The whole point of this bound is that it is loud. A truncation that only
     * shortened the array would be a visibility bound wearing a materialization
     * bound's clothes: approvers would silently stop seeing claimable work, tasks
     * would lapse on their TTL, and the auto-reject would look like a decision
     * somebody made. So the assertions are on the SIGNALS, and the length is the
     * least interesting of the three.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = Array.from({ length: APPROVAL_POOL_CAP + 1 }, (_, i) => i);
    const out = capApprovalPool('unassigned', 'EXPENSE_REPORT', 'actor-1', rows);

    expect(out.capped).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    // The metric filter matches on this literal; the rest is for the human who
    // gets paged and has to know which queue and whose load.
    expect(line).toContain(APPROVAL_POOL_CAPPED_METRIC);
    expect(line).toContain('pool=unassigned');
    expect(line).toContain('subjectType=EXPENSE_REPORT');
    expect(line).toContain('actor-1');
    expect(out.rows).toHaveLength(APPROVAL_POOL_CAP);
  });

  // VeloExpense (w4-00c): skipped — VeloExpense has no observability stack, so there is no
  // metric filter or alarm to assert on yet (see the header of approvalPoolCap.ts).
  it.skip('is wired to an alarm, not just to a log line', () => {
    /**
     * A log-derived metric has no compile-time coupling to its emitter: rename the
     * literal here and the CloudWatch filter quietly matches nothing forever, which
     * is the failure this bound exists to avoid, one level up. Assert the two ends
     * still agree, and that something actually alarms on the metric.
     */
    const stack = readFileSync(
      path.resolve(__dirname, '../../../../../infrastructure/cdk/lib/observability-stack.ts'),
      'utf8',
    );
    expect(stack).toContain(`'"${APPROVAL_POOL_CAPPED_METRIC}"'`);
    expect(stack).toContain('approvalPoolCappedAlarm.addAlarmAction(warningAction)');
  });
});
