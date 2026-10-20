import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '@/lib/storage';
import { receiptViewUrl, scanIsClean } from './viewUrl';

const storage = { presignDownload: vi.fn(async (key: string) => `signed:${key}`) } as unknown as Storage;

describe('f19 — receiptViewUrl', () => {
  it('signs only a CLEAN scan', async () => {
    expect(await receiptViewUrl('k', 'CLEAN', { storage })).toBe('signed:k');
  });

  it.each(['PENDING', 'SCANNING', 'INFECTED', 'FAILED', null, undefined, 'clean'])(
    'refuses %s (no link, and storage is never asked)',
    async (status) => {
      vi.mocked(storage.presignDownload).mockClear();
      expect(await receiptViewUrl('k', status as string | null | undefined, { storage })).toBeNull();
      expect(storage.presignDownload).not.toHaveBeenCalled();
    },
  );

  it('passes the filename and download options through', async () => {
    await receiptViewUrl('k', 'CLEAN', { storage, filename: 'r.pdf', download: { expiresInSeconds: 3600 } });
    expect(storage.presignDownload).toHaveBeenLastCalledWith('k', 'r.pdf', { expiresInSeconds: 3600 });
  });

  it('scanIsClean is exact', () => {
    expect(scanIsClean('CLEAN')).toBe(true);
    expect(scanIsClean('PENDING')).toBe(false);
    expect(scanIsClean(null)).toBe(false);
  });
});
