import { describe, expect, it } from 'vitest';
import {
  type AttachedFile,
  attachmentNotice,
  MAX_ATTACHMENT_BYTES,
  RECEIPT_ACCEPT,
  rejectAttachment,
} from './attachments';

const file = (over: Partial<AttachedFile> = {}): AttachedFile => ({
  filename: 'dinner.heic',
  contentType: 'image/heic',
  sizeBytes: 2_411_004,
  ...over,
});

describe('rejectAttachment', () => {
  it('accepts the receipt types the product already accepts', () => {
    for (const contentType of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'application/pdf',
    ]) {
      expect(rejectAttachment(file({ contentType })), contentType).toBeNull();
    }
  });

  it('rejects a type nothing downstream can read', () => {
    // The extraction pipeline normalises HEIC and reads images and PDFs. A .docx would be
    // stored, scanned, and then quietly never extracted.
    expect(rejectAttachment(file({ contentType: 'text/csv' }))).toBe('type');
  });

  it('rejects over the size ceiling but not at it', () => {
    expect(rejectAttachment(file({ sizeBytes: MAX_ATTACHMENT_BYTES }))).toBeNull();
    expect(rejectAttachment(file({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }))).toBe('size');
  });

  it('offers the picker the same list it validates', () => {
    expect(RECEIPT_ACCEPT).toContain('image/heic');
    expect(RECEIPT_ACCEPT).toContain('application/pdf');
  });
});

describe('attachmentNotice', () => {
  it('states exact byte counts, because the model has to copy them into the tool call', () => {
    // "2.3 MB" is a number the model cannot turn back into sizeBytes — it would invent one
    // or omit the field, and the procedure would reject the call either way.
    const notice = attachmentNotice([file()], 'en');
    expect(notice).toContain('2411004 bytes');
    expect(notice).not.toMatch(/MB|KB/);
  });

  it('names every file and its type', () => {
    const notice = attachmentNotice(
      [file(), file({ filename: 'taxi.pdf', contentType: 'application/pdf', sizeBytes: 88_120 })],
      'en',
    );
    expect(notice).toContain('dinner.heic — image/heic, 2411004 bytes');
    expect(notice).toContain('taxi.pdf — application/pdf, 88120 bytes');
  });

  it('says nothing about upload state', () => {
    // The transcript is permanent and replayed. "Not yet uploaded" would be true for one
    // turn and a lie for every turn after the press.
    const notice = attachmentNotice([file()], 'en');
    expect(notice).not.toMatch(/uploaded|pending|waiting/i);
  });

  it('is written in the locale of the turn', () => {
    expect(attachmentNotice([file()], 'fr-CA')).toContain('Fichiers joints');
    expect(attachmentNotice([file()], 'fr-CA')).toContain('2411004 bytes');
  });
});
