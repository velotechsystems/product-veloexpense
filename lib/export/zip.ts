/**
 * VX5-12 — a ZIP writer, streaming, with no new dependency.
 *
 * ── WHY NOT A LIBRARY ──────────────────────────────────────────────────────
 *
 * ExpenseOS zips with `fflate`, and porting that choice was the first thing
 * considered. This product does not have it, and the whole of what it would be
 * used for is here: DEFLATE, which is `node:zlib`, and the container format
 * around it, which is the 130 lines below. A dependency earns its place by doing
 * something hard or by being used widely enough that its API is worth learning
 * once; this would be neither.
 *
 * ── WHY IT STREAMS, AND WHAT THAT COSTS IN THE FORMAT ──────────────────────
 *
 * A ZIP entry's local header carries the CRC and both sizes, which a writer only
 * knows AFTER compressing. The usual way out is to compress each entry into
 * memory first — and the largest entry here is `audit_entry.csv`, which is
 * unbounded by design: it grows for the life of the tenant and is never pruned
 * (the retention policy does not exist yet — see VX5-14). Buffering it would put
 * the memory ceiling of a legal deliverable in the hands of how long a customer
 * has been a customer.
 *
 * So entries are written with a DATA DESCRIPTOR: general-purpose bit 3 set, the
 * local header's CRC and sizes left zero, and the real values written in a
 * 16-byte trailer after the compressed bytes. The central directory at the end
 * carries them properly, which is where every reader looks first. Memory stays
 * at one DEFLATE window per entry regardless of table size.
 *
 * That is the standard streaming shape rather than a trick — it is what every
 * server-side zip writer emits — but it is worth naming, because a reader
 * comparing this to a textbook ZIP will notice the zeros in the local headers
 * and could reasonably think they are a bug.
 *
 * ── WHAT IT REFUSES RATHER THAN GETS WRONG ─────────────────────────────────
 *
 * No ZIP64. The classic container holds 32-bit sizes and offsets and a 16-bit
 * entry count, so it tops out at 4 GiB and 65,535 entries. Past either, a writer
 * that keeps going silently emits a file whose central directory points at the
 * wrong place — and the symptom is an archive that opens, lists its contents,
 * and produces garbage for the last entries.
 *
 * Every limit is therefore checked and throws `ZipLimitError` naming which one.
 * An export that fails loudly with "this tenant's data exceeds 4 GiB" is a
 * ticket; an export that hands somebody a subtly corrupt archive of their own
 * records is a liability. ZIP64 is a contained follow-up when a real tenant
 * approaches it, and `EXPORT_SIZE_LIMIT` is where to start.
 */
import { createDeflateRaw } from 'node:zlib';

/** The classic container's ceilings. Past any of these, ZIP64 is required. */
export const ZIP_MAX_BYTES = 0xffff_ffff; // 4 GiB - 1, per entry AND per archive
export const ZIP_MAX_ENTRIES = 0xffff;

