/**
 * VX5-12 — the ZIP writer, and the limits it refuses rather than gets wrong.
 *
 * `test/export-archive.db.test.ts` proves a real archive opens. This suite is
 * for the two things that suite cannot reach: the format's ceilings, and the
 * streaming shape.
 *
 * The ceilings matter more than they look. The classic container holds 32-bit
 * sizes and a 16-bit entry count, and a writer that sails past them emits a file
 * that OPENS, LISTS ITS CONTENTS, and produces garbage for the last entries —
 * the worst possible failure for an archive of somebody's own records. So each
 * limit throws, and each one is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { crc32, ZipLimitError, ZipWriter, ZIP_MAX_ENTRIES } from '@/lib/export/zip';
import { readZip, readZipMap } from './support/zip-reader';

/** Collect an archive into one buffer. */
async function build(
  fn: (zip: ZipWriter) => Promise<void>,
  modifiedAt = new Date('2026-09-07T12:34:56Z'),
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter(async (c) => {
    chunks.push(c);
  }, modifiedAt);
  await fn(zip);
  await zip.finish();
  return Buffer.concat(chunks);
}

describe('a round trip', () => {
  it('writes files an independent reader can open, with the right bytes', async () => {
    const buf = await build(async (zip) => {
      await zip.add('a.csv', ['id,name\r\n', '1,Ada\r\n']);
      await zip.add('nested/b.txt', ['hello']);
    });

    const files = readZipMap(buf);
    expect([...files.keys()]).toEqual(['a.csv', 'nested/b.txt']);
    expect(files.get('a.csv')!.toString('utf8')).toBe('id,name\r\n1,Ada\r\n');
    expect(files.get('nested/b.txt')!.toString('utf8')).toBe('hello');
  });

  it('handles an empty entry', async () => {
    // A fresh tenant has empty tables, so this is the common case rather than an
    // edge one — and a zero-length DEFLATE stream is the piece most likely to be
    // written wrong.
    const buf = await build(async (zip) => {
      await zip.add('empty.csv', []);
    });
    const entries = readZip(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0].declaredSize).toBe(0);
    expect(entries[0].data).toHaveLength(0);
  });

  it('actually compresses, which is the reason for deflate at all', async () => {
    const buf = await build(async (zip) => {
      await zip.add(
        'repetitive.csv',
        (async function* () {
          for (let i = 0; i < 5000; i += 1) yield `row-${i},1500,"a description"\r\n`;
        })(),
      );
    });
    const entry = readZip(buf)[0];
    // Roughly 8:1 on this input. Asserting a ratio rather than a byte count, so
    // a zlib version bump does not fail the suite.
    expect(buf.length).toBeLessThan(entry.declaredSize / 4);
  });

  it('survives a chunk boundary landing inside a multi-byte character', async () => {
    // The writer takes strings and encodes each piece separately, so a caller
    // that splits mid-character would corrupt it. This pins that a caller does
    // NOT have to think about that for whole strings.
    const buf = await build(async (zip) => {
      await zip.add('utf8.csv', ['café,naïve\r\n', '日本語,🧾\r\n']);
    });
    expect(readZipMap(buf).get('utf8.csv')!.toString('utf8')).toBe('café,naïve\r\n日本語,🧾\r\n');
  });

  it('reports what went in, for the manifest', async () => {
    const chunks: Uint8Array[] = [];
    const zip = new ZipWriter(async (c) => {
      chunks.push(c);
    });
    await zip.add('a.csv', ['abc']);
    await zip.finish();

    expect(zip.manifestEntries).toEqual([
      { name: 'a.csv', bytes: 3, crc32: crc32(new Uint8Array(Buffer.from('abc'))) },
    ]);
    expect(zip.bytesWritten).toBe(Buffer.concat(chunks).length);
  });

  it('is byte-identical for the same input and timestamp', async () => {
    // Worth having: it means two exports of an unchanged tenant can be compared,
    // and it is only true because the DOS timestamp is fixed rather than read
    // from the clock per entry.
    const once = await build(async (z) => z.add('a.csv', ['x,y\r\n']));
    const twice = await build(async (z) => z.add('a.csv', ['x,y\r\n']));
    expect(once.equals(twice)).toBe(true);
  });
});

describe('the limits it refuses', () => {
  it('refuses more entries than the container can index', async () => {
    const zip = new ZipWriter(async () => {});
    // Reach into the count rather than writing 65,535 files: the assertion is
    // about the guard, and a test that took a minute to arrive at it would be
    // skipped by whoever is in a hurry.
    (zip as unknown as { entries: unknown[] }).entries = new Array(ZIP_MAX_ENTRIES).fill({
      name: new Uint8Array(),
      crc: 0,
      compressed: 0,
      uncompressed: 0,
      offset: 0,
      time: 0,
      date: 0,
    });
    await expect(zip.add('one-too-many.csv', ['x'])).rejects.toBeInstanceOf(ZipLimitError);
    await expect(zip.add('one-too-many.csv', ['x'])).rejects.toMatchObject({ limit: 'entries' });
  });

  it('refuses to add after finishing, rather than writing past the directory', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.add('a.csv', ['x']);
    await zip.finish();
    // An entry written after the central directory is invisible to every reader
    // and silently lost — the caller has to be told.
    await expect(zip.add('late.csv', ['y'])).rejects.toThrow(/after finish/);
  });

  it('refuses to finish twice', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.finish();
    await expect(zip.finish()).rejects.toThrow(/twice/);
  });

  it('names which limit was hit', async () => {
    // The message is the deliverable here: an operator meeting this needs to
    // know whether it was the entry count or the byte count, because the answers
    // are different work.
    const zip = new ZipWriter(async () => {});
    (zip as unknown as { offset: number }).offset = 0xffff_fff0;
    const err = await zip.add('big.csv', ['x'.repeat(64)]).catch((e) => e);
    expect(err).toBeInstanceOf(ZipLimitError);
    expect((err as ZipLimitError).limit).toBe('archive_bytes');
    expect((err as Error).message).toContain('ZIP64');
  });
});

describe('crc32', () => {
  it('agrees with the known value for the standard check string', () => {
    // `123456789` → 0xCBF43926 is the reference vector every CRC-32
    // implementation is checked against. Without this, a wrong table would make
    // every archive fail in a reader while every local round trip passed.
    expect(crc32(new Uint8Array(Buffer.from('123456789')))).toBe(0xcbf4_3926);
  });

  it('is resumable across chunks, which is what lets an entry stream', () => {
    const whole = crc32(new Uint8Array(Buffer.from('123456789')));
    const a = crc32(new Uint8Array(Buffer.from('1234')));
    const both = crc32(new Uint8Array(Buffer.from('56789')), a);
    expect(both).toBe(whole);
  });

  it('is zero for no bytes', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});
