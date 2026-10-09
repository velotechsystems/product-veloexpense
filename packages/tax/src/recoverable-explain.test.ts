import { describe, expect, it } from 'vitest';
import { allocateRecoverable } from './recoverable';
import { explainRecoverable } from './recoverable-explain';

const line = (amountMinor: bigint, itcGstHstRate = 100, itcQstRate = 100) => ({
  amountMinor,
  itcGstHstRate,
  itcQstRate,
});

const params = (over: Partial<Parameters<typeof explainRecoverable>[0]> = {}) => ({
  gstHstMinor: 1300n,
  qstMinor: 0n,
  entityRecovers: true,
  lines: [line(11300n)],
  ...over,
});

describe('explainRecoverable', () => {
  it('returns the allocator’s numbers untouched', () => {
    // A second implementation would eventually disagree with the first, and then the
    // explanation would be confidently wrong about the figure on the screen.
    const input = params({ lines: [line(5000n, 50), line(6300n, 100)] });
    const explained = explainRecoverable(input);
    const { recoverableGstHstMinor, recoverableQstMinor } = allocateRecoverable(input);
    expect(explained.recoverableGstHstMinor).toBe(recoverableGstHstMinor);
    expect(explained.recoverableQstMinor).toBe(recoverableQstMinor);
  });

  it('explains nothing when there is a credit', () => {
    const { trace } = explainRecoverable(params());
    expect(trace.gstHst.zeroReason).toBeNull();
    expect(trace.gstHst.amountMinor).toBe(1300n);
  });

  describe('why it is zero', () => {
    it('says no tax was charged before blaming anything downstream', () => {
      // Every other reason is a statement about recovering tax nobody paid. Naming a
      // category here sends somebody to recode an expense over a tax that never existed.
      const { trace } = explainRecoverable(
        params({ gstHstMinor: 0n, entityRecovers: false, lines: [line(100n, 0)] }),
      );
      expect(trace.gstHst.zeroReason).toBe('NO_TAX_CHARGED');
    });

    it('blames the legal entity before the categories', () => {
      // The cause that made this file necessary. When the entity gate is shut, recoding a
      // category changes nothing — so naming the category would be advice that cannot work.
      const { trace } = explainRecoverable(
        params({ entityRecovers: false, lines: [line(11300n, 0)] }),
      );
      expect(trace.gstHst.zeroReason).toBe('ENTITY_NOT_REGISTERED');
    });

    it('names the missing line items, which is the part a claimant can fix', () => {
      const { trace } = explainRecoverable(params({ lines: [] }));
      expect(trace.gstHst.zeroReason).toBe('NO_LINES');
    });

    it('blames the categories only once every one of them recovers nothing', () => {
      const { trace } = explainRecoverable(params({ lines: [line(5000n, 0), line(6300n, 0)] }));
      expect(trace.gstHst.zeroReason).toBe('CATEGORIES_NOT_RECOVERABLE');
    });

    it('does not blame the categories when one of them does recover', () => {
      // A mixed expense whose credit is zero is a rounding story, not a coding story.
      const { trace } = explainRecoverable(
        params({ gstHstMinor: 1n, lines: [line(100n, 0), line(1n, 100)] }),
      );
      expect(trace.gstHst.zeroReason).toBe('ROUNDS_TO_ZERO');
    });
  });

  it('explains each tax on its own', () => {
    // Quebec: GST recovers, and a category that recovers no QST is a separate answer.
    const { trace } = explainRecoverable(
      params({ gstHstMinor: 500n, qstMinor: 998n, lines: [line(11300n, 100, 0)] }),
    );
    expect(trace.gstHst.zeroReason).toBeNull();
    expect(trace.qst.zeroReason).toBe('CATEGORIES_NOT_RECOVERABLE');
  });

  it('carries the per-line rates the answer has to name', () => {
    const { trace } = explainRecoverable(params({ lines: [line(5000n, 50), line(6300n, 0)] }));
    expect(trace.lines).toEqual([
      { amountMinor: 5000n, itcGstHstRate: 50, itcQstRate: 100 },
      { amountMinor: 6300n, itcGstHstRate: 0, itcQstRate: 100 },
    ]);
    expect(trace.entityRecovers).toBe(true);
  });
});