export class ZipLimitError extends Error {
  constructor(
    message: string,
    readonly limit: 'entry_bytes' | 'archive_bytes' | 'entries',
  ) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

/** Where the bytes go. Returning a promise is what gives the caller backpressure. */
export type Sink = (chunk: Uint8Array) => Promise<void> | void;

/* ── CRC-32, the one piece of arithmetic the format needs ──────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** Rolling CRC-32, so a streamed entry never has to be held to be checksummed. */
export function crc32(chunk: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffff_ffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    c = (CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

/* ── little-endian field writers ───────────────────────────────────────────── */

function u16(v: number): Uint8Array {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function u32(v: number): Uint8Array {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

/**
 * MS-DOS date and time, which is what ZIP stores.
 *
 * Two-second resolution and no timezone — a limitation of the format, not a
 * choice. The real timestamps are IN the CSVs as ISO 8601 with offsets, so
 * nothing depends on these; they exist so a file manager shows something
 * plausible. UTC is used rather than local time so the same export produces the
 * same bytes wherever the server runs.
 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time:
      (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Entry {
  name: Uint8Array;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  time: number;
  date: number;
}

/**
 * Write a ZIP to a sink, one entry at a time.
 *
 * Usage is strictly `add()`* then `finish()`. `add` takes an async iterable so a
 * caller can hand it a database cursor's pages without materialising the table.
 */
export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private closed = false;

  constructor(
    private readonly sink: Sink,
    /** Fixed so an export is byte-reproducible; defaults to now. */
    private readonly modifiedAt: Date = new Date(),
  ) {}

  private async put(chunk: Uint8Array): Promise<void> {
    if (this.offset + chunk.length > ZIP_MAX_BYTES) {
      throw new ZipLimitError(
        `archive would exceed ${ZIP_MAX_BYTES} bytes; ZIP64 is required`,
        'archive_bytes',
      );
    }
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  /**
   * Add one file, compressing as it goes.
   *
   * `content` is an async iterable of text or bytes — a generator that reads the
   * table in pages is the intended caller, which is what keeps a million-row
   * `audit_entry` from being a million rows in memory.
   */
  async add(
    name: string,
    content: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  ): Promise<void> {
    if (this.closed) throw new Error('ZipWriter: add() after finish()');
    if (this.entries.length >= ZIP_MAX_ENTRIES) {
      throw new ZipLimitError(
        `archive would exceed ${ZIP_MAX_ENTRIES} entries; ZIP64 is required`,
        'entries',
      );
    }

    const nameBytes = new Uint8Array(Buffer.from(name, 'utf8'));
    const { time, date } = dosDateTime(this.modifiedAt);
    const offset = this.offset;

    // Local header. Flag bit 3 says "CRC and sizes follow the data", which is
    // the whole reason this can stream — see the header of this file.
    await this.put(u32(0x0403_4b50));
    await this.put(u16(20)); // version needed: 2.0 (deflate)
    await this.put(u16(0x0008)); // bit 3: data descriptor
    await this.put(u16(8)); // method: deflate
    await this.put(u16(time));
    await this.put(u16(date));
    await this.put(u32(0)); // crc — in the descriptor
    await this.put(u32(0)); // compressed size — in the descriptor
    await this.put(u32(0)); // uncompressed size — in the descriptor
    await this.put(u16(nameBytes.length));
    await this.put(u16(0)); // no extra field
    await this.put(nameBytes);

    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;

    const deflate = createDeflateRaw();
    // Collect the compressed output as it appears. `deflate` is a Transform, so
    // its 'data' events can arrive while we are still writing input — the
    // pending array keeps the ordering without an extra stream.
    const pending: Uint8Array[] = [];
    deflate.on('data', (c: Buffer) => pending.push(new Uint8Array(c)));
    const finished = new Promise<void>((resolve, reject) => {
      deflate.on('end', resolve);
      deflate.on('error', reject);
    });

    const drain = async () => {
      while (pending.length > 0) {
        const chunk = pending.shift() as Uint8Array;
        compressed += chunk.length;
        await this.put(chunk);
      }
    };

    for await (const piece of content) {
      const bytes =
        typeof piece === 'string' ? new Uint8Array(Buffer.from(piece, 'utf8')) : piece;
      if (bytes.length === 0) continue;
      uncompressed += bytes.length;
      if (uncompressed > ZIP_MAX_BYTES) {
        deflate.destroy();
        throw new ZipLimitError(
          `entry ${JSON.stringify(name)} would exceed ${ZIP_MAX_BYTES} bytes; ZIP64 is required`,
          'entry_bytes',
        );
      }
      crc = crc32(bytes, crc);
      if (!deflate.write(bytes)) {
        await new Promise<void>((resolve) => deflate.once('drain', resolve));
      }
      await drain();
    }

    deflate.end();
    await finished;
    await drain();

    // Data descriptor.
    await this.put(u32(0x0807_4b50));
    await this.put(u32(crc));
    await this.put(u32(compressed));
    await this.put(u32(uncompressed));

    this.entries.push({ name: nameBytes, crc, compressed, uncompressed, offset, time, date });
  }

  /** Write the central directory and the end record. The archive is complete after this. */
  async finish(): Promise<void> {
    if (this.closed) throw new Error('ZipWriter: finish() twice');
    this.closed = true;

    const cdOffset = this.offset;
    for (const e of this.entries) {
      await this.put(u32(0x0201_4b50));
      await this.put(u16(20)); // version made by
      await this.put(u16(20)); // version needed
      await this.put(u16(0x0008)); // same flags as the local header, or readers complain
      await this.put(u16(8));
      await this.put(u16(e.time));
      await this.put(u16(e.date));
      await this.put(u32(e.crc));
      await this.put(u32(e.compressed));
      await this.put(u32(e.uncompressed));
      await this.put(u16(e.name.length));
      await this.put(u16(0)); // extra
      await this.put(u16(0)); // comment
      await this.put(u16(0)); // disk number
      await this.put(u16(0)); // internal attributes
      await this.put(u32(0)); // external attributes
      await this.put(u32(e.offset));
      await this.put(e.name);
    }
    const cdSize = this.offset - cdOffset;

    await this.put(u32(0x0605_4b50));
    await this.put(u16(0)); // this disk
    await this.put(u16(0)); // disk with the central directory
    await this.put(u16(this.entries.length));
    await this.put(u16(this.entries.length));
    await this.put(u32(cdSize));
    await this.put(u32(cdOffset));
    await this.put(u16(0)); // no archive comment
  }

  /** Bytes written so far, which is the archive size once `finish()` has run. */
  get bytesWritten(): number {
    return this.offset;
  }

  /** What went in, for the manifest and for the tests. */
  get manifestEntries(): readonly { name: string; bytes: number; crc32: number }[] {
    return this.entries.map((e) => ({
      name: Buffer.from(e.name).toString('utf8'),
      bytes: e.uncompressed,
      crc32: e.crc,
    }));
  }
}
